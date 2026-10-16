import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser } from "playwright";
import { loadConfig } from "./config.js";
import { createPool, createStore } from "./database.js";
import { startEgressProxy } from "./network-proxy.js";
import { validateTaskUrl } from "./policy.js";
import type { WorkerTaskStore } from "./store.js";

const maxEvidenceBytes = 5 * 1024 * 1024;

async function executeTask(
  task: { id: string; url: string },
  browser: Browser,
  store: WorkerTaskStore,
  allowedDomains: Set<string>,
): Promise<void> {
  const context = await browser.newContext({
    acceptDownloads: false,
    permissions: [],
    serviceWorkers: "block",
    viewport: { width: 1280, height: 800 },
  });
  let cancelled = false;
  let checkingCancellation = false;
  let stage = "new-page";

  try {
    const page = await context.newPage();
    stage = "route-setup";
    await page.route("**/*", async (route) => {
      try {
        if (cancelled) {
          await route.abort();
          return;
        }
        validateTaskUrl(route.request().url(), allowedDomains);
        await route.continue();
      } catch {
        console.info("worker blocked browser request", task.id);
        await route.abort().catch(() => undefined);
      }
    });
    page.on("popup", (popup) => void popup.close().catch(() => undefined));

    const cancellationCheck = setInterval(() => {
      if (checkingCancellation) return;
      checkingCancellation = true;
      void store
        .isCancellationRequested(task.id)
        .then((requested) => {
          if (requested) {
            cancelled = true;
            return context.close();
          }
        })
        .catch(() => {
          cancelled = true;
          return context.close();
        })
        .finally(() => {
          checkingCancellation = false;
        });
    }, 500);
    cancellationCheck.unref();

    try {
      stage = "navigation";
      console.info("worker task navigation started", task.id);
      await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      stage = "screenshot";
      if (cancelled || (await store.isCancellationRequested(task.id))) {
        await store.finishTask(task.id, "cancelled");
        console.info("worker task cancelled", task.id);
        return;
      }
      const evidence = await page.screenshot({ type: "png", timeout: 10000 });
      if (evidence.byteLength > maxEvidenceBytes) {
        await store.finishTask(task.id, "failed");
        console.info("worker task failed", task.id);
      } else {
        await store.finishTask(task.id, "completed", evidence);
        console.info("worker task completed", task.id);
      }
    } catch {
      console.info("worker task stopped", task.id, stage);
      const wasCancelled =
        cancelled ||
        (await store.isCancellationRequested(task.id).catch(() => true));
      await store.finishTask(task.id, wasCancelled ? "cancelled" : "failed");
    } finally {
      clearInterval(cancellationCheck);
    }
  } catch {
    console.info("worker task stopped", task.id, stage);
    const wasCancelled =
      cancelled ||
      (await store.isCancellationRequested(task.id).catch(() => true));
    await store.finishTask(task.id, wasCancelled ? "cancelled" : "failed");
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function runWorker(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const store = createStore(pool);
  let proxy: Awaited<ReturnType<typeof startEgressProxy>> | undefined;
  let browser: Browser | undefined;
  try {
    proxy = await startEgressProxy(config.allowedDomains);
    browser = await chromium.launch({
      headless: true,
      proxy: { server: proxy.address, bypass: "<-loopback>" },
      args: [
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
      ],
    });
    let stopping = false;
    const shutdown = () => {
      stopping = true;
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    while (!stopping) {
      try {
        const task = await store.claimNextTask();
        if (task) {
          console.info("worker task claimed", task.id);
          await executeTask(task, browser, store, config.allowedDomains);
        } else {
          await delay(500);
        }
      } catch {
        await delay(1000);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (proxy) {
      const proxyServer = proxy.server;
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    }
    await pool.end().catch(() => undefined);
  }
}

runWorker().catch(() => {
  process.exitCode = 1;
});

import type { IncomingMessage, ServerResponse } from "node:http";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPool, createStore } from "../src/database.js";

let appPromise: ReturnType<typeof createApi> | undefined;

async function createApi() {
  const config = loadConfig();
  const pool = createPool(config);
  const app = createApp({
    apiToken: config.apiToken,
    allowedDomains: config.allowedDomains,
    store: createStore(pool),
  });
  app.addHook("onClose", async () => pool.end());
  await app.ready();
  return app;
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    appPromise ??= createApi();
    const app = await appPromise;
    app.server.emit("request", request, response);
  } catch {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "Service unavailable" }));
  }
}

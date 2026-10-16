import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startEgressProxy } from "../src/network-proxy.js";

let proxy: Awaited<ReturnType<typeof startEgressProxy>>;

afterEach(async () => {
  if (proxy) await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
});

describe("default-deny egress proxy", () => {
  it("rejects ordinary HTTP forwarding", async () => {
    proxy = await startEgressProxy(new Set(["example.com"]));
    const response = await new Promise<number>((resolve, reject) => {
      const requestToProxy = request(
        proxy.address,
        { method: "GET", path: "http://example.com/", headers: { host: "example.com" } },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode ?? 0));
        },
      );
      requestToProxy.once("error", reject);
      requestToProxy.end();
    });
    expect(response).toBe(403);
  });

  it("rejects CONNECT for unlisted hosts without resolving them", async () => {
    proxy = await startEgressProxy(new Set(["example.com"]));
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(proxy.address).port), "127.0.0.1");
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(
          "CONNECT unlisted.example:443 HTTP/1.1\r\nHost: unlisted.example:443\r\n\r\n",
        );
      });
      socket.once("data", (data) => {
        socket.destroy();
        resolve(data.toString());
      });
    });
    expect(response).toContain("403 Forbidden");
  });

  it("rejects alternate destination ports", async () => {
    proxy = await startEgressProxy(new Set(["example.com"]));
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(proxy.address).port), "127.0.0.1");
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(
          "CONNECT example.com:444 HTTP/1.1\r\nHost: example.com:444\r\n\r\n",
        );
      });
      socket.once("data", (data) => {
        socket.destroy();
        resolve(data.toString());
      });
    });
    expect(response).toContain("403 Forbidden");
  });
});

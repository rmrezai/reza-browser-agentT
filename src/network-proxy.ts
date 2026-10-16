import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isPublicAddress } from "./policy.js";

function deny(socket: Duplex, status = 403): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nConnection: close\r\n\r\n`,
    );
  }
}

export async function startEgressProxy(
  allowedDomains: Set<string>,
): Promise<{ server: Server; address: string }> {
  const server = createServer();
  server.on("connect", async (request, client, head) => {
    let upstream: Socket | undefined;
    const clientTimeout = setTimeout(() => client.destroy(), 10000);
    client.once("close", () => clearTimeout(clientTimeout));
    client.on("error", () => upstream?.destroy());

    try {
      const authority = request.url ?? "";
      const target = new URL(`https://${authority}`);
      const hostname = target.hostname.toLowerCase();
      if (
        target.username ||
        target.password ||
        target.port ||
        target.pathname !== "/" ||
        target.search ||
        target.hash ||
        !allowedDomains.has(hostname)
      ) {
        deny(client);
        return;
      }

      const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("DNS timeout")), 5000);
        void lookup(hostname, { all: true, verbatim: true }).then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
      if (client.destroyed) return;
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        deny(client);
        return;
      }

      const address = addresses[0];
      const socket = connect({
        host: address.address,
        family: address.family,
        port: 443,
      });
      upstream = socket;
      socket.once("error", () => deny(client, 502));
      socket.once("connect", () => {
        clearTimeout(clientTimeout);
        if (client.destroyed) {
          socket.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) socket.write(head);
        client.pipe(socket);
        socket.pipe(client);
      });
    } catch {
      deny(client);
      upstream?.destroy();
    }
  });
  server.on("request", (_request, response) => {
    response.writeHead(403, { connection: "close" }).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind egress proxy");
  return { server, address: `http://127.0.0.1:${address.port}` };
}

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool, createStore } from "./database.js";

const config = loadConfig();
const pool = createPool(config);
const app = createApp({
  apiToken: config.apiToken,
  allowedDomains: config.allowedDomains,
  store: createStore(pool),
});

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { QueueFullError, type ApiTaskStore } from "../src/store.js";

const token = "test-token-that-is-at-least-thirty-two-bytes";
const taskId = "11111111-1111-4111-8111-111111111111";

function makeStore(): ApiTaskStore {
  return {
    async createTask() {
      return { id: taskId, status: "pending", createdAt: new Date() };
    },
    async getTask(id) {
      return id === taskId
        ? {
            id,
            status: "completed",
            createdAt: new Date(),
            startedAt: new Date(),
            finishedAt: new Date(),
          }
        : null;
    },
    async cancelTask(id) {
      return id === taskId ? { id, status: "cancelled" } : null;
    },
    async getEvidence(id) {
      return id === taskId ? Buffer.from("synthetic image") : null;
    },
  };
}

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp({
    apiToken: token,
    allowedDomains: new Set(["example.com"]),
    store: makeStore(),
  });
});
afterEach(async () => app.close());

describe("authenticated task API", () => {
  it("rejects unauthenticated requests", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tasks",
      payload: { url: "https://example.com" },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects an incorrect bearer token", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}`,
      headers: { authorization: "Bearer " + "incorrect-token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("creates tasks only for allowed HTTPS destinations", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { authorization: "Bearer " + token },
      payload: { url: "https://example.com/report" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: taskId, status: "pending" });
    expect(response.body).not.toContain("example.com");
  });

  it("rejects unknown domains and malformed request bodies", async () => {
    for (const payload of [
      { url: "https://not-allowed.example" },
      { url: "https://example.com", extra: true },
      {},
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/tasks",
        headers: { authorization: "Bearer " + token },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("keeps evidence private and supports authenticated cancellation", async () => {
    const privateResponse = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/evidence`,
    });
    expect(privateResponse.statusCode).toBe(401);

    const response = await app.inject({
      method: "POST",
      url: `/tasks/${taskId}/cancel`,
      headers: { authorization: "Bearer " + token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: taskId, status: "cancelled" });
  });

  it("does not expose evidence in task status responses", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}`,
      headers: { authorization: "Bearer " + token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).not.toContain("synthetic image");
  });

  it("returns evidence only from the authenticated private endpoint", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/tasks/${taskId}/evidence`,
      headers: { authorization: "Bearer " + token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["cache-control"]).toContain("private");
    expect(response.body).toBe("synthetic image");
  });

  it("bounds the active queue", async () => {
    const store = makeStore();
    store.createTask = async () => {
      throw new QueueFullError();
    };
    await app.close();
    app = createApp({
      apiToken: token,
      allowedDomains: new Set(["example.com"]),
      store,
    });
    const response = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: { authorization: "Bearer " + token },
      payload: { url: "https://example.com" },
    });
    expect(response.statusCode).toBe(429);
  });
});

import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { validateTaskUrl } from "./policy.js";
import { QueueFullError, type ApiTaskStore } from "./store.js";

export interface CreateAppOptions {
  apiToken: string;
  allowedDomains: Set<string>;
  store: ApiTaskStore;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createApp(options: CreateAppOptions): FastifyInstance {
  const app = Fastify({
    bodyLimit: 8192,
    logger: false,
  });
  const expectedToken = createHash("sha256").update(options.apiToken).digest();

  app.setErrorHandler((error, _request, reply) => {
    const reportedStatus =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    const statusCode =
      reportedStatus && reportedStatus >= 400 && reportedStatus < 500
        ? reportedStatus
        : 500;
    reply
      .code(statusCode)
      .send({ error: statusCode < 500 ? "Invalid request" : "Internal server error" });
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    if (!reply.hasHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.get("/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok" };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/tasks")) return;
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const supplied = authorization.slice(7);
    const suppliedToken = createHash("sha256").update(supplied).digest();
    if (!timingSafeEqual(expectedToken, suppliedToken)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.post<{ Body: { url?: unknown } }>("/tasks", async (request, reply) => {
    const body = request.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.hasOwn(body, "url")
    ) {
      return reply.code(400).send({ error: "Expected a URL" });
    }

    let url: URL;
    try {
      url = validateTaskUrl(body.url, options.allowedDomains);
    } catch {
      return reply.code(400).send({ error: "Destination is not allowed" });
    }
    let task;
    try {
      task = await options.store.createTask(url.toString());
    } catch (error) {
      if (error instanceof QueueFullError) {
        return reply.code(429).send({ error: "Task queue is full" });
      }
      throw error;
    }
    reply.header("cache-control", "no-store").code(201);
    return { id: task.id, status: task.status, createdAt: task.createdAt };
  });

  app.get<{ Params: { id: string } }>("/tasks/:id", async (request, reply) => {
    if (!uuidPattern.test(request.params.id)) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const task = await options.store.getTask(request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found" });
    reply.header("cache-control", "no-store");
    return {
      id: task.id,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? null,
    };
  });

  app.post<{ Params: { id: string } }>("/tasks/:id/cancel", async (request, reply) => {
    if (!uuidPattern.test(request.params.id)) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const task = await options.store.cancelTask(request.params.id);
    if (!task) return reply.code(404).send({ error: "Task not found or no longer active" });
    reply.header("cache-control", "no-store");
    return { id: task.id, status: task.status };
  });

  app.get<{ Params: { id: string } }>(
    "/tasks/:id/evidence",
    async (request, reply) => {
      if (!uuidPattern.test(request.params.id)) {
        return reply.code(404).send({ error: "Evidence not found" });
      }
      const evidence = await options.store.getEvidence(request.params.id);
      if (!evidence) return reply.code(404).send({ error: "Evidence not found" });
      reply
        .header("cache-control", "private, no-store")
        .header("content-type", "image/png")
        .header("content-disposition", 'attachment; filename="evidence.png"')
        .header("x-content-type-options", "nosniff");
      return reply.send(evidence);
    },
  );

  return app;
}

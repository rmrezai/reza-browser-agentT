import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database.js";
import { PostgresTaskStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
const store = pool ? new PostgresTaskStore(pool) : undefined;
const taskIds: string[] = [];

describeWithDatabase("PostgreSQL task persistence", () => {
  beforeAll(async () => {
    await migrate(pool!);
  });

  afterEach(async () => {
    if (taskIds.length) {
      await pool!.query("DELETE FROM tasks WHERE id = ANY($1::uuid[])", [taskIds.splice(0)]);
    }
  });

  afterAll(async () => {
    await pool!.end();
  });

  it("claims tasks and persists private evidence", async () => {
    const task = await store!.createTask("https://example.com/synthetic");
    taskIds.push(task.id);
    const claimed = await store!.claimNextTask();

    expect(claimed).toMatchObject({ id: task.id, status: "running" });
    await store!.finishTask(task.id, "completed", Buffer.from("synthetic evidence"));

    expect((await store!.getTask(task.id))?.status).toBe("completed");
    expect(await store!.getEvidence(task.id)).toEqual(Buffer.from("synthetic evidence"));
  });

  it("does not retain evidence when a running task is cancelled", async () => {
    const task = await store!.createTask("https://example.com/synthetic-cancel");
    taskIds.push(task.id);
    await store!.claimNextTask();
    await store!.cancelTask(task.id);

    expect(await store!.isCancellationRequested(task.id)).toBe(true);
    await store!.finishTask(task.id, "completed", Buffer.from("must be discarded"));

    expect((await store!.getTask(task.id))?.status).toBe("cancelled");
    expect(await store!.getEvidence(task.id)).toBeNull();
  });
});

import type { Pool } from "pg";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface TaskSummary {
  id: string;
  status: TaskStatus;
  createdAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export interface ApiTaskStore {
  createTask(url: string): Promise<TaskSummary>;
  getTask(id: string): Promise<TaskSummary | null>;
  cancelTask(id: string): Promise<Pick<TaskSummary, "id" | "status"> | null>;
  getEvidence(id: string): Promise<Buffer | null>;
}

export interface WorkerTask extends TaskSummary {
  url: string;
}

export interface WorkerTaskStore extends ApiTaskStore {
  claimNextTask(): Promise<WorkerTask | null>;
  isCancellationRequested(id: string): Promise<boolean>;
  finishTask(
    id: string,
    status: "completed" | "failed" | "cancelled",
    evidence?: Buffer,
  ): Promise<void>;
}

export class QueueFullError extends Error {}

const maxActiveTasks = 100;

export class PostgresTaskStore implements WorkerTaskStore {
  constructor(private readonly pool: Pool) {}

  async createTask(url: string): Promise<TaskSummary> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(398427)");
      const active = await client.query(
        `SELECT count(*) FROM tasks WHERE status IN ('pending', 'running')`,
      );
      if (Number(active.rows[0].count) >= maxActiveTasks) throw new QueueFullError();
      const result = await client.query(
        `INSERT INTO tasks (url) VALUES ($1)
         RETURNING id, status, created_at AS "createdAt"`,
        [url],
      );
      await client.query("COMMIT");
      return result.rows[0] as TaskSummary;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getTask(id: string): Promise<TaskSummary | null> {
    const result = await this.pool.query(
      `SELECT id, status, created_at AS "createdAt",
              started_at AS "startedAt", finished_at AS "finishedAt"
       FROM tasks WHERE id = $1`,
      [id],
    );
    return (result.rows[0] as TaskSummary | undefined) ?? null;
  }

  async cancelTask(id: string): Promise<Pick<TaskSummary, "id" | "status"> | null> {
    const result = await this.pool.query(
      `UPDATE tasks
       SET cancel_requested = true,
           status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
           finished_at = CASE WHEN status = 'pending' THEN now() ELSE finished_at END
       WHERE id = $1 AND status IN ('pending', 'running')
       RETURNING id, status`,
      [id],
    );
    return (result.rows[0] as Pick<TaskSummary, "id" | "status"> | undefined) ?? null;
  }

  async getEvidence(id: string): Promise<Buffer | null> {
    const result = await this.pool.query(
      `SELECT evidence FROM tasks WHERE id = $1 AND status = 'completed'`,
      [id],
    );
    return (result.rows[0]?.evidence as Buffer | null | undefined) ?? null;
  }

  async claimNextTask(): Promise<WorkerTask | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE tasks
         SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
             finished_at = now()
         WHERE status = 'running' AND started_at < now() - interval '2 minutes'`,
      );
      const selected = await client.query(
        `SELECT id, url FROM tasks
         WHERE status = 'pending' AND cancel_requested = false
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!selected.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const claimed = await client.query(
        `UPDATE tasks SET status = 'running', started_at = now()
         WHERE id = $1
         RETURNING id, url, status, created_at AS "createdAt",
                   started_at AS "startedAt"`,
        [selected.rows[0].id],
      );
      await client.query("COMMIT");
      return claimed.rows[0] as WorkerTask;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async isCancellationRequested(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT cancel_requested FROM tasks WHERE id = $1 AND status = 'running'`,
      [id],
    );
    return result.rows[0]?.cancel_requested === true;
  }

  async finishTask(
    id: string,
    status: "completed" | "failed" | "cancelled",
    evidence?: Buffer,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE tasks
       SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE $2 END,
           evidence = CASE WHEN cancel_requested THEN NULL ELSE $3::bytea END,
           finished_at = now()
       WHERE id = $1 AND status = 'running'`,
      [id, status, evidence ?? null],
    );
  }
}

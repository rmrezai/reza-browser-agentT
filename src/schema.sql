CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  cancel_requested boolean NOT NULL DEFAULT false,
  evidence bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS tasks_pending_created_idx
  ON tasks (created_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS tasks_active_idx
  ON tasks (status) WHERE status IN ('pending', 'running');

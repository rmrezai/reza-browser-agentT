# REZA Browser Agent

A small, authenticated browser-task MVP. The API queues a task to navigate to an explicitly allowlisted HTTPS URL; a separate Playwright worker takes a screenshot and stores it as private evidence. It does not execute user-supplied JavaScript, shell commands, or model-generated actions.

## Local run with Docker Compose

Requirements: Docker Compose, Node.js 22+, and npm.

```sh
cp .env.example .env
```

Replace `API_TOKEN` with a randomly generated value of at least 32 bytes and `POSTGRES_PASSWORD` with a unique local password. The sample allowlist is `example.com`; only add exact hostnames for synthetic test sites you control. The Compose API and worker both use the example allowlist.

```sh
docker compose up --build
```

Compose starts PostgreSQL, applies the schema, and runs the API and isolated browser worker. The API is bound to `127.0.0.1:3000`; the database is bound to `127.0.0.1:5432`. Use Ctrl-C to stop the services.

Queue a task, check its status, and fetch its screenshot with:

```sh
curl -X POST http://localhost:3000/tasks \
  -H "$(printf '%s: %s %s' Authorization Bearer "$API_TOKEN")" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

curl http://localhost:3000/tasks/TASK_ID \
  -H "$(printf '%s: %s %s' Authorization Bearer "$API_TOKEN")"

curl http://localhost:3000/tasks/TASK_ID/evidence \
  -H "$(printf '%s: %s %s' Authorization Bearer "$API_TOKEN")" \
  -o evidence.png
```

`POST /tasks/:id/cancel` requests cancellation. Pending tasks are cancelled immediately; a running browser context is closed on its next cancellation check. Task status responses omit the URL and evidence. Evidence is only returned by the authenticated evidence endpoint and is marked `private, no-store`.

## Configuration and security

- `API_TOKEN`: shared bearer credential; at least 32 bytes. Generate and inject it through a secrets manager. The example placeholder is not secure.
- `DATABASE_URL`: PostgreSQL connection string. Production connections require TLS certificate verification.
- `ALLOWED_DOMAINS`: comma-separated exact hostnames. It is required, has no wildcard support, and defaults to deny when unset.
- Browser navigation and subresource requests must use HTTPS to an allowed hostname. The worker's local CONNECT proxy resolves destinations itself, rejects private/reserved IP ranges and non-443 ports, and connects to the checked IP. Direct HTTP forwarding is denied. Chromium uses that proxy, disables QUIC and non-proxied WebRTC, and runs in a per-task isolated context inside a non-root container.
- Do not allow domains that host private data or submit real credentials. Use synthetic data and test sites you control. The MVP is single-tenant: anyone holding the bearer token can access all tasks and evidence.
- Keep `.env` out of source control. In production, use separate PostgreSQL databases and credentials for preview and production, keep the database private, and grant the runtime role only the required `SELECT`, `INSERT`, and `UPDATE` access to `tasks`. Run migrations with a separate schema-owner role.

## Tests and checks

```sh
npm ci --legacy-peer-deps
npm test
npm run build
npm audit --audit-level=high
```

Tests use synthetic in-memory task stores and local sockets; they do not contact external sites or require PostgreSQL. GitHub Actions runs these checks on pushes and pull requests.

## Vercel preview and separate worker

Deploy the Fastify function from `api/[[...route]].ts` using the included `vercel.json`. The worker is intentionally not a Vercel function: deploy the included Playwright container on a separate container host with the same preview-only `DATABASE_URL`, `API_TOKEN`, and `ALLOWED_DOMAINS`. The Playwright image version in `Dockerfile` matches the pinned npm Playwright version.

For Vercel, configure `API_TOKEN`, a preview-only TLS PostgreSQL `DATABASE_URL`, and `ALLOWED_DOMAINS` as Preview environment variables; do not reuse production secrets or data. Apply `src/schema.sql` to the preview database before sending tasks, using the migration role and `npm run migrate` (only `DATABASE_URL` is required). Enable Vercel Preview Deployment Protection in the project's dashboard; it is a project-level setting and cannot be safely enabled by this repository alone. Keep the external worker private, run it as a non-root container, and use synthetic data only.

The API function and worker communicate only through PostgreSQL. Scale workers independently; `FOR UPDATE SKIP LOCKED` prevents multiple workers from claiming the same pending task.

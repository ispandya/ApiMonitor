# API Monitor

An uptime-monitoring service, built as a learning project to practice real backend engineering:
it probes your HTTP endpoints on a schedule, records every result, opens an **incident** when one
goes down (not one row per failed check), delivers **webhook alerts** with retries, and pushes
results to a **live dashboard**.

![Dashboard](docs/dashboard.png)

**Stack:** Node.js · TypeScript · Express · PostgreSQL · Redis · BullMQ · Socket.io · Zod

## What it does

- **Monitors** any HTTP(S) endpoint at an interval you choose (10 s to 24 h), with your expected
  status code and a timeout.
- **Incidents** open on an up→down transition and resolve on down→up, so a 50-minute outage is one
  incident, not fifty.
- **Webhook alerts** on open and resolve: separate queue, retried with exponential backoff,
  permanent failures (like a 404) are not retried, and delivery is idempotent.
- **Live dashboard** with a latency chart, recent checks, and incident activity, updated over
  WebSockets.
- **Multi-tenant:** accounts own monitors, API keys belong to accounts (so keys can be rotated
  without losing data), and the API is rate limited.
- **Self-maintaining:** the `checks` table is partitioned by day, and a nightly job creates new
  partitions and drops expired ones.

## Architecture

```mermaid
flowchart LR
  subgraph API["API process: npm run dev"]
    R["Express routes<br/>auth and rate limits"]
    S["Socket.io"]
    B["Redis subscriber"]
  end
  subgraph W["Worker process: npm run worker"]
    C["Check worker"]
    A["Alert worker"]
    M["Maintenance worker"]
  end
  PG[("PostgreSQL")]
  RD[("Redis")]
  UI["Dashboard"]
  T["Monitored APIs"]
  H["Customer webhooks"]

  UI -->|REST| R
  R --> PG
  R -->|schedule and unschedule| RD
  RD -->|check jobs| C
  C -->|HTTP probe| T
  C -->|checks and incidents| PG
  C -->|alert jobs| RD
  RD --> A
  A -->|POST| H
  C -->|publish events| RD
  RD --> B
  B --> S
  S -->|live updates| UI
  M -->|partitions| PG
```

The API and the worker are **separate processes** that only talk through Postgres and Redis, so
either can be restarted, scaled, or crash without taking the other down.

## Quick start

Requires Node 20 or newer (developed and tested on Node 24) and Docker.

```bash
git clone https://github.com/ispandya/ApiMonitor.git
cd ApiMonitor
docker compose up -d            # Postgres 16 and Redis 7
npm install
npm run db:migrate              # applies the numbered SQL migrations

npm run account:create -- "my account"
npm run key:create -- "my laptop" <the account id it printed>   # copy the key: shown once

npm run dev                     # terminal 1: API + dashboard on http://localhost:4000
npm run worker                  # terminal 2: probes, alerts, maintenance
```

Open <http://localhost:4000>, paste your key, and create a monitor:

```bash
curl -X POST http://localhost:4000/monitors \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"My site","url":"https://example.com","interval_seconds":30}'
```

On Windows PowerShell use `curl.exe` (plain `curl` is an alias for something else).

## API

Everything under `/monitors` needs `Authorization: Bearer <key>`. `/health` is public.

| Method | Path | |
|---|---|---|
| `GET` | `/monitors` | list your monitors |
| `POST` | `/monitors` | create one and start monitoring it |
| `GET` | `/monitors/:id` | one monitor |
| `PATCH` | `/monitors/:id` | change fields; changing `interval_seconds` or `is_active` reschedules |
| `DELETE` | `/monitors/:id` | delete it and its history |
| `GET` | `/monitors/:id/checks?limit=N` | recent checks, newest first (1–500, default 100) |

**Validation:** `interval_seconds` 10–86400, `timeout_ms` 1000–60000 and less than the interval,
`method` GET/HEAD/POST, URLs must be `http`/`https`. Invalid input returns `400` with a per-field
list of problems.

**Limits:** 120 requests/min per IP, 60/min per account, 10 monitor creations/min per account.
Exceeding one returns `429` with `Retry-After`.

**Webhooks** receive a `POST` with an `Idempotency-Key` header (`<incident id>-<event>`) and:

```json
{ "event": "incident.opened",
  "incident": { "id": "…", "started_at": "…", "resolved_at": null, "cause": "timed out after 10000ms" },
  "monitor":  { "id": "…", "name": "My site", "url": "https://example.com" } }
```

**Live events** over Socket.io: connect with `io({ auth: { token: key } })`, emit
`subscribe` with a monitor id, and listen for `check` and `incident` events.

## Configuration

Defaults match `docker-compose.yml`, so local development needs no configuration.

| Variable | Default |
|---|---|
| `DATABASE_URL` | `postgres://monitor:monitor@localhost:5432/api_monitor` |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` |

The credentials in `docker-compose.yml` are for local development only.

## Testing

```bash
docker compose up -d
docker compose --profile test up -d redis-test   # a separate Redis on port 6390

npm test               # everything: 142 tests, about a minute
npm run test:unit      # only the tests that need no database or Redis (about a second)
npm run typecheck
```

- **Unit tests** cover the pieces that can be tested alone: request validation, the HTTP probe, webhook
  delivery and its retry rules, the error handler, and key generation.
- **Integration tests** run against real Postgres and Redis (no mocks), because nearly every bug worth
  catching here lives in the seams: transactions and row locks, races between workers, the queue,
  partitioning, migrations, the rate limiter, sockets, and ownership isolation. One test runs the
  whole pipeline with the real workers: a failing API becomes one incident, two webhooks and live events.
- **The suite cannot touch your data.** It uses its own database (`api_monitor_test`, recreated on every
  run) and its own Redis, and refuses to start if pointed at anything else.
- **CI** runs the typecheck and the full suite on every push and pull request
  (`.github/workflows/ci.yml`).

## Design decisions

The parts I'd want to talk through in an interview.

**Scheduling.** One BullMQ job scheduler per monitor, keyed by the monitor's id, stored in Redis.
Each monitor's interval changes independently, schedules survive restarts, and upserting the same
id twice still gives one schedule. Postgres is the source of truth: on startup the API reconciles
Redis against it (create missing, fix wrong intervals, remove orphans).

**Failed probes are results, not job failures.** A target being down is a normal outcome that gets
recorded; a job only fails when *our* system breaks. Retries are reserved for alert delivery,
where they make sense.

**Incidents only change on a state transition**, inside the same transaction as the check and
under a row lock, so two workers can never open two incidents. A partial unique index enforces
"at most one open incident per monitor" even if the code has a bug.

**Alerts are at-least-once, made safe with idempotency at three layers:** the job id (no duplicate
enqueue), a delivery table (no duplicate send after a crash), and the `Idempotency-Key` header
(lets the receiver ignore repeats). The database commit and the queue publish can't share a
transaction, so a periodic sweep re-queues alerts that were committed but never enqueued.

**Live updates** flow worker → Redis pub/sub → API → Socket.io room per monitor. Pub/sub is
fire-and-forget, so the dashboard re-reads over REST after every (re)connect.

**Security.** API keys are 256-bit random values stored only as SHA-256 hashes and shown once.
Every auth failure returns the identical `401`. Someone else's monitor returns the same `404` as
a missing one, so ids can't be probed. The rate limiter is an atomic Lua script in Redis (no
counter can lose its expiry), runs per IP before auth and per account after, and fails open if
Redis is down.

**Data lifecycle.** `checks` is partitioned by UTC day. Dropping an expired partition is instant
and leaves no dead rows behind, unlike deleting millions of rows.

**Migrations** are numbered SQL files, applied once each in a transaction, recorded with a
checksum (editing an applied migration is refused), and guarded by an advisory lock. Breaking
changes use *expand → deploy → contract*: migrations 003 and 004 replaced key-based ownership
with accounts without ever breaking the running code.

## Known limitations

Written down deliberately, since knowing them matters as much as the features.

- **The suite runs serially** against one shared test database, because parallel test files would collide, and a few tests wait on real time (retry backoff, rate-limit windows), so they are slower than pure unit tests.
- **No SSRF protection.** A monitor can point at `localhost` or a private address, and the worker
  will request it. Fine for a private deployment, not for a public one.
- The fixed-window rate limiter allows up to 2× the limit in a burst across a window boundary.
- Sockets stay connected after their key is revoked, until they next reconnect.
- The dashboard is read-only (monitors are created through the API), keeps the key in
  `sessionStorage`, sets no Content-Security-Policy, and loads Chart.js from a CDN.
- The history query has no time bound, so it visits every partition.
- Single Postgres and single Redis, and probes run from one location.

## Project layout

```
src/
  index.ts            API entry point (routes, dashboard, sockets)
  worker.ts           worker entry point (checks, alerts, maintenance)
  routes/ schemas/    HTTP layer and Zod validation
  services/           SQL, one module per concern
  checks/             the HTTP probe and one full check run
  queue/              BullMQ queues, workers, scheduling, reconciliation
  alerts/             webhook delivery and the sweep
  realtime/           Socket.io server and the Redis pub/sub bridge
  middleware/         auth, rate limiting, error handling
  maintenance/        partition creation and retention
  db/                 pool and migrations/
public/               the dashboard (plain HTML and JS)
test/                 unit/ and integration/ tests, shared helpers, one-time setup
.github/workflows/    CI
```

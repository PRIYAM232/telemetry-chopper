# Telemetry Chopper Control Plane

Fleet management API for the `otelcol-chopper` data plane: Next.js 16 (App
Router, TypeScript), Prisma 7, PostgreSQL.

Collectors poll `GET /api/v1/policies/:fleetId` with their fleet's API key and
receive the fleet's dynamic `PolicyRule` set (`DROP` / `SAMPLE` / `REDACT`
against traces, logs, or metrics). The Go side of this contract lives in
`data-plane/processors/filterprocessor/config.go` — keep the two in sync.

## Layout

| Path | Purpose |
| --- | --- |
| `prisma/schema.prisma` | `CollectorFleet` + `PolicyRule` models and enums |
| `prisma/seed.ts` | Deterministic dev fleet + 3 sample rules (created only if the fleet doesn't exist) |
| `src/lib/prisma.ts` | Prisma Client singleton (hot-reload safe, pg driver adapter) |
| `src/app/api/v1/policies/[fleetId]/route.ts` | Bearer-authenticated policy endpoint |
| `src/lib/fleet-keys.ts`, `src/lib/fleets.ts` | Fleet keys (stored as SHA-256), creating fleets, rotation with a grace period |
| `src/lib/auth.ts`, `src/proxy.ts` | Operator sessions; every page and Server Action calls `requireOperator()` |
| `src/lib/audit.ts` | Audit trail writer (`AuditEvent`), rendered at `/audit` |
| `scripts/operator.ts` | `npm run operator -- create\|reset-password <email>` for account recovery |
| `src/**/*.test.ts`, `test/` | Vitest tests and their database harness (see [Tests](#tests)) |

## Local development

```bash
# 1. PostgreSQL (from the repo root; data persists in the chopper-pgdata volume)
docker compose -f deploy/docker/docker-compose.yaml up -d postgres

# 2. Migrate + seed (from control-plane/)
npm install
npx prisma migrate dev
npx prisma db seed

# 3. API server on :3000
npm run dev
```

Sign in at http://localhost:3000. The first operator is created from
`CHOPPER_ADMIN_EMAIL` and `CHOPPER_ADMIN_PASSWORD` (12+ characters) the first
time someone signs in with them, so put both in `control-plane/.env` next to
`DATABASE_URL`. See
[Sign in, manage operators and review the audit log](../docs/deploy/sign-in-and-operators.md).

The seed provisions fleet `f1ee7000-0000-4000-8000-000000000001` with API key
`chopper_dev_sk_2f7d1b9c4e8a4f60b3d5a9c1e6f80712` (**local dev only**: create
your own fleets and rotate keys on the **Fleets** page, see
[Create fleets and rotate fleet keys](../docs/deploy/manage-fleets.md)).
Smoke-test:

```bash
curl -s http://localhost:3000/api/v1/policies/f1ee7000-0000-4000-8000-000000000001 \
  -H "Authorization: Bearer chopper_dev_sk_2f7d1b9c4e8a4f60b3d5a9c1e6f80712" | jq
```

Wrong or missing key → generic `401` (fleet IDs are not enumerable); malformed
fleet ID → `400`. Key comparison is constant-time.

## Tests

```bash
npx prisma generate   # once, and after schema changes
npm test
```

Tests call route handlers and `src/lib` directly against a real PostgreSQL
database; nothing starts a Next.js server. `test/global-setup.ts` creates the
database if it's missing and runs `prisma migrate deploy`, so the tests see
the schema a deployment gets, and every table is emptied before each test.

The database is `TEST_DATABASE_URL`, by default
`postgresql://chopper:chopper@localhost:5432/chopper_test` (the compose
Postgres from step 1 above). Its name must end in `_test`: the tests refuse
anything else rather than wipe a real database. CI runs the same suite
against a `postgres:16-alpine` service container.

Put a test next to the code it covers (`foo.ts` → `foo.test.ts`). Helpers:
`@test/db` (`createFleet`, `createRule`), `@test/request` (`fleetRequest`,
`fleetParams` for calling an App Router handler). Code that reads
`next/headers` needs it mocked; `src/lib/auth.test.ts` shows a cookie jar.

## End-to-end with the data plane

With postgres + the dev server up, build and run the collector (repo root):

```bash
make build && make run
```

`data-plane/config/otelcol-dev.yaml` points `chopper_filter` at this API with a
10s sync interval. Send test spans:

```bash
go install github.com/open-telemetry/opentelemetry-collector-contrib/cmd/telemetrygen@v0.156.0
telemetrygen traces --otlp-insecure --otlp-endpoint localhost:4317 \
  --traces 2 --telemetry-attributes 'http.status_code="404"'   # dropped
telemetrygen traces --otlp-insecure --otlp-endpoint localhost:4318 --otlp-http \
  --traces 2 --telemetry-attributes 'http.status_code="200"'   # passes
```

Rule edits (dashboard, SQL or Prisma Studio) propagate to running
collectors within one sync interval — no restart.

## Roadmap

- ETag/`If-None-Match` on the policy endpoint so unchanged polls are cheap 304s.
- Dashboard: ingestion cost trends, drop rates, fleet health.
- CRUD API + UI for fleets and rules (Phase 3).

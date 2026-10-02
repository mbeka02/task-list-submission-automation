# Task-list submission automation

A TypeScript worker for compiling daily Lark task-list submitters using Nairobi time. The planned workflow includes a 09:30 reminder and a report after the inclusive 10:00 cutoff, Monday–Friday excluding Kenyan public holidays.

Phase 0, Slice 1 and the local Slice 2 path are implemented: offline preflight, deterministic submission evaluation, durable report/evidence storage and delivery through a supplied controlled transport. The production Lark history/sending adapters, full retry/reconciliation workflow and scheduling are still pending.

## Setup

Use nvm with the pinned Node version and pnpm 12.6.0:

```bash
nvm install
nvm use
pnpm install --frozen-lockfile
cp .env.example .env
pnpm preflight
```

The project pins Node 24.21.0. `better-sqlite3` may need Python, make and a C/C++ compiler to build its native binding. Dependency build scripts are enabled only for `better-sqlite3` and `esbuild`.

## Implemented capabilities

`pnpm preflight` loads `.env` when present and defaults to preview mode with outbound delivery disabled. It checks a real in-memory SQLite/Drizzle query and constructs a Lark-domain SDK client using dummy credentials. It makes no network requests or persistent business database. Every mode currently rejects outbound delivery.

`evaluateSubmissions({ businessDate, policy, messages })` in `src/evaluate-submissions.ts` evaluates current canonical observations. It recognizes supported text/rich-text task lists, applies the Nairobi date/cutoff and supplied holiday calendar, resolves platform names, deduplicates scoped sender identities and explains exclusion/review decisions. Unconfirmed task replies require review. A `ready` result establishes detector readiness; complete retrieval and approved publication policy remain separate requirements.

`openReportLedger(options)` in `src/report-ledger.ts` opens a dedicated SQLite file and applies the packaged migrations. It exposes `prepareDailyReport({ businessDate, scan, policy })`, `getDelivery(deliveryId)`, `deliverDelivery({ deliveryId, now })` and `close()`. Configuration binds one app/source/destination; no transport is supplied by default and no production adapter is connected.

Preparation requires a complete appropriately bounded scan and explicit reply policy. It preserves candidate observations and freezes distinct names, exact text, source evidence, policy version and a stable UUID in one transaction. Repeated preparation keeps the frozen report. Incomplete/ambiguous/conflicting evidence blocks freezing; a genuinely successful empty scan produces explicit zero-submission text. Ordinary unrelated posts are not retained as new business records.

Delivery atomically claims a pending report, commits the claim, sends its persisted text/UUID outside the transaction and records the acknowledgement. Other claimants and acknowledged reports do not send. Ambiguous responses become uncertain with no automatic resend; expired in-flight claims remain blocked for the later recovery workflow. The current claim lease is 60 seconds. These local behaviors do not establish Lark's delivery eligibility, deduplication guarantees or production readiness.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
node dist/preflight.js
```

To target a submission behavior:

```bash
pnpm exec vitest run tests/unit/evaluate-submissions.test.ts -t 'test name'
```

`pnpm test:contract` runs the preflight CLI contract tests. `pnpm test:integration` runs the file-backed SQLite report tests, including independent-process races. Automated tests use synthetic inputs and controlled transports without live Lark credentials or messages.

## Database and delivery

The stack uses the official Lark SDK, Drizzle ORM/Kit and local SQLite through `better-sqlite3`. Versioned SQL and Drizzle snapshots under `drizzle/` are tracked. The four business tables cover messages, observations, deliveries and report entries; Drizzle also keeps its migration journal. Connections enable foreign keys, WAL, full synchronous durability and a five-second busy timeout. Preparation uses an immediate write transaction. SQLite files belong on dedicated local storage rather than a shared network volume.

The integration suite verifies new-database creation, reopening and an upgrade from the earlier migration while preserving its text/UUID. Older records lacking audit fields remain readable but cannot send automatically. Production credentials, group access, holiday data, retention, backups and hosting still require validation before activation. No retention or pruning policy is activated in this slice.

Generate changes with `pnpm db:generate`, review and commit the generated SQL/snapshot, then apply reviewed migrations to isolated local storage. For the manual migration command, create the database directory first and set `SQLITE_FILE_PATH` for the intended file. The ledger constructor also applies the packaged migrations on opening. Review and migration rollout must precede any authorized production launch; do not use schema push against production.

## Git workflow

The initial Phase 0 / Slice 1 baseline is on `main`. Each subsequent phase or slice starts on its own branch from current `main`, for example `codex/slice-2-frozen-report`. Use coherent commits with purpose-focused messages, push the phase/slice branch for review, and merge to `main` after approval.

Local implementation plans, design specs, docs, research and agent state are intentionally ignored. Dependencies, build output, database files, backups and secrets are also ignored. Track the sanitized `.env.example`; keep actual credentials and chat IDs in local environment configuration.

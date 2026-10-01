# Task-list submission automation

A TypeScript worker for compiling daily Lark task-list submitters using Nairobi time. The planned workflow includes a 09:30 reminder and a report after the inclusive 10:00 cutoff, Monday–Friday excluding Kenyan public holidays.

Phase 0 and Slice 1 are implemented: offline preflight and deterministic submission evaluation. Lark history reading, report persistence, sending and scheduling are still pending.

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

`pnpm test:contract` runs the preflight CLI contract tests. Automated tests use synthetic inputs without live Lark credentials or messages. `pnpm test:integration` is reserved for the next SQLite report slice and currently has no test files.

## Database and delivery

The stack uses the official Lark SDK, Drizzle ORM/Kit and local SQLite through `better-sqlite3`. Migration commands are configured, but the business schema/migrations arrive in the next slice; do not run them yet. Production credentials, group access, holiday data, hosting and operational policies still require validation before activation.

## Git workflow

The initial Phase 0 / Slice 1 baseline is on `main`. Each subsequent phase or slice starts on its own branch from current `main`, for example `codex/slice-2-frozen-report`. Use coherent commits with purpose-focused messages, push the phase/slice branch for review, and merge to `main` after approval.

Local implementation plans, design specs, docs, research and agent state are intentionally ignored. Dependencies, build output, database files, backups and secrets are also ignored. Track the sanitized `.env.example`; keep actual credentials and chat IDs in local environment configuration.

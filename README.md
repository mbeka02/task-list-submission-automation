# Task-list submission automation

A TypeScript worker for compiling daily Lark task-list submitters using Nairobi time. The planned workflow includes a 09:30 reminder and a report after the inclusive 10:00 cutoff, Monday–Friday excluding Kenyan public holidays.

Phase 0 and Slices 1–5 are implemented locally: offline preflight, submission evaluation, durable report/evidence storage, the real Lark SDK history reader with saved user OAuth renewal, scoped app-bot delivery, safe retries, operator reconciliation and reminder/report due checks. One explicitly approved private-group test confirmed live app-bot sending through the existing CLI. Worker commands keep sending disabled; worker SDK credentials, production destination access and deployment acceptance remain activation gates.

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

`createSubmissionHistoryReader(options)` in `src/submission-history.ts` exposes `readSubmissionHistory({ businessDate, sourceChatId, replyPolicy })`. The selected route uses user OAuth under one approved app and source group. V1 counts main conversation posts only (`replyPolicy: "exclude"`); including thread replies returns an unsupported-policy outcome. Reads start at/after the inclusive 10:00 cutoff, retrieve all pages for Nairobi midnight–10:00, and preserve current text/post content, sender identity/names, raw millisecond timestamps, recalls, forwarding markers and per-page observation times. Overlapping pages select the latest version without masking conflicts. A complete read feeds `prepareDailyReport`; partial, malformed, denied, rate-limited or unavailable reads cannot freeze an empty report.

Reader options require `appId`, `appSecret`, `sourceChatId` and either a trusted external `getUserAccessToken()` supplier or `credentialFile` plus the approved account's app-scoped `readerOpenId`. The supplier returns `{ appId, accessToken, expiresAtMs }` and is checked on every page. `maxPages` defaults to 100 and accepts 1–100; reaching it with remaining pages blocks completion. The default HTTP transport has a 15-second timeout, no redirects and a 10 MiB response limit. `credentialTimeoutMs` defaults to 15 seconds and can be lowered. There is no automatic retry loop or background polling in this module; an injected transport must also enforce its own HTTP timeout.

File-based renewal uses the pinned SDK OAuth endpoint, saves refresh intent before networking, and atomically saves replacement tokens before history reads. An exclusive file lock prevents competing renewals. Expired refresh grants, revocation and uncertain/interrupted renewals require operator action; no old refresh key is replayed automatically after uncertainty. A crash can leave a lock and `refreshing` state: stop the worker and reauthorize through the future reviewed recovery procedure rather than deleting state and retrying blindly. Credentials require a worker-owned private directory (0700) and regular file (0600), stored on local persistent storage; symlinks and access by other users are rejected. This file contains secrets and must stay under ignored `data/` or outside the repository.

The initial file format is JSON: `version: 1`, `state: "ready"`, `appId`, `readerOpenId`, `accessToken`, `expiresAtMs`, `refreshToken`, and `refreshExpiresAtMs`. Both expiries are absolute epoch milliseconds derived from the actual authorization response. Provision a separate OAuth grant for the worker under the currently approved app/account; sharing and rotating the CLI session's refresh token could interfere with the CLI. Initial login and recovery commands are not implemented yet. A bounded read-only CLI check confirmed external-group access and response shape; fixture tests prove local SDK behavior, not live worker renewal or least-privilege permissions.

`openReportLedger(options)` in `src/report-ledger.ts` opens a dedicated SQLite file and applies the packaged migrations. It exposes report/reminder preparation, scoped delivery inspection/date-range discovery, `deliverDelivery({ deliveryId, now, deliveryDeadlineMs? })`, reviewed reconciliation and `close()`. Configuration binds one app/source/destination; no transport is supplied by default and no production adapter is connected.

Preparation requires a complete appropriately bounded scan and explicit reply policy. It preserves candidate observations and freezes distinct names, exact text, source evidence, policy version and a stable UUID in one transaction. Repeated preparation keeps the frozen report. Incomplete/ambiguous/conflicting evidence blocks freezing; a genuinely successful empty scan produces explicit zero-submission text. Ordinary unrelated posts are not retained as new business records.

Delivery atomically claims an eligible report, commits the claim, sends its persisted text/UUID outside the transaction and records the acknowledgement. Other claimants and acknowledged reports do not send. A definitive temporary rejection becomes `retryable`; permission/bot/credential rejection becomes `failed`; lost responses or acknowledgement writes remain `uncertain`. Expired claims recover as uncertain rather than resetting to pending. Claim tokens and attempt numbers fence competing workers and stale operator decisions.

Retry eligibility is saved in SQLite. Definitive rejections use backoff from response completion, starting at 30 seconds and increasing to a 15-minute cap; a longer supplied retry delay is respected. Each `deliverDelivery` call makes at most one attempt. The worker supplies later due checks; retries preserve the original text, UUID and earliest attempt time.

`createLarkDeliveryTransport(options)` in `src/lark-delivery.ts` supplies the real SDK app-bot adapter: fixed `appId`/`appSecret`, `allowedDestinationChatIds`, Lark domain and tenant credentials. It obtains a tenant token explicitly and sends text with `receive_id_type=chat_id`; it never falls back to a user or another destination. Known rejection codes are sanitized into outcomes; malformed responses, in-progress responses, timeouts and ambiguous server failures remain uncertain. Its default HTTP timeout is 15 seconds per request with redirects disabled; an injected HTTP instance must enforce its own timeout. SDK logs are suppressed to keep credentials and request bodies out of diagnostics.

Only attempts recorded as the app API may automatically replay an uncertain request, and only before 55 minutes from the earliest saved attempt. This reserves five minutes inside [Lark's documented one-hour UUID window](https://open.larksuite.com/document/server-docs/im-v1/message/create). Both the UUID deadline and the 60-second claim lease are checked again after obtaining credentials; the latest message POST start leaves 15 seconds inside the lease. An unverified adapter cannot inherit this guarantee by later switching to the app API. Rejected replays cannot erase earlier uncertainty. Outside the window, or after a deadline/permanent replay problem, operator review is required. These bounds reduce duplicate risk; they do not promise exactly-once delivery.

Worker commands and preflight reject `ENABLE_OUTBOUND=true`. The approved private smoke test establishes CLI app-bot eligibility and durable acknowledgement; worker SDK credentials, external reminder eligibility and management access remain unproven.

## Reminder and scheduled recovery

`createDueWorker(options)` in `src/due-worker.ts` exposes `runDueWork({ now })`, read-only `getStatus({ now })` and `close()`. It uses the real history reader and two ledger scopes in one SQLite file: reminders target the source group, reports target management. The existing four business tables and migrations support both kinds; no new migration is needed.

On Monday–Friday excluding supplied Kenyan public holidays, the reminder window is **09:30 inclusive to 10:00 exclusive** in Nairobi. Its approved text is “Please post today's task list in this group by 10:00 AM Nairobi time.” A reminder needs no history read and freezes its own text/UUID without report entries. At **10:00**, the report reads that day's history, freezes it and attempts delivery independently. A normal single-worker run completes one compilation read per eligible date; incomplete or blocked reads can be retried. Saved reports bypass history on delivery retries. Separate processes can read the same unfrozen date, while SQLite uniqueness and claims protect the frozen delivery.

Startup and later checks recover today's unfinished work. Older unfinished reports appear under `backfill`, with delivery IDs and states where a frozen record exists; calendar revisions cannot hide those records. Old uncertain/failed reminders remain under `reminderReviews`. Neither is automatically replayed. Lists show at most 31 items with total/truncation metadata. Reminder retries stop at 10:00, and automatic report publication stops at the next Nairobi midnight. The app adapter rechecks these deadlines after credentials. A read crossing midnight can retain a frozen report for reviewed backfill. Uncertainty still follows S4's UUID/claim rules.

Configure the fields in `.env.example`, create the database's parent directory, and supply a reviewed calendar before running:

```bash
pnpm worker status
pnpm worker run --once
pnpm worker run
```

`status` requires an existing migrated ledger and opens it read-only; it needs no SDK credentials and contacts no Lark endpoint. `run` additionally requires the app secret, approved reader open ID and separate worker OAuth-file path. It may read Lark after cutoff and freeze local preview work, but installs no outbound transport. Use an isolated preview database. `run --once` performs one check; continuous `run` checks at startup, then waits `WORKER_CHECK_INTERVAL_MS` after each completed check (default 60000; accepted range 1000–3600000). Checks never overlap. It prints changed state, keeps unchanged checks quiet, and waits for an active check before closing on SIGINT/SIGTERM.

Calendar JSON uses `version`, `fromDate`, `throughDate`, `reviewedOn`, `sourceUrls` (HTTPS references) and `publicHolidays` (real `YYYY-MM-DD` dates). Coverage must include activation through today; future review dates, malformed dates and missing provenance block work. Metadata validation cannot prove official annual completeness. Keep the actual maintained dataset under ignored `data/`; no approved annual Kenyan calendar is bundled. Refresh the reviewed configuration and restart when coverage changes.

`WORKER_RESTORE_MODE=true` pauses reads, freezing and outbound attempts while keeping review status visible. Leave it enabled after restoring a backup until recent sends have been reviewed. The reviewed restore-release procedure belongs to Phase 6; this flag cannot detect a restored file automatically. Recent read/preparation failure reasons are visible in the running worker and its JSON output; a separate status process reconstructs durable delivery state rather than that transient read diagnostic.

## Delivery status and reconciliation

Configure `SQLITE_FILE_PATH`, `LARK_APP_ID`, `SOURCE_CHAT_ID` and `MANAGEMENT_CHAT_ID` for the intended existing ledger. These commands construct no network transport:

```bash
pnpm delivery status --id <delivery-id>
pnpm delivery reconcile --id <delivery-id> --decision sent --expected-attempt <number> --operator "Anthony" --reason "Verified exact destination message, sender and report" --message-id <om_message_id>
pnpm delivery reconcile --id <delivery-id> --decision not-sent --expected-attempt <number> --operator "Anthony" --reason "Evidence establishing that the original request did not send"
```

The same commands resolve report IDs only in the configured management scope and reminder IDs only in the configured source scope. Status opens the migrated file read-only and reports attempts, retry/lease times, adapter kind, message ID, failure reason, replay deadline and review history. Wrong scope or missing storage blocks the command. Reconciliation records a decision atomically. It accepts uncertain, failed or expired in-flight deliveries with the current attempt number; active claims, completed deliveries, stale attempts and invalid arguments are blocked.

A `sent` decision requires the actual Lark message ID and leaves the report completed. A `not-sent` decision needs evidence establishing non-delivery, not just an incomplete search or a similar-looking message. It records the operator/reason and permits a later attempt with the original payload/UUID; the command itself sends nothing. If evidence is unresolved, leave the delivery uncertain. Review never resets the earliest attempt time or creates a new UUID to extend replay safety. A correction would need an explicitly labelled new report revision; correction creation is outside this slice.

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

`pnpm test:contract` runs the preflight/operator CLI and Lark SDK history/OAuth/delivery contract tests. SDK tests exercise a local HTTP server and real temporary credential files; report preparation also uses real SQLite. `pnpm test:integration` runs the file-backed SQLite report tests, including independent-process freeze, delivery, crash and retry races. Automated tests use synthetic inputs without live Lark credentials or messages.

## Database and delivery

The stack uses the official Lark SDK, Drizzle ORM/Kit and local SQLite through `better-sqlite3`. Versioned SQL and Drizzle snapshots under `drizzle/` are tracked. The four business tables cover messages, observations, deliveries and report entries; Drizzle also keeps its migration journal. Connections enable foreign keys, WAL, full synchronous durability and a five-second busy timeout. Preparation uses an immediate write transaction. SQLite files belong on dedicated local storage rather than a shared network volume.

The integration suite verifies new-database creation, reopening and an upgrade from the earlier migration while preserving its text/UUID. The three additive Slice 4 migrations retain retry times, adapter kind and reviewed reconciliation evidence inside `daily_delivery`. Older records lacking audit fields remain readable but cannot send automatically. Production credentials, group access, holiday data, retention, backups and hosting still require validation before activation. No retention or pruning policy is activated in this slice.

Generate changes with `pnpm db:generate`, review and commit the generated SQL/snapshot, then apply reviewed migrations to isolated local storage. For the manual migration command, create the database directory first and set `SQLITE_FILE_PATH` for the intended file. The ledger constructor also applies the packaged migrations on opening. Review and migration rollout must precede any authorized production launch; do not use schema push against production.

## Git workflow

The initial Phase 0 / Slice 1 baseline is on `main`. Each subsequent phase or slice starts on its own branch from current `main`, for example `codex/slice-2-frozen-report`. Use coherent commits with purpose-focused messages, push the phase/slice branch for review, and merge to `main` after approval.

Local implementation plans, design specs, docs, research and agent state are intentionally ignored. Dependencies, build output, database files, backups and secrets are also ignored. Track the sanitized `.env.example`; keep actual credentials and chat IDs in local environment configuration.

# Local release and operator guide

The server currently runs a paused preview. The new production profile supports names reports and editable brief links to a private operator/admin group via a signed webhook, plus a separate source-group reminder webhook. App-bot delivery remains supported where tenant availability permits it. Local tests authorize no live send or sharing changes.

## Build and exercise the local image

Use the pinned Node/pnpm versions, then:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm release:build
pnpm test:release
```

Docker daemon access is required for the last two commands. Acceptance uses synthetic
records, temporary storage and containers with `--network=none`; it needs no real
Lark credential or group. The Dockerfile pins the official Node base by version and
manifest digest, builds native SQLite on that base, and copies compiled code,
production dependencies and migrations into a non-root runtime. `.dockerignore`
allows only build inputs; it excludes credentials, databases, research and drafts.

The image defaults to `node dist/worker-command.js run`. In containers, invoke built
commands with Node; pnpm/tsx and the TypeScript sources are not runtime dependencies.
Keep the tested image ID with the release record. Rebuilding an image after a source
change requires rerunning container acceptance.

For the optional rollback check, build a predecessor image from an isolated Git
archive of its exact commit using this Dockerfile and `.dockerignore` (never copy
local credentials/data into that build context), then run:

```bash
RELEASE_PREVIOUS_IMAGE=<local-previous-image-tag> pnpm test:release
```

The final optional-brief drill uses the merged AI-6 runtime as predecessor
(main `8f3907c`). Earlier core acceptance used merged Slice 5
`d8000cf74ae0deec644c8f2282cfb0f066f8a597`. The rollback check preserves
pending/sent records through both built versions. Without
`RELEASE_PREVIOUS_IMAGE`, that optional case is skipped. Use the actual deployed predecessor for a future release drill.

### What the brief release drill proves

The two added container cases select Gemini or DeepSeek through the same factory
configuration. Each uses actual packaged worker, SQLite, Lark SDK and provider
adapters against synthetic loopback HTTP; `--network=none` prevents remote access.
The test driver is mounted separately and excluded from the release image.

Both cases verify the same on-time/late membership, names-report cutoff, native
Doc text/late-label/footer readback and independent report/reminder/link records.
Container replacement preserves IDs, UUIDs, acknowledgements and the saved Doc
reference without another history read, generation, Doc write or send. Built
status inspects the published reference with outbound disabled. Online backup and
isolated restore preserve these records; restore remains paused with no HTTP.
Generated-body canaries are absent from the ledger and snapshot, while original
source evidence remains. These are controlled-fixture checks, not live quality,
permissions or appearance evidence.

Run the complete final drill with local image tags, for example:

```bash
RUN_DOCKER_ACCEPTANCE=true RELEASE_TEST_IMAGE=task-list-local:ai-7 RELEASE_PREVIOUS_IMAGE=task-list-local:ai-6 pnpm exec vitest run tests/acceptance/container.test.ts
```

Run regression and container suites sequentially on a busy workstation: both use
real subprocesses, and competing load can exhaust startup-test deadlines.

## Configure an isolated preview

Copy `.env.example` to an ignored `.env` with permissions 0600. Keep
`APP_MODE=preview`, `ENABLE_OUTBOUND=false` and use isolated storage. The reports-group ID stays in private configuration. Verify the webhook destination and view-only Doc access before activation. Fixture
calendar dates and synthetic grants from tests are not production configuration.

For the Compose package, an authorized local operator must prepare:

- A private `.env` (or `WORKER_ENV_FILE`) supplying the approved app/source scope,
  activation date, policy and eventually the app secret/reader identity.
- The reviewed calendar at `/data/kenyan-holidays.json` in the project's dedicated
  ledger volume. No real annual Kenyan calendar is bundled.
- A separate worker OAuth grant at `/credentials/user-oauth.json`. Its directory
  must be 0700, its file 0600, both owned by the container's UID/GID 1000. Renewal
  needs a writable private directory. Never copy the interactive CLI refresh token.
- An existing backup directory (`WORKER_BACKUP_DIRECTORY`, default `./backups`),
  private and writable by UID/GID 1000. Compose refuses to auto-create that bind path.

Compose creates dedicated ledger and credential volumes, runs one non-root worker,
uses a read-only root filesystem and init process, drops capabilities, bounds logs,
and publishes no ports. The supplied package has networking disabled. Enabling
authorized live preview reads later requires a reviewed network change and a host
egress policy; Compose's offline setting is not a production domain allowlist.
`.env` remains outside the image; Docker administrators can inspect runtime secrets.

Validate configuration without printing resolved secret values:

```bash
docker compose config --quiet
```

Do not start the server deployment as part of this local phase. Once the above
configuration is ready, an isolated local preview can use:

```bash
docker compose up --build -d worker
docker compose logs --tail 50 worker
docker compose exec worker node dist/worker-command.js status
docker compose stop worker
```

Do not use `docker compose down --volumes`: it destroys the durable ledger and grant.
Replacing/stopping a container must retain the same volumes. Test offline mode can
exercise already frozen work, but a due report needing Lark remains blocked offline.

## Optional 10:15 brief capture

Keep `ENABLE_DAILY_BRIEF=false` until a reviewed preview capture is wanted. To
capture only, set `ENABLE_DAILY_BRIEF=true`, `BRIEF_MODE=capture_only`, an explicit
`BRIEF_ACTIVATION_DATE` on/after core activation within the calendar's coverage,
`BRIEF_PROVIDER`, its `GEMINI_MODEL` or `DEEPSEEK_MODEL`, and all three
`BRIEF_TEMPLATE_VERSION`, `BRIEF_PROMPT_VERSION`, `BRIEF_SCHEMA_VERSION` values.
Use the existing `pnpm worker run --once`, `run` and `status` commands. No model
key is needed for capture or inspection. A run still needs the approved source
user-OAuth grant. Preview rejects publishing and outbound sending. Production permits them only with explicit activation and complete reviewed settings.

At/after 10:15 on a Nairobi working day, one additional bounded history read
captures sends before 10:15, labelling sends from 10:01 as late. Failed or
ambiguous reads stay blocked; they are not empty days. Core and brief reads fail
independently. A frozen brief is reused on restart; retries do not expand the
capture. Capture-only does not call a model, create/share a Doc or send a message.

`status` exposes `brief` state, ID, entry count, generation/publication errors,
attempts/leases, Doc URL and announcement state when present, without source or
generated text. It reads existing storage only, needs no credentials, and performs
no migrations. `briefBackfill` lists at most 31 older missing/unfinished jobs with
metadata and total/truncation indicators. Completed capture-only jobs are not
listed as unfinished. Older work always needs review; discovery never backfills.

Production CLI and library publish modes are available, with the approved
provider, prompt/template, private staging folder and delivery transport. It
recovers today's unfinished work using frozen input; announcement retries reuse
the saved link and UUID. Review-required jobs are not automatically repaired.
Changed frozen generation or publishing configuration blocks progress visibly.
A scheduled invocation passes the next Nairobi midnight as its exclusive deadline;
model requests are bounded by remaining time and Doc mutations reserve 15 seconds.
Expired work is surfaced the next day instead of automatically publishing late.
Restore pauses capture, generation, Doc changes and announcements.

Before activation, establish a Doc-enabled worker user grant, approved data processing,
a private staging folder accessible to that user, and a synthetic live access test.
Set `LARK_DOC_AUTH_STRATEGY=user_oauth`: the configured reader owns/edits the Doc,
and the reports group receives view-only access. Verify closed link sharing,
owner-only collaborator management and the sole expected owner before writing;
verify that same owner and exact group view permission before announcing the link.
Never broaden link sharing to work around an access failure. Existing app-owned
integrations remain explicit through `app` auth.

User-owned publishing requires the five Doc permissions listed in
[worker consent setup](#provision-the-workers-own-oauth-login). Enabling scopes
in the developer console does not add them to an existing grant: obtain reviewed
fresh consent while the worker is paused. The previous app-owned staging folder
is not automatically suitable for the user identity. No publishing configuration
or live permission is implied by enabling capture.

## Capture and diagnose operational logs

The first questions are: did today's work finish, where was it slow, why did it
fall back or stop, and does an operator need to review it? Telemetry on stderr
answers those questions; stdout retains the operator-command result contract.
`LOG_LEVEL=info` includes state changes and a ten-minute liveness heartbeat.
Use `debug` temporarily for every check and attempt start; restore `info` afterward.

For a locally authorized preview run, separate the streams:

```bash
mkdir -p data
chmod 700 data
(umask 077; LOG_LEVEL=debug pnpm worker run --once >data/worker-result.json 2>data/worker-events.ndjson)
```

pnpm may add its own script banner to stderr. Collect records with
`service=task-list` and a stable `event`; the built container runs Node directly
and produces the application stream without that banner. The Docker `json-file`
envelope preserves `stream=stderr`; configure a future collector to parse its
`log` field as JSON and exclude stdout command results. Rotation is already
10 MB × three files. Rotation is not off-server capture or a backup.

Find a `worker_check_completed`, `delivery_completed` or `brief_completed` for the
Nairobi business date, then filter all records by its `runId`. `entryPoint`
distinguishes startup, periodic, one-shot and direct API work. Use opaque
`deliveryId`/`briefId` to connect retries across different run IDs and inspect
durable state with the existing status commands. Missing logs do not prove a
delivery failed or authorize replay; SQLite and the acknowledged Lark record
remain authoritative.

| Symptom | First check | Next action |
| --- | --- | --- |
| Report blocked | `history_read_completed` reason/code and `report_preparation_blocked` reasons | Check reader authorization, calendar or ambiguous candidates; consult the operator/admin for source/name review |
| AI fallback | `model_attempt_completed` reason/classification, attempt and retry delay | Check quota/access/model configuration; preserve frozen input and the bounded retry policy |
| Publication needs review | `document_step_failed` stage and `brief_completed` reason | Verify bot scopes and private Doc/access state; do not create a replacement or overwrite edits |
| Delivery uncertain/failed | `delivery_completed` reason, attempt and opaque delivery ID | Follow the reviewed delivery procedure below; compare with Lark evidence before reconciliation |
| Worker appears idle | Latest ten-minute heartbeat plus container process/restart state | Check local configuration/storage; escalate server access to the server administrator |
| Slow work | Operation `durationMs` under the same run ID | Separate history, model, Doc stage and delivery time; retries/backoff also contribute to total check time |

Do not add raw provider exceptions, source messages, generated text or identifiers
to logs while diagnosing. Unknown reasons intentionally become `unclassified`.
Nullable usage means unavailable, not zero. Synchronous sink failures are best-effort
and must not undo business work. Restrict log access and set retention with the
chosen collector. External calls are correlated within this process; no outbound
trace propagation/exporter is installed. Metrics histograms and alert thresholds
await a selected backend and an agreed delivery grace period; no active alerts
are implied by this logging change.

## Inspect and recover ordinary work

```bash
pnpm worker status
pnpm worker run --once
pnpm delivery status --id <delivery-id>
```

`status` reads an existing migrated ledger and contacts no Lark endpoint. Preview
`run` can freeze local work and, with later approved network/credentials, read Lark;
it never sends. Startup checks recover today. Reports begin compilation at 10:01
Nairobi and include original sends through 10:00:59.999; posts at 10:01:00.000 or
later are late. Reminders stop at 10:00, and report retries stop at the next
midnight. Older unfinished reports appear in `backfill`
with IDs/states; closed-window uncertain reminders appear in `reminderReviews`.
Neither list authorizes replay. A running worker prints changed state and its latest
read/preparation failure; a separate status command cannot recover transient read
diagnostics from a past process. Missing/invalid calendar, credentials or storage
must not be treated as a valid zero-submission day.

On ambiguous content/name, confirm the source message and sender with the operator/admin.
Fix the source or approved alias/policy through a reviewed change, then rerun an
unfrozen date. Names are display data; different scoped IDs are distinct people.
The full-minute cutoff uses policy `task-list-v2`; select that version in existing
configuration when adopting this rule. Earlier frozen reports retain their saved
cutoff, policy and payload. Do not edit frozen report text, evidence, IDs or UUIDs
by hand. Corrections and dated
backfill publication are deferred to separately agreed interfaces.

For an uncertain send, inspect the exact destination, app sender, business date and
frozen content. A failed search does not establish non-delivery. Record a reviewed
decision using the current attempt number:

```bash
pnpm delivery reconcile --id <delivery-id> --decision sent --expected-attempt <number> --operator "<reviewer>" --reason "<verified evidence>" --message-id <actual-message-id>
pnpm delivery reconcile --id <delivery-id> --decision not-sent --expected-attempt <number> --operator "<reviewer>" --reason "<evidence proving non-delivery>"
```

These commands never send. Unresolved cases stay uncertain; no fresh UUID is created
to evade the replay limit. Restored storage has an additional mandatory review pause.

## Back up and rehearse restore

Create the destination directory first with private permissions. Use a new filename:

```bash
pnpm storage backup --output ./backups/task-list-2026-10-02.sqlite
pnpm storage restore --backup ./backups/task-list-2026-10-02.sqlite --output ./data/restore-drill.sqlite
```

Backup uses SQLite's online backup API, including committed WAL state. It checks
integrity, foreign keys and the exact packaged migration history, then publishes a
complete private snapshot without overwriting any existing destination, including
existing WAL/journal/shared-memory files or restore metadata. The command never
migrates; use the matching release for an older schema. A raw copy of
an active `.sqlite` file is not a replacement for this command.

Restore uses the same checks and refuses existing storage. Before publishing the
restored database it durably creates `<database>-restore-review.json`. Keep that
marker beside the database on the same volume. Worker checks and direct delivery
calls remain paused even if `WORKER_RESTORE_MODE=false`. Local reconciliation and
inspection remain available. A manually copied/replaced database cannot be detected
automatically: set restore mode before any manual recovery and preserve the marker.

Point an isolated configuration at the restored path and inspect worker/delivery
status. Compare frozen text, scoped sender evidence, UUIDs, attempts, states and
actual acknowledgements with the original through the public ledger interface;
the automated drill demonstrates this with synthetic records. Check reports sent
after the snapshot separately: an older backup may wrongly show them pending/missing.
Do not clear the marker or launch the restored file against live groups. A reviewed
release procedure is required before future activation; no unpause command is part
of this local scope.

In Compose, run the built storage command on the same volume, for example:

```bash
docker compose run --rm --no-deps worker node dist/storage-command.js backup --output /backups/task-list-2026-10-02.sqlite
```

Ledger backup does not include the calendar, `.env` or rotating OAuth grant. Preserve
reviewed configuration separately and reauthorize the worker if the grant is lost;
do not restore/replay a stale refresh token. Assign a backup owner, off-server copy,
encryption/access policy, frequency and retention before launch. A local backup
directory or persistent volume alone does not satisfy that gate.

## Stop, replace and roll back

SIGTERM/SIGINT stops new checks; an active bounded check finishes before SQLite
closes. Compose allows 45 seconds before forced termination. Forced termination
during a send can leave `sending`: later expiry is uncertain, not proof of failure.

Stop the worker before changing reviewed calendar/scope or replacing its image.
Take a consistent backup, retain configuration/volumes, and record the old image ID.
AI-2 adds the `daily_brief` and `brief_entry` tables without changing existing
names/reminder tables. Back up with the **previous release before upgrading**;
opening a writable ledger applies the packaged migrations. Rehearse the upgrade
on isolated storage first. Backup/restore commands require their release's exact
migration history, so use the upgraded release for snapshots taken after upgrade.
The local predecessor rollback check preserves pending/sent delivery records,
UUIDs and acknowledgements. Releases predating the brief extension cannot
operate that module; verify the selected predecessor rather than assuming
backward compatibility. Keep the upgraded schema intact when rolling back application code; verify
compatibility or restore to isolated paused storage before changing versions. Never truncate the ledger to
make an old version start.

If OAuth renewal reports revoked/expired/uncertain, stop and reauthorize the separate
worker grant under the same approved app/account. Do not delete a stale lock and
replay an uncertain refresh request. Use the [worker login commands](#provision-the-workers-own-oauth-login) for reviewed reauthorization; live renewal remains an acceptance gate. Never paste tokens into report content or ordinary diagnostics.

## Provision the worker's own OAuth login

Keep the deployed worker paused. This operator command requests a fresh user grant under the configured app; it does not import, rotate or read the interactive CLI's credentials. Provider-side independence of simultaneous grants still needs live verification.

1. Set `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_READER_OPEN_ID`, `LARK_USER_CREDENTIAL_FILE` and `LARK_OAUTH_SCOPES`. Obtain the app secret through the scoped Doppler config; never paste it into an argument or log. Use a dedicated credential directory, owned by the invoking user, mode 0700. The eventual container directory/file must be owned by UID/GID 1000.
2. Request enabled user permissions required for the reader and identity check. In read-only mode the command allows `im:message.group_msg:get_as_user`, `im:message:readonly`, `im:chat:read`, `contact:user.base:readonly` and `offline_access`; `im:message:readonly` is required for the history endpoint; group-message access alone is insufficient. It adds `offline_access` for renewal. Confirm the app's enabled scopes and availability before live consent; the allowlist is not proof of permission.
   For user-owned briefs, set `LARK_DOC_AUTH_STRATEGY=user_oauth` in the login environment and include **all five** additional scopes: `docx:document`, `docs:permission.member:retrieve`, `docs:permission.member:create`, `docs:permission.setting:read`, `docs:permission.setting:write_only`. Publish/enable these as user scopes in the app console first. They are rejected without the explicit Doc opt-in; message-send scopes remain forbidden. The user grant writes Docs, while independent bots send messages. Scope details: [official Doc creation](https://open.larksuite.com/document/server-docs/docs/docs/docx-v1/document/create).
3. Run `pnpm worker-auth start`. Open the returned verification URL and approve as the configured reader before the stated expiry. Output contains only the URL, user code and expiry; the device code stays in a private `.login.json` file beside the credentials.
4. Run `pnpm worker-auth finish`. It honors provider pending/slow-down intervals, verifies the returned user's open ID, and atomically creates a mode-0600 Bearer grant in the existing worker schema. The built-image equivalent is `node dist/worker-auth-command.js start|finish`. Neither command unpauses the worker or sends anything.

Existing credentials, including dangling links, are refused rather than overwritten. For reviewed reauthorization, stop users of this credential file and privately preserve the old grant before selecting a new file; never restore a previously consumed refresh token. Denied, expired, invalid or uncertain issuance requires a new `start`. A `consuming` journal prevents replay after interrupted token issuance. A process killed while holding the shared `.lock` leaves it in place: verify the owner is no longer running and review the journal before removing that lock and starting a **new** login; do not resume its old exchange.

`worker_login_started`, `worker_login_completed` and `worker_login_failed` provide correlated Pino events with entry point, duration/attempt count and finite reasons. URLs, codes, scopes, tokens and provider descriptions are excluded from logs. Local tests exercise real HTTP and worker credential consumption with synthetic data; live grant issuance/renewal is a separate acceptance gate.

Protocol references: [official device flow](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/auth/device_flow.go), [official endpoint paths](https://github.com/larksuite/cli/blob/7beffb086d7fa3c5b843d8affa7c089f49cfc65e/internal/auth/paths.go). The worker uses `/oauth/v1/device_authorization`, `/oauth/v3/token` and `/open-apis/authen/v1/user_info`; no redirect listener is needed.

## Deferred live acceptance

Before activation, identify the deployment/backup/calendar operators; verify
admin access, external-group reminder eligibility, worker OAuth provisioning
and real SDK renewal. Agree evidence retention/access and alert recipients. Compare
bounded preview days with the admin's manual list and explain every discrepancy. The
comparison period and acceptable results require agreement; local fixtures do not
prove these live conditions.

For the optional brief, separately authorize a small synthetic live model sample
and a private Doc test with exact user ownership, group viewer access, folder and content.
Verify every selected person, faithful work summaries, late labels and source-backed
notes; record model/prompt/template/schema versions, actual billable usage and
failure observations. Then verify native layout, operator owner access, reports-group viewer access, saved
link delivery and preservation of human edits. Approve data processing before
using employee tasks; the current Gemini free-tier demo remains synthetic only.
A fixture-passing model is not yet proven cost-effective or factually reliable.
Gemini remains the initial selected provider; DeepSeek live credentials/model
access and processing terms need their own review before selection.

The admin's manual list remains the fallback while access or the worker is unavailable.
Both sending routes require separate activation approval after those gates pass.
The new CLI accepts outbound only in explicit production configuration; the deployed preview remains paused.

Backup and Compose behavior follow the [SQLite backup documentation](https://www.sqlite.org/backup.html)
and [Docker Compose service reference](https://docs.docker.com/reference/compose-file/services/).

## Configure the private reports-group recipient

Use `REPORT_RECIPIENT_TYPE=chat_id`, the private reports-group ID and `REPORT_TRANSPORT=webhook`. Set `REMINDER_TRANSPORT=webhook` for a separate custom bot in the source group. Keep URLs and signing secrets in Doppler. The direct-admin test was rejected with code `230013`; a Doc access grant alone does not establish messaging eligibility.

See [production settings and recipient review](deploy/README.md#production-settings-and-private-reports-group-transition). Frozen deliveries retain their scope. Verify exact group members, closed Doc link sharing, owner-only collaborator management and group viewer access independently; never enable public sharing to work around access failure. Both endpoints need an approved synthetic send to establish their real destinations.

For a lost webhook receipt, ask the recipient/operator to verify the exact frozen message. If verified sent, use the existing reconcile command with `--decision sent` and **omit `--message-id`**; this is accepted only for a stored webhook attempt. Preserve evidence/reviewer/expected-attempt arguments. App-API reconciliation still requires its actual `om_` ID. A failed search is insufficient evidence for `not-sent`.

Documented rate limits may retry after persisted backoff; signing/IP/keyword/payload rejection fails for review. Signing-key rotation at the same endpoint preserves its binding. Changing a URL blocks attempted jobs; resolve them in their original scope before retiring the endpoint. The admin's manual report remains the fallback.

Live setup diagnosis on 7 October: the first grant issued successfully, but Lark rejected history with HTTP 400/code `99991679`. Request `im:message:readonly` in fresh consent; `im:message.group_msg:get_as_user` alone does not authorize history. The login command now rejects that insufficient configuration before networking. The server remains paused until corrected access and renewal are verified.


## Verify OAuth renewal and secret rotation

Stop the paused worker before forcing renewal. Run the matching reviewed image's `node dist/worker-auth-command.js refresh` against the canonical credential directory, with the same app/reader and fresh Doppler app secret. It uses real expiry timestamps, atomically saves the renewed grant and prints only ready/reader metadata. A lost refresh response leaves a review-required state; never retry an uncertain rotating token or restore an old grant. Fresh device consent is the recovery path. Verify the subsequent bounded source read, then leave the worker paused until remaining live gates pass.

Signing/model-key changes take effect on redeployment. Do not change webhook URLs during a key-rotation test. Test signed delivery with synthetic text and explicit approval; inspect safe receipt/state metadata, not expanded Compose environment or tokens. Off-server backups are deferred by the owner; local upgrade snapshots remain enabled.

# Local release and operator guide

This release is for isolated acceptance and preview. The server is currently down,
management access is pending, and `oc_management_placeholder` is a local placeholder.
The worker CLI rejects outbound activation. No production deployment or live send
is authorized by the local release tests.

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

The recorded predecessor for this local acceptance is merged Slice 5 commit
`d8000cf74ae0deec644c8f2282cfb0f066f8a597`; the test checks pending/sent records
through both built versions. Without `RELEASE_PREVIOUS_IMAGE`, this one optional
case is skipped. Use the actual deployed predecessor for a future release drill.

## Configure an isolated preview

Copy `.env.example` to an ignored `.env` with permissions 0600. Keep
`APP_MODE=preview`, `ENABLE_OUTBOUND=false` and use isolated storage. Management's
real chat ID must replace the placeholder only when access is verified. Fixture
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

## Inspect and recover ordinary work

```bash
pnpm worker status
pnpm worker run --once
pnpm delivery status --id <delivery-id>
```

`status` reads an existing migrated ledger and contacts no Lark endpoint. Preview
`run` can freeze local work and, with later approved network/credentials, read Lark;
it never sends. Startup checks recover today. Reminders stop at 10:00 Nairobi and
reports stop at the next midnight. Older unfinished reports appear in `backfill`
with IDs/states; closed-window uncertain reminders appear in `reminderReviews`.
Neither list authorizes replay. A running worker prints changed state and its latest
read/preparation failure; a separate status command cannot recover transient read
diagnostics from a past process. Missing/invalid calendar, credentials or storage
must not be treated as a valid zero-submission day.

On ambiguous content/name, confirm the source message and sender with Anthony/Joseh.
Fix the source or approved alias/policy through a reviewed change, then rerun an
unfrozen date. Names are display data; different scoped IDs are distinct people.
Do not edit frozen report text, evidence, IDs or UUIDs by hand. Corrections and dated
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
This local release adds no migration. Its tested predecessor uses the same packaged
schema; rolling back application code must preserve delivery keys/UUIDs and sent
state. For future migrations, verify backward compatibility or restore to isolated
paused storage before changing application versions. Never truncate the ledger to
make an old version start.

If OAuth renewal reports revoked/expired/uncertain, stop and reauthorize the separate
worker grant under the same approved app/account. Do not delete a stale lock and
replay an uncertain refresh request. Initial login/renewal recovery UX remains a
live setup gate. Never paste tokens into report content or ordinary diagnostics.

## Deferred live acceptance

When the server returns, identify the deployment/backup/calendar operators; verify
management access, external-group reminder eligibility, worker OAuth provisioning
and real SDK renewal. Agree evidence retention/access and alert recipients. Compare
bounded preview days with Joseh's manual list and explain every discrepancy. The
comparison period and acceptable results require agreement; local fixtures do not
prove these live conditions.

Joseh's manual list remains the fallback while access or the worker is unavailable.
Both sending routes require separate activation approval after those gates pass.
The current local CLI still rejects `ENABLE_OUTBOUND=true`.

Backup and Compose behavior follow the [SQLite backup documentation](https://www.sqlite.org/backup.html)
and [Docker Compose service reference](https://docs.docker.com/reference/compose-file/services/).

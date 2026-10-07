# Deployment checklist

Working plan for **7 October 2026**. Branch: `codex/preview-deployment` (following merged deployment PR #19).
This checklist covers deployment and debugging; no production activation has occurred.

## Target and verified starting point

Use one Docker Compose worker, local persistent SQLite and Doppler-managed app/model secrets. Docker owns worker restarts; no reverse proxy or inbound application port is needed. GitHub-hosted runners build/test the image; Tailscale supplies the private deployment connection.

Read-only server inspection confirmed Ubuntu 26.04 LTS, x86_64, Docker 29.7.2, Compose 5.5.0, synchronized host time, Docker enabled at boot, UFW enabled with LAN SSH access, and an online Tailscale client. There is ample local disk/RAM for this worker. HTTPS endpoints for GHCR, Doppler and Lark respond; credentials and API permissions are still separate checks. Doppler CLI was initially absent and is now installed. The restricted deployment account, root-owned helper, private persistent paths and SSH policy are now installed. Existing administrator logins and shared applications were preserved; the firewall was unchanged.

The repository is public. Keep ordinary PR checks on GitHub-hosted runners; do not give PR jobs a production-server runner, Docker socket, deployment identity or real task data. Password SSH is sufficient for today's inspection, but automation should use a restricted deployment identity rather than the administrator's password.

## Why the private network does not prevent CI/CD

```mermaid
flowchart TB
    PR["Pull request / main<br/>GitHub-hosted CI"] --> CHECK["Lint, types, tests<br/>build + offline container acceptance"]
    CHECK --> RELEASE["Manual publish from main<br/>same tested image → GHCR digest"]
    RELEASE --> APPROVE["Manual deployment approval<br/>one digest + one target"]
    APPROVE --> LINK["Ephemeral Tailscale CI identity<br/>restricted server access"]
    LINK --> HOST["Ubuntu server<br/>approved deployment command"]
    HOST --> IMAGE["Pull image from GHCR<br/>outbound HTTPS"]
    HOST --> SECRETS["Fetch Doppler config<br/>server-side service token"]
    HOST --> WORKER["Replace one Compose worker<br/>preserve SQLite + OAuth storage"]
    classDef ci fill:#dbeafe,stroke:#2563eb,color:#172554;
    classDef release fill:#ede9fe,stroke:#7c3aed,color:#4c1d95;
    classDef server fill:#dcfce7,stroke:#16a34a,color:#14532d;
    classDef data fill:#fef3c7,stroke:#d97706,color:#78350f;
    class PR,CHECK ci;
    class RELEASE,APPROVE,LINK release;
    class HOST,WORKER server;
    class IMAGE,SECRETS data;
```

The server pulls its image over HTTPS. We do not need to SCP application source or expose LAN SSH publicly. A GitHub runner temporarily joins the approved tailnet and invokes the deployment command at the server's Tailscale address. Only the deployment job gets this access, never ordinary PR CI. Installing Tailscale directly on the server avoids routing GitHub into the rest of the office LAN. [Tailscale Actions integration](https://github.com/tailscale/github-action)

If tailnet setup is delayed, use the same tested image with a manual LAN-side pull and deployment. A self-hosted runner can also use outbound GitHub connections, but a persistent runner on this shared production host would add unnecessary exposure for a public repository. [GitHub runner requirements](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)

## Step-by-step work

### 1. Establish the baseline

- [x] Create the deployment branch from merged main, including Pino instrumentation.
- [x] Verify the SSH host against the existing known-host entry and inspect the server without changes.
- [x] Verify OS/architecture, Docker/Compose, disk/RAM, boot, clock, firewall and Tailscale state.
- [x] Confirm repository visibility and absence of existing Actions workflows.
- [x] Run local release verification: lint/types/build pass; source regression **443 passed, 22 optional cases skipped**; full Docker acceptance **24 passed**, including the predecessor upgrade/rollback drill.
- [x] Build `task-list-local:deployment-readiness` and preserve `task-list-local:ai-7` for the local upgrade drill. A separately tested GHCR image is now published; see the release evidence below.

### 2. Put CI and image publishing in place

- [x] Draft `.github/workflows/ci.yml`: PR/main/manual source checks plus offline container acceptance, with read-only permissions and no real credentials.
- [x] Draft `.github/workflows/publish-image.yml`: manual main-only verification, build, acceptance and publication of the same image to GHCR, followed by a digest in the run summary.
- [x] Validate all three workflows with actionlint; verify official action pins and exercise their local release commands.
- [x] Observe the first hosted PR CI run: all verification passed.
- [x] Merge reviewed deployment PR #19; merged-main CI passed.
- [ ] Require the CI check for merging main if repository administration settings permit.
- [x] Run the manual publisher on the reviewed main commit; source checks, offline container acceptance and image push passed.
- [x] Choose **public** package visibility, as approved by the owner. GHCR initially creates private packages; a public source repository does not automatically make its container anonymously pullable.
- [x] Apply public visibility and verify anonymous manifest access for the exact release digest (HTTP 200). No registry credential has been installed on the host.
- [x] Confirm anonymous digest pull on the server and inspect its amd64 architecture and reviewed source revision; keep predecessor images for later upgrades.

The workflows are initial infrastructure, not an activation mechanism. Ordinary image acceptance skips the optional predecessor rollback case unless a predecessor image is supplied; rehearse that case before a real upgrade. [GHCR authentication and digest pulls](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

**Release evidence:** reviewed main commit `4becb16a52edd4c8e875266a8823d54b5044bb89`; [main CI](https://github.com/mbeka02/task-list-submission-automation/actions/runs/37598819450) and [tested-image publisher](https://github.com/mbeka02/task-list-submission-automation/actions/runs/37599212543) both succeeded. Published image:

```text
ghcr.io/mbeka02/task-list-submission-automation@sha256:5caa5911747bb5246c279988940348d93eb84d3ad5bfca266799025ff21be8bb
```

Publication, anonymous manifest access and the host digest pull are verified. The host image label matches the reviewed main commit.

### 3. Authorize private deployment connectivity

- [x] Confirm the server is already enrolled and healthy in Tailscale.
- [x] Confirm the user has tailnet admin access.
- [x] Confirm the server now carries `tag:task-list-server` and administrator SSH still works through Tailscale.
- [ ] Verify the effective CI grant excludes unrelated devices/ports during the first runner check; tags/grants were configured by the tailnet administrator.
- [x] Configure Tailscale workload identity federation for this repository/environment and record the required branch/workflow restrictions; enrollment passed and negative claim tests remain outstanding.
- [x] Configure GitHub `preview` with a required `mbeka02` review, a main-only branch rule and non-cancelling deployment concurrency. Save `DEPLOY_HOST`, `TS_CLIENT_ID` and `TS_AUDIENCE` as environment variables.
- [x] Tailnet administrator reports completing the narrowed credential, tag and access-rule setup.
- [x] Prove the reviewed main workflow's OIDC identity is accepted through a successful check-only run. Inspect/test rejection of other subjects/custom claims separately; positive acceptance alone does not verify those restrictions.
- [x] Install the dedicated `task-list-deploy` account/key; keep its private key and verified host key only in GitHub `preview` secrets. Administrator passwords are not in Actions.
- [x] Verify effective SSH settings, host sudoers and real account behavior: check succeeds; shell/injection/mutable-tag/forwarding/unrelated-sudo attempts are denied. No Docker group membership.
- [x] Confirm the existing UFW SSH rule on `tailscale0`; preserve LAN SSH and all existing service rules. Tailnet grants remain a separate restriction.
- [x] Add a default **check-only** workflow mode using the approved SSH `check` command; no digest or worker replacement is needed.
- [x] Run it from reviewed main and prove GitHub runner → server connectivity before deployment: enrollment, restricted SSH check and cleanup all passed.

The [check-only run](https://github.com/mbeka02/task-list-submission-automation/actions/runs/37599009377) now succeeds. Earlier attempts failed first with auth-key creation HTTP 404 (Auth Keys write permission was missing), then HTTP 400 (the requested CI tag was not permitted). The administrator corrected the scope and allowed tag; enrollment and restricted SSH subsequently passed. This verifies the accepted runner identity and positive connectivity, but not rejection of other subjects/devices/ports. No worker replacement was attempted. See [enrollment troubleshooting](deploy/README.md#troubleshoot-runner-enrollment).

Keep Tailscale off the app container: it belongs on the host and ephemeral deploy runner. Tailnet administrator setup is still required even though the server is already online. No subnet router, router port forward or public SSH endpoint is planned.

### 4. Prepare persistent storage and Doppler

- [x] Install Doppler CLI 3.76.6 on the server through the official signed APT repository and verify its version.
- [x] Authenticate in workspace **mbeka02**, create project **task-list**, and create Preview **`prv`**. This repository selects `task-list/prv`; `prd` has a secret but no production deployment is active.
- [x] Install the read-only `prv` service token privately on the server and verify its secret fetch. Preview token expires **6 November 2026**; rotate before expiry. Production remains separate.
- [x] Verify `LARK_APP_SECRET` presence without displaying it in `task-list/prv` (also confirmed in dev/stg/prd). Preview does not need a model key; provision that separately for publication. Keep runtime settings in reviewed configuration and never forward the Doppler token into Docker.
- [x] Install root-owned release tooling/settings and private ledger, credential and backup directories owned by UID/GID 1000. Settings remain paused with preview activation date **8 October 2026**.
- [x] Install the owner-approved **paused-preview-only** calendar for 7–31 October 2026, listing 10 October (Mazingira) and 20 October (Mashujaa). Additional gazetted holidays were not exhaustively verified; this calendar is not approved for live work. Replace/review it before unpausing and extend coverage before November.
- [ ] Complete corrected-scope worker consent and verify initial source access and renewal. The first grant was issued and installed, but the history endpoint rejected it with code `99991679` because `im:message:readonly` was absent. Do not copy the interactive CLI refresh token or restore an old rotating token.
- [x] Prepare the explicit server Compose definition: pinned image, bridge egress, no ports, read-only root, non-root user, bounded resources/logs and persistent mounts.
- [x] Validate configuration through deployment preflight/disposable-storage checks without printing expanded configuration or secret values.
- [x] Verify server-side Doppler fetching with the scoped token and `--no-fallback`, without displaying the secret. The paused preview now uses this path.

The reviewed host paths, setup commands and GitHub/Tailscale settings are in [deploy/README.md](deploy/README.md). Deploy secrets stay on the host; GitHub only needs its deployment identity and target image reference.

### 5. Implement the deployment boundary with TDD

- [x] Agree the public deployment command before its first test, per the installed TDD skill.
- [x] Implement one serialized, validated image replacement: fetch secrets/pull/check first, graceful stop, previous-release consistent backup, replacement, then read-only readiness inspection.
- [x] Prove invalid images/configuration, failed fetch/pull and overlapping deployments leave the current worker alone.
- [x] Prove container replacement preserves ledger IDs, send UUIDs, acknowledged deliveries and the writable OAuth directory.
- [x] Prove failed readiness leaves a visible failure and never automatically restores stale data, clears restore markers or resends uncertain deliveries.
- [x] Wire a main-only manual deploy workflow to that tested helper over Tailscale. Deploy by digest; do not accept arbitrary shell commands or image repositories from inputs.
- [x] Emit safe structured host audit events with run ID, digest, actor UID, duration and outcome; return the backup reference in result JSON. GitHub records the initiating actor and reviewed commit/digest.

The preview helper and restricted SSH boundary are implemented and tested locally. Bash/Node syntax, Python execution and the sudoers template pass; host installation and effective SSH settings are verified. Image publication, public access, hosted connectivity and paused worker deployment passed. The server's sudo-rs rejected the legacy argument wildcard; the fixed-executable rule passed host validation, with exact arguments enforced by the wrapper/helper. Its existing `AllowUsers` list was extended without removing existing users.

### 6. Deploy preview and debug the actual server entry point

- [x] Deploy the tested digest through the [successful preview deployment run](https://github.com/mbeka02/task-list-submission-automation/actions/runs/37602116560), following the owner's GitHub environment approval.
- [x] Start one server preview worker with **restore mode enabled**, outbound disabled and brief publishing disabled. Built status returns `paused` / `restore_review_required`; this is intentional, not a failed deployment.
- [x] Verify startup logs and built read-only status: Nairobi business date 7 October 2026, empty report/brief state and no backfill; verify UID 1000, read-only container root, no published ports, persistent ledger/credential mounts and read-only calendar mount.
- [ ] Run an approved source-history read/capture and explain any blocked or ambiguous submissions.
- [ ] Verify private OAuth renewal and mounted-file ownership in the actual runtime.
- [x] Verify graceful stop (exit 0) and restart; status stays paused and SQLite integrity/empty business-table counts persist. No shared-server reboot.
- [x] Inspect startup/status Pino events with run ID, entry point, timing and paused outcome; command-result JSON remains distinct and inspected logs contain no task content or credentials.
- [ ] Observe the ten-minute heartbeat on the deployed worker.
- [x] Exercise the built online backup command on the running server and restore to a separate file. Both return success, restored SQLite passes `quick_check`, and the restore-review marker is present. The active ledger was not replaced.
- [ ] Set off-server backup destination, owner, schedule and retention. The acceptance snapshot/restore are local files, not an off-server backup policy.

### 7. Enable the live workflow safely

- [ ] Agree the production CLI seam and add tests before changing activation behavior.
- [ ] Wire the existing app-bot delivery transport, selected generator, private Doc publisher and approved scope into the worker CLI.
- [ ] Reject placeholders/unapproved destinations, missing model credentials and unsafe publishing settings before mutations.
- [ ] Verify source reader membership, reminder bot eligibility, test destination, native Doc scopes/folder/privacy and editor access.
- [ ] Prove names report + Doc/link in the development test group through the real deployed entry point, with separately approved content/model data processing.
- [ ] Confirm private admin open ID, bot availability and Doc editor access, production data-processing approval, activation dates and reviewed Kenyan holidays.
- [ ] Activate the approved production destination; keep the manual report fallback and document rollback/reconciliation.

**Current blocker:** the worker CLI deliberately rejects `ENABLE_OUTBOUND=true` and `BRIEF_MODE=publish`. The underlying library flow exists, but a deployed preview image cannot send or publish merely by changing environment settings. The demo scripts are not a service entry point.

### 8. Operational acceptance

- [ ] Agree expected completion grace and an actionable alert recipient/backend.
- [ ] Observe a working-day reminder, names report, brief and their durable acknowledgements.
- [ ] Check that a retry/restart does not generate another report UUID or overwrite a published human-edited Doc.
- [ ] Rehearse reviewed rollback without reverting the ledger automatically.
- [ ] Hand over the runbook, calendar/backup owners, Doppler/Tailscale renewal procedure and incident contact.

## Next decisions

The paused preview is running. Live OAuth renewal, a fully reviewed live calendar, off-server backup policy and the production CLI seam remain open; negative tailnet/identity-policy checks also remain outstanding. The restricted deployment account and positive CI connection are verified. Development-test-group acceptance precedes admin activation. Passwords, private keys, grants and service tokens must never be copied into this checklist.

See [RUNBOOK.md](RUNBOOK.md) for current commands, frozen-delivery recovery and backup/restore behavior.

### Direct-admin destination update

- [x] Complete fresh worker device consent and verify the configured reader locally; credentials remain private.
- [x] Resolve one admin contact; keep their identity only in private runtime configuration.
- [x] Merge worker OAuth PR #21 and install the private grant on the paused server (UID 1000, mode 0600); reviewed image publication remains separate.
- [x] Verify direct-user addressing, Doc editor permissions and restart recovery with synthetic fixtures: 465 source tests and 26 Docker acceptance checks pass.
- [ ] Configure `REPORT_RECIPIENT_TYPE=open_id` and the private `REPORT_RECIPIENT_ID` through a reviewed destination change; never redirect existing deliveries.
- [ ] Obtain explicit approval for an admin delivery/access acceptance test before activation.

The admin replaces the former group destination. Development acceptance still uses the private test group, and reminders stay in the source group. No real recipient name or ID belongs in this document.

OAuth live diagnosis: the deployed reader failed, and a one-message API check returned HTTP 400/code `99991679`, explicitly requiring a history/message-read permission. Login now requires `im:message:readonly` before contacting Lark. A fresh corrected-scope consent is pending; no unpause or sends occurred.

# Server deployment setup

This is the repeatable host layout for `scripts/deploy.sh`. The host is still a paused preview. The production profile can send after reviewed settings and live acceptance gates; follow the [deployment checklist](../DEPLOYMENT_CHECKLIST.md) in order.

## Host layout

The deployment helper runs as root. Docker runs the worker as **UID/GID 1000:1000**, which is independent of the administrator's login account. The private parent directory prevents unrelated host users from reading its contents.

| Path | Owner / mode | Purpose |
| --- | --- | --- |
| `/opt/task-list` | root / 0700 | Private deployment root |
| `release-tool/scripts`, `release-tool/deploy` | root; directories 0755, scripts 0755, other files 0644 | Reviewed helper and fixed Compose definition; never writable by the deploy account |
| `worker.env` | root / 0600 | Non-secret settings; start from `worker.env.example` |
| `doppler.token` | root / 0600 | Read-only service token scoped to the selected config (`prv` or `prd`) |
| `calendar.json` | 1000:1000 / 0600 | Reviewed Kenyan holiday calendar, mounted read-only |
| `ledger`, `credentials`, `backups` | 1000:1000 / 0700 | Persistent SQLite, rotating worker OAuth grant and upgrade snapshots |
| `credentials/user-oauth.json` | 1000:1000 / 0600 | Separately provisioned worker grant; never replace with an old CLI refresh token |
| `deployments.jsonl` | root / 0600 | Structured deployment audit; rotate/archive separately |

`TASK_LIST_DEPLOY_ROOT` and `TASK_LIST_COMPOSE_PROJECT` exist for isolated acceptance environments. The unattended host role uses the fixed defaults `/opt/task-list` and `task-list`; clients cannot choose arbitrary directories or projects.

Install the reviewed `scripts/` and `deploy/` trees together under `release-tool`. Do not make the helper update itself from a branch during deployment. Updating this privileged tooling is an administrator operation, separate from replacing the application image.

Host requirements: Bash, Python 3, util-linux `flock`, Docker, Compose supporting raw env files (2.30+), and the verified Doppler CLI. Doppler CLI 3.76.6 has now been installed on the inspected server through the official signed APT repository. Python is used only for private input/metadata checks, not application runtime.

Create the directories without touching existing Coolify/Nextcloud/n8n services:

```bash
sudo install -d -o root -g root -m 0700 /opt/task-list
sudo install -d -o 1000 -g 1000 -m 0700 \
  /opt/task-list/ledger /opt/task-list/credentials /opt/task-list/backups
```

Install the settings, calendar and scoped token with the ownership above. Provision the token through a hidden prompt or administrator secret channel; never put its value in a shell command, Git, chat or Actions input. Keep the first activation date in the future until source-history access has been verified. A missing grant is not proof of reader readiness.

## Doppler workspace and configuration

The repository is scoped to workspace **mbeka02**, project **task-list**, Preview config **`prv`**. The project and config exist, and secret presence has been verified without displaying its value in `prv`, `dev`, `stg` and `prd`. A read-only `prv` service token is installed on the server and its fetch is verified; it expires 6 November 2026. This preview package fetches only `LARK_APP_SECRET`. The configured app is `cli_aa366f7e9d78de2f`; keep its secret in Doppler, outside chat and Git.

For renewal, create a **read-only, `prv`-scoped service token** for the server and install it as `/opt/task-list/doppler.token` with the ownership above. Use explicit project/config selectors when administering secrets so another workspace's settings cannot be selected accidentally. The helper uses the service token scope and fetches only the app secret; it never injects the service token into the worker. Model credentials and production `prd` setup remain separate activation work. [Doppler service tokens](https://docs.doppler.com/docs/service-tokens)

## Deployment behavior

The public host command accepts only this repository's immutable image:

```bash
sudo /opt/task-list/release-tool/scripts/deploy.sh --image \
  ghcr.io/mbeka02/task-list-submission-automation@sha256:<64-lowercase-hex-characters>
```

1. Validate private paths and allowlisted settings; acquire the host lock.
2. Select preview/production from root-owned `APP_MODE`; fetch only required app/model/webhook secrets through Doppler with fallback disabled; pull and inspect the image.
3. Run built preflight and the built status command against disposable SQLite. The live ledger is untouched.
4. For an existing worker, verify app/group/reader scope and ledger/credential mounts. Stop gracefully, require a clean exit, then back up with that predecessor's image and migration level.
5. Replace one worker using the verified local image ID and the same persistent paths.
6. Inspect built read-only status until ready. A failed replacement is stopped; there is no automatic snapshot restore, old-image restart or send replay.

An existing ledger without a matching predecessor container requires operator review. A changed app/group/reader or storage location is a migration decision, not an ordinary upgrade. Secrets and image acquisition failures leave the existing worker running. A backup failure leaves the old worker stopped so a replacement cannot begin without its snapshot.

SQLite's backup connection is read-only, but its mounted directory is writable because WAL mode may need support files. The source directory, WAL/SHM files and restore marker are always preserved. The writable credential **directory** stays mounted so atomic token renewal continues to work.

Readiness proves local configuration/storage compatibility, not live Lark authorization or successful history reads. A restored ledger remains paused; a ready container must not be mistaken for permission to resume it. Run the separate reviewed reader and live acceptance gates before activation.

Result JSON goes to stdout. Safe JSON events go to stderr and `deployments.jsonl`, with run ID, entry point, image, duration, actor UID and finite failure reason. Raw Docker/Doppler diagnostics are suppressed. Inspect the built status command and the worker's Pino logs when debugging; do not print expanded Compose configuration.

## GitHub environment and Tailscale setup

Create a GitHub environment named **`preview`**, allow deployments from **main only**, and configure a required reviewer. This public repository supports environment protection on current GitHub plans. If self-approval is allowed for this small team, retain an explicit review of the digest before running deployment. [GitHub deployment review](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)

| Environment setting | Type | Where it comes from |
| --- | --- | --- |
| `TS_CLIENT_ID` | Variable | Tailscale federated credential |
| `TS_AUDIENCE` | Variable | Same credential's audience |
| `DEPLOY_HOST` | Variable | Server's verified Tailscale DNS name |
| `DEPLOY_SSH_PRIVATE_KEY` | Secret | Dedicated deployment key; not the administrator's key/password |
| `DEPLOY_KNOWN_HOSTS` | Secret | Host key verified through the existing trusted LAN SSH connection, written for the Tailscale hostname |

In Tailscale's **Trust credentials → Credential → OpenID Connect**, create a GitHub identity with Auth Keys write permission restricted to `tag:task-list-ci`. Copy Client ID and Audience into the environment variables. [Tailscale federation setup](https://tailscale.com/docs/features/workload-identity-federation)

For the **Scopes** section, select only **Auth Keys → Write** (`auth_keys`, which includes its read operations), with **`tag:task-list-ci`** as the allowed tag. Clear all other read/write scopes, including All, Devices, DNS, Access controls/policy, Users and trust-credential management. This lets the action create the ephemeral runner's login key. It does not need permission to administer the tailnet. If editing is unavailable, create a replacement OIDC credential with these settings and revoke the unused broad credential. Keep the subject/custom claims below when replacing it. [Required action scope](https://github.com/tailscale/github-action#workload-identity-federation), [scope definitions](https://tailscale.com/docs/reference/trust-credentials)

API scopes and network grants are separate: `auth_keys` allows runner enrollment; the grant below determines which server/port that enrolled runner can reach. Client ID, Audience and the verified target have been saved in GitHub's `preview` environment. The server tag, laptop SSH and hosted CI enrollment/restricted SSH check are verified. Negative tests of other OIDC claims, unrelated devices and service ports remain outstanding.

Use the verified immutable subject:

```text
repo:mbeka02@93541073/task-list-submission-automation@1400123773:environment:preview
```

Also constrain these custom claims:

```text
repository_id = 1400123773
ref = refs/heads/main
event_name = workflow_dispatch
workflow_ref = mbeka02/task-list-submission-automation/.github/workflows/deploy-preview.yml@refs/heads/main
```

Repository API inspection confirmed immutable subjects enabled. An environment subject does not itself restrict the branch; the additional claims and environment rule do that. [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc)

Merge a restricted grant into the existing tailnet policy, preserving administrator access and existing services:

```json
{
  "src": ["tag:task-list-ci"],
  "dst": ["tag:task-list-server"],
  "ip": ["tcp:22"]
}
```

Define both tags with administrator owners and tag only the target server after checking its current access rules. Inspect existing broad grants: adding this grant does not override an existing allow-all rule. Test that CI can reach this server on 22 and cannot reach unrelated devices or other service ports. Preserve LAN access and permit the specific Tailscale path in UFW if necessary. [Tailscale grants](https://tailscale.com/docs/reference/syntax/grants)

The server currently has Tailscale SSH disabled, so ordinary OpenSSH host keys and forced commands apply. The approved `scripts/deploy-ssh.sh` accepts only `check` and the digest deployment command, clears client deployment overrides, and invokes the fixed helper through non-interactive sudo.

Provision the locked-password `task-list-deploy` account with no Docker group membership and no writable shell startup files. Install the wrapper as root-owned `/usr/local/sbin/task-list-deploy-ssh`. Install the dedicated public key with `restrict` in root-owned `/etc/ssh/task-list-deploy.authorized_keys`; keep its private key only in the GitHub preview environment. Validate `sudoers-task-list` with `visudo -cf`, then install root-owned mode 0440 under `/etc/sudoers.d/`. Install `sshd-task-list.conf` under `/etc/ssh/sshd_config.d/`, run `sshd -t` and inspect the effective settings for this user before reloading SSH. Preserve the administrator's current connection and login rules. If the host already has `AllowUsers`/`AllowGroups`, extend that allowlist for the deployment account while preserving every existing allowed user/group, then check effective settings. Do not introduce an exclusive deployment-only allowlist on an unrestricted host. This server's existing `AllowUsers` list initially blocked the new key and was safely extended.

Sudo permits only the fixed helper executable; both wrapper and helper strictly validate its arguments. Ubuntu 26.04 uses sudo-rs, which rejects command-argument wildcards, so the template intentionally avoids them. Validate with the actual host's `visudo`, not only a local legacy sudo validator. Never grant `NOPASSWD: ALL`, `SETENV`, an arbitrary `env` command, or a writable helper. SSH configuration disables shells/TTY, forwarding and user RC files; the shell script alone cannot enforce SSH forwarding policy. Test a second connection before closing the administrator's session:

```bash
ssh -i <dedicated-key> -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=<verified-known-hosts> task-list-deploy@<tailscale-host> check
```

This check proves the restricted SSH entry point, not application readiness. Attempt an arbitrary command and forwarding separately and confirm denial before the first deploy.

### Troubleshoot runner enrollment

Distinguish the failing step before changing credentials or access rules:

| Failure | What it establishes | Next check |
| --- | --- | --- |
| JWT exchange fails | The runner has not obtained a Tailscale API token | Client ID, audience, issuer and subject/custom claims |
| `unexpected error while creating authkey` | Exchange returned a nonempty token, but temporary runner-key creation failed | Credential's **Auth Keys → Write** scope and allowed `tag:task-list-ci`; then Tailscale API behavior |
| Enrollment succeeds, SSH times out | The runner joined; the host connection is still unverified | Target, effective network grants and host firewall |
| SSH authentication or forced command fails | The connection reached SSH | Verified host key, dedicated key/account and effective SSH/sudo policy |

The reviewed check-only run initially failed at auth-key creation with HTTP 404; enabling the missing Auth Keys write permission changed it to HTTP 400 for an unpermitted CI tag. Correcting the credential's allowed tag made enrollment and SSH pass. A 404 alone does not establish which setting is wrong. The [pinned client implementation](https://github.com/tailscale/tailscale/blob/v1.94.2/feature/identityfederation/identityfederation.go) performs exchange first and emits this error only from `CreateKey`. The current 1.102.3 implementation uses the same sequence, so a version change was not an established fix. The action's [tag troubleshooting](https://github.com/tailscale/github-action#requested-tags-tagmytag-are-invalid-or-not-permitted) requires matching the credential's permitted tags. Do not broaden all API permissions or network grants to diagnose enrollment. Inspect only safe metadata; never print the GitHub JWT, returned API token or generated auth key.

## Release sequence

1. Merge the reviewed branch; observe hosted **CI**.
2. Run **Publish tested image** on main. It builds once, runs container/deployment acceptance against that image, pushes it and records the digest. Choose GHCR visibility or provision a server-side read-only pull credential first.
3. Configure the preview environment, tailnet grant, restricted SSH role, Doppler and persistent paths. Run **Deploy preview** with **operation = check** from main and approve the environment review. It verifies OIDC/tailnet/SSH without an image digest or replacement.
4. Run **Deploy preview** with **operation = deploy** from main using only the digest from the successful publisher. Review the target/digest at the environment approval gate.
5. Inspect local status and Pino logs on the server, then perform the separately approved reader/OAuth checks.

The deploy workflow does not copy source, install privileged tooling or bootstrap access. It contacts the existing host helper through Tailscale; the server pulls the image over HTTPS. The host helper/account, private paths, Doppler token and GitHub SSH secrets are installed and verified. Merged-main CI, tested-image publication, anonymous host pull and runner enrollment/restricted SSH passed. The owner-reviewed preview deployment succeeded: one worker is running in restore mode with sending and briefs disabled. The temporary calendar is approved only for paused acceptance. Separate worker OAuth provisioning and initial source access are verified; live renewal and live calendar review remain outstanding. See the [deployment checklist](../DEPLOYMENT_CHECKLIST.md#2-put-ci-and-image-publishing-in-place) for the verified release digest and run evidence.

Host acceptance verified clean stop/restart, preserved SQLite integrity, non-root/read-only/no-port runtime settings, online backup and an isolated restore with its pause marker. Initial Lark source access was separately verified through the SDK after the reviewed replacement. Live OAuth renewal and report delivery remain unverified; local acceptance snapshots also do not replace an off-server backup policy.

For a failed deployment, find its run ID and finite phase in the audit. Failures before `stop` leave the current worker alone; failures after `stop` need operator inspection. Preserve the ledger and rotating grant. Review schema compatibility before any image rollback, and use the [runbook](../RUNBOOK.md) for isolated paused restore/reconciliation. An interrupted SSH session is not evidence that deployment did or did not finish: inspect host state before retrying.

## Production settings and private reports-group transition

The current one-tenant app cannot DM the external admin: a synthetic live message was rejected with code `230013`. Production now targets a private **Chat** group containing the operator and admin, with a signed custom bot. Use `REPORT_RECIPIENT_TYPE=chat_id`, the privately verified `REPORT_RECIPIENT_ID`, `REPORT_TRANSPORT=webhook` and `REMINDER_TRANSPORT=webhook`. Add a separate signed custom bot to the source group for reminders. Never publish real recipient identities or webhook URLs.

Static settings belong in root-owned `worker.env`; secrets belong in Doppler:

| Selection | Required secrets |
| --- | --- |
| All runs | `LARK_APP_SECRET` (source OAuth renewal and Doc API) |
| Report webhook | `REPORT_WEBHOOK_URL`, `REPORT_WEBHOOK_SIGNING_SECRET` |
| Reminder webhook | `REMINDER_WEBHOOK_URL`, `REMINDER_WEBHOOK_SIGNING_SECRET` |
| Brief publish + Gemini | `GEMINI_API_KEY` |
| Brief publish + DeepSeek | `DEEPSEEK_API_KEY` |

The helper clears inherited credentials and requests only that selection. A `prd`-scoped read-only service token must replace the preview token before production. Fetching happens at deployment; containers do not poll Doppler. Rotate a signing/model key and redeploy the same reviewed digest to load it. Force OAuth renewal against the canonical writable grant, not a copy of a rotating refresh token.

Production settings require `APP_MODE=production`, `ENABLE_OUTBOUND=true`, explicit `WORKER_RESTORE_MODE=true|false`, and a typed recipient. Start with restore mode **true**. Optional publication additionally needs `ENABLE_DAILY_BRIEF=true`, `BRIEF_MODE=publish`, matching activation/provider/model/version settings, private `LARK_DOC_STAGING_FOLDER_TOKEN` and tenant `LARK_DOCUMENT_BASE_URL` ending in `/docx/`. Status needs no model/webhook secrets; run validates them before opening storage. No reverse proxy or application ports are needed.

Existing group-only preview settings remain readable. A recipient change requires a stopped-worker scope review:

1. Stop the paused predecessor cleanly, preserving its container and persistent paths.
2. Prepare private `/opt/task-list/next-settings.env` with the new recipient and restore mode **true**; app/source/reader stay the same.
3. Run `sudo /opt/task-list/release-tool/scripts/review-recipient.sh --settings /opt/task-list/next-settings.env`.
4. The helper preserves prior settings, records the exact successor hash and predecessor ID, then atomically installs reviewed settings. It never edits SQLite or sends.
5. Deploy the reviewed immutable image through CI. Verify paused status, canonical OAuth renewal, both signed endpoints and private Doc access before a reviewed unpause/redeployment.

Frozen jobs keep their original destination. An attempted webhook delivery cannot switch endpoints; signing-key rotation at the same URL preserves its binding. An unknown receipt requires an evidenced operator decision, not a fresh UUID. Acceptance has no message ID and does not prove the recipient read it. Doc access is a separate API check; if group ACL verification fails, keep publication blocked and link sharing closed.

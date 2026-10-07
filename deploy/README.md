# Preview deployment setup

This is the repeatable host layout for `scripts/deploy.sh`. Sending and brief publication remain disabled. Follow the [deployment checklist](../DEPLOYMENT_CHECKLIST.md) in order; do not activate production by changing flags.

## Host layout

The deployment helper runs as root. Docker runs the worker as **UID/GID 1000:1000**, which is independent of the administrator's login account. The private parent directory prevents unrelated host users from reading its contents.

| Path | Owner / mode | Purpose |
| --- | --- | --- |
| `/opt/task-list` | root / 0700 | Private deployment root |
| `release-tool/scripts`, `release-tool/deploy` | root; directories 0755, scripts 0755, other files 0644 | Reviewed helper and fixed Compose definition; never writable by the deploy account |
| `worker.env` | root / 0600 | Non-secret settings; start from `worker.env.example` |
| `doppler.token` | root / 0600 | Read-only service token scoped to the preview Doppler config |
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

The repository is scoped to workspace **mbeka02**, project **task-list**, Preview config **`prv`**. The project and config exist, and secret presence has been verified without displaying its value in `prv`, `dev`, `stg` and `prd`. Server service-token provisioning is still pending. This preview package fetches only `LARK_APP_SECRET`. The configured app is `cli_aa366f7e9d78de2f`; keep its secret in Doppler, outside chat and Git.

Create a **read-only, `prv`-scoped service token** for the server and install it as `/opt/task-list/doppler.token` with the ownership above. Use explicit project/config selectors when administering secrets so another workspace's settings cannot be selected accidentally. The helper uses the service token scope and fetches only the app secret; it never injects the service token into the worker. Model credentials and production `prd` setup remain separate activation work. [Doppler service tokens](https://docs.doppler.com/docs/service-tokens)

## Deployment behavior

The public host command accepts only this repository's immutable image:

```bash
sudo /opt/task-list/release-tool/scripts/deploy.sh --image \
  ghcr.io/mbeka02/task-list-submission-automation@sha256:<64-lowercase-hex-characters>
```

1. Validate private paths and allowlisted settings; acquire the host lock.
2. Fetch only `LARK_APP_SECRET` through Doppler with fallback disabled; pull and inspect the image.
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

API scopes and network grants are separate: `auth_keys` allows runner enrollment; the grant below determines which server/port that enrolled runner can reach. Client ID, Audience and the verified target have been saved in GitHub's `preview` environment; credential scope, tags and claim restrictions still require dashboard verification before the first run.

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

Provision the locked-password `task-list-deploy` account with no Docker group membership and no writable shell startup files. Install the wrapper as root-owned `/usr/local/sbin/task-list-deploy-ssh`. Install the dedicated public key with `restrict` in root-owned `/etc/ssh/task-list-deploy.authorized_keys`; keep its private key only in the GitHub preview environment. Validate `sudoers-task-list` with `visudo -cf`, then install root-owned mode 0440 under `/etc/sudoers.d/`. Install `sshd-task-list.conf` under `/etc/ssh/sshd_config.d/`, run `sshd -t` and inspect the effective settings for this user before reloading SSH. Preserve the administrator's current connection and login rules.

The sudo argument glob is deliberately backed by strict validation in both wrapper and helper. Never grant `NOPASSWD: ALL`, `SETENV`, an arbitrary `env` command, or a writable helper. SSH configuration disables shells/TTY, forwarding and user RC files; the shell script alone cannot enforce SSH forwarding policy. Test a second connection before closing the administrator's session:

```bash
ssh -i <dedicated-key> -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=<verified-known-hosts> task-list-deploy@<tailscale-host> check
```

This check proves the restricted SSH entry point, not application readiness. Attempt an arbitrary command and forwarding separately and confirm denial before the first deploy.

## Release sequence

1. Merge the reviewed branch; observe hosted **CI**.
2. Run **Publish tested image** on main. It builds once, runs container/deployment acceptance against that image, pushes it and records the digest. Choose GHCR visibility or provision a server-side read-only pull credential first.
3. Configure the preview environment, tailnet grant, restricted SSH role, Doppler and persistent paths. Prove the SSH connectivity check before replacement.
4. Run **Deploy preview** from main using only the digest from the successful publisher. Review the target/digest at the environment approval gate.
5. Inspect local status and Pino logs on the server, then perform the separately approved reader/OAuth checks.

The deploy workflow does not copy source, install privileged tooling or bootstrap access. It contacts the existing host helper through Tailscale; the server pulls the image over HTTPS. Host setup and actual hosted runs are still outstanding.

For a failed deployment, find its run ID and finite phase in the audit. Failures before `stop` leave the current worker alone; failures after `stop` need operator inspection. Preserve the ledger and rotating grant. Review schema compatibility before any image rollback, and use the [runbook](../RUNBOOK.md) for isolated paused restore/reconciliation. An interrupted SSH session is not evidence that deployment did or did not finish: inspect host state before retrying.

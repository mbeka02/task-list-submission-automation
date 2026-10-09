# Worker log collection

The worker writes structured Pino events to stderr. A separate Grafana Alloy
container forwards those events to Grafana Cloud Logs over HTTPS. It requires
no public ports, reverse proxy or changes to the worker image.

Questions this answers:

- Did a scheduled check run, and what happened to the report and brief?
- Which provider, credential or delivery stage failed?
- Did the AI brief use the source-extract fallback?
- How long did each model, document and delivery operation take?

## Install or rotate credentials

In the production Doppler configuration, set `GRAFANA_LOKI_URL`,
`GRAFANA_LOKI_USERNAME` and `GRAFANA_LOKI_TOKEN`. The token needs `logs:write`
for the selected Grafana Cloud stack; Grafana's predefined `set:alloy-data-write`
bundle also supplies the required telemetry access. It belongs only to the collector.

## Live acceptance — 8 October 2026

The separate production collector is running. An empty authenticated upload and
the worker-event batches returned HTTP 204; acceptance observed 29 uploaded
entries and zero dropped entries after authentication recovery. The worker's
container ID and start time remained unchanged. No ports were published.

The initial credential returned HTTP 401. The collector was stopped while it was
corrected; its failed source-position state was preserved separately, then a
fresh state directory reread the retained Docker history after the first valid
credential passed. Ordinary updates retain the current state directory.

Alerts are deferred by the operator. View logs through Explore using the query
below; successful upload has been verified through the collector's HTTP outcome
and sent-entry counters, not through a Grafana UI readback.

Create `/opt/task-list-observability-settings.json` as root, mode `0600`:

```json
{
  "environment": "production",
  "collectorRoot": "/opt/task-list-observability",
  "dopplerTokenFile": "/opt/task-list/doppler.token",
  "sourceProject": "task-list",
  "containerName": "task-list-alloy"
}
```

Install the reviewed `scripts/install-log-collector.sh`, `scripts/log-collector.py`
and `deploy/config.alloy` together in a root-owned directory, retaining the
relative `scripts/` and `deploy/` layout. Then run:

```bash
sudo scripts/install-log-collector.sh --settings /opt/task-list-observability-settings.json
```

The helper serializes collector updates, fetches only the three telemetry
credentials, pulls the pinned official Alloy image, validates the configuration,
then replaces only the collector and checks readiness. If replacement fails,
it restarts the retained predecessor. It does not restart the worker or touch
SQLite, OAuth credentials, task content or report-delivery state.

Before pulling or replacing anything, it authenticates an empty Loki upload
(`{"streams":[]}`). A rejected credential blocks the update and leaves the
predecessor untouched. Redirects are disabled so upload credentials cannot be
forwarded to another endpoint.

The upload token is a private, read-only bind-mounted file, rather than a
container environment variable. The collector receives Docker socket access;
that access is effectively privileged even though the socket mount is read-only.
It receives no worker storage mounts, published ports or Doppler service token.

Source selection uses both Compose labels: project `task-list`, service `worker`.
Stdout command results, malformed JSON and lines without an `event` field are
excluded. Original event JSON remains available for searching; run IDs are not
indexed as labels. Application instrumentation must continue to exclude secrets
and employee content; collection is not an independent arbitrary-field redactor.

## Find logs

Open Grafana **Explore**, select the provisioned Loki data source, and run:

```logql
{service_name="task-list", environment="production"} | json
```

Filter an execution or errors:

```logql
{service_name="task-list", environment="production"} | json | runId="COPY_RUN_ID"
{service_name="task-list", environment="production"} | json | level=~"error|fatal"
```

The application's Pino formatter emits **string** levels: `info`, `warn`, `error`, `fatal`. For attention filters use `| level=~"warn|error|fatal"`, not a numeric comparison. `headingReviewCount` and `reviewRequired` keep uncounted names-report candidates visible after successful delivery.
The integration's default Docker dashboard may expect `job="integrations/docker"`;
these intentionally scoped labels are best queried through Explore or a custom
worker dashboard.

## Retention and failure limits

Docker retains at most three 10 MB worker log files. Alloy's persisted positions
live in `/opt/task-list-observability/state`. Keep component names and that path
stable when upgrading. Position persistence is not exactly-once delivery;
duplicates and gaps remain possible around crashes and rotation.

The stable Loki writer retries temporary failures with bounded backoff. Its
pending batches are in memory; this configuration does not enable Alloy's
experimental Loki WAL. Restarting during an upload outage can lose pending
batches, and an extended outage can exhaust retries or outlast Docker retention.
Logs supplement the SQLite business ledger; they do not replace it.

If an initial upload fails authentication, stop only `task-list-alloy` while
correcting the Doppler token. The worker keeps running and Docker retains its
local logs. If no upload has ever succeeded, an operator may preserve the failed
collector state directory under a different name before restarting collection
with a fresh state directory to reread retained local history. Do not reset
positions during ordinary upgrades; doing so can create duplicate cloud logs.

Collector readiness confirms a valid running pipeline, not successful cloud
ingestion. Live acceptance must also confirm sent-entry counters rise and events
appear in Grafana. Authentication failures and dropped-entry counters require
investigation.

## Alert setup

After verifying ingestion, configure and test an email contact point. Add
actionable error/review-required alerts and a separate collector/worker silence
alert. Link each alert to [the runbook](../RUNBOOK.md).

Scheduled missing-report alerts must account for Nairobi working dates,
the approved holiday calendar and activation. Absence of a success log alone
cannot distinguish a stopped worker from a stopped collector. Such alerts are
not enabled by installing the collector.

## Validate changes

```bash
sudo env RUN_DOCKER_ACCEPTANCE=true LOG_TEST_SOURCE_IMAGE=task-list-ci:current \
  python3 tests/acceptance/log_collector_test.py
```

This uses real Docker containers and the pinned Alloy image against a synthetic
local HTTP receiver. It sends no employee data and does not contact Grafana.

References: [Docker source](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.docker/),
[Loki writer](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.write/).

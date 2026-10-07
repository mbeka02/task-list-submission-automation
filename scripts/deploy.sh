#!/usr/bin/env bash
# Public host deployment boundary. Accept immutable images from this repository only.
set -Eeuo pipefail
umask 077
export TASK_LIST_DEPLOYMENT_ID
TASK_LIST_DEPLOYMENT_ID=$(cat /proc/sys/kernel/random/uuid)
started_ms=$(date +%s%3N)
image=""
audit=""
# Answer which release ran, how long it took, and where it failed, without raw tool output.
event() {
  local now_ms record
  now_ms=$(date +%s%3N)
  record=$(printf '{"time":"%s","level":"%s","event":"%s","entryPoint":"deployment_cli","runId":"%s","image":"%s","durationMs":%s,"actorUid":%s,"reason":"%s"}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$TASK_LIST_DEPLOYMENT_ID" "$image" "$((now_ms-started_ms))" "$(id -u)" "${3:-}")
  printf '%s\n' "$record" >&2
  if [[ -n $audit ]]; then printf '%s\n' "$record" >> "$audit"; fi
}
if [[ $# != 2 || $1 != --image || ! $2 =~ ^ghcr\.io/mbeka02/task-list-submission-automation@sha256:[a-f0-9]{64}$ ]]; then
  event error deployment_failed invalid_image
  exit 2
fi
image=$2
export TASK_LIST_DEPLOY_ROOT=${TASK_LIST_DEPLOY_ROOT:-/opt/task-list}
export TASK_LIST_COMPOSE_PROJECT=${TASK_LIST_COMPOSE_PROJECT:-task-list}
# Candidate settings belong only to the separate administrator review command.
unset TASK_LIST_SETTINGS_FILE
if ! settings=$(python3 -I "$(dirname "$0")/deploy-settings.py" 2>/dev/null); then
  event error deployment_failed configuration
  exit 2
fi
read -r TASK_LIST_PROFILE secret_names <<< "$settings"
export TASK_LIST_PROFILE
exec 9>"$TASK_LIST_DEPLOY_ROOT/.deploy.lock"
if ! flock --nonblock 9; then
  event warn deployment_failed deployment_busy
  exit 75
fi
audit="$TASK_LIST_DEPLOY_ROOT/deployments.jsonl"
event info deployment_started
# Clear inherited secrets; only the approved selection may reach the replacement worker.
unset LARK_APP_SECRET GEMINI_API_KEY DEEPSEEK_API_KEY REPORT_WEBHOOK_URL REPORT_WEBHOOK_SIGNING_SECRET REMINDER_WEBHOOK_URL REMINDER_WEBHOOK_SIGNING_SECRET
# The service token is never forwarded to the worker.
export DOPPLER_TOKEN
DOPPLER_TOKEN=$(<"$TASK_LIST_DEPLOY_ROOT/doppler.token")
rm -f "$TASK_LIST_DEPLOY_ROOT/.deployment-failure"
# Discard raw third-party diagnostics; the helper records only a finite phase name.
if doppler run --silent --no-check-version --no-fallback --only-secrets "$secret_names" -- \
  bash "$(dirname "$0")/deploy-apply.sh" "$2" 2>/dev/null; then
  event info deployment_ready
  exit 0
fi
reason=secret_fetch
if [[ -f $TASK_LIST_DEPLOY_ROOT/.deployment-failure ]]; then
  reason=$(<"$TASK_LIST_DEPLOY_ROOT/.deployment-failure")
fi
case $reason in
  pull|preflight|configuration|existing_worker|stop|backup|missing_predecessor|start|readiness|secret_fetch) ;;
  *) reason=deployment_failed ;;
esac
event error deployment_failed "$reason"
exit 1

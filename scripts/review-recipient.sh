#!/usr/bin/env bash
# Administrator-only scope transition. This never sends, starts a worker or edits SQLite.
set -Eeuo pipefail
umask 077
if [[ $# != 2 || $1 != --settings ]]; then exit 2; fi
export TASK_LIST_DEPLOY_ROOT=${TASK_LIST_DEPLOY_ROOT:-/opt/task-list}
export TASK_LIST_COMPOSE_PROJECT=${TASK_LIST_COMPOSE_PROJECT:-task-list}
export TASK_LIST_SETTINGS_FILE=$2
# Validate the private root before opening its deployment lock; revalidate under the lock below.
if ! python3 -I "$(dirname "$0")/deploy-settings.py" >/dev/null 2>&1; then
  printf '{"status":"blocked","reason":"recipient_review_required"}\n' >&2
  exit 2
fi
exec 9>"$TASK_LIST_DEPLOY_ROOT/.deploy.lock"
if ! flock --nonblock 9; then exit 75; fi
if python3 -I "$(dirname "$0")/review-recipient.py" 2>/dev/null; then
  printf '{"status":"recipient_reviewed","workerStopped":true,"ledgerPreserved":true}\n'
else
  printf '{"status":"blocked","reason":"recipient_review_required"}\n' >&2
  exit 2
fi

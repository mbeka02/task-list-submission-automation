#!/usr/bin/env bash
# Private implementation invoked after Doppler has fetched the approved secret.
set -Eeuo pipefail
umask 077
unset DOPPLER_TOKEN
image=$1
phase=pull
failed() {
  local result=$?
  trap - ERR
  printf '%s' "$phase" > "$TASK_LIST_DEPLOY_ROOT/.deployment-failure"
  # Leave a failed replacement stopped. Never restore an old snapshot or retry sends.
  if [[ $phase == start || $phase == readiness ]]; then
    "${compose[@]}" stop worker >/dev/null 2>&1 || true
  fi
  exit "$result"
}
trap failed ERR
docker pull "$image" >/dev/null 2>&1
TASK_LIST_IMAGE=$(docker image inspect --format '{{.Id}}' "$image")
export TASK_LIST_IMAGE
[[ $TASK_LIST_IMAGE =~ ^sha256:[a-f0-9]{64}$ ]]
compose=(docker compose --project-name "$TASK_LIST_COMPOSE_PROJECT" --file "$(dirname "$0")/../deploy/compose.preview.yaml")
phase=preflight
"${compose[@]}" run --rm --no-deps worker node dist/preflight.js >/dev/null 2>&1
phase=configuration
"${compose[@]}" run --rm --no-deps \
  --volume "$(realpath "$(dirname "$0")/deploy-probe.mjs"):/app/deployment-probe.mjs:ro" \
  worker node deployment-probe.mjs >/dev/null 2>&1
previous=$("${compose[@]}" ps --all --quiet worker)
backup=""
if [[ -n $previous ]]; then
  phase=existing_worker
  docker inspect "$previous" | python3 -I "$(dirname "$0")/deploy-existing.py" >/dev/null 2>&1
  predecessor=$(docker inspect --format '{{.Image}}' "$previous")
  phase=stop
  "${compose[@]}" stop worker >/dev/null 2>&1
  [[ $(docker inspect --format '{{.State.ExitCode}}' "$previous") == 0 ]]
  if [[ -f $TASK_LIST_DEPLOY_ROOT/ledger/task-list.sqlite ]]; then
    phase=backup
    backup="$(date -u +%Y%m%dT%H%M%S)-$$.sqlite"
    # Use the stopped predecessor's migration level, never the incoming release.
    docker run --rm --pull never --network none --read-only --cap-drop ALL \
      --security-opt no-new-privileges --user 1000:1000 \
      --mount "type=bind,src=$TASK_LIST_DEPLOY_ROOT/ledger,dst=/data" \
      --mount "type=bind,src=$TASK_LIST_DEPLOY_ROOT/backups,dst=/backups" \
      --env SQLITE_FILE_PATH=/data/task-list.sqlite \
      "$predecessor" node dist/storage-command.js backup --output "/backups/$backup" >/dev/null 2>&1
  fi
elif [[ -e $TASK_LIST_DEPLOY_ROOT/ledger/task-list.sqlite ]]; then
  phase=missing_predecessor
  false
fi
phase=start
"${compose[@]}" up --detach --no-build --pull never --force-recreate worker >/dev/null 2>&1
phase=readiness
for ((attempt=0; attempt<30; attempt++)); do
  if "${compose[@]}" exec --no-TTY worker node dist/worker-command.js status 2>/dev/null |
    python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(0 if v.get("status") in ("ok", "paused") and v.get("outboundEnabled") is False else 1)' 2>/dev/null; then
    printf '{"status":"ready","mode":"preview","image":"%s","backup":"%s","runId":"%s"}\n' "$image" "$backup" "$TASK_LIST_DEPLOYMENT_ID"
    exit 0
  fi
  sleep 1
done
false

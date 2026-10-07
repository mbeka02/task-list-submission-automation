#!/usr/bin/env bash
# Forced-command entry point for the unprivileged deployment account, never a shell.
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
command=${SSH_ORIGINAL_COMMAND:-}
if [[ $command == check ]]; then
  printf '%s\n' '{"status":"ready","entryPoint":"deployment_ssh"}'
  exit 0
fi
pattern='^deploy --image ghcr\.io/mbeka02/task-list-submission-automation@sha256:[a-f0-9]{64}$'
if [[ $command =~ $pattern ]]; then
  # Do not let SSH environment settings choose Docker targets, paths or secret sources.
  for name in "${!TASK_LIST_@}" "${!DOPPLER_@}" "${!DOCKER_@}" "${!COMPOSE_@}"; do
    if [[ -n $name ]]; then unset "$name"; fi
  done
  unset BASH_ENV ENV PYTHONPATH PYTHONOPTIMIZE NODE_OPTIONS
  exec /usr/bin/sudo -n -- /opt/task-list/release-tool/scripts/deploy.sh \
    --image "${command#deploy --image }"
fi
printf '%s\n' '{"event":"deployment_failed","entryPoint":"deployment_ssh","reason":"invalid_ssh_command"}' >&2
exit 2

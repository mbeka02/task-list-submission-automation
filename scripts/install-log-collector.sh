#!/usr/bin/env bash
# Separate host boundary: this helper never invokes the worker deployment helper.
set -Eeuo pipefail
umask 077
exec python3 -I "$(dirname "$0")/log-collector.py" "$@"

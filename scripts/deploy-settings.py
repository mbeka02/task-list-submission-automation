"""Validate administrator-owned deployment inputs without printing their contents."""
import os
from pathlib import Path
import re
import stat


def regular_private(path, owner, directory=False):
    info = path.lstat()
    assert info.st_uid == owner and info.st_mode & 0o077 == 0
    assert stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)


root = Path(os.environ["TASK_LIST_DEPLOY_ROOT"])
assert re.fullmatch(r"/[A-Za-z0-9_./-]+", str(root))
assert root.resolve() == root
assert re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,60}", os.environ["TASK_LIST_COMPOSE_PROJECT"])
regular_private(root, os.geteuid(), directory=True)
for name in ("worker.env", "doppler.token"):
    regular_private(root / name, os.geteuid())
regular_private(root / "calendar.json", 1000)
for name in ("ledger", "credentials", "backups"):
    regular_private(root / name, 1000, directory=True)
grant = root / "credentials/user-oauth.json"
if grant.exists() or grant.is_symlink():
    regular_private(grant, 1000)
for name in ("task-list.sqlite", "task-list.sqlite-wal", "task-list.sqlite-shm", "task-list.sqlite-restore-review.json"):
    path = root / "ledger" / name
    if path.exists() or path.is_symlink():
        regular_private(path, 1000)

required = {"LARK_APP_ID", "SOURCE_CHAT_ID", "MANAGEMENT_CHAT_ID", "ACTIVATION_DATE", "LARK_READER_OPEN_ID"}
allowed = required | {"POLICY_VERSION", "LOG_LEVEL", "WORKER_CHECK_INTERVAL_MS", "WORKER_RESTORE_MODE"}
fixed = {"APP_MODE": "preview", "ENABLE_OUTBOUND": "false", "ENABLE_DAILY_BRIEF": "false", "BUSINESS_TIMEZONE": "Africa/Nairobi"}
values = {}
for line in (root / "worker.env").read_text().splitlines():
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    key, separator, value = line.partition("=")
    assert separator and key not in values and key in allowed | fixed.keys()
    assert value and "\x00" not in value
    if key in fixed:
        assert value == fixed[key]
    values[key] = value
assert required <= values.keys()

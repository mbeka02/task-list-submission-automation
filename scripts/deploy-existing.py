"""Refuse an upgrade that would change persistent paths or the worker's approved scope."""
import json
import os
from pathlib import Path
import sys
import hashlib
import stat

containers = json.load(sys.stdin)
assert len(containers) == 1
container = containers[0]
root = Path(os.environ["TASK_LIST_DEPLOY_ROOT"])
mounts = {mount["Destination"]: mount for mount in container["Mounts"]}
for name, destination in (("ledger", "/data"), ("credentials", "/credentials")):
    mount = mounts[destination]
    assert mount["Type"] == "bind" and mount["RW"]
    assert Path(mount["Source"]) == root / name
environment = dict(item.split("=", 1) for item in container["Config"]["Env"])
assert (environment["APP_MODE"], environment["ENABLE_OUTBOUND"]) in (("preview", "false"), ("production", "true"))
assert container["Config"]["User"] == "1000:1000"
settings = dict(line.split("=", 1) for line in (root / "worker.env").read_text().splitlines() if line.strip() and not line.lstrip().startswith("#"))
for name in ("LARK_APP_ID", "SOURCE_CHAT_ID", "LARK_READER_OPEN_ID"):
    assert environment[name] == settings[name]


def recipient(values):
    if "REPORT_RECIPIENT_TYPE" in values or "REPORT_RECIPIENT_ID" in values:
        assert not values.get("MANAGEMENT_CHAT_ID")
        return (values["REPORT_RECIPIENT_TYPE"], values["REPORT_RECIPIENT_ID"])
    return ("chat_id", values["MANAGEMENT_CHAT_ID"])

# A release upgrade may change configuration spelling, never the approved recipient.
if recipient(environment) != recipient(settings):
    review_path=root/"recipient-review.json"
    info=review_path.lstat()
    assert stat.S_ISREG(info.st_mode) and info.st_uid==os.geteuid() and info.st_mode & 0o077 == 0
    review=json.loads(review_path.read_text())
    assert not container["State"]["Running"]
    assert review["version"]==1 and review["predecessorId"]==container["Id"]
    assert tuple(review["from"])==recipient(environment) and tuple(review["to"])==recipient(settings)
    assert review["settingsHash"]==hashlib.sha256((root/"worker.env").read_bytes()).hexdigest()
    for name in ("LARK_APP_ID", "SOURCE_CHAT_ID", "LARK_READER_OPEN_ID"):
        assert review["scope"][name]==environment[name]==settings[name]

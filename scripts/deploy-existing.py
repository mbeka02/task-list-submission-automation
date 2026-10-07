"""Refuse an upgrade that would change persistent paths or the worker's approved scope."""
import json
import os
from pathlib import Path
import sys

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
assert environment["APP_MODE"] == "preview" and environment["ENABLE_OUTBOUND"] == "false"
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
assert recipient(environment) == recipient(settings)

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

required = {"LARK_APP_ID", "SOURCE_CHAT_ID", "ACTIVATION_DATE", "LARK_READER_OPEN_ID"}
allowed = required | {"APP_MODE", "ENABLE_OUTBOUND", "ENABLE_DAILY_BRIEF", "BRIEF_MODE", "BRIEF_ACTIVATION_DATE", "BRIEF_PROVIDER", "GEMINI_MODEL", "DEEPSEEK_MODEL", "BRIEF_TEMPLATE_VERSION", "BRIEF_PROMPT_VERSION", "BRIEF_SCHEMA_VERSION", "LARK_DOC_STAGING_FOLDER_TOKEN", "LARK_DOCUMENT_BASE_URL","MANAGEMENT_CHAT_ID", "REPORT_RECIPIENT_TYPE", "REPORT_RECIPIENT_ID", "REPORT_TRANSPORT", "REMINDER_TRANSPORT", "POLICY_VERSION", "LOG_LEVEL", "WORKER_CHECK_INTERVAL_MS", "WORKER_RESTORE_MODE"}
fixed = {"APP_MODE": "preview", "ENABLE_OUTBOUND": "false", "ENABLE_DAILY_BRIEF": "false", "BUSINESS_TIMEZONE": "Africa/Nairobi"}
values = {}
settings=Path(os.environ.get("TASK_LIST_SETTINGS_FILE", str(root/"worker.env")))
assert settings.parent==root and settings.resolve()==settings
regular_private(settings, os.geteuid())
for line in settings.read_text().splitlines():
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    key, separator, value = line.partition("=")
    assert separator and key not in values and key in allowed | fixed.keys()
    assert value and "\x00" not in value
    values[key] = value
assert required <= values.keys()

if "REPORT_RECIPIENT_TYPE" in values or "REPORT_RECIPIENT_ID" in values:
    assert "MANAGEMENT_CHAT_ID" not in values
    assert values.get("REPORT_RECIPIENT_TYPE") in ("chat_id", "open_id")
    pattern = r"ou_[A-Za-z0-9_]+" if values["REPORT_RECIPIENT_TYPE"] == "open_id" else r"oc_[A-Za-z0-9_]+"
    assert re.fullmatch(pattern, values.get("REPORT_RECIPIENT_ID", ""))
else:
    assert re.fullmatch(r"oc_[A-Za-z0-9_]+", values.get("MANAGEMENT_CHAT_ID", ""))

mode=values.get("APP_MODE", "preview")
assert mode in ("preview", "production")
assert values.get("BUSINESS_TIMEZONE", "Africa/Nairobi")=="Africa/Nairobi"
secrets="LARK_APP_SECRET"
for transport in ("REPORT_TRANSPORT", "REMINDER_TRANSPORT"):
    assert values.get(transport, "app_bot") in ("app_bot", "webhook")
assert values.get("REPORT_TRANSPORT") != "webhook" or values.get("REPORT_RECIPIENT_TYPE") == "chat_id"
if mode=="preview":
    assert values.get("ENABLE_OUTBOUND", "false")=="false"
    assert values.get("ENABLE_DAILY_BRIEF", "false")=="false"
else:
    assert values.get("ENABLE_OUTBOUND")=="true"
    assert values.get("WORKER_RESTORE_MODE") in ("true", "false")
    assert "REPORT_RECIPIENT_TYPE" in values and "MANAGEMENT_CHAT_ID" not in values
    for prefix in ("REPORT", "REMINDER"):
        if values.get(prefix+"_TRANSPORT") == "webhook":
            secrets+=","+prefix+"_WEBHOOK_URL,"+prefix+"_WEBHOOK_SIGNING_SECRET"
    assert values.get("ENABLE_DAILY_BRIEF", "false") in ("true", "false")
    if values.get("ENABLE_DAILY_BRIEF")=="true":
        assert values.get("BRIEF_MODE") in ("capture_only", "publish")
        assert values.get("BRIEF_PROVIDER") in ("gemini", "deepseek")
        if values["BRIEF_MODE"]=="publish":
            secrets+=",GEMINI_API_KEY" if values["BRIEF_PROVIDER"]=="gemini" else ",DEEPSEEK_API_KEY"
print(mode+" "+secrets)

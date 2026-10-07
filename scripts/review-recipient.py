"""Bind a reviewed destination change to one stopped predecessor and private settings."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

root=Path(os.environ["TASK_LIST_DEPLOY_ROOT"])
source=Path(os.environ["TASK_LIST_SETTINGS_FILE"])
assert source!=root/"worker.env"
subprocess.run([sys.executable,"-I",str(Path(__file__).with_name("deploy-settings.py"))],check=True,stdout=subprocess.DEVNULL)
ids=subprocess.check_output(["docker","ps","--all","--quiet","--filter","label=com.docker.compose.project="+os.environ["TASK_LIST_COMPOSE_PROJECT"],"--filter","label=com.docker.compose.service=worker"],text=True).split()
assert len(ids)==1
container=json.loads(subprocess.check_output(["docker","inspect",ids[0]]))[0]
assert not container["State"]["Running"] and container["State"]["ExitCode"]==0
previous=dict(v.split("=",1) for v in container["Config"]["Env"])
settings=dict(line.split("=",1) for line in source.read_text().splitlines() if line.strip() and not line.lstrip().startswith("#"))
# The privileged settings review authorizes only a destination change, never a new app/reader/source.
scope={}
for name in ("LARK_APP_ID","SOURCE_CHAT_ID","LARK_READER_OPEN_ID"):
    assert previous[name]==settings[name]
    scope[name]=settings[name]
assert previous.get("WORKER_RESTORE_MODE")=="true"
assert settings.get("WORKER_RESTORE_MODE")=="true"
old=(previous.get("REPORT_RECIPIENT_TYPE","chat_id"),previous.get("REPORT_RECIPIENT_ID",previous.get("MANAGEMENT_CHAT_ID")))
new=(settings["REPORT_RECIPIENT_TYPE"],settings["REPORT_RECIPIENT_ID"])
assert old!=new
for mount in (("/data","ledger"),("/credentials","credentials")):
    matches=[m for m in container["Mounts"] if m["Destination"]==mount[0]]
    assert len(matches)==1 and matches[0]["Type"]=="bind" and matches[0]["RW"] and Path(matches[0]["Source"])==root/mount[1]
current=root/"worker.env"
backup=root/("recipient-settings-before-"+str(uuid.uuid4())+".env")
backup.write_bytes(current.read_bytes()); os.chmod(backup,0o600)
body=source.read_bytes()
record={"version":1,"predecessorId":container["Id"],"from":old,"to":new,"scope":scope,"settingsHash":hashlib.sha256(body).hexdigest()}
# Keep the review journal private, and atomically replace settings only after recording its exact hash.
def save(path,body):
    pending=path.with_name(path.name+".new-"+str(uuid.uuid4()))
    fd=os.open(pending,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,"wb") as out:
        out.write(body); out.flush(); os.fsync(out.fileno())
    os.replace(pending,path)
save(root/"recipient-review.json",json.dumps(record).encode())
save(current,body)
fd=os.open(root,os.O_RDONLY)
try: os.fsync(fd)
finally: os.close(fd)

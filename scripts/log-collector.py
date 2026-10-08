"""Install a pinned, worker-only collector without modifying the worker."""
import fcntl
import base64
import json
import ipaddress
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
import uuid

IMAGE = "grafana/alloy@sha256:2aa2099af76c0098d4af7a4d6e48f86cb66dc1a000222ad927a1c67c6542d13f"
SECRET_NAMES = "GRAFANA_LOKI_URL,GRAFANA_LOKI_USERNAME,GRAFANA_LOKI_TOKEN"
RUN_ID = str(uuid.uuid4())
STARTED = time.monotonic()
PHASE = "configuration"


def event(name, level="info"):
    print(json.dumps({"level": level, "event": name, "entryPoint": "collector_install",
                      "runId": RUN_ID, "phase": PHASE,
                      "durationMs": round((time.monotonic() - STARTED) * 1000)}), file=sys.stderr)


def command(*args, **options):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, text=True, **options).strip()


def private_file(path):
    path = Path(path)
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("unsafe_private_file")
    return path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward an upload credential to a redirected endpoint."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "--settings":
        raise ValueError("invalid_arguments")
    settings = json.loads(private_file(sys.argv[2]).read_text())
    if set(settings) != {"environment", "collectorRoot", "dopplerTokenFile", "sourceProject", "containerName"}:
        raise ValueError("invalid_settings")
    testing = settings["environment"] == "test"
    if settings["environment"] not in {"test", "production"} or os.getuid() != 0:
        raise ValueError("invalid_environment")
    project, name = settings["sourceProject"], settings["containerName"]
    if not all(isinstance(v, str) and re.fullmatch(r"[a-z][a-z0-9-]{1,62}", v) for v in [project, name]):
        raise ValueError("invalid_container_binding")
    if not testing and (project != "task-list" or name != "task-list-alloy"):
        raise ValueError("invalid_production_binding")
    root = Path(settings["collectorRoot"])
    if not root.is_absolute() or root == Path("/") or any(p.is_symlink() for p in [root, *root.parents]):
        raise ValueError("unsafe_collector_root")
    if not testing and root != Path("/opt/task-list-observability"):
        raise ValueError("invalid_production_root")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.stat().st_uid != 0 or root.stat().st_mode & 0o077:
        raise ValueError("unsafe_collector_root")
    with (root / ".install.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        install(settings, root, project, name, testing)


def install(settings, root, project, name, testing):
    global PHASE
    # Only the selected telemetry credentials are fetched. Neither Doppler nor worker secrets reach Docker.
    environment = dict(os.environ)
    environment["DOPPLER_TOKEN"] = private_file(settings["dopplerTokenFile"]).read_text().strip()
    for key in SECRET_NAMES.split(","):
        environment.pop(key, None)
    PHASE = "secret_fetch"
    payload = command("doppler", "run", "--silent", "--no-check-version", "--no-fallback",
                      "--only-secrets", SECRET_NAMES, "--", "python3", "-I", "-c",
                      "import os,json; print(json.dumps({k:os.environ[k] for k in "
                      "['GRAFANA_LOKI_URL','GRAFANA_LOKI_USERNAME','GRAFANA_LOKI_TOKEN']}))",
                      env=environment)
    secrets = json.loads(payload)
    url, username, token = (secrets[k] for k in SECRET_NAMES.split(","))
    parsed = urllib.parse.urlsplit(url)
    production_url = (parsed.scheme == "https" and re.fullmatch(r"logs-[a-z0-9-]+\.grafana\.net", parsed.hostname or "")
                      and parsed.port in {None, 443})
    fixture_url = False
    if testing and parsed.scheme == "http":
        try:
            fixture_url = ipaddress.ip_address(parsed.hostname).is_private
        except ValueError:
            pass
    if not (production_url or fixture_url) or parsed.path != "/loki/api/v1/push" or parsed.query or parsed.fragment or parsed.username:
        raise ValueError("invalid_logs_endpoint")
    if not re.fullmatch(r"[0-9]+", username) or not token or "\n" in token:
        raise ValueError("invalid_logs_credentials")
    # Authenticate a content-free upload before replacing the collector or advancing read positions.
    PHASE = "upload_access"
    authorization = base64.b64encode((username + ":" + token).encode()).decode()
    request = urllib.request.Request(url, data=b'{"streams":[]}', method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": "Basic " + authorization})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=10) as response:
        if response.status != 204:
            raise ValueError("upload_access_rejected")
    PHASE = "pull"
    command("docker", "pull", IMAGE)
    release = root / ("release-" + uuid.uuid4().hex)
    release.mkdir(mode=0o700)
    state = root / "state"
    state.mkdir(mode=0o700, exist_ok=True)
    config = Path(__file__).resolve().parent.parent / "deploy" / "config.alloy"
    generated = config.read_text().replace("SOURCE_PROJECT", project).replace("LOGS_URL", json.dumps(url)).replace("LOGS_USERNAME", json.dumps(username))
    (release / "config.alloy").write_text(generated)
    (release / "token").write_text(token)
    (release / "token").chmod(0o600)
    mounts = ["--mount", f"type=bind,src={release},dst=/etc/task-list-alloy,readonly"]
    previous = None
    renamed = False
    created = False
    stopped = False
    try:
        # Validate offline before touching a predecessor. Store credentials as a private bind-mounted file, not container environment.
        PHASE = "validate"
        command("docker", "run", "--rm", "--network", "none", *mounts, IMAGE,
                "validate", "/etc/task-list-alloy/config.alloy")
        existing = subprocess.run(["docker", "inspect", name], capture_output=True, text=True)
        if existing.returncode == 0:
            previous = json.loads(existing.stdout)[0]
            if previous["Config"].get("Labels", {}).get("task-list.role") != "log-collector":
                raise ValueError("unrecognized_predecessor")
            # Stop and retain the predecessor until the replacement has passed readiness.
            PHASE = "replace"
            command("docker", "stop", "--time", "30", name)
            stopped = True
            command("docker", "rename", name, name + "-previous")
            renamed = True
        PHASE = "start"
        created = True
        command("docker", "run", "-d", "--name", name, "--label", "task-list.role=log-collector",
                "--restart", "unless-stopped", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges:true", "--memory", "256m", "--pids-limit", "64",
                "--log-driver", "json-file", "--log-opt", "max-size=5m", "--log-opt", "max-file=2",
                "--add-host", "host.docker.internal:host-gateway", *mounts,
                "--mount", f"type=bind,src={state},dst=/var/lib/alloy",
                "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly",
                IMAGE, "run", "--server.http.listen-addr=0.0.0.0:12345", "--storage.path=/var/lib/alloy",
                "/etc/task-list-alloy/config.alloy")
        PHASE = "readiness"
        deadline = time.monotonic() + 20
        while True:
            inspected = json.loads(command("docker", "inspect", name))[0]
            address = next(iter(inspected["NetworkSettings"]["Networks"].values()))["IPAddress"]
            try:
                with urllib.request.urlopen(f"http://{address}:12345/-/ready", timeout=2) as response:
                    if response.status == 200:
                        break
            except (OSError, ValueError):
                pass
            if not inspected["State"]["Running"] or time.monotonic() >= deadline:
                raise ValueError("collector_not_ready")
            time.sleep(0.2)
        if renamed:
            command("docker", "rm", name + "-previous")
            old_mount = next((m["Source"] for m in previous["Mounts"] if m["Destination"] == "/etc/task-list-alloy"), None)
            if old_mount and Path(old_mount).parent == root and Path(old_mount).name.startswith("release-"):
                shutil.rmtree(old_mount)
        print(json.dumps({"status": "ready", "container": name, "image": IMAGE, "workerChanged": False}))
        event("collector_install_completed")
    except Exception:
        # Roll back only the collector; its state directory remains intact.
        if renamed:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
            command("docker", "rename", name + "-previous", name)
            command("docker", "start", name)
        elif created:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        elif stopped:
            command("docker", "start", name)
        shutil.rmtree(release)
        raise


if __name__ == "__main__":
    os.umask(0o077)
    event("collector_install_started")
    try:
        main()
    except Exception:
        # Never echo provider diagnostics, endpoint credentials or configuration values.
        event("collector_install_failed", "error")
        sys.exit(1)

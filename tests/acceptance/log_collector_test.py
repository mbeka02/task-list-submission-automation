"""Exercise the installer through real Docker and a synthetic Loki HTTP boundary.

Run explicitly with RUN_DOCKER_ACCEPTANCE=true; this suite never calls Grafana.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid


def uncompress(data):
    """Decode the raw Snappy payload used by Loki's public push protocol."""
    offset = 0
    while data[offset] & 128:
        offset += 1
    offset += 1
    output = bytearray()
    while offset < len(data):
        tag = data[offset]
        offset += 1
        kind = tag & 3
        if kind == 0:
            length = tag >> 2
            if length >= 60:
                count = length - 59
                length = int.from_bytes(data[offset:offset + count], "little")
                offset += count
            length += 1
            output.extend(data[offset:offset + length])
            offset += length
        else:
            count = {1: 1, 2: 2, 3: 4}[kind]
            distance = int.from_bytes(data[offset:offset + count], "little")
            offset += count
            if kind == 1:
                distance += (tag & 224) << 3
                length = 4 + ((tag >> 2) & 7)
            else:
                length = 1 + (tag >> 2)
            for _ in range(length):
                output.append(output[-distance])
    return bytes(output)


@unittest.skipUnless(os.getenv("RUN_DOCKER_ACCEPTANCE") == "true", "explicit Docker opt-in")
class CollectorAcceptance(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="task-list-logs-test-")
        self.root = Path(self.directory.name)
        self.project = "logs-test-" + uuid.uuid4().hex[:12]
        self.collector = self.project + "-alloy"
        self.containers = []
        self.pushes = []
        # Keep the synthetic HTTP boundary inside Docker, independent of host firewall policy.
        sink = self.project + "-sink"
        self.containers.append(sink)
        self.docker("run", "-d", "--name", sink, "--user", "0", "--mount",
                    f"type=bind,src={self.root},dst=/capture", "--entrypoint", "node",
                    os.environ["LOG_TEST_SOURCE_IMAGE"], "-e",
                    'require("node:http").createServer((req,res)=>{let chunks=[];req.on("data",c=>chunks.push(c));req.on("end",()=>{const fs=require("node:fs");if(fs.existsSync("/capture/reject")){res.writeHead(401);res.end("synthetic-auth-rejection");return;}if(req.headers["content-type"]!=="application/json"){fs.appendFileSync("/capture/pushes.jsonl",JSON.stringify({auth:req.headers.authorization,body:Buffer.concat(chunks).toString("base64")})+"\\n");}res.writeHead(204);res.end();});}).listen(3100,"0.0.0.0")')
        inspected = json.loads(self.docker("inspect", sink))[0]
        address = next(iter(inspected["NetworkSettings"]["Networks"].values()))["IPAddress"]
        endpoint = f"http://{address}:3100/loki/api/v1/push"
        binary = self.root / "bin"
        binary.mkdir()
        doppler = binary / "doppler"
        doppler.write_text("#!/usr/bin/env python3\nimport os,sys\n"
                           "assert '--only-secrets' in sys.argv\n"
                           "assert sys.argv[sys.argv.index('--only-secrets')+1] == "
                           "'GRAFANA_LOKI_URL,GRAFANA_LOKI_USERNAME,GRAFANA_LOKI_TOKEN'\n"
                           "os.execvp(sys.argv[sys.argv.index('--')+1],sys.argv[sys.argv.index('--')+1:])\n")
        doppler.chmod(0o700)
        self.token = self.root / "doppler.token"
        self.token.write_text("synthetic-doppler-token")
        self.token.chmod(0o600)
        self.settings = self.root / "settings.json"
        self.settings.write_text(json.dumps({
            "environment": "test", "collectorRoot": str(self.root / "collector"),
            "dopplerTokenFile": str(self.token), "sourceProject": self.project,
            "containerName": self.collector,
        }))
        self.settings.chmod(0o600)
        self.environment = {
            **os.environ, "PATH": str(binary) + ":" + os.environ["PATH"],
            "GRAFANA_LOKI_URL": endpoint,
            "GRAFANA_LOKI_USERNAME": "12345", "GRAFANA_LOKI_TOKEN": "synthetic-grafana-secret",
        }
        # A fixture Doppler supplies values independently of the installer's inherited environment.
        doppler.write_text(doppler.read_text().replace("os.execvp", 
            f"os.environ.update({{\"GRAFANA_LOKI_URL\":\"{self.environment['GRAFANA_LOKI_URL']}\","
            '\"GRAFANA_LOKI_USERNAME\":\"12345\",\"GRAFANA_LOKI_TOKEN\":\"synthetic-grafana-secret\"})\nos.execvp'))

    def tearDown(self):
        for name in [self.collector, *self.containers]:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        self.directory.cleanup()

    def docker(self, *args):
        return subprocess.check_output(["docker", *args], text=True).strip()

    def install(self):
        return subprocess.run(["bash", "scripts/install-log-collector.sh", "--settings", str(self.settings)],
                              env=self.environment, capture_output=True, text=True)

    def emitter(self, project):
        name = self.project + "-" + uuid.uuid4().hex[:6]
        self.containers.append(name)
        self.docker("run", "-d", "--name", name,
                    "--label", f"com.docker.compose.project={project}",
                    "--label", "com.docker.compose.service=worker", "--entrypoint", "node",
                    os.environ["LOG_TEST_SOURCE_IMAGE"], "-e",
                    'setInterval(()=>{console.error(JSON.stringify({level:30,event:"synthetic_tick",runId:"' + project + '",entryPoint:"worker_periodic"})); console.log(JSON.stringify({event:"command_result",content:"sensitive-stdout-excluded"}));},500)')
        return name

    def test_collects_worker_json_without_other_containers_or_stdout(self):
        worker = self.emitter(self.project)
        foreign = self.emitter(self.project + "-foreign")
        before = self.docker("inspect", "--format", "{{.State.StartedAt}}", worker)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        deadline = time.monotonic() + 30
        while not self.pushes and time.monotonic() < deadline:
            pushed = self.root / "pushes.jsonl"
            if pushed.exists():
                self.pushes = [(row["auth"], uncompress(base64.b64decode(row["body"])))
                               for row in map(json.loads, pushed.read_text().splitlines())]
            time.sleep(0.2)
        self.assertTrue(self.pushes, "collector never pushed logs")
        payload = b"".join(body for _, body in self.pushes)
        self.assertIn(b'"event":"synthetic_tick"', payload)
        self.assertIn(('"runId":"' + self.project + '"').encode(), payload)
        self.assertNotIn(b"sensitive-stdout-excluded", payload)
        self.assertNotIn((self.project + "-foreign").encode(), payload)
        self.assertEqual(self.pushes[0][0], "Basic " + base64.b64encode(b"12345:synthetic-grafana-secret").decode())
        self.assertEqual(before, self.docker("inspect", "--format", "{{.State.StartedAt}}", worker))
        inspected = json.loads(self.docker("inspect", self.collector))[0]
        self.assertFalse(inspected["HostConfig"]["PortBindings"])
        self.assertNotIn("synthetic-grafana-secret", json.dumps(inspected))
        self.assertNotIn("synthetic-grafana-secret", result.stdout + result.stderr)

    def test_rotation_preserves_worker_and_failed_secret_fetch_preserves_collector(self):
        worker = self.emitter(self.project)
        started = self.docker("inspect", "--format", "{{.State.StartedAt}}", worker)
        self.assertEqual(self.install().returncode, 0)
        before = json.loads(self.docker("inspect", self.collector))[0]
        state_mount = next(m["Source"] for m in before["Mounts"] if m["Destination"] == "/var/lib/alloy")
        doppler = self.root / "bin" / "doppler"
        doppler.write_text(doppler.read_text().replace("synthetic-grafana-secret", "synthetic-grafana-rotated"))
        self.assertEqual(self.install().returncode, 0)
        after = json.loads(self.docker("inspect", self.collector))[0]
        self.assertNotEqual(before["Id"], after["Id"])
        self.assertEqual(state_mount, next(m["Source"] for m in after["Mounts"] if m["Destination"] == "/var/lib/alloy"))
        rotated_auth = "Basic " + base64.b64encode(b"12345:synthetic-grafana-rotated").decode()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            pushed = self.root / "pushes.jsonl"
            if pushed.exists() and any(row["auth"] == rotated_auth for row in map(json.loads, pushed.read_text().splitlines())):
                break
            time.sleep(0.2)
        else:
            self.fail("replacement did not upload with the rotated credential")
        doppler.write_text("#!/usr/bin/env python3\nimport sys\nsys.exit('synthetic-secret-fetch-error')\n")
        failure = self.install()
        self.assertNotEqual(failure.returncode, 0)
        self.assertNotIn("synthetic-secret-fetch-error", failure.stdout + failure.stderr)
        self.assertEqual(after["Id"], json.loads(self.docker("inspect", self.collector))[0]["Id"])
        self.assertEqual(started, self.docker("inspect", "--format", "{{.State.StartedAt}}", worker))

    def test_rejected_upload_credentials_do_not_replace_existing_collector(self):
        worker = self.emitter(self.project)
        self.assertEqual(self.install().returncode, 0)
        before = json.loads(self.docker("inspect", self.collector))[0]
        started = self.docker("inspect", "--format", "{{.State.StartedAt}}", worker)
        (self.root / "reject").touch()
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        after = json.loads(self.docker("inspect", self.collector))[0]
        self.assertEqual(before["Id"], after["Id"])
        self.assertTrue(after["State"]["Running"])
        self.assertEqual(started, self.docker("inspect", "--format", "{{.State.StartedAt}}", worker))
        self.assertNotIn("synthetic-auth-rejection", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

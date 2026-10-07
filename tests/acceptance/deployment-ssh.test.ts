import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const script = resolve("scripts/deploy-ssh.sh");

test("the SSH deployment role offers a harmless check and rejects shells, forwarding commands and injected arguments", () => {
  const check = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: "check" },
  });
  expect(check.status).toBe(0);
  expect(JSON.parse(check.stdout)).toEqual({
    status: "ready",
    entryPoint: "deployment_ssh",
  });
  for (const command of [
    "",
    "bash",
    "scp -t /tmp/release",
    "check; id",
    "deploy --image ghcr.io/mbeka02/task-list-submission-automation:latest",
    `deploy --image ghcr.io/another/worker@sha256:${"a".repeat(64)}`,
    `deploy --image ghcr.io/mbeka02/task-list-submission-automation@sha256:${"a".repeat(64)}; id`,
  ]) {
    const denied = spawnSync("bash", [script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: command },
    });
    expect(denied.status).toBe(2);
    expect(denied.stdout).toBe("");
    expect(denied.stderr).toContain('"reason":"invalid_ssh_command"');
  }
});

const acceptance =
  process.env.RUN_DOCKER_ACCEPTANCE === "true" ? test : test.skip;
acceptance(
  "an approved digest reaches only the fixed privileged helper and cannot forward caller deployment settings",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "task-list-ssh-"));
    const sudo = join(directory, "sudo");
    const image = `ghcr.io/mbeka02/task-list-submission-automation@sha256:${"a".repeat(64)}`;
    // Sudo is the OS boundary under test; the host deploy helper has its own real Docker acceptance.
    writeFileSync(
      sudo,
      `#!/bin/bash\nprintf "%s\\n" "$@"\nprintf "root=%s\\n" "\${TASK_LIST_DEPLOY_ROOT:-unset}"\n`,
      { mode: 0o755 },
    );
    try {
      const result = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--pull",
          "never",
          "--network",
          "none",
          "--read-only",
          "--mount",
          `type=bind,src=${script},dst=/deploy-ssh.sh,readonly`,
          "--mount",
          `type=bind,src=${sudo},dst=/usr/bin/sudo,readonly`,
          "--env",
          `SSH_ORIGINAL_COMMAND=deploy --image ${image}`,
          "--env",
          "TASK_LIST_DEPLOY_ROOT=/unapproved",
          process.env.RELEASE_TEST_IMAGE ??
            "task-list-local:structured-observability",
          "bash",
          "/deploy-ssh.sh",
        ],
        { encoding: "utf8", timeout: 20_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual([
        "-n",
        "--",
        "/opt/task-list/release-tool/scripts/deploy.sh",
        "--image",
        image,
        "root=unset",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

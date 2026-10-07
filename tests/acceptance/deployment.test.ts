import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

const script = resolve("scripts/deploy.sh");
const image =
  process.env.RELEASE_TEST_IMAGE ?? "task-list-local:structured-observability";
const reference = `ghcr.io/mbeka02/task-list-submission-automation@sha256:${"a".repeat(64)}`;
const acceptance =
  process.env.RUN_DOCKER_ACCEPTANCE === "true" ? test : test.skip;

/** Substitute only external registry/secrets boundaries; every container, Compose call and SQLite operation is real. */
function fixture(admin = false) {
  const root = mkdtempSync(join(tmpdir(), "task-list-deploy-"));
  const project = `deploy-${randomUUID()}`;
  const docker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const directory of ["ledger", "credentials", "backups"])
    mkdirSync(join(root, directory), { mode: 0o700 });
  writeFileSync(
    join(root, "credentials", "user-oauth.json"),
    "synthetic rotating grant",
    { mode: 0o600 },
  );
  writeFileSync(join(root, "doppler.token"), "synthetic-deploy-token", {
    mode: 0o600,
  });
  writeFileSync(
    join(root, "worker.env"),
    [
      "LARK_APP_ID=cli_deployment_test",
      "SOURCE_CHAT_ID=oc_source_placeholder",
      ...(admin
        ? ["REPORT_RECIPIENT_TYPE=open_id", "REPORT_RECIPIENT_ID=ou_admin"]
        : ["MANAGEMENT_CHAT_ID=oc_management_placeholder"]),
      "ACTIVATION_DATE=2099-01-01",
      "LARK_READER_OPEN_ID=ou_synthetic_reader",
    ].join("\n"),
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "calendar.json"),
    JSON.stringify({
      version: "synthetic-deployment-v1",
      fromDate: "2020-01-01",
      throughDate: "2099-12-31",
      reviewedOn: "2020-01-01",
      sourceUrls: ["https://example.invalid/calendar"],
      publicHolidays: [],
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -e
if [[ $1 == pull ]]; then [[ \${FIXTURE_FAIL_PULL:-} != true ]]; exit; fi
if [[ $1 == run && \${FIXTURE_FAIL_BACKUP:-} == true && " $* " == *" dist/storage-command.js backup "* ]]; then exit 1; fi
if [[ $1 == compose && \${FIXTURE_FAIL_READINESS:-} == true && " $* " == *" exec "* ]]; then exit 1; fi
if [[ $1 == image && $2 == inspect && \${@: -1} == ghcr.io/mbeka02/task-list-submission-automation@sha256:* ]]; then
  exec "${docker}" image inspect --format '{{.Id}}' "$FIXTURE_IMAGE"
fi
exec "${docker}" "$@"
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(bin, "doppler"),
    `#!/usr/bin/env bash
set -e
if [[ \${FIXTURE_FAIL_SECRETS:-} == true ]]; then echo 'synthetic-secret-do-not-log' >&2; exit 1; fi
for ((index=1; index<=$#; index++)); do
  if [[ \${!index} == --only-secrets ]]; then
    next=$((index+1))
    printf '%s' "\${!next}" > "$TASK_LIST_DEPLOY_ROOT/secret-selection.txt"
  fi
done
while [[ $# -gt 0 && $1 != -- ]]; do shift; done
shift
export LARK_APP_SECRET=synthetic-secret-do-not-log
export REPORT_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa
export REPORT_WEBHOOK_SIGNING_SECRET=synthetic-report-secret
export REMINDER_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb
export REMINDER_WEBHOOK_SIGNING_SECRET=synthetic-reminder-secret
export GEMINI_API_KEY=synthetic-gemini-secret
exec "$@"
`,
    { mode: 0o700 },
  );
  // Hosted runners may use UID 1001; prepare the same UID 1000 storage as the server.
  const ownership = (uid: number, gid: number) =>
    execFileSync(docker, [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--user",
      "0:0",
      "--mount",
      `type=bind,src=${root},dst=/fixture`,
      image,
      "node",
      "--input-type=module",
      "--eval",
      `import fs from 'node:fs';
     const walk = p => { if (fs.lstatSync(p).isDirectory()) for (const child of fs.readdirSync(p)) walk(p+'/'+child); fs.chownSync(p, ${uid}, ${gid}); };
     for (const name of ['ledger','credentials','backups','calendar.json']) walk('/fixture/'+name);`,
    ]);
  ownership(1000, 1000);
  const runInDirectory = (directory: string, source: string) =>
    execFileSync(
      docker,
      [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--read-only",
        "--mount",
        `type=bind,src=${join(root, directory)},dst=/data`,
        image,
        "node",
        "--input-type=module",
        "--eval",
        `process.umask(0o077); ${source}`,
      ],
      { encoding: "utf8" },
    );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TASK_LIST_DEPLOY_ROOT: root,
    TASK_LIST_COMPOSE_PROJECT: project,
    FIXTURE_IMAGE: image,
  };
  return {
    root,
    project,
    bin,
    env,
    files: (directory: string) =>
      JSON.parse(
        runInDirectory(
          directory,
          "import fs from 'node:fs'; console.log(JSON.stringify(fs.readdirSync('/data')));",
        ),
      ) as string[],
    setCalendar: (content: string) =>
      execFileSync(docker, [
        "run",
        "--rm",
        "--pull",
        "never",
        "--network",
        "none",
        "--user",
        "0:0",
        "--mount",
        `type=bind,src=${root}/calendar.json,dst=/calendar.json`,
        image,
        "node",
        "--eval",
        `require('node:fs').writeFileSync('/calendar.json', ${JSON.stringify(content)});`,
      ]),
    ledger: (
      source: string,
      directory = "ledger",
      filename = "task-list.sqlite",
      writable = false,
    ) =>
      JSON.parse(
        runInDirectory(
          directory,
          `import {openReportLedger} from './dist/report-ledger.js';
       const ledger=openReportLedger({databasePath:${JSON.stringify(`/data/${filename}`)},readOnly:${!writable}, appId:'cli_deployment_test',sourceChatId:'oc_source_placeholder',destinationChatId:'oc_source_placeholder',${writable ? "transport:async()=>({messageId:'om_synthetic_ack'})," : ""}});
       try { ${source} } finally { ledger.close(); }`,
        ),
      ),
    grantContent: () =>
      runInDirectory(
        "credentials",
        "import fs from 'node:fs'; process.stdout.write(fs.readFileSync('/data/user-oauth.json','utf8'));",
      ),
    deploy: (extra: NodeJS.ProcessEnv = {}) =>
      spawnSync("bash", [script, "--image", reference], {
        env: { ...env, ...extra },
        encoding: "utf8",
        timeout: 90_000,
      }),
    containerId: () =>
      execFileSync(
        docker,
        [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ],
        { encoding: "utf8" },
      ).trim(),
    close: () => {
      const ids = execFileSync(
        docker,
        [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ],
        { encoding: "utf8" },
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (ids.length) execFileSync(docker, ["rm", "--force", ...ids]);
      spawnSync(docker, ["network", "rm", `${project}_default`], {
        stdio: "ignore",
      });
      ownership(process.getuid?.() ?? 1000, process.getgid?.() ?? 1000);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("deployment rejects mutable tags and foreign repositories before contacting external services", () => {
  for (const image of [
    "ghcr.io/mbeka02/task-list-submission-automation:latest",
    `ghcr.io/another/worker@sha256:${"a".repeat(64)}`,
    "ghcr.io/mbeka02/task-list-submission-automation@sha256:$(touch /tmp/unsafe)",
  ]) {
    const result = spawnSync("bash", [script, "--image", image], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('"reason":"invalid_image"');
    expect(result.stdout).toBe("");
  }
});

acceptance(
  "a fresh preview deployment starts one hardened worker and confirms built read-only readiness",
  () => {
    const environment = fixture();
    try {
      const result = environment.deploy();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "ready",
        mode: "preview",
        image: reference,
      });
      const output = JSON.parse(result.stdout);
      const events = result.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(output.runId).toEqual(expect.any(String));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "deployment_started",
            entryPoint: "deployment_cli",
            runId: output.runId,
          }),
          expect.objectContaining({
            event: "deployment_ready",
            entryPoint: "deployment_cli",
            runId: output.runId,
            durationMs: expect.any(Number),
            image: reference,
          }),
        ]),
      );
      const state = JSON.parse(
        execFileSync("docker", ["inspect", environment.containerId()], {
          encoding: "utf8",
        }),
      )[0];
      expect(state.State.Running).toBe(true);
      expect(state.Config.User).toBe("1000:1000");
      expect(state.HostConfig.ReadonlyRootfs).toBe(true);
      expect(state.HostConfig.PortBindings).toEqual({});
      expect(state.Config.Env).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^DOPPLER_TOKEN=/)]),
      );
      expect(result.stderr).not.toContain("synthetic-secret-do-not-log");
      expect(result.stderr).not.toContain("synthetic-deploy-token");
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "failed readiness stops the replacement and never rolls the ledger back automatically",
  () => {
    const environment = fixture();
    try {
      expect(environment.deploy().status).toBe(0);
      const previous = environment.containerId();
      const result = spawnSync("bash", [script, "--image", reference], {
        env: { ...environment.env, FIXTURE_FAIL_READINESS: "true" },
        encoding: "utf8",
        timeout: 90_000,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"reason":"readiness"');
      const replacement = environment.containerId();
      expect(replacement).not.toBe(previous);
      expect(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", replacement],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("false");
      expect(environment.files("backups")).toHaveLength(1);
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "deployment refuses secret or executable overrides in the non-secret settings file",
  () => {
    const environment = fixture();
    try {
      const settings = join(environment.root, "worker.env");
      writeFileSync(
        settings,
        `${readFileSync(settings, "utf8")}\nNODE_OPTIONS=--trace-warnings\n`,
      );
      const result = environment.deploy();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"reason":"configuration"');
      expect(environment.containerId()).toBe("");
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "invalid calendar configuration is rejected before stopping the current worker",
  () => {
    const environment = fixture();
    try {
      expect(environment.deploy().status).toBe(0);
      const current = environment.containerId();
      environment.setCalendar("{}");
      const result = environment.deploy();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"reason":"configuration"');
      expect(environment.containerId()).toBe(current);
      expect(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", current],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("true");
      expect(environment.files("backups")).toEqual([]);
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "an overlapping deployment is rejected before replacement while the host deployment lock is held",
  async () => {
    const environment = fixture();
    const holder = spawn(
      "flock",
      [
        join(environment.root, ".deploy.lock"),
        "bash",
        "-c",
        "printf ready; read -r line",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await once(holder.stdout, "data");
      const result = environment.deploy();
      expect(result.status).toBe(75);
      expect(result.stderr).toContain('"reason":"deployment_busy"');
      expect(environment.containerId()).toBe("");
    } finally {
      holder.stdin.end("release\n");
      await once(holder, "exit");
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "a failed Doppler fetch leaves the existing worker running and reports only a safe failure reason",
  () => {
    const environment = fixture();
    try {
      expect(environment.deploy().status).toBe(0);
      const current = environment.containerId();
      const result = spawnSync("bash", [script, "--image", reference], {
        env: { ...environment.env, FIXTURE_FAIL_SECRETS: "true" },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"reason":"secret_fetch"');
      expect(result.stderr).not.toContain("synthetic-secret-do-not-log");
      expect(environment.containerId()).toBe(current);
      expect(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", current],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("true");
      expect(environment.files("backups")).toEqual([]);
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "scope changes cannot silently replace an existing worker or attach its grant to another app/group",
  () => {
    const environment = fixture();
    try {
      expect(environment.deploy().status).toBe(0);
      const current = environment.containerId();
      const settings = join(environment.root, "worker.env");
      writeFileSync(
        settings,
        readFileSync(settings, "utf8").replace(
          "SOURCE_CHAT_ID=oc_source_placeholder",
          "SOURCE_CHAT_ID=oc_different_group",
        ),
      );
      const result = environment.deploy();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"reason":"existing_worker"');
      expect(environment.containerId()).toBe(current);
      expect(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", current],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("true");
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "a failed image pull leaves the current worker untouched",
  () => {
    const environment = fixture();
    try {
      expect(environment.deploy().status).toBe(0);
      const current = environment.containerId();
      const result = spawnSync("bash", [script, "--image", reference], {
        env: { ...environment.env, FIXTURE_FAIL_PULL: "true" },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"reason":"pull"');
      expect(environment.containerId()).toBe(current);
      expect(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", current],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("true");
      expect(environment.files("backups")).toEqual([]);
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "a failed predecessor backup leaves the old worker stopped and never starts a replacement",
  () => {
    const environment = fixture();
    try {
      expect(environment.deploy().status).toBe(0);
      const current = environment.containerId();
      const result = spawnSync("bash", [script, "--image", reference], {
        env: { ...environment.env, FIXTURE_FAIL_BACKUP: "true" },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"reason":"backup"');
      expect(environment.containerId()).toBe(current);
      expect(
        execFileSync(
          "docker",
          ["inspect", "--format", "{{.State.Running}}", current],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("false");
      expect(environment.files("backups")).toEqual([]);
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "an existing ledger without a known predecessor is left for reviewed recovery",
  () => {
    const environment = fixture();
    try {
      environment.ledger(
        "console.log(JSON.stringify({status:'seeded'}));",
        "ledger",
        "task-list.sqlite",
        true,
      );
      const result = environment.deploy();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('"reason":"missing_predecessor"');
      expect(environment.containerId()).toBe("");
      expect(environment.files("backups")).toEqual([]);
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "replacement backs up with the predecessor and retains frozen UUIDs, acknowledgements and the rotating grant",
  async () => {
    const environment = fixture();
    try {
      expect(environment.deploy().status).toBe(0);
      const previousContainer = environment.containerId();
      const acknowledged = environment.ledger(
        `
        const frozen=ledger.prepareReminder({businessDate:'2026-10-06',text:'Synthetic reminder',policyVersion:'deploy-test'});
        if(frozen.status!=='frozen') throw Error('Expected frozen reminder');
        await ledger.deliverDelivery({deliveryId:frozen.delivery.id,now:Date.parse('2026-10-06T06:30:00Z')});
        console.log(JSON.stringify(ledger.getDelivery(frozen.delivery.id)));
      `,
        "ledger",
        "task-list.sqlite",
        true,
      );
      const result = environment.deploy();
      expect(result.status, result.stderr).toBe(0);
      expect(environment.containerId()).not.toBe(previousContainer);
      const backups = environment.files("backups");
      expect(backups).toHaveLength(1);
      const inspect = `console.log(JSON.stringify(ledger.getDelivery(${JSON.stringify(acknowledged.id)})));`;
      expect(environment.ledger(inspect, "backups", backups[0])).toEqual(
        acknowledged,
      );
      expect(environment.ledger(inspect)).toEqual(acknowledged);
      expect(environment.grantContent()).toBe("synthetic rotating grant");
    } finally {
      environment.close();
    }
  },
  120_000,
);

acceptance(
  "preview deployment preserves an explicitly configured admin recipient on replacement",
  () => {
    const environment = fixture(true);
    try {
      const first = environment.deploy();
      expect(first.status, first.stderr).toBe(0);
      const replaced = environment.deploy();
      expect(replaced.status, replaced.stderr).toBe(0);
      const info = JSON.parse(
        execFileSync("docker", ["inspect", environment.containerId()], {
          encoding: "utf8",
        }),
      )[0];
      expect(info.Config.Env).toEqual(
        expect.arrayContaining([
          "REPORT_RECIPIENT_TYPE=open_id",
          "REPORT_RECIPIENT_ID=ou_admin",
          "ENABLE_OUTBOUND=false",
        ]),
      );
    } finally {
      environment.close();
    }
  },
  120000,
);

acceptance(
  "production profile starts a paused outbound-capable worker with the approved typed recipient",
  () => {
    const f = fixture(true);
    try {
      const settings = join(f.root, "worker.env");
      writeFileSync(
        settings,
        `${readFileSync(settings, "utf8")}\nAPP_MODE=production\nENABLE_OUTBOUND=true\nENABLE_DAILY_BRIEF=false\nWORKER_RESTORE_MODE=true\n`,
        { mode: 0o600 },
      );
      const result = f.deploy();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "ready",
        mode: "production",
      });
      const inspected = JSON.parse(
        execFileSync("docker", ["inspect", f.containerId()], {
          encoding: "utf8",
        }),
      )[0];
      expect(inspected.Config.Env).toEqual(
        expect.arrayContaining([
          "APP_MODE=production",
          "ENABLE_OUTBOUND=true",
          "WORKER_RESTORE_MODE=true",
          "REPORT_RECIPIENT_ID=ou_admin",
        ]),
      );
      expect(f.grantContent()).toBe("synthetic rotating grant");
    } finally {
      f.close();
    }
  },
  120_000,
);

acceptance(
  "a stopped-worker recipient review permits one scoped transition while preserving the ledger",
  () => {
    const f = fixture();
    try {
      const initial = join(f.root, "worker.env");
      writeFileSync(
        initial,
        `${readFileSync(initial, "utf8")}\nWORKER_RESTORE_MODE=true\n`,
        { mode: 0o600 },
      );
      expect(f.deploy().status).toBe(0);
      const id = f.containerId();
      const next = join(f.root, "next-settings.env");
      writeFileSync(
        next,
        readFileSync(join(f.root, "worker.env"), "utf8").replace(
          "MANAGEMENT_CHAT_ID=oc_management_placeholder",
          "REPORT_RECIPIENT_TYPE=open_id\nREPORT_RECIPIENT_ID=ou_admin",
        ),
        { mode: 0o600 },
      );
      const review = () =>
        spawnSync(
          "bash",
          [resolve("scripts/review-recipient.sh"), "--settings", next],
          { env: f.env, encoding: "utf8", timeout: 15000 },
        );
      expect(review().status).not.toBe(0);
      execFileSync("docker", ["stop", id]);
      expect(review().status).toBe(0);
      expect(f.deploy().status).toBe(0);
      expect(f.grantContent()).toBe("synthetic rotating grant");
      expect(f.files("backups")).toHaveLength(1);
    } finally {
      f.close();
    }
  },
  120_000,
);

acceptance(
  "paused user-owned brief deployment selects only required Doppler secrets and preserves the grant",
  () => {
    const f = fixture(true);
    try {
      const settings = join(f.root, "worker.env");
      writeFileSync(
        settings,
        readFileSync(settings, "utf8")
          .replace(
            "REPORT_RECIPIENT_TYPE=open_id",
            "REPORT_RECIPIENT_TYPE=chat_id",
          )
          .replace(
            "REPORT_RECIPIENT_ID=ou_admin",
            "REPORT_RECIPIENT_ID=oc_private_reports",
          ) +
          "\nAPP_MODE=production\nENABLE_OUTBOUND=true\nENABLE_DAILY_BRIEF=true\nBRIEF_MODE=publish\nBRIEF_ACTIVATION_DATE=2099-01-01\nBRIEF_PROVIDER=gemini\nGEMINI_MODEL=gemini-3.5-flash-lite\nBRIEF_TEMPLATE_VERSION=template-v1\nBRIEF_PROMPT_VERSION=prompt-v1\nBRIEF_SCHEMA_VERSION=schema-v1\nLARK_DOC_AUTH_STRATEGY=user_oauth\nLARK_DOC_STAGING_FOLDER_TOKEN=folderSynthetic\nLARK_DOCUMENT_BASE_URL=https://example.larksuite.com/docx/\nWORKER_RESTORE_MODE=true\nREPORT_TRANSPORT=webhook\nREMINDER_TRANSPORT=webhook\n",
        { mode: 0o600 },
      );
      const result = f.deploy({
        GEMINI_API_KEY: "inherited-model-secret-canary",
        DEEPSEEK_API_KEY: "inherited-other-secret-canary",
      });
      expect(result.status).toBe(0);
      expect(
        readFileSync(join(f.root, "secret-selection.txt"), "utf8")
          .split(",")
          .sort(),
      ).toEqual([
        "GEMINI_API_KEY",
        "LARK_APP_SECRET",
        "REMINDER_WEBHOOK_SIGNING_SECRET",
        "REMINDER_WEBHOOK_URL",
        "REPORT_WEBHOOK_SIGNING_SECRET",
        "REPORT_WEBHOOK_URL",
      ]);
      const inspected = JSON.parse(
        execFileSync("docker", ["inspect", f.containerId()], {
          encoding: "utf8",
        }),
      )[0];
      expect(inspected.Config.Env).toEqual(
        expect.arrayContaining([
          "REPORT_TRANSPORT=webhook",
          "REMINDER_TRANSPORT=webhook",
          "REPORT_WEBHOOK_SIGNING_SECRET=synthetic-report-secret",
          "GEMINI_API_KEY=synthetic-gemini-secret",
          "DEEPSEEK_API_KEY=",
          "LARK_DOC_AUTH_STRATEGY=user_oauth",
        ]),
      );
      expect(f.grantContent()).toBe("synthetic rotating grant");
      expect(result.stdout + result.stderr).not.toContain("secret-canary");
    } finally {
      f.close();
    }
  },
  120_000,
);

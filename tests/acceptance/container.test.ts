import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createLegacyDatabase } from "../support/legacy-database.js";

const image = process.env.RELEASE_TEST_IMAGE ?? "task-list-local:phase-6";
const acceptance =
  process.env.RUN_DOCKER_ACCEPTANCE === "true" ? test : test.skip;

/** Exercise built commands in an isolated local image; never pull or reach Lark during acceptance. */
function container(
  command: string[],
  options: string[] = [],
  releaseImage = image,
) {
  return execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      ...options,
      releaseImage,
      ...command,
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
}

acceptance(
  "the local image runs built preflight with native SQLite and the SDK while offline",
  () => {
    expect(JSON.parse(container(["node", "dist/preflight.js"]))).toMatchObject({
      mode: "preview",
      outboundEnabled: false,
      checks: { sqlite: "ok", larkSdk: "ok" },
    });
  },
);

/** A dedicated Docker volume and external clock/calendar; no employee data or OAuth tokens. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "task-list-container-"));
  const volume = `task-list-phase6-${randomUUID()}`;
  execFileSync("docker", [
    "volume",
    "create",
    "--label",
    "task-list.acceptance=true",
    volume,
  ]);
  const clock = join(directory, "clock.mjs");
  const calendar = join(directory, "calendar.json");
  const setNow = (iso: string) =>
    writeFileSync(
      clock,
      `Date.now = () => Date.parse(${JSON.stringify(iso)});`,
    );
  setNow("2026-10-02T06:30:00.000Z");
  writeFileSync(
    calendar,
    JSON.stringify({
      version: "synthetic-release-v1",
      fromDate: "2026-01-01",
      throughDate: "2026-12-31",
      reviewedOn: "2026-10-01",
      sourceUrls: ["https://example.invalid/synthetic"],
      publicHolidays: [],
    }),
  );
  const settings = {
    SQLITE_FILE_PATH: "/data/task-list.sqlite",
    HOLIDAY_CALENDAR_PATH: "/acceptance/calendar.json",
    LARK_APP_ID: "cli_release_test",
    SOURCE_CHAT_ID: "oc_source_placeholder",
    MANAGEMENT_CHAT_ID: "oc_management_placeholder",
    ACTIVATION_DATE: "2026-10-02",
    LARK_APP_SECRET: "synthetic-secret",
    LARK_READER_OPEN_ID: "ou_synthetic_reader",
    LARK_USER_CREDENTIAL_FILE: "/credentials/missing.json",
    ENABLE_OUTBOUND: "false",
  };
  const options = [
    "--mount",
    `type=volume,src=${volume},dst=/data`,
    "--mount",
    `type=bind,src=${clock},dst=/acceptance/clock.mjs,readonly`,
    "--mount",
    `type=bind,src=${calendar},dst=/acceptance/calendar.json,readonly`,
    ...Object.entries(settings).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
  ];
  return {
    directory,
    volume,
    options,
    setNow,
    run: (args: string[], extra: string[] = []) =>
      JSON.parse(
        container(
          [
            "node",
            "--import",
            "/acceptance/clock.mjs",
            "dist/worker-command.js",
            ...args,
          ],
          [...options, ...extra],
        ),
      ),
    close: () => {
      execFileSync("docker", ["volume", "rm", volume]);
      rmSync(directory, { recursive: true, force: true });
    },
    module: (name: string, source: string) => {
      const path = join(directory, name);
      writeFileSync(path, source);
      options.push(
        "--mount",
        `type=bind,src=${path},dst=/acceptance/${name},readonly`,
      );
      return `/acceptance/${name}`;
    },
  };
}

acceptance(
  "container replacement retains one frozen pending reminder on the dedicated volume",
  () => {
    const environment = fixture();
    try {
      const first = environment.run(["run", "--once"]);
      expect(first).toMatchObject({
        status: "ok",
        outboundEnabled: false,
        reminder: {
          state: "pending",
          attemptCount: 0,
          deliveryId: expect.any(String),
        },
      });
      const second = environment.run(["run", "--once"]);
      expect(second.reminder).toEqual(first.reminder);
      expect(environment.run(["status"]).reminder).toEqual(first.reminder);
    } finally {
      environment.close();
    }
  },
  30_000,
);

/** Wait for observable command output, then terminate only this test's uniquely named container. */
async function firstStatus(name: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const output = execFileSync("docker", ["logs", name], {
      encoding: "utf8",
    }).trim();
    if (output) return JSON.parse(output.split("\n")[0] ?? "{}");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Container did not publish startup status");
}

acceptance(
  "the continuous container exits cleanly on SIGTERM and resumes the same pending work",
  async () => {
    const environment = fixture();
    const name = `task-list-phase6-${randomUUID()}`;
    try {
      execFileSync("docker", [
        "run",
        "--detach",
        "--name",
        name,
        "--pull=never",
        "--init",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        ...environment.options,
        image,
        "node",
        "--import",
        "/acceptance/clock.mjs",
        "dist/worker-command.js",
        "run",
      ]);
      const first = await firstStatus(name);
      expect(first).toMatchObject({
        reminder: { state: "pending", attemptCount: 0 },
      });
      execFileSync("docker", ["stop", "--time", "10", name], {
        timeout: 15_000,
      });
      expect(
        JSON.parse(
          execFileSync(
            "docker",
            ["inspect", "--format", "{{json .State}}", name],
            { encoding: "utf8" },
          ),
        ),
      ).toMatchObject({ Running: false, ExitCode: 0 });
      expect(environment.run(["run", "--once"]).reminder).toEqual(
        first.reminder,
      );
    } finally {
      execFileSync("docker", ["rm", "--force", name]);
      environment.close();
    }
  },
  30_000,
);

acceptance(
  "a killed in-flight container recovers an uncertain claim without replacing its UUID or sending",
  async () => {
    const environment = fixture();
    const name = `task-list-phase6-${randomUUID()}`;
    try {
      const first = environment.run(["run", "--once"]);
      const hold = environment.module(
        "hold.mjs",
        `
      import { openReportLedger } from '/app/dist/report-ledger.js';
      const ledger = openReportLedger({ databasePath: process.env.SQLITE_FILE_PATH,
        appId: process.env.LARK_APP_ID, sourceChatId: process.env.SOURCE_CHAT_ID,
        destinationChatId: process.env.SOURCE_CHAT_ID, clock: Date.now,
        transport: async request => {
          console.log(JSON.stringify({ status: 'attempt_started', uuid: request.uuid }));
          await new Promise(() => { setInterval(() => {}, 1000); });
          return { messageId: 'om_never_acknowledged' };
        }
      });
      const delivery = ledger.getDailyDelivery('2026-10-02', 'reminder');
      await ledger.deliverDelivery({ deliveryId: delivery.id, now: Date.now() });
    `,
      );
      execFileSync("docker", [
        "run",
        "--detach",
        "--name",
        name,
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        ...environment.options,
        image,
        "node",
        "--import",
        "/acceptance/clock.mjs",
        hold,
      ]);
      const request = await firstStatus(name);
      expect(request).toMatchObject({
        status: "attempt_started",
        uuid: expect.any(String),
      });
      execFileSync("docker", ["kill", "--signal", "KILL", name]);
      environment.setNow("2026-10-02T06:31:01.000Z");
      const recovered = environment.run(["run", "--once"]);
      expect(recovered.reminder).toMatchObject({
        deliveryId: first.reminder.deliveryId,
        state: "uncertain",
        attemptCount: 1,
        lastError: "claim_expired",
        reconciliationRequired: true,
      });
      const inspect = environment.module(
        "inspect-reminder.mjs",
        `
      import { openReportLedger } from '/app/dist/report-ledger.js';
      const ledger = openReportLedger({ databasePath: process.env.SQLITE_FILE_PATH,
        appId: process.env.LARK_APP_ID, sourceChatId: process.env.SOURCE_CHAT_ID,
        destinationChatId: process.env.SOURCE_CHAT_ID, readOnly: true });
      console.log(JSON.stringify(ledger.getDailyDelivery('2026-10-02', 'reminder')));
      ledger.close();
    `,
      );
      expect(
        JSON.parse(container(["node", inspect], environment.options)),
      ).toMatchObject({
        state: "uncertain",
        sendUuid: request.uuid,
        attemptCount: 1,
        messageId: null,
      });
    } finally {
      execFileSync("docker", ["rm", "--force", name]);
      environment.close();
    }
  },
  30_000,
);

acceptance(
  "the built backup/restore drill preserves acknowledged evidence and keeps restored work paused",
  () => {
    const environment = fixture();
    try {
      const seed = environment.module(
        "sent-report.mjs",
        `
      import { openReportLedger } from '/app/dist/report-ledger.js';
      const appId = process.env.LARK_APP_ID, sourceChatId = process.env.SOURCE_CHAT_ID;
      const now = Date.parse('2026-10-02T07:01:00.000Z');
      const ledger = openReportLedger({ databasePath: process.env.SQLITE_FILE_PATH, appId, sourceChatId,
        destinationChatId: process.env.MANAGEMENT_CHAT_ID, clock: () => now,
        transport: async () => ({ messageId: 'om_synthetic_release_ack' }) });
      const prepared = ledger.prepareDailyReport({ businessDate: '2026-10-02',
        policy: { appId, sourceChatId, timeZone: 'Africa/Nairobi', publicHolidays: [], replyPolicy: 'exclude', policyVersion: 'synthetic-release-v1' },
        scan: { status: 'complete', appId, sourceChatId, businessDate: '2026-10-02', observedAtMs: now,
          fromMs: Date.parse('2026-10-01T21:00:00.000Z'), throughMs: Date.parse('2026-10-02T07:01:00.000Z'), replyPolicy: 'exclude',
          messages: [{ observationId: 'obs_release', messageId: 'om_release', appId, sourceChatId,
            sender: { type: 'user', tenantKey: 'external_fixture', openId: 'ou_synthetic', displayName: 'Synthetic Submitter' },
            createdMs: Date.parse('2026-10-02T06:55:00.000Z'), updatedMs: Date.parse('2026-10-02T06:55:00.000Z'),
            messageType: 'text', content: JSON.stringify({ text: 'Task list\\n1. Test release' }), deleted: false }] } });
      if (prepared.status !== 'frozen') throw new Error('Expected frozen report');
      await ledger.deliverDelivery({ deliveryId: prepared.delivery.id, now });
      console.log(JSON.stringify(ledger.getDelivery(prepared.delivery.id)));
      ledger.close();
    `,
      );
      const original = JSON.parse(
        container(["node", seed], environment.options),
      );
      expect(original).toMatchObject({
        state: "sent",
        messageId: "om_synthetic_release_ack",
        entries: [
          {
            displayName: "Synthetic Submitter",
            observation: expect.any(Object),
          },
        ],
      });
      expect(
        JSON.parse(
          container(
            [
              "node",
              "dist/storage-command.js",
              "backup",
              "--output",
              "/data/snapshot.sqlite",
            ],
            environment.options,
          ),
        ),
      ).toMatchObject({ status: "backed_up" });
      expect(
        JSON.parse(
          container(
            [
              "node",
              "dist/storage-command.js",
              "restore",
              "--backup",
              "/data/snapshot.sqlite",
              "--output",
              "/data/restored.sqlite",
            ],
            environment.options,
          ),
        ),
      ).toMatchObject({ status: "restored", restoreReviewRequired: true });
      const inspect = environment.module(
        "inspect-report.mjs",
        `
      import { openReportLedger } from '/app/dist/report-ledger.js';
      const ledger = openReportLedger({ databasePath: process.env.SQLITE_FILE_PATH,
        appId: process.env.LARK_APP_ID, sourceChatId: process.env.SOURCE_CHAT_ID,
        destinationChatId: process.env.MANAGEMENT_CHAT_ID, readOnly: true });
      console.log(JSON.stringify(ledger.getDailyDelivery('2026-10-02', 'report')));
      ledger.close();
    `,
      );
      const restoredOptions = [
        ...environment.options,
        "--env",
        "SQLITE_FILE_PATH=/data/restored.sqlite",
      ];
      expect(JSON.parse(container(["node", inspect], restoredOptions))).toEqual(
        original,
      );
      expect(
        environment.run(
          ["run", "--once"],
          [
            "--env",
            "SQLITE_FILE_PATH=/data/restored.sqlite",
            "--env",
            "WORKER_RESTORE_MODE=false",
          ],
        ),
      ).toMatchObject({
        status: "paused",
        reason: "restore_review_required",
        outboundEnabled: false,
      });
      environment.setNow("2026-10-02T07:01:00.000Z");
      expect(environment.run(["run", "--once"])).toMatchObject({
        report: {
          state: "sent",
          messageId: "om_synthetic_release_ack",
          attemptCount: 1,
        },
      });
    } finally {
      environment.close();
    }
  },
  30_000,
);

acceptance(
  "packaged migrations preserve the identity and UUID of an older frozen report",
  () => {
    const environment = fixture();
    try {
      const legacy = join(environment.directory, "legacy.sqlite");
      createLegacyDatabase(legacy);
      environment.options.push(
        "--mount",
        `type=bind,src=${legacy},dst=/acceptance/legacy.sqlite,readonly`,
      );
      const load = environment.module(
        "load-legacy.mjs",
        `
      import { copyFileSync } from 'node:fs';
      copyFileSync('/acceptance/legacy.sqlite', process.env.SQLITE_FILE_PATH);
    `,
      );
      container(["node", load], environment.options);
      environment.run(["run", "--once"]);
      const inspect = environment.module(
        "inspect-legacy.mjs",
        `
      import { openReportLedger } from '/app/dist/report-ledger.js';
      const ledger = openReportLedger({ databasePath: process.env.SQLITE_FILE_PATH,
        appId: 'cli_test', sourceChatId: 'oc_source', destinationChatId: 'oc_destination', readOnly: true });
      console.log(JSON.stringify(ledger.getDelivery('legacy-report')));
      ledger.close();
    `,
      );
      expect(
        JSON.parse(container(["node", inspect], environment.options)),
      ).toMatchObject({
        id: "legacy-report",
        state: "pending",
        sendUuid: "cccccccc-3333-4333-8333-cccccccccccc",
        text: "1 October 2026\n1. Anthony",
        entries: [{ displayName: "Anthony" }],
      });
      expect(
        JSON.parse(
          container(
            [
              "node",
              "dist/storage-command.js",
              "backup",
              "--output",
              "/data/upgraded-snapshot.sqlite",
            ],
            environment.options,
          ),
        ),
      ).toMatchObject({ status: "backed_up" });
    } finally {
      environment.close();
    }
  },
  30_000,
);

const previousImage = process.env.RELEASE_PREVIOUS_IMAGE;
const rollbackAcceptance =
  process.env.RUN_DOCKER_ACCEPTANCE === "true" && previousImage
    ? test
    : test.skip;

rollbackAcceptance(
  "the previous release preserves pending and sent records when application code rolls back",
  () => {
    if (!previousImage) throw new Error("Rollback image not configured");
    const environment = fixture();
    try {
      const pending = environment.run(["run", "--once"]);
      const seed = environment.module(
        "previous-sent.mjs",
        `
      import { openReportLedger } from '/app/dist/report-ledger.js';
      const now = Date.parse('2026-10-01T06:30:00.000Z');
      const ledger = openReportLedger({ databasePath: process.env.SQLITE_FILE_PATH,
        appId: process.env.LARK_APP_ID, sourceChatId: process.env.SOURCE_CHAT_ID,
        destinationChatId: process.env.SOURCE_CHAT_ID, clock: () => now,
        transport: async () => ({ messageId: 'om_synthetic_prior_ack' }) });
      const saved = ledger.prepareReminder({ businessDate: '2026-10-01', text: 'Synthetic prior reminder', policyVersion: 'synthetic-release-v1' });
      await ledger.deliverDelivery({ deliveryId: saved.delivery.id, now });
      ledger.close();
    `,
      );
      container(["node", seed], environment.options);
      const inspect = environment.module(
        "rollback-records.mjs",
        `
      import { openReportLedger } from '/app/dist/report-ledger.js';
      const ledger = openReportLedger({ databasePath: process.env.SQLITE_FILE_PATH,
        appId: process.env.LARK_APP_ID, sourceChatId: process.env.SOURCE_CHAT_ID,
        destinationChatId: process.env.SOURCE_CHAT_ID, readOnly: true });
      console.log(JSON.stringify(['2026-10-01', '2026-10-02'].map(date => ledger.getDailyDelivery(date, 'reminder'))));
      ledger.close();
    `,
      );
      const before = JSON.parse(
        container(["node", inspect], environment.options),
      );
      expect(before).toMatchObject([
        { state: "sent", messageId: "om_synthetic_prior_ack" },
        { state: "pending", id: pending.reminder.deliveryId },
      ]);
      const rolledBack = JSON.parse(
        container(
          [
            "node",
            "--import",
            "/acceptance/clock.mjs",
            "dist/worker-command.js",
            "run",
            "--once",
          ],
          environment.options,
          previousImage,
        ),
      );
      expect(rolledBack.reminder).toEqual(pending.reminder);
      expect(
        JSON.parse(
          container(["node", inspect], environment.options, previousImage),
        ),
      ).toEqual(before);
      expect(
        JSON.parse(container(["node", inspect], environment.options)),
      ).toEqual(before);
    } finally {
      environment.close();
    }
  },
  30_000,
);

acceptance(
  "the non-root worker creates private ledger files inside its private persistent volume",
  () => {
    const environment = fixture();
    try {
      environment.run(["run", "--once"]);
      const output = JSON.parse(
        container(
          [
            "node",
            "--input-type=module",
            "--eval",
            `
      import { statSync } from 'node:fs';
      console.log(JSON.stringify({ uid: process.getuid(), directoryMode: statSync('/data').mode & 0o777,
        fileMode: statSync(process.env.SQLITE_FILE_PATH).mode & 0o777 }));
    `,
          ],
          environment.options,
        ),
      );
      expect(output).toEqual({
        uid: 1000,
        directoryMode: 0o700,
        fileMode: 0o600,
      });
    } finally {
      environment.close();
    }
  },
  30_000,
);

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openBriefLedger } from "../../src/brief-ledger.js";
import type { BriefScan } from "../../src/brief-submissions.js";
import {
  evaluateBriefObservations,
  type SubmissionObservation,
} from "../../src/evaluate-submissions.js";
import { openReportLedger } from "../../src/report-ledger.js";
import { createPreBriefDatabase } from "../support/pre-brief-database.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const businessDate = "2026-10-01";
const policy = {
  appId: "cli_test",
  sourceChatId: "oc_source",
  timeZone: "Africa/Nairobi" as const,
  publicHolidays: [],
  policyVersion: "policy-v1",
};
const config = {
  appId: policy.appId,
  sourceChatId: policy.sourceChatId,
  destinationChatId: "oc_management",
  policy,
  templateVersion: "template-v1",
  promptVersion: "prompt-v1",
  schemaVersion: "schema-v1",
  provider: "gemini" as const,
  model: "configured-model",
};
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "brief-ledger-"));
  directories.push(directory);
  return join(directory, "ledger.sqlite");
}
function message(
  name: string,
  time: string,
  task: string,
): SubmissionObservation {
  const createdMs = Date.parse(`${businessDate}T${time}+03:00`);
  return {
    observationId: `obs_${name}`,
    messageId: `msg_${name}`,
    appId: policy.appId,
    sourceChatId: policy.sourceChatId,
    sender: {
      type: "user",
      openId: `ou_${name}`,
      tenantKey: "external_tenant",
      displayName: name,
    },
    createdMs,
    updatedMs: createdMs,
    messageType: "text",
    content: JSON.stringify({ text: `Task list\n1. ${task}` }),
    deleted: false,
  };
}
function scan(
  messages = [
    message("Alice", "09:45:00", "Prepare drawings"),
    message("Bob", "10:07:00", "Review estimates"),
  ],
): BriefScan {
  const evaluated = evaluateBriefObservations({
    businessDate,
    policy: { ...policy, replyPolicy: "exclude" },
    messages,
  });
  return {
    status: evaluated.status === "ready" ? "complete" : "review_required",
    appId: policy.appId,
    sourceChatId: policy.sourceChatId,
    businessDate,
    fromMs: Date.parse(`${businessDate}T00:00:00+03:00`),
    throughMs: Date.parse(`${businessDate}T10:15:00+03:00`),
    observedAtMs: Date.parse(`${businessDate}T10:15:01+03:00`),
    replyPolicy: "exclude",
    messages,
    decisions: evaluated.decisions,
    entries: evaluated.entries.map((entry) => {
      const source = messages.find(
        (m) => m.observationId === entry.evidence.observationId,
      );
      const decision = evaluated.decisions.find(
        (d) => d.observationId === entry.evidence.observationId,
      );
      if (!source || !decision?.normalizedText)
        throw new Error("Invalid fixture");
      return {
        ...entry,
        createdMs: source.createdMs,
        normalizedText: decision.normalizedText,
        timeliness:
          source.createdMs < Date.parse(`${businessDate}T10:01:00+03:00`)
            ? "on_time"
            : "late",
      };
    }),
  };
}

test("freezes on-time and late task lists across source edits, configuration changes and restart", () => {
  const path = databasePath();
  const ledger = openBriefLedger({ ...config, databasePath: path });
  const prepared = ledger.prepareDailyBrief({ businessDate, scan: scan() });
  if (prepared.status !== "frozen") throw new Error("Expected frozen input");
  const initial = ledger.getBrief(prepared.brief.id);
  expect(initial).toMatchObject({
    state: "input_frozen",
    outputMode: "doc",
    provider: "gemini",
    model: "configured-model",
    entries: [
      {
        displayName: "Alice",
        normalizedText: "Task list\n1. Prepare drawings",
        timeliness: "on_time",
      },
      {
        displayName: "Bob",
        normalizedText: "Task list\n1. Review estimates",
        timeliness: "late",
      },
    ],
  });
  ledger.close();
  const reopened = openBriefLedger({
    ...config,
    databasePath: path,
    model: "new-model",
    templateVersion: "template-v2",
  });
  try {
    expect(
      reopened.prepareDailyBrief({
        businessDate,
        scan: scan([message("Alice", "09:45:00", "Changed tasks")]),
      }),
    ).toEqual({ status: "existing", brief: initial });
    expect(reopened.getBrief(prepared.brief.id)).toEqual(initial);
  } finally {
    reopened.close();
  }
});

/** Invalid captures must leave no job behind so a repaired capture can still be frozen. */
test.each([
  [
    "incomplete",
    (value: BriefScan) => ({ ...value, status: "incomplete" as const }),
  ],
  [
    "review required",
    (value: BriefScan) => ({ ...value, status: "review_required" as const }),
  ],
  ["wrong app", (value: BriefScan) => ({ ...value, appId: "other_app" })],
  [
    "wrong group",
    (value: BriefScan) => ({ ...value, sourceChatId: "other_group" }),
  ],
  [
    "wrong date",
    (value: BriefScan) => ({ ...value, businessDate: "2026-10-02" }),
  ],
  [
    "short history window",
    (value: BriefScan) => ({ ...value, throughMs: value.throughMs - 1 }),
  ],
  [
    "extended history window",
    (value: BriefScan) => ({ ...value, throughMs: value.throughMs + 1 }),
  ],
  [
    "missing start coverage",
    (value: BriefScan) => ({ ...value, fromMs: value.fromMs + 1 }),
  ],
  [
    "before capture time",
    (value: BriefScan) => ({ ...value, observedAtMs: value.throughMs - 1 }),
  ],
  [
    "thread coverage",
    (value: BriefScan) => ({ ...value, replyPolicy: "include" as const }),
  ],
])("blocks %s captures without occupying the daily job", (_, change) => {
  const ledger = openBriefLedger({ ...config, databasePath: databasePath() });
  try {
    expect(
      ledger.prepareDailyBrief({ businessDate, scan: change(scan()) }).status,
    ).toBe("blocked");
    expect(
      ledger.prepareDailyBrief({ businessDate, scan: scan() }).status,
    ).toBe("frozen");
  } finally {
    ledger.close();
  }
});

test.each([
  [
    "omitted person",
    (value: BriefScan) => ({ ...value, entries: value.entries.slice(0, 1) }),
  ],
  [
    "changed task text",
    (value: BriefScan) => ({
      ...value,
      entries: value.entries.map((entry) => ({
        ...entry,
        normalizedText: "invented tasks",
      })),
    }),
  ],
  [
    "wrong late label",
    (value: BriefScan) => ({
      ...value,
      entries: value.entries.map((entry) => ({
        ...entry,
        timeliness: "on_time" as const,
      })),
    }),
  ],
  [
    "unresolved source name",
    (value: BriefScan) => ({
      ...value,
      messages: value.messages.map((source) => ({
        ...source,
        sender: {
          type: "user",
          tenantKey: "external_tenant",
          ...(source.sender.openId ? { openId: source.sender.openId } : {}),
        },
      })),
    }),
  ],
  [
    "duplicate source observations",
    (value: BriefScan) => ({
      ...value,
      messages: [...value.messages, ...value.messages.slice(0, 1)],
    }),
  ],
])("blocks %s rather than freezing unverified membership", (_, change) => {
  const ledger = openBriefLedger({ ...config, databasePath: databasePath() });
  try {
    expect(
      ledger.prepareDailyBrief({ businessDate, scan: change(scan()) }).status,
    ).toBe("blocked");
    expect(
      ledger.prepareDailyBrief({ businessDate, scan: scan() }).status,
    ).toBe("frozen");
  } finally {
    ledger.close();
  }
});

test.each([
  ["holiday", { ...policy, publicHolidays: [businessDate] }],
  ["wrong policy app", { ...policy, appId: "other_app" }],
  ["thread policy", { ...policy, replyPolicy: "include" as const }],
  ["invalid holiday", { ...policy, publicHolidays: ["2026-02-30"] }],
])("blocks %s policy before creating a job", (_, rules) => {
  const ledger = openBriefLedger({
    ...config,
    policy: rules,
    databasePath: databasePath(),
  });
  try {
    expect(
      ledger.prepareDailyBrief({ businessDate, scan: scan() }).status,
    ).toBe("blocked");
  } finally {
    ledger.close();
  }
});

/** Freeze a names report through its existing seam, using the same source evidence. */
function freezeNames(path: string, sources: SubmissionObservation[]) {
  const ledger = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => Date.parse(`${businessDate}T10:16:00+03:00`),
  });
  const prepared = ledger.prepareDailyReport({
    businessDate,
    policy: { ...policy, replyPolicy: "exclude" },
    scan: {
      ...scan(sources),
      status: "complete",
      throughMs: Date.parse(`${businessDate}T10:01:00+03:00`),
    },
  });
  if (prepared.status !== "frozen") throw new Error("Expected names report");
  const delivery = ledger.getDelivery(prepared.delivery.id);
  if (!delivery) throw new Error("Missing frozen names report");
  return { ledger, delivery };
}

test("reuses names-report evidence and independently adds late membership without relabelling it", () => {
  const path = databasePath();
  const source = scan();
  const names = freezeNames(path, [...source.messages]);
  const brief = openBriefLedger({ ...config, databasePath: path });
  try {
    const prepared = brief.prepareDailyBrief({ businessDate, scan: source });
    if (prepared.status !== "frozen") throw new Error("Expected brief");
    expect(prepared.brief.entries[0]?.observation).toEqual(
      names.delivery.entries[0]?.observation,
    );
    expect(prepared.brief.entries[1]).toMatchObject({
      displayName: "Bob",
      timeliness: "late",
      observation: {
        detectorVersion: "brief-task-list-v2",
        reason: "task_list",
      },
    });
    expect(names.ledger.getDelivery(names.delivery.id)).toEqual(names.delivery);
  } finally {
    brief.close();
    names.ledger.close();
  }
});

test("rolls back the entire brief when a later entry contradicts retained source evidence", () => {
  const path = databasePath();
  const alice = message("Alice", "09:40:00", "Prepare drawings");
  const bob = message("Bob", "09:50:00", "Review estimates");
  const sources = [alice, bob];
  const names = freezeNames(path, sources);
  const ledger = openBriefLedger({ ...config, databasePath: path });
  try {
    const editedAlice = {
      ...alice,
      updatedMs: alice.updatedMs + 1000,
      content: JSON.stringify({ text: "Task list\n1. Updated drawings" }),
    };
    const contradictedBob = {
      ...bob,
      content: JSON.stringify({ text: "Task list\n1. Conflicting estimates" }),
    };
    expect(
      ledger.prepareDailyBrief({
        businessDate,
        scan: scan([editedAlice, contradictedBob]),
      }),
    ).toMatchObject({
      status: "blocked",
      reasons: ["source_version_conflict"],
    });
    // The first entry's newer version must also have rolled back; the original scan can still freeze.
    const repaired = ledger.prepareDailyBrief({
      businessDate,
      scan: scan(sources),
    });
    expect(repaired.status).toBe("frozen");
    expect(names.ledger.getDelivery(names.delivery.id)).toEqual(names.delivery);
  } finally {
    ledger.close();
    names.ledger.close();
  }
});

test.each([
  [
    "changed sender",
    (source: SubmissionObservation) => ({
      ...source,
      sender: { ...source.sender, openId: "ou_other" },
    }),
    "source_identity_conflict",
  ],
  [
    "changed original send time",
    (source: SubmissionObservation) => ({
      ...source,
      createdMs: source.createdMs + 1,
    }),
    "source_identity_conflict",
  ],
  [
    "older version",
    (source: SubmissionObservation) => ({
      ...source,
      updatedMs: source.updatedMs - 500,
    }),
    "stale_observation",
  ],
])("blocks %s against previously stored evidence", (_, change, reason) => {
  const path = databasePath();
  const original = message("Alice", "09:40:00", "Prepare drawings");
  const stored = { ...original, updatedMs: original.createdMs + 1000 };
  const names = freezeNames(path, [stored]);
  const ledger = openBriefLedger({ ...config, databasePath: path });
  try {
    expect(
      ledger.prepareDailyBrief({ businessDate, scan: scan([change(stored)]) }),
    ).toMatchObject({ status: "blocked", reasons: [reason] });
    expect(
      ledger.prepareDailyBrief({ businessDate, scan: scan([stored]) }).status,
    ).toBe("frozen");
  } finally {
    ledger.close();
    names.ledger.close();
  }
});

test("never resurrects a recall already retained by the names ledger", () => {
  const path = databasePath();
  const original = message("Alice", "09:40:00", "Prepare drawings");
  const names = freezeNames(path, [original]);
  names.ledger.prepareDailyReport({
    businessDate,
    policy: { ...policy, replyPolicy: "exclude" },
    scan: {
      ...scan([
        { ...original, deleted: true, updatedMs: original.updatedMs + 1000 },
      ]),
      status: "complete",
      throughMs: Date.parse(`${businessDate}T10:01:00+03:00`),
    },
  });
  const ledger = openBriefLedger({ ...config, databasePath: path });
  try {
    expect(
      ledger.prepareDailyBrief({
        businessDate,
        scan: scan([{ ...original, updatedMs: original.updatedMs + 2000 }]),
      }),
    ).toMatchObject({ status: "blocked", reasons: ["known_recall"] });
  } finally {
    ledger.close();
    names.ledger.close();
  }
});

test("empty complete capture freezes a readable job without manufacturing entries", () => {
  const ledger = openBriefLedger({ ...config, databasePath: databasePath() });
  try {
    const prepared = ledger.prepareDailyBrief({ businessDate, scan: scan([]) });
    if (prepared.status !== "frozen") throw new Error("Expected empty brief");
    expect(ledger.getBrief(prepared.brief.id)).toMatchObject({
      state: "input_frozen",
      entries: [],
    });
    expect(ledger.getBrief("unknown")).toBeNull();
  } finally {
    ledger.close();
  }
});

test("brief reads and repeat preparation remain scoped to the configured destination", () => {
  const path = databasePath();
  const first = openBriefLedger({ ...config, databasePath: path });
  const other = openBriefLedger({
    ...config,
    databasePath: path,
    destinationChatId: "oc_other",
  });
  try {
    const prepared = first.prepareDailyBrief({ businessDate, scan: scan() });
    if (prepared.status !== "frozen") throw new Error("Expected brief");
    expect(other.getBrief(prepared.brief.id)).toBeNull();
    const second = other.prepareDailyBrief({ businessDate, scan: scan() });
    if (second.status !== "frozen") throw new Error("Expected separate job");
    expect(second.brief.id).not.toBe(prepared.brief.id);
  } finally {
    first.close();
    other.close();
  }
});

/** Run existing backup/restore commands without credentials or live Lark access. */
function storageCommand(path: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/storage-command.ts", ...args],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { PATH: process.env.PATH, SQLITE_FILE_PATH: path },
    },
  );
}

test("online backup and isolated restore preserve the exact brief input alongside names delivery", () => {
  const path = databasePath();
  const names = freezeNames(path, [...scan().messages]);
  const ledger = openBriefLedger({ ...config, databasePath: path });
  try {
    const prepared = ledger.prepareDailyBrief({ businessDate, scan: scan() });
    if (prepared.status !== "frozen") throw new Error("Expected brief");
    const backup = `${path}.backup`;
    const restored = `${path}.restored`;
    expect(storageCommand(path, ["backup", "--output", backup]).status).toBe(0);
    const restoredResult = storageCommand(path, [
      "restore",
      "--backup",
      backup,
      "--output",
      restored,
    ]);
    expect(restoredResult.status).toBe(0);
    expect(JSON.parse(restoredResult.stdout)).toMatchObject({
      restoreReviewRequired: true,
    });
    const restoredBrief = openBriefLedger({
      ...config,
      databasePath: restored,
    });
    const restoredNames = openReportLedger({
      ...config,
      databasePath: restored,
    });
    try {
      expect(restoredBrief.getBrief(prepared.brief.id)).toEqual(prepared.brief);
      expect(restoredNames.getDelivery(names.delivery.id)).toEqual(
        names.delivery,
      );
    } finally {
      restoredBrief.close();
      restoredNames.close();
    }
  } finally {
    ledger.close();
    names.ledger.close();
  }
});

/** Two independent workers start against an already migrated ledger; SQLite arbitrates the freeze. */
function prepareProcess(path: string): Promise<{
  status: string;
  brief: { id: string; inputFingerprint: string };
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { openBriefLedger } from './src/brief-ledger.ts'; let body=''; for await (const chunk of process.stdin) body+=chunk; const request=JSON.parse(body); const ledger=openBriefLedger(request.options); try { console.log(JSON.stringify(ledger.prepareDailyBrief(request.input))); } finally { ledger.close(); }`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr));
      else {
        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(
      JSON.stringify({
        options: { ...config, databasePath: path },
        input: { businessDate, scan: scan() },
      }),
    );
  });
}

test("competing processes freeze exactly one daily job and share its immutable input", async () => {
  const path = databasePath();
  openBriefLedger({ ...config, databasePath: path }).close();
  const results = await Promise.all([
    prepareProcess(path),
    prepareProcess(path),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "existing",
    "frozen",
  ]);
  expect(results[0]?.brief).toEqual(results[1]?.brief);
});

test("upgrades the pre-brief release without changing frozen names or reminder payloads and UUIDs", () => {
  const path = databasePath();
  createPreBriefDatabase(path);
  const brief = openBriefLedger({ ...config, databasePath: path });
  const names = openReportLedger({
    ...config,
    databasePath: path,
    readOnly: true,
  });
  const reminders = openReportLedger({
    ...config,
    databasePath: path,
    destinationChatId: config.sourceChatId,
    readOnly: true,
  });
  try {
    expect(names.getDelivery("previous-report")).toMatchObject({
      text: "1 October 2026\n1. Alice",
      sendUuid: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      state: "pending",
    });
    expect(reminders.getDelivery("previous-reminder")).toMatchObject({
      text: "Please post your task list.",
      sendUuid: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
      state: "pending",
    });
    expect(brief.prepareDailyBrief({ businessDate, scan: scan() }).status).toBe(
      "frozen",
    );
  } finally {
    brief.close();
    names.close();
    reminders.close();
  }
});

test("accepts equivalent entry objects regardless of property insertion order", () => {
  const ledger = openBriefLedger({ ...config, databasePath: databasePath() });
  const capture = scan();
  capture.entries = capture.entries.map((entry) => ({
    normalizedText: entry.normalizedText,
    timeliness: entry.timeliness,
    createdMs: entry.createdMs,
    evidence: {
      messageId: entry.evidence.messageId,
      observationId: entry.evidence.observationId,
    },
    displayName: entry.displayName,
    senderIdentity: {
      openId: entry.senderIdentity.openId,
      tenantKey: entry.senderIdentity.tenantKey,
      appId: entry.senderIdentity.appId,
    },
  }));
  try {
    expect(
      ledger.prepareDailyBrief({ businessDate, scan: capture }).status,
    ).toBe("frozen");
  } finally {
    ledger.close();
  }
});

test("accepts resolved sender identity after earlier names preparation retained incomplete metadata", () => {
  const path = databasePath();
  const source = message("Alice", "09:40:00", "Prepare drawings");
  const names = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => Date.parse(`${businessDate}T10:16:00+03:00`),
  });
  const incomplete = {
    ...source,
    sender: { type: "user", displayName: "Alice" },
  };
  const prepared = names.prepareDailyReport({
    businessDate,
    policy: { ...policy, replyPolicy: "exclude" },
    scan: {
      ...scan([incomplete]),
      status: "complete",
      throughMs: Date.parse(`${businessDate}T10:01:00+03:00`),
    },
  });
  expect(prepared.status).toBe("blocked");
  const brief = openBriefLedger({ ...config, databasePath: path });
  try {
    const resolved = brief.prepareDailyBrief({
      businessDate,
      scan: scan([source]),
    });
    expect(resolved.status).toBe("frozen");
    if (resolved.status !== "frozen")
      throw new Error("Expected resolved input");
    expect(resolved.brief.entries[0]?.senderIdentity).toEqual({
      appId: "cli_test",
      tenantKey: "external_tenant",
      openId: "ou_Alice",
    });
    expect(resolved.brief.entries[0]?.observation?.sender).toEqual({
      type: "user",
      displayName: "Alice",
    });
  } finally {
    brief.close();
    names.close();
  }
});

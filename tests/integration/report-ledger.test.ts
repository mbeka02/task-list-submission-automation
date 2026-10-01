import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  openReportLedger,
  type PrepareReportInput,
} from "../../src/report-ledger.js";
import { createLegacyDatabase } from "../support/legacy-database.js";
import { ledgerProcess } from "../support/process-harness.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, 1790837999999])(
  "an invalid or before-cutoff delivery time cannot send: %s",
  async (deliveryTime) => {
    const requests: unknown[] = [];
    const ledger = openReportLedger({
      ...config,
      databasePath: databasePath(),
      clock: () => now,
      transport: async (request) => {
        requests.push(request);
        return { messageId: "unexpected" };
      },
    });
    try {
      const prepared = ledger.prepareDailyReport({
        businessDate: "2026-10-01",
        scan,
        policy,
      });
      if (prepared.status !== "frozen")
        throw new Error("Expected frozen report");
      expect(
        await ledger.deliverDelivery({
          deliveryId: prepared.delivery.id,
          now: deliveryTime,
        }),
      ).toMatchObject({ status: "not_sent", reason: "invalid_delivery_time" });
      expect(requests).toEqual([]);
      expect(ledger.getDelivery(prepared.delivery.id)).toMatchObject({
        state: "pending",
        attemptCount: 0,
      });
    } finally {
      ledger.close();
    }
  },
);

test("equal send times use stable sender identity to order the frozen report", () => {
  const ledger = openReportLedger({
    ...config,
    databasePath: databasePath(),
    clock: () => now,
  });
  try {
    const result = ledger.prepareDailyReport({
      businessDate: "2026-10-01",
      policy,
      scan: {
        ...scan,
        messages: [
          {
            ...observation,
            messageId: "om_a",
            observationId: "obs_z",
            sender: {
              ...observation.sender,
              openId: "ou_z",
              displayName: "Zoe",
            },
          },
          {
            ...observation,
            messageId: "om_z",
            observationId: "obs_a",
            sender: {
              ...observation.sender,
              openId: "ou_a",
              displayName: "Alice",
            },
          },
        ],
      },
    });
    expect(result).toMatchObject({
      status: "frozen",
      delivery: {
        text: "1 October 2026\n1. Alice\n2. Zoe",
        entries: [{ displayName: "Alice" }, { displayName: "Zoe" }],
      },
    });
  } finally {
    ledger.close();
  }
});

test("schema upgrades preserve earlier frozen reports and block delivery with missing legacy evidence", async () => {
  const path = databasePath();
  createLegacyDatabase(path);
  const requests: unknown[] = [];
  const ledger = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
    transport: async (request) => {
      requests.push(request);
      return { messageId: "unexpected" };
    },
  });
  try {
    expect(ledger.getDelivery("legacy-report")).toMatchObject({
      text: "1 October 2026\n1. Anthony",
      sendUuid: "cccccccc-3333-4333-8333-cccccccccccc",
      state: "pending",
      entries: [{ displayName: "Anthony", observation: null }],
    });
    expect(
      await ledger.deliverDelivery({ deliveryId: "legacy-report", now }),
    ).toMatchObject({
      status: "not_sent",
      reason: "frozen_evidence_unavailable",
    });
    expect(requests).toEqual([]);
  } finally {
    ledger.close();
  }
});

test.each(["multiple_versions", "reused_observation_id"])(
  "an allegedly complete scan with %s is rejected before freezing",
  (conflict) => {
    const ledger = openReportLedger({
      ...config,
      databasePath: databasePath(),
      clock: () => now,
    });
    try {
      const second = {
        ...observation,
        observationId:
          conflict === "reused_observation_id"
            ? observation.observationId
            : "obs_second_version",
        messageId:
          conflict === "multiple_versions"
            ? observation.messageId
            : "om_second",
        updatedMs: now,
        sender: {
          ...observation.sender,
          openId: "ou_second",
          displayName: "Second",
        },
        content: JSON.stringify({ text: "Task list\n1. Different task" }),
      };
      expect(
        ledger.prepareDailyReport({
          businessDate: "2026-10-01",
          policy,
          scan: { ...scan, messages: [observation, second] },
        }),
      ).toMatchObject({
        status: "blocked",
        reasons: ["scan_observation_conflict"],
      });
    } finally {
      ledger.close();
    }
  },
);

test.each(["older_version", "equal_version_conflict", "recalled"])(
  "cached evidence rejects a misleading %s observation",
  (change) => {
    const ledger = openReportLedger({
      ...config,
      databasePath: databasePath(),
      clock: () => now + 60_000,
    });
    const review = {
      ...observation,
      messageId: "om_review",
      observationId: "obs_review",
      sender: {
        type: "user",
        tenantKey: "tenant_external",
        openId: "ou_review",
      },
    };
    const current = {
      ...observation,
      observationId: "obs_current",
      updatedMs: now,
      deleted: change === "recalled",
      content:
        change === "recalled"
          ? ""
          : JSON.stringify({ text: "Task list\n1. Current task" }),
    };
    try {
      ledger.prepareDailyReport({
        businessDate: "2026-10-01",
        policy,
        scan: { ...scan, messages: [current, review] },
      });
      const misleading = {
        ...observation,
        observationId: "obs_misleading",
        updatedMs:
          change === "older_version"
            ? observation.updatedMs
            : change === "recalled"
              ? now + 1
              : now,
      };
      const reasons: Record<string, string> = {
        older_version: "stale_observation",
        equal_version_conflict: "source_version_conflict",
        recalled: "known_recall",
      };
      expect(
        ledger.prepareDailyReport({
          businessDate: "2026-10-01",
          policy,
          scan: { ...scan, observedAtMs: now + 60_000, messages: [misleading] },
        }),
      ).toMatchObject({ status: "blocked", reasons: [reasons[change]] });
    } finally {
      ledger.close();
    }
  },
);

test.each(["openId", "tenantKey"] as const)(
  "an empty %s in a later scan cannot erase an established sender identity",
  (missingField) => {
    const path = databasePath();
    let ledger = openReportLedger({
      ...config,
      databasePath: path,
      clock: () => now,
    });
    const unresolvedName = {
      ...observation,
      sender: {
        type: "user",
        tenantKey: observation.sender.tenantKey,
        openId: observation.sender.openId,
      },
    };
    try {
      expect(
        ledger.prepareDailyReport({
          businessDate: "2026-10-01",
          policy,
          scan: { ...scan, messages: [unresolvedName] },
        }),
      ).toMatchObject({ status: "blocked", reasons: ["unresolved_name"] });
      expect(
        ledger.prepareDailyReport({
          businessDate: "2026-10-01",
          policy,
          scan: {
            ...scan,
            messages: [
              {
                ...unresolvedName,
                observationId: "obs_identity_missing",
                updatedMs: now - 1000,
                sender: { ...unresolvedName.sender, [missingField]: "" },
              },
            ],
          },
        }),
      ).toMatchObject({ status: "blocked", reasons: ["unresolved_identity"] });
      ledger.close();
      ledger = openReportLedger({
        ...config,
        databasePath: path,
        clock: () => now,
      });
      expect(
        ledger.prepareDailyReport({
          businessDate: "2026-10-01",
          policy,
          scan: {
            ...scan,
            messages: [
              {
                ...observation,
                observationId: "obs_identity_changed",
                updatedMs: now,
                sender: {
                  ...observation.sender,
                  [missingField]: "different_identity",
                },
              },
            ],
          },
        }),
      ).toMatchObject({
        status: "blocked",
        reasons: ["source_identity_conflict"],
      });
    } finally {
      ledger.close();
    }
  },
);

test.each(["sender", "tenant", "creation_time"])(
  "a source message cannot change its immutable %s metadata across scans",
  (change) => {
    const ledger = openReportLedger({
      ...config,
      databasePath: databasePath(),
      clock: () => now + 60_000,
    });
    const review = {
      ...observation,
      messageId: "om_review",
      observationId: "obs_review",
      sender: {
        type: "user",
        tenantKey: "tenant_external",
        openId: "ou_review",
      },
    };
    try {
      ledger.prepareDailyReport({
        businessDate: "2026-10-01",
        policy,
        scan: { ...scan, messages: [observation, review] },
      });
      const changed = {
        ...observation,
        observationId: "obs_changed",
        updatedMs: now,
        createdMs:
          change === "creation_time"
            ? observation.createdMs - 1000
            : observation.createdMs,
        sender: {
          ...observation.sender,
          openId: change === "sender" ? "ou_imposter" : "ou_anthony",
          tenantKey: change === "tenant" ? "tenant_other" : "tenant_external",
        },
      };
      expect(
        ledger.prepareDailyReport({
          businessDate: "2026-10-01",
          policy,
          scan: { ...scan, observedAtMs: now + 60_000, messages: [changed] },
        }),
      ).toMatchObject({
        status: "blocked",
        reasons: ["source_identity_conflict"],
      });
    } finally {
      ledger.close();
    }
  },
);

test("a ledger configured for another app or destination cannot read or send this report", async () => {
  const path = databasePath();
  const owner = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
  });
  const prepared = owner.prepareDailyReport({
    businessDate: "2026-10-01",
    scan,
    policy,
  });
  if (prepared.status !== "frozen") throw new Error("Expected frozen report");
  owner.close();
  for (const overrides of [
    { appId: "cli_other" },
    { destinationChatId: "oc_other" },
    { sourceChatId: "oc_other" },
  ]) {
    const requests: unknown[] = [];
    const other = openReportLedger({
      ...config,
      ...overrides,
      databasePath: path,
      clock: () => now,
      transport: async (request) => {
        requests.push(request);
        return { messageId: "unexpected" };
      },
    });
    try {
      expect(other.getDelivery(prepared.delivery.id)).toBeNull();
      expect(
        await other.deliverDelivery({ deliveryId: prepared.delivery.id, now }),
      ).toMatchObject({ status: "not_sent" });
      expect(requests).toEqual([]);
    } finally {
      other.close();
    }
  }
});

test("independent processes send once and outbound waiting leaves SQLite available to another writer", async () => {
  const path = databasePath();
  const parent = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now + 86_400_000,
  });
  const seed = parent.prepareDailyReport({
    businessDate: "2026-10-01",
    scan,
    policy,
  });
  if (seed.status !== "frozen") throw new Error("Expected frozen report");
  const fixture = {
    ...config,
    databasePath: path,
    now,
    action: "deliver",
    deliveryId: seed.delivery.id,
    input: { businessDate: "2026-10-01", scan, policy },
  };
  const first = ledgerProcess(fixture);
  const second = ledgerProcess(fixture);
  try {
    await Promise.all([first.next("ready"), second.next("ready")]);
    first.go();
    const outbound = await first.next("request");
    expect(outbound.request).toMatchObject({
      text: "1 October 2026\n1. Anthony",
      uuid: seed.delivery.sendUuid,
    });
    second.go();
    expect((await second.next("result")).result).toMatchObject({
      status: "not_sent",
    });
    const another = parent.prepareDailyReport({
      businessDate: "2026-10-02",
      policy,
      scan: {
        ...scan,
        businessDate: "2026-10-02",
        observedAtMs: now + 86_400_000,
        fromMs: Date.parse("2026-10-01T21:00:00.000Z"),
        throughMs: Date.parse("2026-10-02T07:00:00.000Z"),
        messages: [
          {
            ...observation,
            messageId: "om_next_day",
            observationId: "obs_next_day",
            createdMs: Date.parse("2026-10-02T06:55:00.000Z"),
            updatedMs: Date.parse("2026-10-02T06:55:00.000Z"),
          },
        ],
      },
    });
    expect(another.status).toBe("frozen");
    first.acknowledge();
    expect((await first.next("result")).result).toMatchObject({
      status: "sent",
    });
    expect(parent.getDelivery(seed.delivery.id)).toMatchObject({
      state: "sent",
      attemptCount: 1,
      messageId: "om_process_ack",
    });
  } finally {
    await Promise.all([first.close(), second.close()]);
    parent.close();
  }
});

test("competing processes freeze one logical report with one persisted UUID", async () => {
  const path = databasePath();
  openReportLedger({ ...config, databasePath: path, clock: () => now }).close();
  const fixture = {
    ...config,
    databasePath: path,
    now,
    action: "prepare",
    input: { businessDate: "2026-10-01", scan, policy },
  };
  const first = ledgerProcess({ ...fixture, holdUuid: true });
  const second = ledgerProcess(fixture);
  try {
    await Promise.all([first.next("ready"), second.next("ready")]);
    first.go();
    await first.next("uuid");
    second.go();
    await second.next("starting");
    const secondResult = second.next("result");
    // Keep the first write transaction open while the other process attempts
    // its own transaction. This is a bounded process-control wait, not a clock
    // advance or a scheduling/lease assertion.
    await Promise.race([
      secondResult,
      new Promise<void>((resolve) => setTimeout(resolve, 125)),
    ]);
    first.releaseUuid();
    const outcomes = await Promise.all([first.next("result"), secondResult]);
    expect(outcomes.map((event) => event.result?.status)).toEqual([
      "frozen",
      "frozen",
    ]);
    const one = outcomes[0]?.result;
    const two = outcomes[1]?.result;
    if (one?.status !== "frozen" || two?.status !== "frozen")
      throw new Error("Expected frozen reports");
    expect(two.delivery).toEqual(one.delivery);
    expect(outcomes.map((event) => event.uuidCalls)).toEqual([1, 0]);
  } finally {
    first.releaseUuid();
    await Promise.all([first.close(), second.close()]);
  }
});

test.each(["lost_response", "empty_ack"])(
  "an ambiguous %s remains durable and cannot be automatically resent",
  async (failure) => {
    const path = databasePath();
    const requests: unknown[] = [];
    const ledger = openReportLedger({
      ...config,
      databasePath: path,
      clock: () => now,
      transport: async (request) => {
        requests.push(request);
        if (failure === "lost_response")
          throw new Error("synthetic-secret-do-not-store");
        return { messageId: "" };
      },
    });
    const prepared = ledger.prepareDailyReport({
      businessDate: "2026-10-01",
      scan,
      policy,
    });
    if (prepared.status !== "frozen") throw new Error("Expected frozen report");
    const outcome = await ledger.deliverDelivery({
      deliveryId: prepared.delivery.id,
      now,
    });
    expect(outcome).toMatchObject({ status: "uncertain" });
    ledger.close();
    const reopened = openReportLedger({
      ...config,
      databasePath: path,
      clock: () => now,
      transport: async (request) => {
        requests.push(request);
        return { messageId: "unexpected" };
      },
    });
    try {
      const saved = reopened.getDelivery(prepared.delivery.id);
      expect(saved).toMatchObject({
        state: "uncertain",
        attemptCount: 1,
        messageId: null,
      });
      expect(JSON.stringify(saved)).not.toContain(
        "synthetic-secret-do-not-store",
      );
      expect(
        await reopened.deliverDelivery({
          deliveryId: prepared.delivery.id,
          now: now + 60_000,
        }),
      ).toMatchObject({ status: "not_sent" });
      expect(requests).toHaveLength(1);
    } finally {
      reopened.close();
    }
  },
);

test("independent connections claim one delivery and an acknowledged report is never sent again", async () => {
  const path = databasePath();
  const requests: unknown[] = [];
  let respond: ((ack: { messageId: string }) => void) | undefined;
  const response = new Promise<{ messageId: string }>((resolve) => {
    respond = resolve;
  });
  const first = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
    transport: async (request) => {
      requests.push(request);
      return response;
    },
  });
  const prepared = first.prepareDailyReport({
    businessDate: "2026-10-01",
    scan,
    policy,
  });
  if (prepared.status !== "frozen") throw new Error("Expected frozen report");
  const second = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
    transport: async (request) => {
      requests.push(request);
      return response;
    },
  });
  const delivering = first.deliverDelivery({
    deliveryId: prepared.delivery.id,
    now,
  });
  try {
    expect(second.getDelivery(prepared.delivery.id)).toMatchObject({
      state: "sending",
      attemptCount: 1,
      firstAttemptMs: now,
      claimExpiresMs: now + 60_000,
    });
    expect(
      await second.deliverDelivery({ deliveryId: prepared.delivery.id, now }),
    ).toMatchObject({ status: "not_sent" });
    respond?.({ messageId: "om_single_ack" });
    await delivering;
    expect(
      await second.deliverDelivery({ deliveryId: prepared.delivery.id, now }),
    ).toMatchObject({ status: "not_sent" });
    expect(requests).toHaveLength(1);
    expect(second.getDelivery(prepared.delivery.id)).toMatchObject({
      state: "sent",
      attemptCount: 1,
      acknowledgedMs: now,
      messageId: "om_single_ack",
    });
  } finally {
    respond?.({ messageId: "om_single_ack" });
    await delivering;
    first.close();
    second.close();
  }
});

test.each(["recalled", "changed", "absent"])(
  "current completed scan cannot replace %s content with an older cached submission",
  (change) => {
    const ledger = openReportLedger({
      ...config,
      databasePath: databasePath(),
      clock: () => now + 60_000,
    });
    try {
      const unresolved = {
        ...observation,
        messageId: "om_review",
        observationId: "obs_review",
        sender: {
          type: "user",
          tenantKey: "tenant_external",
          openId: "ou_review",
        },
      };
      expect(
        ledger.prepareDailyReport({
          businessDate: "2026-10-01",
          policy,
          scan: { ...scan, messages: [observation, unresolved] },
        }).status,
      ).toBe("blocked");
      const current =
        change === "absent"
          ? []
          : [
              {
                ...observation,
                observationId: "obs_current",
                updatedMs: now,
                deleted: change === "recalled",
                content:
                  change === "recalled"
                    ? ""
                    : JSON.stringify({ text: "Ordinary discussion" }),
              },
            ];
      const frozen = ledger.prepareDailyReport({
        businessDate: "2026-10-01",
        policy,
        scan: { ...scan, observedAtMs: now + 60_000, messages: current },
      });
      expect(frozen).toMatchObject({
        status: "frozen",
        delivery: {
          text: "1 October 2026\nNo valid submissions found by the approved cutoff",
          entries: [],
        },
      });
    } finally {
      ledger.close();
    }
  },
);

test("a freeze constraint failure rolls back the report and its new evidence and cannot send", async () => {
  const path = databasePath();
  const nextDay = Date.parse("2026-10-02T07:01:00.000Z");
  const ledger = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => nextDay,
    newSendUuid: () => sendUuid,
  });
  const seed = ledger.prepareDailyReport({
    businessDate: "2026-10-01",
    scan,
    policy,
  });
  if (seed.status !== "frozen") throw new Error("Expected seed report");
  const bob = {
    ...observation,
    messageId: "om_bob",
    observationId: "obs_bob",
    sender: { ...observation.sender, openId: "ou_bob", displayName: "Bob" },
    createdMs: Date.parse("2026-10-02T06:55:00.000Z"),
    updatedMs: Date.parse("2026-10-02T06:55:00.000Z"),
  };
  const nextScan = {
    ...scan,
    businessDate: "2026-10-02",
    fromMs: Date.parse("2026-10-01T21:00:00.000Z"),
    throughMs: Date.parse("2026-10-02T07:00:00.000Z"),
    observedAtMs: nextDay,
    messages: [bob],
  };
  const failed = ledger.prepareDailyReport({
    businessDate: "2026-10-02",
    scan: nextScan,
    policy,
  });
  expect(failed).toMatchObject({
    status: "blocked",
    reasons: ["storage_error"],
  });
  if (failed.status !== "blocked" || !("deliveryId" in failed))
    throw new Error("Expected failed delivery reference");
  ledger.close();
  const sent: unknown[] = [];
  const reopened = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => nextDay + 60_000,
    transport: async (request) => {
      sent.push(request);
      return { messageId: "unexpected" };
    },
  });
  try {
    expect(reopened.getDelivery(failed.deliveryId)).toBeNull();
    await reopened.deliverDelivery({
      deliveryId: failed.deliveryId,
      now: nextDay,
    });
    expect(sent).toEqual([]);
    const review = reopened.prepareDailyReport({
      businessDate: "2026-10-02",
      policy,
      scan: {
        ...nextScan,
        observedAtMs: nextDay + 60_000,
        messages: [
          {
            ...bob,
            observationId: "obs_after_failure",
            updatedMs: nextDay,
            sender: {
              type: "user",
              openId: "ou_bob",
              tenantKey: "tenant_external",
            },
          },
        ],
      },
    });
    if (review.status !== "blocked") throw new Error("Expected name review");
    expect(
      review.evidenceVersions.map((version) => version.observationId),
    ).toEqual(["obs_after_failure"]);
    expect(reopened.getDelivery(seed.delivery.id)?.text).toBe(
      "1 October 2026\n1. Anthony",
    );
  } finally {
    reopened.close();
  }
});

test("blocked candidate versions survive reopening and repeated observations preserve their first-seen time", () => {
  const path = databasePath();
  const unnamed = {
    type: "user",
    openId: "ou_anthony",
    tenantKey: "tenant_external",
  };
  const firstScan = {
    ...scan,
    messages: [{ ...observation, sender: unnamed }],
  };
  const ledger = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
  });
  expect(
    ledger.prepareDailyReport({
      businessDate: "2026-10-01",
      policy,
      scan: firstScan,
    }),
  ).toMatchObject({
    status: "blocked",
    evidenceVersions: [{ observationId: "obs_anthony_v1", observedAtMs: now }],
  });
  ledger.close();
  const later = now + 60_000;
  const reopened = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => later,
  });
  const edited = {
    ...observation,
    observationId: "obs_anthony_v2",
    updatedMs: later,
    sender: unnamed,
    content: JSON.stringify({ text: "Task list\n1. New task" }),
  };
  try {
    const second = reopened.prepareDailyReport({
      businessDate: "2026-10-01",
      policy,
      scan: { ...scan, observedAtMs: later, messages: [edited] },
    });
    if (second.status !== "blocked") throw new Error("Expected name review");
    expect(
      second.evidenceVersions.map((version) => [
        version.observationId,
        version.normalizedText,
        version.observedAtMs,
      ]),
    ).toEqual([
      ["obs_anthony_v1", "My task list\n1. Review infrastructure", now],
      ["obs_anthony_v2", "Task list\n1. New task", later],
    ]);
    const final = reopened.prepareDailyReport({
      businessDate: "2026-10-01",
      policy,
      scan: {
        ...scan,
        observedAtMs: later + 60_000,
        messages: [
          {
            ...edited,
            observationId: "obs_repeat",
            sender: observation.sender,
          },
        ],
      },
    });
    expect(final).toMatchObject({
      status: "frozen",
      delivery: {
        entries: [
          {
            observation: {
              observationId: "obs_anthony_v2",
              observedAtMs: later,
              normalizedText: "Task list\n1. New task",
            },
          },
        ],
      },
    });
  } finally {
    reopened.close();
  }
});

test("report evidence includes original and normalized content and source times after reopening", () => {
  const path = databasePath();
  const ledger = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
  });
  const result = ledger.prepareDailyReport({
    businessDate: "2026-10-01",
    scan,
    policy,
  });
  if (result.status !== "frozen") throw new Error("Expected frozen report");
  ledger.close();
  const reopened = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
  });
  try {
    expect(reopened.getDelivery(result.delivery.id)).toMatchObject({
      timeZone: "Africa/Nairobi",
      cutoffMs: 1790838000000,
      entries: [
        {
          observation: {
            observationId: "obs_anthony_v1",
            messageId: "om_anthony",
            createdMs: 1790837700000,
            updatedMs: 1790837700000,
            observedAtMs: now,
            content: '{"text":"My task list\\n1. Review infrastructure"}',
            normalizedText: "My task list\n1. Review infrastructure",
            deleted: false,
            reason: "task_list",
          },
        },
      ],
    });
  } finally {
    reopened.close();
  }
});

test("repeated preparation preserves the frozen text, name, UUID and original evidence after edits", () => {
  const path = databasePath();
  const ledger = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
    newSendUuid: () => sendUuid,
  });
  const first = ledger.prepareDailyReport({
    businessDate: "2026-10-01",
    scan,
    policy,
  });
  if (first.status !== "frozen") throw new Error("Expected frozen report");
  ledger.close();
  const reopened = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
    newSendUuid: () => {
      throw new Error("Existing report must not need randomness");
    },
  });
  try {
    const repeated = reopened.prepareDailyReport({
      businessDate: "2026-10-01",
      policy: { ...policy, policyVersion: "test-v2" },
      scan: {
        ...scan,
        messages: [
          {
            ...observation,
            observationId: "obs_v2",
            updatedMs: now,
            sender: { ...observation.sender, displayName: "New Display Name" },
            content: JSON.stringify({
              text: "Task list\n1. Completely different task",
            }),
          },
        ],
      },
    });
    expect(repeated).toEqual(first);
  } finally {
    reopened.close();
  }
});

test("freezing requires cutoff time and the ledger's approved policy scope", () => {
  const ledger = openReportLedger({
    ...config,
    databasePath: databasePath(),
    clock: () => Date.parse("2026-10-01T06:59:59.999Z"),
  });
  try {
    expect(
      ledger.prepareDailyReport({ businessDate: "2026-10-01", scan, policy }),
    ).toMatchObject({ status: "blocked", reasons: ["before_cutoff"] });
  } finally {
    ledger.close();
  }
  const afterCutoff = openReportLedger({
    ...config,
    databasePath: databasePath(),
    clock: () => now,
  });
  try {
    expect(
      afterCutoff.prepareDailyReport({
        businessDate: "2026-10-01",
        scan,
        policy: { ...policy, appId: "cli_other" },
      }),
    ).toMatchObject({ status: "blocked", reasons: ["policy_scope_mismatch"] });
  } finally {
    afterCutoff.close();
  }
});

test("complete coverage must match the approved app, source, date and reply policy through cutoff", () => {
  const variants: PrepareReportInput["scan"][] = [
    { ...scan, appId: "cli_other" },
    { ...scan, sourceChatId: "oc_other" },
    { ...scan, businessDate: "2026-09-30" },
    { ...scan, fromMs: Date.parse("2026-10-01T06:00:00.000Z") },
    { ...scan, throughMs: Date.parse("2026-10-01T06:59:59.999Z") },
    { ...scan, replyPolicy: "include" },
    { ...scan, observedAtMs: Date.parse("2026-10-01T06:59:59.999Z") },
  ];
  const ledger = openReportLedger({
    ...config,
    databasePath: databasePath(),
    clock: () => now,
  });
  try {
    for (const candidate of variants)
      expect(
        ledger.prepareDailyReport({
          businessDate: "2026-10-01",
          scan: candidate,
          policy,
        }),
      ).toMatchObject({
        status: "blocked",
        reasons: ["scan_coverage_mismatch"],
      });
  } finally {
    ledger.close();
  }
});

test("unresolved candidates prevent freezing while successful empty scans produce explicit zero-submission text", () => {
  const ledger = openReportLedger({
    ...config,
    databasePath: databasePath(),
    clock: () => now,
  });
  try {
    const unresolved = ledger.prepareDailyReport({
      businessDate: "2026-10-01",
      policy,
      scan: {
        ...scan,
        messages: [
          {
            ...observation,
            sender: {
              type: "user",
              openId: "ou_anthony",
              tenantKey: "tenant_external",
            },
          },
        ],
      },
    });
    expect(unresolved).toMatchObject({
      status: "blocked",
      reasons: ["unresolved_name"],
    });
    const empty = ledger.prepareDailyReport({
      businessDate: "2026-10-01",
      policy,
      scan: { ...scan, messages: [] },
    });
    expect(empty).toMatchObject({
      status: "frozen",
      delivery: {
        text: "1 October 2026\nNo valid submissions found by the approved cutoff",
        entries: [],
      },
    });
  } finally {
    ledger.close();
  }
});
function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), "task-list-ledger-"));
  directories.push(directory);
  return join(directory, "report.sqlite");
}
const now = Date.parse("2026-10-01T07:01:00.000Z");
const sendUuid = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const config = {
  appId: "cli_test",
  sourceChatId: "oc_source",
  destinationChatId: "oc_destination",
};
const policy = {
  appId: "cli_test",
  sourceChatId: "oc_source",
  timeZone: "Africa/Nairobi",
  publicHolidays: [],
  replyPolicy: "exclude",
  policyVersion: "test-v1",
} as const;
const observation = {
  observationId: "obs_anthony_v1",
  messageId: "om_anthony",
  appId: "cli_test",
  sourceChatId: "oc_source",
  sender: {
    type: "user",
    tenantKey: "tenant_external",
    openId: "ou_anthony",
    displayName: "Anthony",
  },
  createdMs: Date.parse("2026-10-01T06:55:00.000Z"),
  updatedMs: Date.parse("2026-10-01T06:55:00.000Z"),
  messageType: "text",
  content: JSON.stringify({ text: "My task list\n1. Review infrastructure" }),
  deleted: false,
};
const scan = {
  status: "complete",
  appId: "cli_test",
  sourceChatId: "oc_source",
  businessDate: "2026-10-01",
  observedAtMs: now,
  fromMs: Date.parse("2026-09-30T21:00:00.000Z"),
  throughMs: Date.parse("2026-10-01T07:00:00.000Z"),
  replyPolicy: "exclude",
  messages: [observation],
} as const;

test("a frozen report survives reopening and records its acknowledged controlled delivery", async () => {
  const path = databasePath();
  const ledger = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
    newSendUuid: () => sendUuid,
  });
  const prepared = ledger.prepareDailyReport({
    businessDate: "2026-10-01",
    scan,
    policy,
  });
  expect(prepared.status).toBe("frozen");
  if (prepared.status !== "frozen") throw new Error("Expected a frozen report");
  const deliveryId = prepared.delivery.id;
  ledger.close();
  const reopened = openReportLedger({
    ...config,
    databasePath: path,
    clock: () => now,
    transport: async (request) => {
      expect(request).toEqual({
        appId: "cli_test",
        destinationChatId: "oc_destination",
        text: "1 October 2026\n1. Anthony",
        uuid: sendUuid,
      });
      return { messageId: "om_acknowledged" };
    },
  });
  try {
    await reopened.deliverDelivery({ deliveryId, now });
    expect(reopened.getDelivery(deliveryId)).toMatchObject({
      text: "1 October 2026\n1. Anthony",
      sendUuid,
      state: "sent",
      messageId: "om_acknowledged",
      entries: [
        {
          displayName: "Anthony",
          senderIdentity: {
            appId: "cli_test",
            tenantKey: "tenant_external",
            openId: "ou_anthony",
          },
          evidence: {
            observationId: "obs_anthony_v1",
            messageId: "om_anthony",
          },
        },
      ],
    });
  } finally {
    reopened.close();
  }
});

test("an incomplete or unavailable scan cannot freeze an empty report", () => {
  const ledger = openReportLedger({
    ...config,
    databasePath: databasePath(),
    clock: () => now,
  });
  try {
    for (const status of ["incomplete", "unavailable"] as const) {
      const result = ledger.prepareDailyReport({
        businessDate: "2026-10-01",
        policy,
        scan: { ...scan, status, messages: [] },
      });
      expect(result).toMatchObject({
        status: "blocked",
        reasons: ["scan_incomplete"],
      });
    }
  } finally {
    ledger.close();
  }
});

import { randomUUID } from "node:crypto";
import {
  Client,
  Domain,
  defaultHttpInstance,
  type HttpInstance,
  LoggerLevel,
  withUserAccessToken,
} from "@larksuiteoapi/node-sdk";
import type { SubmissionObservation } from "./evaluate-submissions.js";
import type { CompleteScan } from "./report-ledger.js";
import {
  CredentialError,
  fileUserAccessToken,
} from "./user-oauth-credentials.js";

/**
 * Coverage and observations from a history traversal, or a failure with its prefix.
 * Complete means accessible interval/root coverage, not an atomic Lark snapshot.
 */
export type HistoryScan =
  | CompleteScan
  | (Omit<CompleteScan, "status"> & {
      status: "incomplete" | "unavailable";
      reason: string;
      providerCode?: number;
    });

/** User OAuth token bound to the reader's app; expiresAtMs is absolute epoch milliseconds. */
export interface UserAccessGrant {
  appId: string;
  accessToken: string;
  expiresAtMs: number;
}
/** Fixed app/source scope and read bounds; an injected clock returns epoch milliseconds. */
interface ReaderConfig {
  appId: string;
  appSecret: string;
  sourceChatId: string;
  httpInstance?: HttpInstance | typeof defaultHttpInstance;
  clock?: () => number;
  maxPages?: number;
  credentialTimeoutMs?: number;
}
/**
 * Reader setup with exactly one credential strategy: a trusted token supplier,
 * or a private credential file bound to the approved reader's app-scoped open ID.
 */
export type HistoryReaderOptions = ReaderConfig &
  (
    | {
        getUserAccessToken: () => Promise<UserAccessGrant>;
        credentialFile?: never;
        readerOpenId?: never;
      }
    | {
        credentialFile: string;
        readerOpenId: string;
        getUserAccessToken?: never;
      }
  );
/** Request one YYYY-MM-DD Nairobi date from the configured source; v1 excludes replies. */
export interface HistoryReadInput {
  businessDate: string;
  sourceChatId: string;
  replyPolicy: "include" | "exclude";
}

/** Guard object-shaped response values before reading their fields. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode Lark's decimal-string epoch milliseconds; invalid or unsafe values return null. */
function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

/** Allow missing/null optional fields while rejecting non-string values when present. */
function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

/**
 * Configure a Lark SDK reader bound to one app and source group.
 * The returned operation obtains user credentials and reads history on demand.
 */
export function createSubmissionHistoryReader(options: HistoryReaderOptions) {
  const http = defaultHttpInstance.create({
    timeout: 15_000,
    maxRedirects: 0,
    maxContentLength: 10 * 1024 * 1024,
  });
  http.interceptors.response.use((response) => response.data);
  /** Discard SDK logs that could contain credential headers or request bodies. */
  const silent = () => {};
  const client = new Client({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: Domain.Lark,
    disableTokenCache: true,
    // SDK transport returns unwrapped data; Axios types describe an envelope.
    httpInstance: (options.httpInstance ?? http) as HttpInstance,
    loggerLevel: LoggerLevel.error,
    logger: {
      error: silent,
      warn: silent,
      info: silent,
      debug: silent,
      trace: silent,
    },
  });
  const getUserAccessToken =
    options.getUserAccessToken ??
    fileUserAccessToken({
      credentialFile: options.credentialFile,
      readerOpenId: options.readerOpenId,
      appId: options.appId,
      client,
      clock: options.clock ?? Date.now,
    });

  /**
   * At 10:01 or later, read main-post history covering the entire Nairobi 10:00 minute.
   * Query bounds are padded; the evaluator applies the exact millisecond cutoff.
   * Merge overlaps to the latest observed version and block conflicting source evidence.
   * Provider/credential failures return sanitized incomplete/unavailable outcomes.
   */
  async function readSubmissionHistory(
    input: HistoryReadInput,
  ): Promise<HistoryScan> {
    const fromMs = Date.parse(`${input.businessDate}T00:00:00.000+03:00`);
    const throughMs = Date.parse(`${input.businessDate}T10:01:00.000+03:00`);
    const messages: SubmissionObservation[] = [];
    const messagePositions = new Map<string, number>();
    const sourceIdentities = new Map<string, SubmissionObservation>();
    const sourceVersions = new Map<string, string>();
    const coverage = {
      appId: options.appId,
      sourceChatId: options.sourceChatId,
      businessDate: input.businessDate,
      replyPolicy: input.replyPolicy,
      fromMs,
      throughMs,
    };
    /** Preserve coverage and partial observations without signalling an empty success. */
    function failed(
      reason: string,
      status: "incomplete" | "unavailable" = "incomplete",
      providerCode?: number,
    ): HistoryScan {
      return {
        ...coverage,
        status,
        reason,
        observedAtMs: (options.clock ?? Date.now)(),
        messages,
        ...(providerCode === undefined ? {} : { providerCode }),
      };
    }
    if (input.sourceChatId !== options.sourceChatId)
      return failed("source_scope_mismatch", "unavailable");
    // Chat history covers roots; replies require a separate thread-discovery path.
    if (input.replyPolicy !== "exclude")
      return failed("unsupported_reply_policy", "unavailable");
    const maxPages = options.maxPages ?? 100;
    const credentialTimeoutMs = options.credentialTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100)
      return failed("invalid_reader_configuration", "unavailable");
    if (
      !Number.isSafeInteger(credentialTimeoutMs) ||
      credentialTimeoutMs < 1 ||
      credentialTimeoutMs > 15_000
    )
      return failed("invalid_reader_configuration", "unavailable");
    const dateCheck = Date.parse(`${input.businessDate}T12:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
      !Number.isSafeInteger(dateCheck) ||
      new Date(dateCheck).toISOString().slice(0, 10) !== input.businessDate
    )
      return failed("invalid_business_date", "unavailable");
    const startedAtMs = (options.clock ?? Date.now)();
    if (!Number.isSafeInteger(startedAtMs))
      return failed("invalid_clock", "unavailable");
    if (startedAtMs < throughMs) return failed("before_cutoff", "unavailable");
    let pageToken: string | undefined;
    const seenTokens = new Set<string>();
    let pagesRead = 0;
    try {
      do {
        if (pagesRead >= maxPages) return failed("page_limit_reached");
        let grant: UserAccessGrant;
        let credentialTimer: ReturnType<typeof setTimeout> | undefined;
        // Recheck/renew per page. The deadline limits waiting, not the supplier's work.
        try {
          grant = await Promise.race([
            getUserAccessToken(),
            new Promise<never>((_, reject) => {
              credentialTimer = setTimeout(
                () => reject(new CredentialError("credentials_timed_out")),
                credentialTimeoutMs,
              );
            }),
          ]);
        } catch (error) {
          return failed(
            error instanceof CredentialError
              ? error.reason
              : "credentials_unavailable",
            pagesRead ? "incomplete" : "unavailable",
          );
        } finally {
          clearTimeout(credentialTimer);
        }
        if (grant.appId !== options.appId)
          return failed(
            "credential_scope_mismatch",
            pagesRead ? "incomplete" : "unavailable",
          );
        if (
          typeof grant.accessToken !== "string" ||
          !grant.accessToken.trim() ||
          !Number.isSafeInteger(grant.expiresAtMs)
        )
          return failed(
            "credentials_unavailable",
            pagesRead ? "incomplete" : "unavailable",
          );
        if (grant.expiresAtMs <= (options.clock ?? Date.now)())
          return failed(
            "credentials_expired",
            pagesRead ? "incomplete" : "unavailable",
          );
        const response = await client.im.message.list(
          {
            params: {
              container_id_type: "chat",
              container_id: options.sourceChatId,
              // Pad second-based API bounds; the evaluator applies exact milliseconds.
              start_time: String(fromMs / 1000 - 1),
              end_time: String(throughMs / 1000 + 1),
              sort_type: "ByCreateTimeAsc",
              page_size: 50,
              only_thread_root_messages: true,
              with_sender_name: true,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          },
          withUserAccessToken(grant.accessToken),
        );
        // SDK types do not validate responses; only numeric provider codes are exposed.
        if (!record(response) || !Number.isSafeInteger(response.code))
          return failed(
            "invalid_response",
            pagesRead ? "incomplete" : "unavailable",
          );
        if (response.code !== 0)
          return failed(
            response.code === 230027
              ? "source_access_denied"
              : "page_unavailable",
            pagesRead ? "incomplete" : "unavailable",
            response.code,
          );
        if (
          !response.data ||
          typeof response.data.has_more !== "boolean" ||
          !Array.isArray(response.data.items)
        )
          return failed(
            "invalid_response",
            pagesRead ? "incomplete" : "unavailable",
          );
        pagesRead += 1;
        // Each page is observed separately, rather than at the scan's completion time.
        const observedAtMs = (options.clock ?? Date.now)();
        if (!Number.isSafeInteger(observedAtMs) || observedAtMs < throughMs)
          return failed("invalid_clock");
        // Absent identity/name fields can go to review; malformed source data blocks coverage.
        for (const raw of response.data.items) {
          if (!record(raw)) return failed("invalid_message");
          const createdMs = timestamp(raw.create_time);
          const updatedMs = timestamp(
            raw.update_time ??
              (raw.updated === false ? raw.create_time : undefined),
          );
          if (
            typeof raw.message_id !== "string" ||
            !raw.message_id.trim() ||
            raw.chat_id !== options.sourceChatId ||
            typeof raw.msg_type !== "string" ||
            !raw.msg_type.trim() ||
            createdMs === null ||
            updatedMs === null ||
            updatedMs < createdMs ||
            typeof raw.deleted !== "boolean" ||
            typeof raw.updated !== "boolean" ||
            !record(raw.sender) ||
            typeof raw.sender.sender_type !== "string" ||
            !raw.sender.sender_type.trim() ||
            !optionalString(raw.sender.id) ||
            !optionalString(raw.sender.id_type) ||
            !optionalString(raw.sender.tenant_key) ||
            !optionalString(raw.sender.sender_name) ||
            !optionalString(raw.root_id) ||
            !optionalString(raw.parent_id) ||
            !optionalString(raw.upper_message_id) ||
            (raw.sender.sender_i18n_names != null &&
              !record(raw.sender.sender_i18n_names)) ||
            (!raw.deleted &&
              (raw.msg_type === "text" || raw.msg_type === "post") &&
              (typeof raw.body?.content !== "string" ||
                !raw.body.content.trim()))
          )
            return failed("invalid_message");
          const localizedNames = Object.fromEntries(
            Object.entries(raw.sender?.sender_i18n_names ?? {}).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          );
          const observation: SubmissionObservation = {
            observationId: randomUUID(),
            messageId: raw.message_id ?? "",
            appId: options.appId,
            sourceChatId: raw.chat_id ?? "",
            sender: {
              type: raw.sender?.sender_type ?? "unknown",
              ...(raw.sender?.id_type === "open_id"
                ? { openId: raw.sender.id }
                : {}),
              ...(raw.sender?.tenant_key
                ? { tenantKey: raw.sender.tenant_key }
                : {}),
              ...(raw.sender?.sender_name
                ? { displayName: raw.sender.sender_name }
                : {}),
              localizedNames,
            },
            createdMs,
            updatedMs,
            messageType: raw.msg_type ?? "",
            content:
              typeof raw.body?.content === "string" ? raw.body.content : "",
            deleted: raw.deleted ?? false,
            observedAtMs,
            sourceRoute: "lark.im.v1.message.list:user",
            ...(raw.upper_message_id
              ? { provenance: "forwarded" as const }
              : {}),
            ...(raw.root_id && raw.root_id !== raw.message_id
              ? { rootMessageId: raw.root_id }
              : raw.parent_id && raw.parent_id !== raw.message_id
                ? { rootMessageId: raw.parent_id }
                : {}),
          };
          const position = messagePositions.get(observation.messageId);
          const prior = position === undefined ? undefined : messages[position];
          // A later live copy cannot undo a recall already observed in this scan.
          if (
            prior?.deleted &&
            !observation.deleted &&
            observation.updatedMs >= prior.updatedMs
          )
            return failed("source_conflict");
          // Keep identity anchors for conflict checks, without backfilling current fields.
          const identity = sourceIdentities.get(observation.messageId);
          if (
            identity &&
            (identity.createdMs !== observation.createdMs ||
              identity.sender.type !== observation.sender.type ||
              (identity.sender.openId &&
                observation.sender.openId &&
                identity.sender.openId !== observation.sender.openId) ||
              (identity.sender.tenantKey &&
                observation.sender.tenantKey &&
                identity.sender.tenantKey !== observation.sender.tenantKey))
          )
            return failed("source_conflict");
          sourceIdentities.set(observation.messageId, {
            ...observation,
            sender: {
              ...observation.sender,
              ...(identity?.sender.openId
                ? { openId: identity.sender.openId }
                : {}),
              ...(identity?.sender.tenantKey
                ? { tenantKey: identity.sender.tenantKey }
                : {}),
            },
          });
          // A newer edit must not hide contradictory copies of an older version.
          const versionKey = JSON.stringify([
            observation.messageId,
            observation.updatedMs,
            // A recall can leave the content update timestamp unchanged.
            observation.deleted,
          ]);
          const versionContent = JSON.stringify([
            observation.messageType,
            observation.content,
            observation.rootMessageId,
            observation.provenance,
          ]);
          const knownVersion = sourceVersions.get(versionKey);
          if (knownVersion !== undefined && knownVersion !== versionContent)
            return failed("source_conflict");
          sourceVersions.set(versionKey, versionContent);
          // Ignore older overlaps; same-time recalls supersede live content.
          if (!prior) {
            messagePositions.set(observation.messageId, messages.length);
            messages.push(observation);
          } else if (
            (observation.updatedMs > prior.updatedMs ||
              (observation.updatedMs === prior.updatedMs &&
                observation.deleted &&
                !prior.deleted)) &&
            position !== undefined
          ) {
            messages[position] = observation;
          }
        }
        // Remaining pages need a fresh cursor; missing/repeated cursors break coverage.
        if (
          response.data.has_more &&
          (typeof response.data.page_token !== "string" ||
            !response.data.page_token.trim())
        )
          return failed("pagination_incomplete");
        if (
          response.data.has_more &&
          response.data.page_token &&
          seenTokens.has(response.data.page_token)
        )
          return failed("pagination_incomplete");
        pageToken = response.data?.has_more
          ? response.data.page_token
          : undefined;
        if (pageToken) seenTokens.add(pageToken);
      } while (pageToken);
      return {
        status: "complete" as const,
        ...coverage,
        observedAtMs: (options.clock ?? Date.now)(),
        messages,
      };
    } catch (error) {
      // Return stable categories rather than raw errors that could expose credentials.
      const status =
        record(error) && record(error.response)
          ? error.response.status
          : undefined;
      if (status === 401 || status === 403)
        return failed(
          "authorization_failed",
          pagesRead ? "incomplete" : "unavailable",
        );
      if (status === 429)
        return failed("rate_limited", pagesRead ? "incomplete" : "unavailable");
      if (
        record(error) &&
        record(error.response) &&
        record(error.response.data) &&
        error.response.data.code === 230027
      )
        return failed(
          "source_access_denied",
          pagesRead ? "incomplete" : "unavailable",
          230027,
        );
      return failed(
        "page_unavailable",
        pagesRead ? "incomplete" : "unavailable",
      );
    }
  }
  return { readSubmissionHistory };
}

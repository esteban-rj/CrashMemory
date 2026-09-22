import { createHash } from "node:crypto";

export const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
export const NORMALIZATION_VERSION = "gmail-body-v2";

export interface GmailBody {
  data?: string;
  attachmentId?: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: GmailBody;
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  historyId: string;
  /** Gmail's raw RFC822 payload when requested with format=raw. */
  raw?: string;
  payload: GmailPart;
}

export interface NormalizedAttachment {
  externalAttachmentId: string;
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface NormalizedMessage {
  externalId: string;
  historyId: string;
  original: Uint8Array;
  body: string;
  attachments: NormalizedAttachment[];
}

function decodeBase64Url(value: string | undefined): Uint8Array {
  if (!value) return new Uint8Array();
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Stable UTF-8 normalization. Its version must change if this changes. */
export function normalizeGmailBody(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\0")
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function header(part: GmailPart, name: string): string | undefined {
  return part.headers?.find(
    (candidate) => candidate.name?.toLowerCase() === name,
  )?.value;
}

function isAttachment(part: GmailPart): boolean {
  return Boolean(
    part.filename ||
    header(part, "content-disposition")?.toLowerCase().includes("attachment"),
  );
}

/**
 * Produces V05's canonical body and attachment inputs. Text/plain wins over
 * text/html; nested MIME parts are traversed in their displayed order.
 */
export async function normalizeMessage(
  message: GmailMessage,
  downloadAttachment: (attachmentId: string) => Promise<Uint8Array>,
): Promise<NormalizedMessage> {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: NormalizedAttachment[] = [];
  let generatedAttachment = 0;

  const walk = async (part: GmailPart): Promise<void> => {
    const mimeType = part.mimeType?.toLowerCase() ?? "application/octet-stream";
    const bytes =
      part.body?.attachmentId && !part.body.data
        ? await downloadAttachment(part.body.attachmentId)
        : decodeBase64Url(part.body?.data);
    if (isAttachment(part)) {
      const attachmentId =
        part.body?.attachmentId ?? `inline-${generatedAttachment++}`;
      attachments.push({
        externalAttachmentId: attachmentId,
        fileName: part.filename || `attachment-${generatedAttachment}`,
        mediaType: mimeType,
        bytes,
      });
      return;
    }
    if (mimeType === "text/plain" && bytes.byteLength) {
      plain.push(new TextDecoder().decode(bytes));
    } else if (mimeType === "text/html" && bytes.byteLength) {
      html.push(stripHtml(new TextDecoder().decode(bytes)));
    }
    for (const child of part.parts ?? []) await walk(child);
  };
  await walk(message.payload);

  const original = message.raw
    ? decodeBase64Url(message.raw)
    : new TextEncoder().encode(JSON.stringify(message));
  return {
    externalId: message.id,
    historyId: message.historyId,
    original,
    body: normalizeGmailBody((plain.length ? plain : html).join("\n\n")),
    attachments,
  };
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface GmailHistoryPage {
  historyId?: string;
  nextPageToken?: string;
  messageIds: string[];
}

export interface GmailRemote {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  listMessages(input: {
    pageToken?: string;
    maxResults: number;
  }): Promise<{ nextPageToken?: string; messageIds: string[] }>;
  listHistory(input: {
    startHistoryId: string;
    pageToken?: string;
  }): Promise<GmailHistoryPage>;
  getMessage(id: string): Promise<GmailMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array>;
  watch(): Promise<{ historyId: string; expiration: Date }>;
}

/** Small native-fetch adapter; callers keep refresh tokens encrypted in DB. */
export class GoogleGmailRemote implements GmailRemote {
  constructor(
    private readonly accessToken: string,
    private readonly topicName?: string,
  ) {}

  private async request(
    path: string,
    init?: RequestInit,
  ): Promise<Record<string, unknown>> {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      {
        ...init,
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          ...(init?.headers ?? {}),
        },
      },
    );
    if (response.status === 404 && path.startsWith("history"))
      throw new GmailHistoryExpiredError();
    if (response.status === 404 && path.startsWith("messages/"))
      throw new GmailMessageNotFoundError();
    if (response.status === 401) throw new GmailReauthRequiredError();
    const payload = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok || !payload)
      throw new Error(`Gmail API request failed (${response.status})`);
    return payload;
  }

  async getProfile(): Promise<{ emailAddress: string; historyId: string }> {
    const payload = await this.request("profile");
    if (
      typeof payload.emailAddress !== "string" ||
      typeof payload.historyId !== "string"
    )
      throw new Error("Gmail profile response is incomplete");
    return { emailAddress: payload.emailAddress, historyId: payload.historyId };
  }

  async listMessages(input: {
    pageToken?: string;
    maxResults: number;
  }): Promise<{ nextPageToken?: string; messageIds: string[] }> {
    const query = new URLSearchParams({ maxResults: String(input.maxResults) });
    if (input.pageToken) query.set("pageToken", input.pageToken);
    const payload = await this.request(`messages?${query}`);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return {
      ...(typeof payload.nextPageToken === "string"
        ? { nextPageToken: payload.nextPageToken }
        : {}),
      messageIds: messages.flatMap((message) =>
        message &&
        typeof message === "object" &&
        typeof (message as { id?: unknown }).id === "string"
          ? [(message as { id: string }).id]
          : [],
      ),
    };
  }

  async listHistory(input: {
    startHistoryId: string;
    pageToken?: string;
  }): Promise<GmailHistoryPage> {
    const query = new URLSearchParams({ startHistoryId: input.startHistoryId });
    if (input.pageToken) query.set("pageToken", input.pageToken);
    const payload = await this.request(`history?${query}`);
    const history = Array.isArray(payload.history) ? payload.history : [];
    const messageIds = history.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as { messagesAdded?: unknown; messages?: unknown };
      const entries = [
        ...(Array.isArray(value.messagesAdded)
          ? value.messagesAdded.map((item) =>
              item && typeof item === "object"
                ? (item as { message?: unknown }).message
                : undefined,
            )
          : []),
        ...(Array.isArray(value.messages) ? value.messages : []),
      ];
      return entries.flatMap((message) =>
        message &&
        typeof message === "object" &&
        typeof (message as { id?: unknown }).id === "string"
          ? [(message as { id: string }).id]
          : [],
      );
    });
    return {
      ...(typeof payload.historyId === "string"
        ? { historyId: payload.historyId }
        : {}),
      ...(typeof payload.nextPageToken === "string"
        ? { nextPageToken: payload.nextPageToken }
        : {}),
      messageIds,
    };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    const [full, raw] = await Promise.all([
      this.request(`messages/${encodeURIComponent(id)}?format=full`),
      this.request(`messages/${encodeURIComponent(id)}?format=raw`),
    ]);
    if (
      typeof full.id !== "string" ||
      typeof full.historyId !== "string" ||
      !full.payload ||
      typeof full.payload !== "object"
    ) {
      throw new Error("Gmail message response is incomplete");
    }
    return {
      id: full.id,
      historyId: full.historyId,
      ...(typeof raw.raw === "string" ? { raw: raw.raw } : {}),
      payload: full.payload as GmailPart,
    };
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<Uint8Array> {
    const payload = await this.request(
      `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    if (typeof payload.data !== "string")
      throw new Error("Gmail attachment response is incomplete");
    return decodeBase64Url(payload.data);
  }

  async watch(): Promise<{ historyId: string; expiration: Date }> {
    if (!this.topicName)
      throw new Error("Gmail Pub/Sub topic is not configured");
    const payload = await this.request("watch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicName: this.topicName }),
    });
    const expirationMs =
      typeof payload.expiration === "string" ? Number(payload.expiration) : NaN;
    if (typeof payload.historyId !== "string" || !Number.isFinite(expirationMs))
      throw new Error("Gmail watch response is incomplete");
    return { historyId: payload.historyId, expiration: new Date(expirationMs) };
  }
}

export async function refreshGoogleAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ accessToken: string; expiresAt: Date }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok && payload?.error === "invalid_grant")
    throw new GmailReauthRequiredError();
  if (!response.ok || !payload || typeof payload.access_token !== "string")
    throw new Error("Gmail access-token refresh failed");
  const expiresIn =
    typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    accessToken: payload.access_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

export interface GmailPersistence {
  /** Must atomically write revision, canonical body, attachments and outbox. */
  persistPage(input: {
    messages: NormalizedMessage[];
    reason: "bootstrap" | "incremental" | "resync";
  }): Promise<void>;
  /** Called only after every message from the processed history page is durable. */
  confirmCursor(historyId: string): Promise<void>;
  recordWatch(input: { historyId: string; expiration: Date }): Promise<void>;
  recordSyncFailure(
    code: "history_not_found" | "reauth_required",
  ): Promise<void>;
}

export class GmailHistoryExpiredError extends Error {
  readonly code = "history_not_found";
  constructor() {
    super("Gmail history cursor is no longer available");
  }
}

/** A message can disappear after history.list reports it; this is not a cursor failure. */
export class GmailMessageNotFoundError extends Error {
  readonly code = "message_not_found";
  constructor() {
    super("Gmail message is no longer available");
  }
}

export class GmailReauthRequiredError extends Error {
  readonly code = "reauth_required";
  constructor() {
    super("Gmail refresh token is invalid or expired");
  }
}

export class GmailSyncService {
  constructor(
    private readonly remote: GmailRemote,
    private readonly persistence: GmailPersistence,
    private readonly historicalLimit = 200,
  ) {
    if (
      !Number.isInteger(historicalLimit) ||
      historicalLimit < 1 ||
      historicalLimit > 500
    ) {
      throw new Error("Historical Gmail limit must be between 1 and 500");
    }
  }

  private async persistBatches(
    ids: string[],
    reason: "bootstrap" | "incremental" | "resync",
  ): Promise<number> {
    const uniqueIds = [...new Set(ids)];
    let persisted = 0;
    for (let offset = 0; offset < uniqueIds.length; offset += 4) {
      const materialized = await Promise.allSettled(
        uniqueIds.slice(offset, offset + 4).map(async (id) => {
          const message = await this.remote.getMessage(id);
          return normalizeMessage(message, (attachmentId) =>
            this.remote.getAttachment(message.id, attachmentId),
          );
        }),
      );
      const messages: NormalizedMessage[] = [];
      for (const result of materialized) {
        if (result.status === "fulfilled") {
          messages.push(result.value);
        } else if (!(result.reason instanceof GmailMessageNotFoundError)) {
          throw result.reason;
        }
      }
      await this.persistence.persistPage({ messages, reason });
      persisted += messages.length;
    }
    return persisted;
  }

  /**
   * Snapshot the history position first, persist the requested bounded archive,
   * then catch up from that snapshot. Replaying this sequence is safe because
   * persistence is idempotent by Gmail message and content revision.
   */
  async bootstrap(reason: "bootstrap" | "resync" = "bootstrap"): Promise<void> {
    const snapshot = await this.remote.getProfile();
    let pageToken: string | undefined;
    let remaining = this.historicalLimit;
    do {
      const page = await this.remote.listMessages({
        pageToken,
        maxResults: Math.min(100, remaining),
      });
      remaining -= await this.persistBatches(
        page.messageIds.slice(0, remaining),
        reason,
      );
      pageToken = remaining > 0 ? page.nextPageToken : undefined;
    } while (pageToken);
    await this.incremental(snapshot.historyId, reason);
  }

  async incremental(
    startHistoryId: string,
    reason: "bootstrap" | "incremental" | "resync" = "incremental",
  ): Promise<void> {
    let pageToken: string | undefined;
    let lastHistoryId: string | undefined;
    try {
      do {
        const page = await this.remote.listHistory({
          startHistoryId,
          pageToken,
        });
        await this.persistBatches(page.messageIds, reason);
        // A checkpoint never advances until this page's message data and its
        // outbox event are committed. A crash only causes a harmless replay.
        if (page.historyId) lastHistoryId = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
      await this.persistence.confirmCursor(lastHistoryId ?? startHistoryId);
    } catch (error) {
      if (error instanceof GmailHistoryExpiredError) {
        await this.persistence.recordSyncFailure("history_not_found");
      }
      if (error instanceof GmailReauthRequiredError) {
        await this.persistence.recordSyncFailure("reauth_required");
      }
      throw error;
    }
  }

  /** Google watch expires; scheduler calls this daily and polling stays available. */
  async renewWatch(): Promise<void> {
    const watch = await this.remote.watch();
    await this.persistence.recordWatch(watch);
  }
}

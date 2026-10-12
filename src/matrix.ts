// A deliberately small Matrix client-server API client: just enough to read messages
// from one room and answer in it. No dependencies, no end-to-end encryption.

export interface MessageEvent {
  eventId: string;
  sender: string;
  body: string;
}

interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, { timeline?: { events?: RawEvent[] } }>;
    invite?: Record<string, unknown>;
  };
}

interface RawEvent {
  type: string;
  event_id: string;
  sender: string;
  content?: {
    msgtype?: string;
    body?: unknown;
    'm.relates_to'?: { rel_type?: string };
  };
}

export interface SendOptions {
  /** Event this message replies to. */
  replyTo?: string;
  /** Users to mention (and notify). Their IDs should appear in the text. */
  mention?: string[];
  /** m.notice (default) does not notify anyone; m.text does. */
  msgtype?: 'm.notice' | 'm.text';
}

export class MatrixError extends Error {
  readonly status: number;
  readonly errcode?: string;
  readonly retryAfterMs?: number;

  constructor(status: number, body: { errcode?: string; error?: string; retry_after_ms?: number }) {
    super(`Matrix API ${status} ${body.errcode ?? ''}: ${body.error ?? 'unknown error'}`);
    this.status = status;
    this.errcode = body.errcode;
    this.retryAfterMs = body.retry_after_ms;
  }
}

const SYNC_TIMEOUT_MS = 30_000;

export class MatrixClient {
  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private txnCounter = 0;
  private stopped = false;
  private abort = new AbortController();
  userId = '';

  constructor(homeserverUrl: string, accessToken: string) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
  }

  async whoami(): Promise<string> {
    const res = await this.request<{ user_id: string }>('GET', '/account/whoami');
    this.userId = res.user_id;
    return res.user_id;
  }

  /** Joins a room by ID or alias (also accepts pending invites) and returns its room ID. */
  async join(roomIdOrAlias: string): Promise<string> {
    const res = await this.request<{ room_id: string }>('POST', `/join/${encodeURIComponent(roomIdOrAlias)}`, {});
    return res.room_id;
  }

  async isEncrypted(roomId: string): Promise<boolean> {
    try {
      await this.request('GET', `/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption/`);
      return true;
    } catch (err) {
      if (err instanceof MatrixError && err.status === 404) return false;
      throw err;
    }
  }

  async sendMessage(roomId: string, markdown: string, options: SendOptions = {}): Promise<string> {
    const content: Record<string, unknown> = {
      msgtype: options.msgtype ?? 'm.notice',
      body: toPlain(markdown),
      format: 'org.matrix.custom.html',
      formatted_body: toHtml(markdown),
      'm.mentions': { user_ids: options.mention ?? [] },
    };
    if (options.replyTo) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: options.replyTo } };
    }
    const txnId = `${Date.now()}-${this.txnCounter++}`;
    const path = `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.request<{ event_id: string }>('PUT', path, content);
        return res.event_id;
      } catch (err) {
        // Same txnId on retry, so the homeserver deduplicates if the first attempt did land.
        if (err instanceof MatrixError && err.status === 429 && attempt < 3) {
          await sleep(err.retryAfterMs ?? 1000);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Long-polls /sync and calls `onMessage` for every new text message in `roomId`.
   * Messages sent before the bot started are skipped, so old commands are never replayed.
   */
  async run(roomId: string, onMessage: (event: MessageEvent) => void): Promise<void> {
    const filter = JSON.stringify({
      presence: { not_types: ['*'] },
      account_data: { not_types: ['*'] },
      room: {
        rooms: [roomId],
        timeline: { types: ['m.room.message'], limit: 20 },
        state: { types: [] },
        ephemeral: { not_types: ['*'] },
        account_data: { not_types: ['*'] },
      },
    });

    let since = (await this.sync(filter, undefined, 0)).next_batch;
    let failures = 0;

    while (!this.stopped) {
      try {
        const res = await this.sync(filter, since, SYNC_TIMEOUT_MS);
        since = res.next_batch;
        failures = 0;

        if (res.rooms?.invite?.[roomId]) {
          console.log(`Invited to ${roomId}, joining.`);
          await this.join(roomId);
        }
        for (const raw of res.rooms?.join?.[roomId]?.timeline?.events ?? []) {
          const event = toMessageEvent(raw, this.userId);
          if (event) onMessage(event);
        }
      } catch (err) {
        if (this.stopped) break;
        if (err instanceof MatrixError && err.status === 401) throw err; // token revoked: give up
        failures++;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
        console.error(`Sync failed (${describe(err)}), retrying in ${delay / 1000}s`);
        await sleep(delay);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  private sync(filter: string, since: string | undefined, timeout: number): Promise<SyncResponse> {
    const params = new URLSearchParams({ filter, timeout: String(timeout) });
    if (since) params.set('since', since);
    return this.request<SyncResponse>('GET', `/sync?${params}`);
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.homeserverUrl}/_matrix/client/v3${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Long-poll syncs hang for up to 30s by design; everything else should be quick.
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(SYNC_TIMEOUT_MS + 30_000)]),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new MatrixError(res.status, json);
    return json as T;
  }
}

function toMessageEvent(raw: RawEvent, ownUserId: string): MessageEvent | null {
  if (raw.type !== 'm.room.message' || raw.sender === ownUserId) return null;
  const content = raw.content ?? {};
  if (content.msgtype !== 'm.text' || typeof content.body !== 'string') return null;
  if (content['m.relates_to']?.rel_type === 'm.replace') return null; // edits
  return { eventId: raw.event_id, sender: raw.sender, body: stripReplyFallback(content.body) };
}

/** Older clients prefix replies with "> <@user:hs> quoted text" lines. */
function stripReplyFallback(body: string): string {
  if (!body.startsWith('> ')) return body;
  const lines = body.split('\n');
  while (lines.length > 0 && lines[0].startsWith('>')) lines.shift();
  return lines.join('\n');
}

// Messages are written with **bold** and `code` only; these turn that into the two Matrix formats.
function toPlain(markdown: string): string {
  return markdown.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1');
}

function toHtml(markdown: string): string {
  return markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

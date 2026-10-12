import { PowerState, RespawnHostClient, RespawnHostError, ServersService } from '@respawnhost/sdk';

export type Power = 'start' | 'stop' | 'restart' | 'kill';

export interface ServerStatus {
  /** Panel state, e.g. "running", "offline", "starting", "stopping". */
  state: string;
  suspended: boolean;
  cpuPercent?: number;
  memoryBytes?: number;
  diskBytes?: number;
  uptimeMs?: number;
}

const POWER_STATES: Record<Power, PowerState> = {
  start: PowerState.START,
  stop: PowerState.STOP,
  restart: PowerState.RESTART,
  kill: PowerState.KILL,
};

/**
 * The one RespawnHost server this bot controls.
 *
 * The API reference does not document response bodies, so the readers below accept
 * the shapes from the SDK's types and fall back to a few likely alternatives.
 * `npm run probe` prints the raw responses if something shows up as unknown.
 */
export class RespawnHostServer {
  readonly uuid: string;
  private readonly client: RespawnHostClient;
  private readonly servers: ServersService;

  constructor(options: { apiKey: string; serverUuid: string; baseUrl?: string }) {
    this.uuid = options.serverUuid;
    this.client = new RespawnHostClient({ apiKey: options.apiKey, baseURL: options.baseUrl });
    this.servers = new ServersService(this.client);
  }

  async getStatus(): Promise<ServerStatus> {
    const raw = (await this.servers.getResourceUtilization(this.uuid)) as unknown;
    return parseStatus(raw);
  }

  async setPower(action: Power): Promise<void> {
    const res = (await this.servers.setPowerState(this.uuid, { power_state: POWER_STATES[action] })) as unknown;
    if (pick(res, ['data', 'eulaRequired']) === true) {
      throw new Error('the server requires accepting a EULA first (do that once in the RespawnHost panel)');
    }
  }

  /** Server alias as shown in the RespawnHost panel. */
  async getAlias(): Promise<string | undefined> {
    const raw = await this.client.get<unknown>(`/api/v1/servers/${this.uuid}`);
    const alias = pick(raw, ['alias']) ?? pick(raw, ['data', 'alias']) ?? pick(raw, ['server', 'alias']);
    return typeof alias === 'string' && alias.trim() ? alias.trim() : undefined;
  }

  /** Best-effort "host:port" players connect to. Not part of the SDK yet, so called directly. */
  async getAddress(): Promise<string | undefined> {
    const raw = await this.client.get<unknown>(`/api/v1/servers/${this.uuid}/connection-info`);
    return parseAddress(raw);
  }

  /** Raw responses, for `npm run probe`. */
  async probe(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    const calls: Record<string, () => Promise<unknown>> = {
      details: () => this.client.get(`/api/v1/servers/${this.uuid}`),
      'resource-utilization': () => this.servers.getResourceUtilization(this.uuid),
      'connection-info': () => this.client.get(`/api/v1/servers/${this.uuid}/connection-info`),
      'auto-stop-settings': () => this.client.get(`/api/v1/servers/${this.uuid}/auto-stop-settings`),
    };
    for (const [name, call] of Object.entries(calls)) {
      try {
        result[name] = await call();
      } catch (err) {
        result[name] = { error: describeApiError(err) };
      }
    }
    return result;
  }
}

export function parseStatus(raw: unknown): ServerStatus {
  const attrs = firstObject(pick(raw, ['attributes']), pick(raw, ['data', 'attributes']), pick(raw, ['data']), raw);
  const resources = firstObject(pick(attrs, ['resources']), attrs);
  const state = pick(attrs, ['current_state']) ?? pick(attrs, ['state']) ?? pick(attrs, ['status']);
  return {
    state: typeof state === 'string' ? state.toLowerCase() : 'unknown',
    suspended: pick(attrs, ['is_suspended']) === true,
    cpuPercent: num(pick(resources, ['cpu_absolute']) ?? pick(resources, ['cpu'])),
    memoryBytes: num(pick(resources, ['memory_bytes'])),
    diskBytes: num(pick(resources, ['disk_bytes'])),
    uptimeMs: num(pick(resources, ['uptime'])),
  };
}

export function parseAddress(raw: unknown): string | undefined {
  const info = firstObject(pick(raw, ['data']), raw);
  for (const key of ['address', 'connect', 'connection', 'connectionString']) {
    const value = pick(info, [key]);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const host = ['domain', 'hostname', 'host', 'ip', 'ip_alias']
    .map((key) => pick(info, [key]))
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const port = pick(info, ['port']);
  if (!host) return undefined;
  return typeof port === 'number' || typeof port === 'string' ? `${host}:${port}` : host;
}

/** A message that is safe and useful to show in the chat room. */
export function describeApiError(err: unknown): string {
  if (err instanceof RespawnHostError) {
    if (err.statusCode === 401) return 'the RespawnHost API key is invalid or expired';
    if (err.statusCode === 403) return 'the RespawnHost API key is missing the `servers` scope';
    if (err.statusCode === 404) return 'RespawnHost does not know this server UUID';
    if (err.statusCode === 0) return `could not reach RespawnHost (${err.message})`;
    return `RespawnHost answered ${err.statusCode}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function pick(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function firstObject(...candidates: unknown[]): unknown {
  return candidates.find((c) => c !== null && typeof c === 'object' && !Array.isArray(c));
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

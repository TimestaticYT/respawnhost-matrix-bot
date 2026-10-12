export interface Config {
  matrix: {
    homeserverUrl: string;
    accessToken: string;
    /** Room ID (!abc:example.org) or alias (#vintagestory:example.org) of the command room. */
    room: string;
  };
  respawnhost: {
    apiKey: string;
    serverUuid: string;
    baseUrl?: string;
  };
  access: AccessConfig;
  /** Name used in messages. Falls back to the server alias from the API. */
  serverName?: string;
  /** Shown by the status and ip commands and after a start. Falls back to the API's connection info. */
  serverAddress?: string;
  /** First word of every command, e.g. "!rh" in "!rh start". */
  namespace: string;
  /** How long to wait for the server to report "running" after a start command. */
  startupTimeoutMs: number;
}

export interface AccessConfig {
  /** Matrix user IDs that may use the normal commands (start, status, ip). */
  users: string[];
  /** Homeserver names (the part after ":" in @user:example.org) whose users count as allowed. */
  homeservers: string[];
  /** Matrix user IDs that may additionally stop, restart and kill the server. */
  admins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? '';
  };

  const config: Config = {
    matrix: {
      homeserverUrl: required('MATRIX_HOMESERVER_URL').replace(/\/+$/, ''),
      accessToken: required('MATRIX_ACCESS_TOKEN'),
      room: required('MATRIX_ROOM'),
    },
    respawnhost: {
      apiKey: required('RESPAWNHOST_API_KEY'),
      serverUuid: required('RESPAWNHOST_SERVER_UUID'),
      baseUrl: env.RESPAWNHOST_BASE_URL?.trim() || undefined,
    },
    access: {
      users: list(env.ALLOWED_USERS),
      homeservers: list(env.ALLOWED_HOMESERVERS).map(normalizeHomeserver),
      admins: list(env.ADMIN_USERS),
    },
    serverName: env.SERVER_NAME?.trim() || undefined,
    serverAddress: env.SERVER_ADDRESS?.trim() || undefined,
    namespace: env.COMMAND_NAMESPACE?.trim() || '!rh',
    startupTimeoutMs: Number(env.STARTUP_TIMEOUT_SECONDS || 600) * 1000,
  };

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (/\s/.test(config.namespace)) {
    throw new Error('COMMAND_NAMESPACE must be a single word, e.g. !vs');
  }
  if (!Number.isFinite(config.startupTimeoutMs) || config.startupTimeoutMs <= 0) {
    throw new Error('STARTUP_TIMEOUT_SECONDS must be a positive number');
  }
  return config;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Accepts "example.org", "https://example.org/" or ":example.org" and returns "example.org". */
export function normalizeHomeserver(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^:/, '')
    .replace(/\/.*$/, '');
}

import type { AccessConfig, Config } from './config.ts';
import { describe, sleep, type MatrixClient, type MessageEvent } from './matrix.ts';
import { describeApiError, type Power, type RespawnHostServer, type ServerStatus } from './respawnhost.ts';

export type Role = 'admin' | 'user';

interface Command {
  role: Role | 'anyone';
  help: string;
  run: (ctx: Context) => Promise<void>;
}

interface Context {
  event: MessageEvent;
  role: Role | null;
}

const POLL_INTERVAL_MS = 4000;
/** After a start, an "offline" state this long into the wait means the start did not take. */
const START_GRACE_MS = 60_000;

export class Bot {
  private readonly matrix: MatrixClient;
  private readonly server: RespawnHostServer;
  private readonly config: Config;
  private readonly roomId: string;
  private readonly commands: Record<string, Command>;
  private readonly aliases: Record<string, string> = { connect: 'ip', address: 'ip', online: 'status' };

  private serverName: string;
  private nameLoaded = false;
  private apiAddress?: string;
  /** The power action currently being watched, if any. */
  private pending?: { action: Power; by: string; id: number };
  private nextPendingId = 0;

  constructor(matrix: MatrixClient, server: RespawnHostServer, config: Config, roomId: string) {
    this.matrix = matrix;
    this.server = server;
    this.config = config;
    this.roomId = roomId;
    this.serverName = config.serverName ?? 'the server';

    this.commands = {
      help: { role: 'anyone', help: 'show this list', run: (ctx) => this.help(ctx) },
      status: { role: 'user', help: 'is the server online?', run: (ctx) => this.status(ctx) },
      start: { role: 'user', help: 'start the server', run: (ctx) => this.power(ctx, 'start') },
      ip: { role: 'user', help: 'show the address to connect to', run: (ctx) => this.ip(ctx) },
      stop: { role: 'admin', help: 'stop the server', run: (ctx) => this.power(ctx, 'stop') },
      restart: { role: 'admin', help: 'restart the server', run: (ctx) => this.power(ctx, 'restart') },
      kill: { role: 'admin', help: 'force-stop a hanging server', run: (ctx) => this.power(ctx, 'kill') },
    };
  }

  /**
   * Looks up the panel alias so messages can use the real server name.
   * If RespawnHost is unreachable, it is tried again with the next command.
   */
  async init(): Promise<void> {
    if (this.config.serverName || this.nameLoaded) return;
    try {
      const alias = await this.server.getAlias();
      if (alias) this.serverName = alias;
      this.nameLoaded = true;
    } catch (err) {
      console.warn(`Could not read the server alias (${describeApiError(err)}), using "${this.serverName}".`);
    }
  }

  async handle(event: MessageEvent): Promise<void> {
    const parsed = parseCommand(event.body, this.config.namespace);
    if (!parsed) return;
    await this.init();

    const name = this.aliases[parsed] ?? parsed;
    const command = this.commands[name];
    if (!command) {
      await this.reply(event, `Unknown command. Try \`${this.cmd('help')}\`.`);
      return;
    }

    const role = roleOf(event.sender, this.config.access);
    if (!isPermitted(role, command.role)) {
      console.log(`Denied ${this.cmd(name)} for ${event.sender}`);
      await this.reply(
        event,
        role === null
          ? `Sorry, you are not on this bot's allow-list.`
          : `Sorry, \`${this.cmd(name)}\` is reserved for admins.`,
      );
      return;
    }

    console.log(`${event.sender} ran ${this.cmd(name)}`);
    try {
      await command.run({ event, role });
    } catch (err) {
      console.error(`${this.cmd(name)} failed:`, err);
      await this.reply(event, `❌ That did not work: ${describeApiError(err)}`).catch(() => {});
    }
  }

  private async help({ event, role }: Context): Promise<void> {
    const lines = Object.entries(this.commands)
      .filter(([, command]) => isPermitted(role, command.role))
      .map(([name, command]) => `\`${this.cmd(name)}\` – ${command.help}`);
    await this.reply(event, [`**${this.serverName}** bot commands:`, ...lines].join('\n'));
  }

  private async status({ event }: Context): Promise<void> {
    const status = await this.server.getStatus();
    const lines = [formatStatus(this.serverName, status, this.cmd('start'))];
    if (status.state === 'running') {
      const address = await this.address();
      if (address) lines.push(`Address: \`${address}\``);
    }
    if (this.pending) lines.push(`(${this.pending.action} requested by ${this.pending.by} is in progress)`);
    await this.reply(event, lines.join('\n'));
  }

  private async ip({ event }: Context): Promise<void> {
    const address = await this.address();
    await this.reply(
      event,
      address
        ? `Connect to \`${address}\``
        : 'I do not know the address. Set SERVER_ADDRESS in the bot config.',
    );
  }

  private async power({ event, role }: Context, action: Power): Promise<void> {
    // Admins may override a running action (e.g. kill a start that hangs); everyone else waits.
    if (this.pending && role !== 'admin') {
      await this.reply(event, `⏳ Already on it: ${this.pending.action} requested by ${this.pending.by}.`);
      return;
    }

    if (action === 'start') {
      const status = await this.server.getStatus().catch((err: unknown) => {
        console.warn(`Status check before start failed (${describeApiError(err)}), starting anyway.`);
        return undefined;
      });
      const blocked = status && startBlockedReason(this.serverName, status);
      if (blocked) {
        await this.reply(event, blocked + (status.state === 'running' ? await this.addressSuffix() : ''));
        return;
      }
    }

    await this.server.setPower(action);
    const verb = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', kill: 'Killing' }[action];
    await this.reply(event, `⏳ ${verb} **${this.serverName}**… I will post here once it is done.`);

    const id = this.nextPendingId++;
    this.pending = { action, by: event.sender, id };
    void this.watch(action, event, id).finally(() => {
      if (this.pending?.id === id) this.pending = undefined;
    });
  }

  /** Polls the server state after a power action and reports the outcome in the room. */
  private async watch(action: Power, event: MessageEvent, id: number): Promise<void> {
    const target = action === 'start' || action === 'restart' ? 'running' : 'offline';
    const started = Date.now();
    let leftTarget = action !== 'restart'; // a restart only counts once the server went down first
    let sawStarting = false;
    let lastState = 'unknown';

    while (Date.now() - started < this.config.startupTimeoutMs) {
      await sleep(POLL_INTERVAL_MS);
      if (this.pending?.id !== id) return; // superseded by another action

      let state: string;
      try {
        state = (await this.server.getStatus()).state;
      } catch (err) {
        console.warn(`Status poll failed: ${describe(err)}`);
        continue;
      }
      lastState = state;
      if (state !== target) leftTarget = true;
      if (state === 'starting') sawStarting = true;

      if (state === target && leftTarget) {
        if (target === 'running') {
          await this.notify(event, `✅ **${this.serverName}** is online!${await this.addressSuffix()}`);
        } else {
          await this.notify(event, `⏹️ **${this.serverName}** is offline.`);
        }
        return;
      }

      const elapsed = Date.now() - started;
      if (target === 'running' && state === 'offline' && (sawStarting || elapsed > START_GRACE_MS)) {
        await this.notify(
          event,
          `❌ **${this.serverName}** went offline again while starting. Check the console in the RespawnHost panel.`,
        );
        return;
      }
    }

    const minutes = Math.round(this.config.startupTimeoutMs / 60_000);
    await this.notify(
      event,
      `⚠️ **${this.serverName}** is still \`${lastState}\` after ${minutes} min. ` +
        `Try \`${this.cmd('status')}\` again later or check the RespawnHost panel.`,
    );
  }

  private async address(): Promise<string | undefined> {
    if (this.config.serverAddress) return this.config.serverAddress;
    if (!this.apiAddress) {
      try {
        this.apiAddress = await this.server.getAddress();
      } catch (err) {
        console.warn(`Could not read connection info: ${describeApiError(err)}`);
      }
    }
    return this.apiAddress;
  }

  private async addressSuffix(): Promise<string> {
    const address = await this.address();
    return address ? ` Connect to \`${address}\`` : '';
  }

  /** How users type a command, e.g. "!rh start". */
  private cmd(name: string): string {
    return `${this.config.namespace} ${name}`;
  }

  private reply(event: MessageEvent, text: string): Promise<string> {
    return this.matrix.sendMessage(this.roomId, text, { replyTo: event.eventId });
  }

  /** Like reply, but pings the person who asked, since they may have stopped watching the room. */
  private async notify(event: MessageEvent, text: string): Promise<void> {
    try {
      await this.matrix.sendMessage(this.roomId, `${event.sender}: ${text}`, {
        replyTo: event.eventId,
        mention: [event.sender],
        msgtype: 'm.text',
      });
    } catch (err) {
      console.error(`Could not send result message: ${describe(err)}`);
    }
  }
}

/**
 * Returns the command name if `body` is addressed to the bot, e.g. "!rh Start now" → "start".
 * The namespace on its own ("!rh") means help.
 */
export function parseCommand(body: string, namespace: string): string | null {
  const [first, second] = body.trim().split(/\s+/, 2);
  if (first.toLowerCase() !== namespace.toLowerCase()) return null;
  return second ? second.toLowerCase() : 'help';
}

export function roleOf(sender: string, access: AccessConfig): Role | null {
  const id = sender.toLowerCase();
  if (access.admins.includes(id)) return 'admin';
  if (access.users.includes(id)) return 'user';
  // User IDs look like @localpart:server.name, and localparts cannot contain ":".
  const colon = id.indexOf(':');
  if (id.startsWith('@') && colon > 0 && access.homeservers.includes(id.slice(colon + 1))) return 'user';
  return null;
}

export function isPermitted(role: Role | null, required: Role | 'anyone'): boolean {
  if (required === 'anyone') return true;
  if (required === 'user') return role !== null;
  return role === 'admin';
}

export function startBlockedReason(name: string, status: ServerStatus): string | undefined {
  if (status.suspended || status.state === 'suspended') {
    return `🚫 **${name}** is suspended. The owner needs to check the RespawnHost account (balance?).`;
  }
  switch (status.state) {
    case 'running':
      return `✅ **${name}** is already online.`;
    case 'starting':
      return `⏳ **${name}** is already starting.`;
    case 'stopping':
      return `⏳ **${name}** is shutting down right now. Try again in a minute.`;
    case 'installing':
    case 'moving':
      return `⏳ **${name}** is busy (${status.state}). Try again later.`;
    default:
      return undefined;
  }
}

export function formatStatus(name: string, status: ServerStatus, startCommand: string): string {
  if (status.suspended) return `🚫 **${name}** is suspended.`;
  switch (status.state) {
    case 'running': {
      const details = [
        status.uptimeMs !== undefined ? `up ${formatDuration(status.uptimeMs)}` : undefined,
        status.cpuPercent !== undefined ? `CPU ${Math.round(status.cpuPercent)}%` : undefined,
        status.memoryBytes !== undefined ? `RAM ${formatBytes(status.memoryBytes)}` : undefined,
      ].filter(Boolean);
      return `🟢 **${name}** is online` + (details.length ? ` (${details.join(' · ')})` : '');
    }
    case 'offline':
      return `🔴 **${name}** is offline. Start it with \`${startCommand}\`.`;
    case 'starting':
      return `🟡 **${name}** is starting…`;
    case 'stopping':
      return `🟠 **${name}** is stopping…`;
    default:
      return `⚪ **${name}** is \`${status.state}\`.`;
  }
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

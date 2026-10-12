# RespawnHost Matrix Bot

A small Matrix bot that lets your friends start **one** RespawnHost game server from a Matrix room.
It is modelled on the official RespawnHost Discord bot, cut down to one server and an allow-list, and talks
to the [RespawnHost API](https://developers.respawnhost.com/docs) through
[`@respawnhost/sdk`](https://www.npmjs.com/package/@respawnhost/sdk). It is not game-specific; it was written
for a Vintage Story server.

Combined with RespawnHost's **Auto-Stopp** (stops the server after N minutes without players), nobody has
to wait for the owner: someone types `!rh start`, plays, and the server shuts itself down afterwards.

## Commands

Every command starts with the bot's namespace, `!rh` by default. Set `COMMAND_NAMESPACE` to change it,
e.g. to `!vs` for a Vintage Story server: then it is `!vs start`. Commands are case-insensitive.

| Command | Who | What |
|---|---|---|
| `!rh start` | allowed users | Starts the server, then posts (and pings you) once it is online, with the address |
| `!rh status` | allowed users | Online/offline, uptime, CPU, RAM, address |
| `!rh ip` | allowed users | Address to connect to (`!rh connect` works too) |
| `!rh stop` / `restart` / `kill` | admins | Power actions. Admins can also override an action that is in progress |
| `!rh help` or just `!rh` | everyone in the room | Lists the commands *you* may use |

"Allowed users" are the people in `ALLOWED_USERS`, everyone on a homeserver in `ALLOWED_HOMESERVERS`,
and the admins. Everyone else gets a polite "not on the allow-list".

The bot handles one power action at a time, so five people typing `!rh start` only start the server once.
Commands sent while the bot was offline are ignored, so an old `!rh start` is never replayed.

## Limitations

- **No end-to-end encryption.** The command room must be unencrypted (see setup). The bot refuses to start otherwise.
- **No player list.** The RespawnHost API has no player endpoint, and Vintage Story has no query protocol.
- **No votes or status panels** like the Discord bot. Those are possible additions later.

## Setup

You need Node.js 22.18 or newer, or Docker.

### 1. Create the bot account

Register a normal user for the bot on your homeserver, e.g. on Synapse:

```bash
register_new_matrix_user -c /path/to/homeserver.yaml -u respawnbot --no-admin
```

Then get an access token for it. Don't copy the token from an Element session: logging out of
Element invalidates it. Request a dedicated one:

```bash
curl -s -X POST https://matrix.example.org/_matrix/client/v3/login -H 'Content-Type: application/json' -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"respawnbot"},"password":"YOUR_PASSWORD","initial_device_display_name":"respawnhost-bot"}'
```

Copy `access_token` from the answer. (If your homeserver uses Matrix Authentication Service, password
login is off. Use `mas-cli manage issue-compatibility-token respawnbot` instead.)

### 2. Create the command room

Create a room for the bot (e.g. "Vintage Story" in your Space) with **end-to-end encryption turned off**.
Encryption cannot be disabled later, so if the room already exists encrypted, make a new one. Invite the bot.

### 3. Get the RespawnHost API key and server UUID

In the RespawnHost dashboard, create an API key with the **`servers`** scope. The server UUID is
in the panel URL of your server.

### 4. Configure

```bash
cp .env.example .env
```

Fill in `.env`. The comments explain each value. About `ALLOWED_HOMESERVERS`: it matches the *server name*
in user IDs (`@anna:example.org` → `example.org`). That can differ from the URL your client connects to
(e.g. `https://matrix.example.org`) if your homeserver uses delegation.

Check the API side before starting the bot:

```bash
npm install
npm run probe
```

It prints the raw API responses plus what the bot reads from them (state, address). If the address comes
out wrong or empty, set `SERVER_ADDRESS` in `.env`.

### 5. Run it

With Docker:

```bash
docker compose up -d --build
```

Or with Node directly:

```bash
npm ci --omit=dev
npm start
```

For a permanent install without Docker, a systemd unit like this works
(`/etc/systemd/system/respawnhost-bot.service`):

```ini
[Unit]
Description=RespawnHost Matrix bot
After=network-online.target
Wants=network-online.target

[Service]
User=respawnbot
WorkingDirectory=/opt/respawnhost-bot
ExecStart=/usr/bin/node --env-file=.env src/main.ts
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Development

```bash
npm test          # unit tests
npm run typecheck # tsc, no build output
```

The code is TypeScript that Node runs directly (type stripping), so there is no build step.

- `src/main.ts`: startup and wiring
- `src/bot.ts`: commands, allow-list, messages
- `src/matrix.ts`: minimal Matrix client (sync, join, send), no dependencies
- `src/respawnhost.ts`: the RespawnHost server via the SDK, with tolerant response parsing, since the API docs do not describe response bodies
- `scripts/probe.ts`: `npm run probe`

## License

MIT, see [LICENSE](LICENSE).

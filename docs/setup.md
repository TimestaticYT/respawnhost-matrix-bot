# Step-by-step setup

This is the exact path used to set up the bot on a VPS that already runs a Matrix homeserver
(Synapse deployed with [matrix-docker-ansible-deploy](https://github.com/spantaleev/matrix-docker-ansible-deploy)).
Plain Synapse works the same way; the steps say where it differs.

In the examples, the homeserver's server name is `example.org`, its client API is at
`https://matrix.example.org`, and the bot account is `@respawnbot:example.org`. Replace these with your own.

You need:

- a server with Docker and Docker Compose (the VPS that runs your homeserver works fine; Node.js is not needed there),
- an account on your homeserver that can invite people to the command room,
- a RespawnHost account with the game server you want to control.

## 1. Create the bot account

The bot is a normal (non-admin) Matrix user.

**matrix-docker-ansible-deploy**, from your playbook checkout:

```bash
just register-user respawnbot 'CHOOSE_A_PASSWORD' no
```

The last argument must be `yes` or `no`. A `0` fails with
"The `admin` variable needs to be provided to this playbook". Avoid spaces in the password, because the
recipe passes it through `--extra-vars`.

Alternatively, on the server itself: `sudo /matrix/synapse/bin/register-user respawnbot 'CHOOSE_A_PASSWORD' 0`
(this script takes `0`/`1` instead of `no`/`yes`).

**Plain Synapse:**

```bash
register_new_matrix_user -c /path/to/homeserver.yaml -u respawnbot --no-admin
```

## 2. Get an access token for the bot

Log in once with the password to get a token for a dedicated device. Don't copy a token from an Element
session, because logging out of Element invalidates it.

```bash
curl -s -X POST https://matrix.example.org/_matrix/client/v3/login -H 'Content-Type: application/json' -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"respawnbot"},"password":"CHOOSE_A_PASSWORD","initial_device_display_name":"respawnhost-bot"}'
```

Keep the `access_token` value (`syt_...`) from the answer for step 6.

If your homeserver uses Matrix Authentication Service, password login is disabled. Use
`mas-cli manage issue-compatibility-token respawnbot` instead.

## 3. Prepare the command room

1. Create a room for the bot (or use an existing one) **without end-to-end encryption**. The bot cannot read
   encrypted messages and refuses to start in an encrypted room. Encryption cannot be turned off later.
2. Find its room ID: in Element, open **Room settings → Advanced → Internal room ID**. It looks like
   `!aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg` (newer rooms have no `:example.org` at the end; that is normal).
3. Invite the bot by typing this in the room:

   ```
   /invite @respawnbot:example.org
   ```

   This is required even if the room is open to members of your Space, because the bot account is not in
   the Space. Without the invite, the bot fails with
   "You do not belong to any of the required rooms/spaces to join this room".

## 4. Create a RespawnHost API key

In the RespawnHost dashboard, create a new API key:

- Name: anything, e.g. `Matrix Bot`
- Leave **Full access** (Vollzugriff) **off**
- Enable only **Game servers** (Gameserver)

Copy the key (`rsp_...`). It controls *all* game servers on your account, so treat it like a password.
If it leaks, delete it in the dashboard and create a new one.

## 5. Find the server UUID

The bot needs the server's `panelUuid`. The dashboard does not show it, so ask the API, using the key from step 4:

```bash
curl -s -H "X-Api-Key: YOUR_API_KEY" https://respawnhost.com/api/v1/servers | jq
```

(`jq` only formats the output. Without it, the command works too, just harder to read.)

Each server in the answer has a `"panelUuid"`. Pick the one whose game or name matches your server, e.g.
`"name": "Vintage Story"`. It looks like `0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d`.

## 6. Install and configure the bot

On the server:

```bash
git clone https://github.com/TimestaticYT/respawnhost-matrix-bot.git
```

```bash
cd respawnhost-matrix-bot && cp .env.example .env && chmod 600 .env
```

Then edit `.env` (e.g. `nano .env`). Write every value plainly: no quotes, no brackets, no spaces around `=`.
Lists are separated by commas.

This is the configuration used for a Vintage Story server where everyone on your own homeserver may start it:

```
MATRIX_HOMESERVER_URL=https://matrix.example.org
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_ROOM=!aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg

RESPAWNHOST_API_KEY=rsp_...
RESPAWNHOST_SERVER_UUID=0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d

ALLOWED_USERS=
ALLOWED_HOMESERVERS=example.org
ADMIN_USERS=@you:example.org

COMMAND_NAMESPACE=!vs
SERVER_NAME=Vintage Story
```

What each value is:

| Variable | Value |
|---|---|
| `MATRIX_HOMESERVER_URL` | Your homeserver's client API URL, the one Element connects to (step 2 used it) |
| `MATRIX_ACCESS_TOKEN` | Token from step 2 |
| `MATRIX_ROOM` | Room ID from step 3 (an alias like `#vs:example.org` also works) |
| `RESPAWNHOST_API_KEY` | Key from step 4 |
| `RESPAWNHOST_SERVER_UUID` | `panelUuid` from step 5 |
| `ALLOWED_USERS` | Individual people who may use `start`, `status`, `ip`, as full Matrix IDs: `@anna:matrix.org,@bob:example.com`. Can stay empty |
| `ALLOWED_HOMESERVERS` | Everyone on these homeservers counts as allowed. This is the *server name* from user IDs (`@anna:example.org` → `example.org`), not necessarily the URL from `MATRIX_HOMESERVER_URL` |
| `ADMIN_USERS` | Full Matrix IDs that may also `stop`, `restart` and `kill`. Admins are allowed users automatically |
| `COMMAND_NAMESPACE` | First word of every command. Default `!rh`; with `!vs`, commands are `!vs start`, `!vs status`, … |
| `SERVER_NAME` | Name the bot uses in messages. Set it: the RespawnHost API currently returns no server name, so without it the bot says "the server" |

Optional: `SERVER_ADDRESS` overrides the address shown to players (by default it comes from the API),
and `STARTUP_TIMEOUT_SECONDS` (default `600`) is how long the bot waits for "online" after a start.

## 7. Check the RespawnHost side

```bash
docker compose run --rm respawnhost-bot node scripts/probe.ts
```

This builds the image on first run, then prints the raw API answers and, at the end, what the bot reads
from them:

```
Parsed status: { state: 'offline', ... }
Parsed address: 203.0.113.10:42420
```

If the state is `unknown` or the address is missing, set `SERVER_ADDRESS` and open an issue with the
(cleaned) output.

**Careful:** the server details in this output contain `panelUserPassword`, the generated password of the
server's panel account. Don't post the output anywhere without removing it.

## 8. Start the bot

```bash
docker compose up -d
```

```bash
docker compose logs -f
```

A working start logs:

```
Logged in as @respawnbot:example.org, listening in !aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefg
```

Then type `!vs` (or your namespace) in the room. The bot answers with the commands you may use.

## Day-to-day

| Task | Command (in the bot's folder) |
|---|---|
| Apply changes to `.env` | `docker compose up -d --force-recreate` |
| Update to the latest version | `git pull && docker compose up -d --build` |
| See what the bot is doing | `docker compose logs -f` |
| Stop the bot | `docker compose down` |

## Troubleshooting

| Log message | Cause and fix |
|---|---|
| `You do not belong to any of the required rooms/spaces to join this room` | The bot has no invite. Invite it (step 3). It retries automatically. |
| `The command room is end-to-end encrypted` | Create a new room without encryption and point `MATRIX_ROOM` at it. |
| `Missing required environment variables: …` | Fill in the listed values in `.env`. |
| `Matrix API 401 M_UNKNOWN_TOKEN` | The access token is wrong or was logged out. Get a new one (step 2). |
| Bot answers "the RespawnHost API key is invalid or expired" | Wrong or deleted key (step 4). |
| Bot answers "the RespawnHost API key is missing the `servers` scope" | Recreate the key with **Game servers** enabled. |
| Bot answers "RespawnHost does not know this server UUID" | Wrong `RESPAWNHOST_SERVER_UUID` (step 5). |
| Bot answers "not on this bot's allow-list" | Add the person to `ALLOWED_USERS` or their homeserver to `ALLOWED_HOMESERVERS`, then recreate the container. |

import { Bot } from './bot.ts';
import { loadConfig } from './config.ts';
import { describe, MatrixClient } from './matrix.ts';
import { RespawnHostServer } from './respawnhost.ts';

const config = loadConfig();
const matrix = new MatrixClient(config.matrix.homeserverUrl, config.matrix.accessToken);
const server = new RespawnHostServer(config.respawnhost);

const userId = await matrix.whoami();
const roomId = await matrix.join(config.matrix.room);
console.log(`Logged in as ${userId}, listening in ${roomId}`);

if (await matrix.isEncrypted(roomId)) {
  console.error(
    'The command room is end-to-end encrypted, and this bot cannot read encrypted messages. ' +
      'Create a separate room with encryption turned off for the bot.',
  );
  process.exit(1);
}

const { access } = config;
if (access.users.length + access.homeservers.length + access.admins.length === 0) {
  console.warn('ALLOWED_USERS, ALLOWED_HOMESERVERS and ADMIN_USERS are all empty: nobody can use the bot.');
}

const bot = new Bot(matrix, server, config, roomId);
await bot.init();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down.`);
    matrix.stop();
    process.exit(0);
  });
}

// Handle commands one at a time, so two quick start commands cannot both get past the "already starting" check.
let queue = Promise.resolve();
try {
  await matrix.run(roomId, (event) => {
    queue = queue.then(() => bot.handle(event)).catch((err) => console.error('Unhandled error:', err));
  });
} catch (err) {
  console.error(`Stopped: ${describe(err)}`);
  process.exit(1);
}

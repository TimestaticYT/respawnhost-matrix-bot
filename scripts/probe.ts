// Prints what the RespawnHost API returns for the configured server, and what the bot makes of it.
// Useful to check the API key, and to see the raw shapes if status or address show up wrong.
// The output may contain your server's IP, so look through it before posting it anywhere.
import { parseAddress, parseStatus, RespawnHostServer } from '../src/respawnhost.ts';

const apiKey = process.env.RESPAWNHOST_API_KEY;
const serverUuid = process.env.RESPAWNHOST_SERVER_UUID;
if (!apiKey || !serverUuid) {
  console.error('Set RESPAWNHOST_API_KEY and RESPAWNHOST_SERVER_UUID (e.g. in .env) first.');
  process.exit(1);
}

const server = new RespawnHostServer({ apiKey, serverUuid, baseUrl: process.env.RESPAWNHOST_BASE_URL });
const raw = await server.probe();
console.log(JSON.stringify(raw, null, 2));
console.log('\nParsed status:', parseStatus(raw['resource-utilization']));
console.log('Parsed address:', parseAddress(raw['connection-info']) ?? '(not found, set SERVER_ADDRESS)');

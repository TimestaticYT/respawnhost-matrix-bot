import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, isPermitted, parseCommand, roleOf, startBlockedReason } from '../src/bot.ts';
import { loadConfig, normalizeHomeserver } from '../src/config.ts';
import { parseAddress, parseStatus } from '../src/respawnhost.ts';

const access = {
  users: ['@bob:matrix.org'],
  homeservers: ['example.org'],
  admins: ['@daniel:example.org'],
};

test('roleOf checks admins, users and homeservers', () => {
  assert.equal(roleOf('@daniel:example.org', access), 'admin');
  assert.equal(roleOf('@Bob:matrix.org', access), 'user');
  assert.equal(roleOf('@anyone:example.org', access), 'user');
  assert.equal(roleOf('@eve:matrix.org', access), null);
  // the homeserver must match exactly, not as a suffix
  assert.equal(roleOf('@eve:evil-example.org', access), null);
  assert.equal(roleOf('@eve:example.org.evil.com', access), null);
});

test('isPermitted', () => {
  assert.equal(isPermitted(null, 'anyone'), true);
  assert.equal(isPermitted(null, 'user'), false);
  assert.equal(isPermitted('user', 'user'), true);
  assert.equal(isPermitted('user', 'admin'), false);
  assert.equal(isPermitted('admin', 'user'), true);
});

test('parseCommand', () => {
  assert.equal(parseCommand('!rh start', '!rh'), 'start');
  assert.equal(parseCommand('  !RH   Start please', '!rh'), 'start');
  assert.equal(parseCommand('!rh', '!rh'), 'help');
  assert.equal(parseCommand('!rhstart', '!rh'), null);
  assert.equal(parseCommand('!start', '!rh'), null);
  assert.equal(parseCommand('start', '!rh'), null);
  assert.equal(parseCommand('!vs status', '!vs'), 'status');
  assert.equal(parseCommand('!rh status', '!vs'), null);
});

test('normalizeHomeserver accepts URLs and bare names', () => {
  assert.equal(normalizeHomeserver('https://Example.org/'), 'example.org');
  assert.equal(normalizeHomeserver(':example.org'), 'example.org');
  assert.equal(normalizeHomeserver('example.org:8448'), 'example.org:8448');
});

test('loadConfig reports all missing variables', () => {
  assert.throws(() => loadConfig({}), /MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, MATRIX_ROOM/);
});

test('parseStatus reads the documented resource-utilization shape', () => {
  const status = parseStatus({
    object: 'stats',
    attributes: {
      current_state: 'running',
      is_suspended: false,
      resources: { memory_bytes: 3 * 1024 ** 3, cpu_absolute: 42.5, disk_bytes: 1, uptime: 7_380_000 },
    },
  });
  assert.deepEqual(status, {
    state: 'running',
    suspended: false,
    cpuPercent: 42.5,
    memoryBytes: 3 * 1024 ** 3,
    diskBytes: 1,
    uptimeMs: 7_380_000,
  });
  assert.equal(parseStatus({ data: { attributes: { current_state: 'OFFLINE' } } }).state, 'offline');
  assert.equal(parseStatus(null).state, 'unknown');
});

test('parseAddress', () => {
  assert.equal(parseAddress({ data: { ip: '1.2.3.4', port: 42420 } }), '1.2.3.4:42420');
  assert.equal(parseAddress({ domain: 'vs.example.org', ip: '1.2.3.4', port: '42420' }), 'vs.example.org:42420');
  assert.equal(parseAddress({ address: 'play.example.org' }), 'play.example.org');
  assert.equal(parseAddress({}), undefined);
});

test('startBlockedReason only lets offline servers start', () => {
  const base = { suspended: false };
  assert.equal(startBlockedReason('VS', { ...base, state: 'offline' }), undefined);
  assert.match(startBlockedReason('VS', { ...base, state: 'running' }) ?? '', /already online/);
  assert.match(startBlockedReason('VS', { state: 'offline', suspended: true }) ?? '', /suspended/);
});

test('formatDuration', () => {
  assert.equal(formatDuration(59_000), '0m');
  assert.equal(formatDuration(7_380_000), '2h 3m');
  assert.equal(formatDuration(90_000_000), '1d 1h');
});

test('loadConfig defaults the namespace to !rh and rejects spaces', () => {
  const env = {
    MATRIX_HOMESERVER_URL: 'https://hs', MATRIX_ACCESS_TOKEN: 't', MATRIX_ROOM: '!r:hs',
    RESPAWNHOST_API_KEY: 'k', RESPAWNHOST_SERVER_UUID: 'u',
  };
  assert.equal(loadConfig(env).namespace, '!rh');
  assert.equal(loadConfig({ ...env, COMMAND_NAMESPACE: '!vs' }).namespace, '!vs');
  assert.throws(() => loadConfig({ ...env, COMMAND_NAMESPACE: '!vs start' }), /single word/);
});

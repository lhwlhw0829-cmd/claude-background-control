// Drives the real server over stdio. Only covers what happens before macOS is
// touched (tool list, schemas, argument checks), so it runs without
// Accessibility or Screen Recording permission, e.g. in CI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const server = spawn(process.execPath, [new URL('./server.ts', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'ignore'] });
const pending = new Map<number, (msg: any) => void>();
createInterface({ input: server.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});

let nextId = 1;
function rpc(method: string, params: unknown = {}): Promise<any> {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => pending.set(id, (msg) => resolve(msg.result ?? msg.error)));
}

// Expects the call to fail with a tool error matching `re`.
async function rejects(name: string, args: object, re: RegExp) {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.equal(r.isError, true, `${name} should fail: ${JSON.stringify(r)}`);
  assert.match(r.content[0].text, re);
}

before(async () => {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});
after(() => server.kill());

test('tools/list: every tool with all four hints', async () => {
  const { tools } = await rpc('tools/list');
  const hints = Object.fromEntries(tools.map((t: any) => [t.name, t.annotations]));
  const readOnly = ['screenshot', 'inspect', 'wait_for'];
  const destructive = ['click_element', 'set_value', 'click', 'drag', 'menu', 'type', 'key'];
  const safeActions = ['scroll', 'activate_app'];
  assert.deepEqual(Object.keys(hints).sort(), [...readOnly, ...destructive, ...safeActions].sort());
  for (const [name, h] of Object.entries<any>(hints)) {
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof h[k], 'boolean', `${name}.${k}`);
    assert.equal(h.readOnlyHint, readOnly.includes(name), `${name}.readOnlyHint`);
    assert.equal(h.destructiveHint, destructive.includes(name), `${name}.destructiveHint`);
    assert.equal(h.openWorldHint, false, `${name}.openWorldHint`);
  }
});

test('screenshot: region must be complete and not mixed with app', async () => {
  await rejects('screenshot', { x: 0, y: 0 }, /Pass all of x, y, w, h/);
  await rejects('screenshot', { app: 'Finder', x: 0, y: 0, w: 10, h: 10 }, /either app or a region/);
  await rejects('screenshot', { x: 0, y: 0, w: 0, h: 10 }, /Input validation error/);
});

test('inspect: depth and node limits', async () => {
  await rejects('inspect', { maxDepth: 31 }, /maxDepth/);
  await rejects('inspect', { maxNodes: 0 }, /maxNodes/);
});

test('click_element / set_value: argument types', async () => {
  await rejects('click_element', { id: 3 }, /id/);
  await rejects('set_value', { label: 'Name' }, /value/);
});

test('click: coordinates, button, click count', async () => {
  await rejects('click', { x: 1 }, /y/);
  await rejects('click', { x: 1, y: 1, button: 'middle' }, /button/);
  await rejects('click', { x: 1, y: 1, clicks: 4 }, /clicks/);
});

test('scroll: needs both x and y, or neither', async () => {
  await rejects('scroll', { direction: 'down', x: 10 }, /both x and y/);
  await rejects('scroll', { direction: 'sideways' }, /direction/);
  await rejects('scroll', { direction: 'up', amount: 0 }, /amount/);
});

test('drag: all four coordinates', async () => {
  await rejects('drag', { x1: 0, y1: 0, x2: 5 }, /y2/);
});

test('menu: path is a list of names', async () => {
  await rejects('menu', { path: 'File' }, /path/);
});

test('type: text must not be empty', async () => {
  await rejects('type', { text: '' }, /text/);
});

test('key: unknown combos fail before any key is sent', async () => {
  await rejects('key', { combo: 'hyper+a' }, /Unknown modifier/);
  await rejects('key', { combo: 'return', repeat: 51 }, /repeat/);
});

test('wait_for: find and timeout range', async () => {
  await rejects('wait_for', {}, /find/);
  await rejects('wait_for', { find: 'OK', timeout: 0 }, /timeout/);
});

test('activate_app: needs a name', async () => {
  await rejects('activate_app', {}, /name/);
});

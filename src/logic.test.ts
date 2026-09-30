import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPoint, findElement, formatTree, parseCombo, parseId, permissionHelp, type Node } from './logic.ts';

test('parseCombo', () => {
  assert.deepEqual(parseCombo('return'), { code: 36, mods: [] });
  assert.deepEqual(parseCombo('Cmd+Shift+T'), { code: 17, mods: ['command down', 'shift down'] });
  assert.deepEqual(parseCombo('cmd+command+a'), { code: 0, mods: ['command down'] });
  assert.deepEqual(parseCombo('cmd++'), { code: 24, mods: ['command down'] });
  assert.throws(() => parseCombo('hyper+a'), /Unknown modifier/);
  assert.throws(() => parseCombo('cmd+ㅁ'), /Unknown key/);
});

test('checkPoint', () => {
  const screen = { w: 100, h: 50 };
  checkPoint(0, 0, screen);
  checkPoint(99, 49, screen);
  assert.throws(() => checkPoint(100, 10, screen), /outside/);
  assert.throws(() => checkPoint(-1, 10, screen), /outside/);
});

const node = (id: string, role: string, name: string | null, extra: Partial<Node> = {}): Node =>
  ({ id, depth: id.split('.').length - 1, role, name, desc: null, value: null, frame: null, ...extra });

const nodes = [
  node('1', 'AXWindow', 'Untitled'),
  node('1.1', 'AXButton', 'Save'),
  node('1.2', 'AXButton', 'Save As…'),
  node('1.3', 'AXTextField', null, { desc: 'Search' }),
  node('1.4', 'AXStaticText', 'Save'),
];

test('findElement', () => {
  assert.equal(findElement(nodes, 'save', 'AXButton').id, '1.1'); // exact beats substring
  assert.equal(findElement(nodes, 'search').id, '1.3'); // matches description
  assert.equal(findElement(nodes, 'as…').id, '1.2'); // substring fallback
  assert.throws(() => findElement(nodes, 'Save'), /2 elements match[\s\S]*\[1\.1\][\s\S]*\[1\.4\]/);
  assert.throws(() => findElement(nodes, 'Nope'), /No element/);
  assert.equal(findElement(nodes, undefined, 'AXTextField').id, '1.3'); // role alone
  assert.throws(() => findElement(nodes, undefined, 'AXButton'), /2 elements match role AXButton/);
  const twoWindows = [...nodes, node('2', 'AXWindow', 'Other'), node('2.1', 'AXButton', 'Save')];
  assert.equal(findElement(twoWindows, 'save', 'AXButton').id, '1.1'); // frontmost window wins
});

test('formatTree', () => {
  const out = formatTree('TextEdit', [node('1.1', 'AXButton', 'OK', { desc: 'OK', frame: [1.4, 2, 30, 20] })], true);
  assert.match(out, /^App: TextEdit — 1 elements/);
  assert.match(out, /\n {2}\[1\.1\] AXButton "OK" @1,2,30,20\n\(truncated/);
});

test('parseId', () => {
  assert.deepEqual(parseId('1.3.2'), [1, 3, 2]);
  assert.throws(() => parseId('1..2'), /Bad element id/);
});

test('permissionHelp', () => {
  const inner = '/Users/a/Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude';
  const msg = permissionHelp('screen', inner, 'x');
  assert.match(msg, /^Screen Recording permission is missing\. macOS charges it to "claude":/);
  assert.match(msg, /\n {2}\/Users\/a\/Library\/Application Support\/Claude\/claude-code\/2\.1\.284\/claude\.app\n/);
  assert.match(msg, /Screen & System Audio Recording.*click \+, press Cmd\+Shift\+G/);
  const term = permissionHelp('ax', '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', 'x');
  assert.match(term, /"Terminal":\n {2}\/System\/Applications\/Utilities\/Terminal\.app\n/);
  assert.doesNotMatch(term, /Cmd\+Shift\+G/); // listed apps need no manual add
  assert.match(permissionHelp('ax', '/usr/bin/sshd', 'x'), /"sshd":\n {2}\/usr\/bin\/sshd/);
  assert.equal(permissionHelp('ax', null, 'iTerm'), 'Accessibility permission is missing. Open System Settings → Privacy & Security → Accessibility, enable iTerm, then restart it.');
});

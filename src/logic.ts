// Pure logic: no OS calls, unit-tested in logic.test.ts.

export type Node = {
  id: string; // 1-based child path from the app process, e.g. "1.3.2"
  depth: number;
  role: string;
  name: string | null;
  desc: string | null;
  value: string | null;
  frame: [number, number, number, number] | null; // x, y, w, h in screen points
};

// ANSI key codes. Sending key codes (not characters) keeps shortcuts working
// while a non-Latin input source (e.g. Korean 2-set) is active.
const KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12,
  w: 13, e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21,
  '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40,
  ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, forwarddelete: 117, home: 115, end: 119, pageup: 116,
  pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

const MODIFIERS: Record<string, string> = {
  cmd: 'command down', command: 'command down',
  shift: 'shift down',
  opt: 'option down', option: 'option down', alt: 'option down',
  ctrl: 'control down', control: 'control down',
};

export function parseCombo(combo: string): { code: number; mods: string[] } {
  const parts = combo.toLowerCase().split('+').map((s) => s.trim());
  // "cmd++" means cmd and "+": an empty last part stands for the plus key itself.
  if (parts.length > 1 && parts.at(-1) === '' && parts.at(-2) === '') parts.splice(-2, 2, '=');
  const key = parts.pop()!;
  const mods = parts.map((m) => {
    const mod = MODIFIERS[m];
    if (!mod) throw new Error(`Unknown modifier "${m}". Use cmd, shift, opt, ctrl.`);
    return mod;
  });
  const code = KEY_CODES[key];
  if (code === undefined) throw new Error(`Unknown key "${key}" in "${combo}".`);
  return { code, mods: [...new Set(mods)] };
}

export function checkPoint(x: number, y: number, screen: { w: number; h: number }): void {
  if (x < 0 || y < 0 || x >= screen.w || y >= screen.h) {
    throw new Error(`Point (${x}, ${y}) is outside the main screen (${screen.w}x${screen.h} points).`);
  }
}

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s);

export function formatTree(app: string, nodes: Node[], truncated: boolean): string {
  const lines = nodes.map((n) => {
    let line = `${'  '.repeat(n.depth)}[${n.id}] ${n.role}`;
    if (n.name) line += ` "${clip(n.name)}"`;
    if (n.desc && n.desc !== n.name) line += ` (${clip(n.desc)})`;
    if (n.value) line += ` = ${JSON.stringify(clip(n.value))}`;
    if (n.frame) line += ` @${n.frame.map(Math.round).join(',')}`;
    return line;
  });
  const head = `App: ${app} — ${nodes.length} elements. Frames are x,y,w,h in screen points.`;
  const tail = truncated ? '\n(truncated: raise maxNodes/maxDepth or pass a narrower app)' : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}

// Match by label (name, description, or value), case-insensitive: exact
// matches win over substring matches. Matches that stay ambiguous even
// within the frontmost window are an error listing candidate ids.
// With no label, the role alone must pick out exactly one element.
export function findElement(nodes: Node[], label?: string, role?: string): Node {
  const pool = role ? nodes.filter((n) => n.role.toLowerCase() === role.toLowerCase()) : nodes;
  let hits = pool;
  if (label) {
    const want = label.toLowerCase();
    const labels = (n: Node) => [n.name, n.desc, n.value].filter(Boolean).map((s) => s!.toLowerCase());
    hits = pool.filter((n) => labels(n).includes(want));
    if (!hits.length) hits = pool.filter((n) => labels(n).some((l) => l.includes(want)));
  }
  // Same control in several windows: the first window is the frontmost one.
  const top = (n: Node) => Number(n.id.split('.')[0]);
  const front = hits.filter((n) => top(n) === Math.min(...hits.map(top)));
  if (front.length === 1) return front[0];
  const what = [label && `label "${label}"`, role && `role ${role}`].filter(Boolean).join(' and ');
  if (!hits.length) throw new Error(`No element with ${what}. Call inspect again: the UI may have changed.`);
  const list = hits.slice(0, 10).map((n) => `  [${n.id}] ${n.role} "${n.name ?? n.desc ?? n.value}"`).join('\n');
  throw new Error(`${hits.length} elements match ${what}; pass one id instead:\n${list}`);
}

export function parseId(id: string): number[] {
  if (!/^\d+(\.\d+)*$/.test(id)) throw new Error(`Bad element id "${id}". Use an id from inspect, e.g. "1.3.2".`);
  return id.split('.').map(Number);
}

const PANES = {
  ax: 'Accessibility',
  screen: 'Screen & System Audio Recording',
};

// Tells the user exactly which app to enable. `exe` is the responsible
// executable, e.g. ".../claude.app/Contents/MacOS/claude" or "/bin/zsh".
export function permissionHelp(kind: 'ax' | 'screen', exe: string | null, fallback: string): string {
  const what = kind === 'ax' ? 'Accessibility' : 'Screen Recording';
  const pane = `System Settings → Privacy & Security → ${PANES[kind]}`;
  if (!exe) return `${what} permission is missing. Open ${pane}, enable ${fallback}, then restart it.`;
  const app = exe.match(/^(.*?\.app)\//)?.[1] ?? exe;
  const name = app.split('/').pop()!.replace(/\.app$/, '');
  const hidden = !app.startsWith('/Applications/') && !app.startsWith('/System/');
  const add = hidden ? ` If "${name}" isn't listed, click +, press Cmd+Shift+G, and paste the path above.` : '';
  return `${what} permission is missing. macOS charges it to "${name}":\n  ${app}\n` +
    `Open ${pane} and enable it.${add} Then fully quit and reopen the app running Claude Code.`;
}

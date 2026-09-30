// Everything that talks to macOS: osascript (JXA), screencapture, sips.
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Node } from './logic.ts';

const exec = promisify(execFile);

async function sh(cmd: string, args: string[]): Promise<string> {
  try {
    return (await exec(cmd, args, { timeout: 30_000, maxBuffer: 32 << 20 })).stdout;
  } catch (e: any) {
    throw new Error(`${cmd} failed: ${e.stderr?.trim() || e.message}`);
  }
}

// Runs a JXA function. The argument travels as argv JSON, never spliced into
// the script, so labels/text can't inject code.
async function jxa<T>(fn: string, arg: unknown = null): Promise<T> {
  const script = `function run(argv) { return JSON.stringify({ r: (${fn})(JSON.parse(argv[0])) }); }`;
  return JSON.parse(await sh('osascript', ['-l', 'JavaScript', '-e', script, JSON.stringify(arg)])).r;
}

// Shared JXA prelude: the target process (named app, or the frontmost one).
const PROC = `
  const se = Application('System Events');
  const proc = a.app ? se.processes.byName(a.app) : se.processes.whose({ frontmost: true })[0];
  if (!proc.exists()) throw new Error('No running app named "' + a.app + '" (use the process name, e.g. "TextEdit")');`;

export const permissions = () =>
  jxa<{ ax: boolean; screen: boolean }>(`() => {
    ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics');
    ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
    return { ax: $.AXIsProcessTrusted(), screen: $.CGPreflightScreenCaptureAccess() };
  }`);

// ponytail: main display only; multi-monitor needs per-display bounds.
export const screenSize = () =>
  jxa<{ w: number; h: number }>(`() => {
    ObjC.import('AppKit');
    const f = $.NSScreen.mainScreen.frame;
    return { w: f.size.width, h: f.size.height };
  }`);

export const activateApp = (name: string) =>
  jxa<void>(`(a) => { Application(a.name).activate(); delay(0.3); }`, { name });

// Real HID mouse events via CoreGraphics: works on canvas/Electron content
// that System Events' "click at" can't reach.
export const click = (x: number, y: number, button: 'left' | 'right', clicks: number) =>
  jxa<void>(`(a) => {
    ObjC.import('CoreGraphics');
    const p = $.CGPointMake(a.x, a.y);
    const [down, up, btn] = a.button === 'right' ? [3, 4, 1] : [1, 2, 0]; // CGEventType / CGMouseButton
    $.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, p, btn)); // move first so hover state is right
    for (let i = 1; i <= a.clicks; i++) for (const t of [down, up]) {
      const e = $.CGEventCreateMouseEvent(null, t, p, btn);
      $.CGEventSetIntegerValueField(e, 1, i); // kCGMouseEventClickState: 2 = double-click
      $.CGEventPost(0, e);
    }
  }`, { x, y, button, clicks });

export const keyCode = (code: number, mods: string[]) =>
  jxa<void>(`(a) => { Application('System Events').keyCode(a.code, { using: a.mods }); }`, { code, mods });

// Types via clipboard paste: keystroke() mangles Hangul/IME input and even
// types ASCII as Hangul when a Korean input source is active.
// ponytail: restores only a text clipboard; images/files on it are lost.
export const typeText = (text: string) =>
  jxa<void>(`(a) => {
    const app = Application.currentApplication(); app.includeStandardAdditions = true;
    let prev = null; try { prev = app.theClipboard(); } catch (e) {}
    app.setTheClipboardTo(a.text);
    Application('System Events').keyCode(9, { using: ['command down'] });
    delay(0.3); // paste reads the clipboard asynchronously
    if (typeof prev === 'string') app.setTheClipboardTo(prev);
  }`, { text });

// Walks the accessibility tree, fetching each attribute for a whole sibling
// list in one Apple Event (per-element fetches are ~100x slower).
// ponytail: skips the menu bar's contents; use key() shortcuts for menus.
export const inspect = (app: string | undefined, maxDepth: number, maxNodes: number) =>
  jxa<{ app: string; nodes: Node[]; truncated: boolean }>(`(a) => {
    ${PROC}
    const out = { app: proc.name(), nodes: [], truncated: false };
    const get = (c, p) => { try { return c[p](); } catch (e) { return []; } };
    const str = (v) => v === null || v === undefined || v === '' ? null : String(v);
    (function walk(parent, path, depth) {
      if (depth > a.maxDepth) return;
      const kids = parent.uiElements;
      const roles = get(kids, 'role');
      const names = get(kids, 'name'), descs = get(kids, 'description'), vals = get(kids, 'value');
      const pos = get(kids, 'position'), size = get(kids, 'size');
      for (let i = 0; i < roles.length; i++) {
        if (out.nodes.length >= a.maxNodes) { out.truncated = true; return; }
        const id = path.concat(i + 1);
        out.nodes.push({
          id: id.join('.'), depth, role: roles[i], name: str(names[i]), desc: str(descs[i]),
          value: str(vals[i]), frame: pos[i] && size[i] ? pos[i].concat(size[i]) : null,
        });
        if (roles[i] !== 'AXMenuBar') walk(kids[i], id, depth + 1);
      }
    })(proc, [], 0);
    return out;
  }`, { app, maxDepth, maxNodes });

type Hit = { role: string; name: string | null; center: [number, number] | null };

// Acts on an element without moving the mouse or stealing focus when the
// app supports it: focus for text inputs, AXPress for everything else.
// Returns center so the caller can fall back to a real click.
export const actOn = (app: string | undefined, path: number[], action: 'press' | 'set_value', value?: string) =>
  jxa<Hit & { done: boolean }>(`(a) => {
    ${PROC}
    let el = proc;
    for (const i of a.path) el = el.uiElements[i - 1];
    if (!el.exists()) throw new Error('Element ' + a.path.join('.') + ' no longer exists; call inspect again');
    const role = el.role();
    let center = null;
    try { const p = el.position(), s = el.size(); center = [p[0] + s[0] / 2, p[1] + s[1] / 2]; } catch (e) {}
    const res = { role, name: el.name(), center, done: false };
    if (a.action === 'set_value') { el.value = a.value; res.done = true; return res; }
    if (/TextField|TextArea|ComboBox|SearchField/.test(role)) {
      try { el.focused = true; res.done = true; return res; } catch (e) {}
    }
    try { el.actions.byName('AXPress').perform(); res.done = true; } catch (e) {}
    return res;
  }`, { app, path, action, value });

// Screenshot scaled so 1 image pixel = 1 screen point: coordinates read off
// the image can go straight into click(). Also keeps Retina images small.
export async function screenshot(region?: { x: number; y: number; w: number; h: number }): Promise<string> {
  const file = join(tmpdir(), `cbc-${process.pid}-${Date.now()}.png`);
  try {
    const where = region ? ['-R', `${region.x},${region.y},${region.w},${region.h}`] : ['-m'];
    await sh('screencapture', ['-x', '-t', 'png', ...where, file]);
    const width = region ? region.w : (await screenSize()).w;
    await sh('sips', ['--resampleWidth', String(Math.round(width)), file]);
    return (await readFile(file)).toString('base64');
  } finally {
    await rm(file, { force: true });
  }
}

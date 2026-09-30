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

// The executable macOS charges permissions to (TCC's "responsible process").
// Often not the app the user sees: e.g. Claude.app runs Claude Code through a
// helper that disclaims responsibility, so the inner claude.app needs the grant.
// Uses a private libsystem call; null if it's unavailable.
export async function responsibleExecutable(): Promise<string | null> {
  try {
    const pid = await jxa<number>(`() => {
      ObjC.bindFunction('responsibility_get_pid_responsible_for_pid', ['int', ['int']]);
      ObjC.bindFunction('getpid', ['int', []]);
      return $.responsibility_get_pid_responsible_for_pid($.getpid());
    }`);
    return pid > 0 ? (await sh('ps', ['-o', 'comm=', '-p', String(pid)])).trim() || null : null;
  } catch {
    return null;
  }
}

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
      delay(0.03); // AppKit drops multi-clicks that arrive faster than its event loop
    }
  }`, { x, y, button, clicks });

// Scroll wheel by lines at (x, y), or wherever the cursor is.
// dy > 0 scrolls up, dx > 0 scrolls left (CGEvent convention).
export const scroll = (dy: number, dx: number, at?: { x: number; y: number }) =>
  jxa<void>(`(a) => {
    ObjC.import('CoreGraphics');
    if (a.at) $.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, $.CGPointMake(a.at.x, a.at.y), 0));
    $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 2, a.dy, a.dx)); // 1 = line units, 2 wheels
  }`, { dy, dx, at });

// Left-button drag in small steps so apps see a continuous motion.
export const drag = (x1: number, y1: number, x2: number, y2: number) =>
  jxa<void>(`(a) => {
    ObjC.import('CoreGraphics');
    const post = (type, x, y) => $.CGEventPost(0, $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), 0));
    // Pauses let the app enter and follow its mouse-tracking loop; without
    // them the down/up pair reads as a plain click.
    post(5, a.x1, a.y1); post(1, a.x1, a.y1); delay(0.1); // move, down
    for (let i = 1; i <= 20; i++) { post(6, a.x1 + (a.x2 - a.x1) * i / 20, a.y1 + (a.y2 - a.y1) * i / 20); delay(0.02); } // dragged
    delay(0.1); post(2, a.x2, a.y2); // up
  }`, { x1, y1, x2, y2 });

// Walks the menu bar by item names. Ends on a menu → lists its items;
// ends on a plain item → clicks it. Works on background apps.
export const menu = (app: string | undefined, path: string[]) =>
  jxa<{ trail: string[]; clicked: boolean; items: { name: string | null; enabled: boolean }[] }>(`(a) => {
    ${PROC}
    const norm = (s) => s.toLowerCase().replace(/\\.\\.\\./g, '…').trim(); // "Save..." matches "Save…"
    let items = proc.menuBars[0].menuBarItems;
    const trail = [];
    for (let step = 0; step < a.path.length; step++) {
      const names = items.name();
      const i = names.findIndex((n) => n && norm(n) === norm(a.path[step]));
      if (i < 0) throw new Error('No menu item "' + a.path[step] + '" in ' + (trail.join(' > ') || 'the menu bar') + '. Available: ' + names.filter(Boolean).join(', '));
      const item = items[i];
      trail.push(names[i]);
      if (item.menus.length === 0) {
        if (step < a.path.length - 1) throw new Error('"' + trail.join(' > ') + '" has no submenu');
        if (!item.enabled()) throw new Error('"' + trail.join(' > ') + '" is disabled right now');
        item.click();
        return { trail, clicked: true, items: [] };
      }
      items = item.menus[0].menuItems;
    }
    const names = items.name(), enabled = items.enabled();
    return { trail, clicked: false, items: names.map((name, i) => ({ name, enabled: enabled[i] })) };
  }`, { app, path });

// Types via clipboard paste: keystroke() mangles Hangul/IME input and even
// types ASCII as Hangul when a Korean input source is active. Every item and
// type on the clipboard (images, files, rich text) is saved and put back,
// unless something else wrote to the clipboard in the meantime.
export const typeText = (text: string) =>
  jxa<{ restored: boolean }>(`(a) => {
    ObjC.import('AppKit');
    const pb = $.NSPasteboard.generalPasteboard;
    const saved = [];
    const items = pb.pasteboardItems;
    for (let i = 0; i < items.count; i++) {
      const item = items.objectAtIndex(i), types = item.types, copy = $.NSPasteboardItem.alloc.init;
      for (let j = 0; j < types.count; j++) {
        const t = types.objectAtIndex(j), d = item.dataForType(t);
        if (!d.isNil()) copy.setDataForType(d, t);
      }
      saved.push(copy);
    }
    pb.clearContents;
    pb.setStringForType($(a.text), $.NSPasteboardTypeString);
    const ours = pb.changeCount;
    Application('System Events').keyCode(9, { using: ['command down'] });
    delay(0.3); // paste reads the clipboard asynchronously
    if (pb.changeCount !== ours) return { restored: false }; // someone copied meanwhile: keep theirs
    pb.clearContents;
    if (saved.length) pb.writeObjects($(saved));
    return { restored: true };
  }`, { text });

// Presses a key code `times` times, pausing so apps see separate presses.
export const keyCode = (code: number, mods: string[], times = 1) =>
  jxa<void>(`(a) => {
    const se = Application('System Events');
    for (let i = 0; i < a.times; i++) { se.keyCode(a.code, { using: a.mods }); if (i < a.times - 1) delay(0.03); }
  }`, { code, mods, times });

// Fetches the accessibility tree one *level* at a time: an attribute read on
// a chained specifier (windows.uiElements.uiElements…) returns that attribute
// for every element at that depth, nested by parent, in a single Apple Event.
// ~6 events per level instead of ~6 per parent (TextEdit: 3s -> ~0.5s).
// ponytail: fetches whole levels even past maxNodes; very deep web views can
// be slow — lower maxDepth for those.
export const inspect = (app: string | undefined, maxDepth: number, maxNodes: number) =>
  jxa<{ app: string; nodes: Node[]; truncated: boolean }>(`(a) => {
    ${PROC}
    // Children of these are noise (a button's image, a text's runs).
    const NO_DESCEND = new Set(['AXStaticText', 'AXImage', 'AXButton', 'AXScrollBar',
      'AXValueIndicator', 'AXCheckBox', 'AXRadioButton', 'AXSlider', 'AXIncrementor', 'AXTextField']);
    const out = { app: proc.name(), nodes: [], truncated: false };
    const get = (spec, p) => { try { return spec[p](); } catch (e) { return null; } };
    // Some values are references to other elements (object specifiers, typeof
    // 'function'); stringifying those throws -1700, so they become null.
    const str = (v) => v === null || v === undefined || v === '' || typeof v === 'function' ? null : String(v);
    const at = (arr, path) => path.reduce((x, i) => (x == null ? null : x[i]), arr);
    const levels = [];
    let spec = proc.windows; // windows only: the menu bar is menu()'s job
    for (let d = 0; d <= a.maxDepth; d++) {
      const role = get(spec, 'role');
      if (!role || !JSON.stringify(role).includes('"')) break; // no elements at this depth
      levels.push({ role, name: get(spec, 'name'), desc: get(spec, 'description'), value: get(spec, 'value'),
        pos: get(spec, 'position'), size: get(spec, 'size') });
      spec = spec.uiElements;
    }
    (function walk(path, d) {
      const L = levels[d], roles = L && at(L.role, path);
      if (!Array.isArray(roles)) return;
      for (let i = 0; i < roles.length; i++) {
        if (out.nodes.length >= a.maxNodes) { out.truncated = true; return; }
        const p = path.concat(i), pos = at(L.pos, p), size = at(L.size, p);
        out.nodes.push({
          id: p.map((n) => n + 1).join('.'), depth: d, role: roles[i],
          name: str(at(L.name, p)), desc: str(at(L.desc, p)), value: str(at(L.value, p)),
          frame: Array.isArray(pos) && Array.isArray(size) ? pos.concat(size) : null,
        });
        if (!NO_DESCEND.has(roles[i])) walk(p, d + 1);
      }
    })([], 0);
    return out;
  }`, { app, maxDepth, maxNodes });

type Hit = { role: string; name: string | null; center: [number, number] | null };

// Acts on an element without moving the mouse or stealing focus when the
// app supports it: focus for text inputs, AXPress for everything else.
// Returns center so the caller can fall back to a real click.
export const actOn = (app: string | undefined, path: number[], action: 'press' | 'set_value', value?: string) =>
  jxa<Hit & { done: boolean }>(`(a) => {
    ${PROC}
    let el = proc.windows[a.path[0] - 1]; // ids start at windows, like inspect
    for (const i of a.path.slice(1)) el = el.uiElements[i - 1];
    if (!el.exists()) throw new Error('Element ' + a.path.join('.') + ' no longer exists; call inspect again');
    const role = el.role();
    let center = null;
    try { const p = el.position(), s = el.size(); center = [p[0] + s[0] / 2, p[1] + s[1] / 2]; } catch (e) {}
    const res = { role, name: el.name() || el.description(), center, done: false };
    if (a.action === 'set_value') { el.value = a.value; res.done = true; return res; }
    if (/TextField|TextArea|ComboBox|SearchField/.test(role)) {
      try { el.focused = true; res.done = true; return res; } catch (e) {}
    }
    try { el.actions.byName('AXPress').perform(); res.done = true; } catch (e) {}
    return res;
  }`, { app, path, action, value });

type WindowInfo = { id: number; x: number; y: number; w: number; h: number; name: string | null; axW: number | null };

// The app's frontmost on-screen window: CoreGraphics id and bounds, plus the
// accessibility width to spot Stage Manager thumbnails (CG reports the
// shrunken thumbnail, AX the real window).
export const frontWindow = (app: string) =>
  jxa<WindowInfo>(`(a) => {
    ${PROC}
    ObjC.import('CoreGraphics');
    const pid = proc.unixId();
    // 1 | 16 = on-screen only, excluding desktop elements; list is front-to-back.
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0)));
    const w = list.find((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0);
    if (!w) throw new Error(a.app + ' has no visible window (minimized or hidden?). Try activate_app.');
    let axW = null; try { axW = proc.windows[0].size()[0]; } catch (e) {}
    const b = w.kCGWindowBounds;
    return { id: w.kCGWindowNumber, x: b.X, y: b.Y, w: b.Width, h: b.Height, name: w.kCGWindowName || null, axW };
  }`, { app });

// Screenshot scaled so 1 image pixel = 1 screen point: coordinates read off
// the image can go straight into click(). Also keeps Retina images small.
// A window capture (-l) works even when other windows cover it.
export async function screenshot(target?: { x: number; y: number; w: number; h: number } | { windowId: number; w: number }): Promise<string> {
  const file = join(tmpdir(), `cbc-${process.pid}-${Date.now()}.png`);
  try {
    const where = !target ? ['-m']
      : 'windowId' in target ? ['-o', '-l', String(target.windowId)] // -o: no shadow, so pixels map to bounds
      : ['-R', `${target.x},${target.y},${target.w},${target.h}`];
    await sh('screencapture', ['-x', '-t', 'png', ...where, file]);
    const width = target ? target.w : (await screenSize()).w;
    await sh('sips', ['--resampleWidth', String(Math.round(width)), file]);
    return (await readFile(file)).toString('base64');
  } finally {
    await rm(file, { force: true });
  }
}

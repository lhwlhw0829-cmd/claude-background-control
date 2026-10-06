#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { checkPoint, filterNodes, pollUntil, findElement, formatTree, parseCombo, parseId, permissionHelp } from './logic.ts';
import * as mac from './mac.ts';

const fallbackHost = process.env.TERM_PROGRAM ?? 'the app that runs Claude Code (Terminal, iTerm, Claude, …)';

// Only positive results are cached: a denied permission is re-checked each
// call so granting it takes effect without restarting the server.
const granted = { ax: false, screen: false };
async function need(kind: 'ax' | 'screen') {
  if (granted[kind]) return;
  Object.assign(granted, await mac.permissions());
  if (!granted[kind]) throw new Error(permissionHelp(kind, await mac.responsibleExecutable(), fallbackHost));
}

type Result = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
const text = (t: string): Result => ({ content: [{ type: 'text', text: t }] });

// Turns any thrown error into a readable tool error instead of a protocol failure.
function tool<A>(fn: (args: A) => Promise<Result>) {
  return async (args: A): Promise<Result> => {
    try {
      return await fn(args);
    } catch (e: any) {
      return { ...text(e.message ?? String(e)), isError: true };
    }
  };
}

const target = {
  id: z.string().optional().describe('Element id from inspect, e.g. "1.3.2"'),
  label: z.string().optional().describe('Element name/description/value to match (used when id is not given)'),
  role: z.string().optional().describe('Role to match, e.g. "AXButton". Alone, it must match exactly one element.'),
  app: z.string().optional().describe('Process name, e.g. "TextEdit". Defaults to the frontmost app. Works on background apps.'),
};

// Tool hints so hosts can warn before anything that acts on the GUI.
// Everything stays on this Mac, so openWorldHint is always false.
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

async function resolve(a: { id?: string; label?: string; role?: string; app?: string }): Promise<number[]> {
  if (a.id) return parseId(a.id);
  if (!a.label && !a.role) throw new Error('Pass id, label, or role.');
  const { nodes } = await mac.inspect(a.app, 12, 2000); // fresh tree, so the match isn't stale
  return parseId(findElement(nodes, a.label, a.role).id);
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'claude-background-control', version: '0.4.0' });

  server.registerTool('screenshot', {
    annotations: READ,
    description: 'Capture as PNG: the main screen, a region (x, y, w, h), or one app\'s front window (app), even if other windows cover it. Image pixels equal screen points; for a window, add the reported origin to get screen coordinates for click.',
    inputSchema: z.object({
      app: target.app,
      x: z.number().optional(), y: z.number().optional(),
      w: z.number().positive().optional(), h: z.number().positive().optional(),
    }),
  }, tool(async ({ app, x, y, w, h }) => {
    const parts = [x, y, w, h].filter((v) => v !== undefined).length;
    if (parts !== 0 && parts !== 4) throw new Error('Pass all of x, y, w, h for a region, or none for the full screen.');
    if (app && parts) throw new Error('Pass either app or a region, not both.');
    await need('screen');
    if (app) {
      const win = await mac.frontWindow(app);
      const data = await mac.screenshot({ windowId: win.id, w: win.w });
      let note = `Window "${win.name ?? app}" at origin (${win.x}, ${win.y}), ${win.w}x${win.h} points. Screen point = origin + image pixel.`;
      if (win.axW && win.w < win.axW * 0.6) note += ` Warning: this is a shrunken thumbnail (Stage Manager side strip) of a ${win.axW}-point-wide window; call activate_app("${app}") first for a full-size capture.`;
      return { content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: note }] };
    }
    const data = await mac.screenshot(parts ? { x: x!, y: y!, w: w!, h: h! } : undefined);
    return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
  }));

  server.registerTool('inspect', {
    annotations: READ,
    description: 'List UI elements (id, role, label, value, frame) of an app\'s windows via the accessibility tree. The preferred way to find what to click. Pass find to get only matching elements instead of the whole tree.',
    inputSchema: z.object({
      app: target.app,
      find: z.string().optional().describe('Only elements whose role equals this or whose label/value contains it, e.g. "Save" or "AXTextField"'),
      maxDepth: z.number().int().min(0).max(30).default(10),
      maxNodes: z.number().int().min(1).max(3000).default(400),
    }),
  }, tool(async ({ app, find, maxDepth, maxNodes }) => {
    await need('ax');
    // With find, search the whole tree; maxNodes then caps the hits shown.
    const r = await mac.inspect(app, maxDepth, find ? 3000 : maxNodes);
    if (!find) return text(formatTree(r.app, r.nodes, r.truncated));
    const hits = filterNodes(r.nodes, find);
    if (!hits.length) return text(`App: ${r.app} — nothing matches "${find}" among ${r.nodes.length} elements.`);
    return text(formatTree(r.app, hits.slice(0, maxNodes), hits.length > maxNodes || r.truncated));
  }));

  server.registerTool('click_element', {
    annotations: ACT,
    description: 'Press a button/link or focus a text field by id or label. Uses accessibility actions (no mouse movement) and falls back to a real click at the element center.',
    inputSchema: z.object(target),
  }, tool(async (a) => {
    await need('ax');
    const hit = await mac.actOn(a.app, await resolve(a), 'press');
    const what = `${hit.role} "${hit.name ?? ''}"`;
    if (hit.done) return text(`Pressed ${what}.`);
    if (!hit.center) throw new Error(`${what} has no press action and no position to click.`);
    if (a.app) await mac.activateApp(a.app);
    await mac.click(hit.center[0], hit.center[1], 'left', 1);
    return text(`Clicked ${what} at (${hit.center.map(Math.round).join(', ')}).`);
  }));

  server.registerTool('set_value', {
    annotations: { ...ACT, idempotentHint: true },
    description: 'Set a text field\'s value directly through accessibility. Works in background apps and with any language, without touching the keyboard or clipboard.',
    inputSchema: z.object({ ...target, value: z.string() }),
  }, tool(async (a) => {
    await need('ax');
    const hit = await mac.actOn(a.app, await resolve(a), 'set_value', a.value);
    return text(`Set value of ${hit.role} "${hit.name ?? ''}".`);
  }));

  server.registerTool('click', {
    annotations: ACT,
    description: 'Real mouse click at screen coordinates (points). Fallback for content without accessibility info.',
    inputSchema: z.object({
      x: z.number(), y: z.number(),
      button: z.enum(['left', 'right']).default('left'),
      clicks: z.number().int().min(1).max(3).default(1).describe('2 = double-click'),
    }),
  }, tool(async ({ x, y, button, clicks }) => {
    await need('ax');
    checkPoint(x, y, await mac.screenSize());
    await mac.click(x, y, button, clicks);
    return text(`Clicked ${button} x${clicks} at (${x}, ${y}).`);
  }));

  server.registerTool('scroll', {
    annotations: { ...ACT, destructiveHint: false },
    description: 'Scroll with the mouse wheel, at (x, y) if given, else wherever the cursor is.',
    inputSchema: z.object({
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(100).default(5).describe('Lines to scroll'),
      x: z.number().optional(), y: z.number().optional(),
    }),
  }, tool(async ({ direction, amount, x, y }) => {
    if ((x === undefined) !== (y === undefined)) throw new Error('Pass both x and y, or neither.');
    await need('ax');
    if (x !== undefined) checkPoint(x, y!, await mac.screenSize());
    const [dy, dx] = { up: [amount, 0], down: [-amount, 0], left: [0, amount], right: [0, -amount] }[direction];
    await mac.scroll(dy, dx, x === undefined ? undefined : { x, y: y! });
    return text(`Scrolled ${direction} ${amount} lines.`);
  }));

  server.registerTool('drag', {
    annotations: ACT,
    description: 'Drag with the left mouse button from (x1, y1) to (x2, y2): select text, move items, resize.',
    inputSchema: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }),
  }, tool(async ({ x1, y1, x2, y2 }) => {
    await need('ax');
    const screen = await mac.screenSize();
    checkPoint(x1, y1, screen);
    checkPoint(x2, y2, screen);
    await mac.drag(x1, y1, x2, y2);
    return text(`Dragged (${x1}, ${y1}) → (${x2}, ${y2}).`);
  }));

  server.registerTool('menu', {
    annotations: ACT,
    description: 'Use an app\'s menu bar by item names, e.g. path ["File", "Save…"]. A path ending on a menu (or empty) lists its items; ending on an item clicks it. Works on background apps. Names are localized ("..." matches "…").',
    inputSchema: z.object({ path: z.array(z.string()).default([]), app: target.app }),
  }, tool(async ({ path, app }) => {
    await need('ax');
    const r = await mac.menu(app, path);
    if (r.clicked) return text(`Clicked ${r.trail.join(' > ')}.`);
    const lines = r.items.map((i) => (i.name === null ? '  ───' : `  ${i.name}${i.enabled ? '' : '  (disabled)'}`));
    return text(`${r.trail.join(' > ') || 'Menu bar'}:\n${lines.join('\n')}`);
  }));

  server.registerTool('type', {
    annotations: ACT,
    description: 'Type text into the focused element of the frontmost app (via paste, so Korean and other IME text work; the clipboard, images included, is restored). Prefer set_value for plain text fields.',
    inputSchema: z.object({ text: z.string().min(1) }),
  }, tool(async (a) => {
    await need('ax');
    const { restored } = await mac.typeText(a.text);
    return text(`Typed ${a.text.length} characters.${restored ? '' : ' The clipboard changed during typing, so it was left as is.'}`);
  }));

  server.registerTool('key', {
    annotations: ACT,
    description: 'Press a key or combo in the frontmost app, e.g. "return", "cmd+s", "cmd+shift+t", "esc", "down". repeat presses it several times.',
    inputSchema: z.object({ combo: z.string(), repeat: z.number().int().min(1).max(50).default(1) }),
  }, tool(async ({ combo, repeat }) => {
    const { code, mods } = parseCombo(combo);
    await need('ax');
    await mac.keyCode(code, mods, repeat);
    return text(`Pressed ${combo}${repeat > 1 ? ` x${repeat}` : ''}.`);
  }));

  server.registerTool('wait_for', {
    annotations: READ,
    description: 'Wait until an element matching find (role or label, like inspect find) appears in the app, or disappears with gone=true. Use after actions that open dialogs, load pages, or show spinners.',
    inputSchema: z.object({
      find: z.string(),
      app: target.app,
      gone: z.boolean().default(false),
      timeout: z.number().min(1).max(120).default(10).describe('Seconds'),
    }),
  }, tool(async ({ find, app, gone, timeout }) => {
    await need('ax');
    const start = Date.now();
    const r = await pollUntil(async () => {
      const t = await mac.inspect(app, 10, 3000);
      const hits = filterNodes(t.nodes, find);
      return (hits.length > 0) !== gone ? { app: t.app, hits } : null;
    }, timeout * 1000).catch((e) => { throw new Error(`"${find}" ${gone ? 'is still there' : 'did not appear'}. ${e.message}`); });
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    if (gone) return text(`"${find}" is gone (${secs}s).`);
    return text(`Found after ${secs}s:\n${formatTree(r.app, r.hits.slice(0, 20), r.hits.length > 20)}`);
  }));

  server.registerTool('activate_app', {
    annotations: { ...ACT, destructiveHint: false, idempotentHint: true },
    description: 'Launch or bring an app to the front (needed before type/key, which go to the frontmost app).',
    inputSchema: z.object({ name: z.string().describe('App name, e.g. "TextEdit"') }),
  }, tool(async ({ name }) => {
    await mac.activateApp(name);
    return text(`Activated ${name}.`);
  }));

  return server;
}

void serveStdio(createServer);
console.error('claude-background-control MCP server running on stdio');

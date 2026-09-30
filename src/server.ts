#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { checkPoint, findElement, formatTree, parseCombo, parseId } from './logic.ts';
import * as mac from './mac.ts';

const host = process.env.TERM_PROGRAM ?? 'the app that runs Claude Code (Terminal, iTerm, Claude, …)';
const PERM_HELP = {
  ax: `Accessibility permission is missing. Open System Settings → Privacy & Security → Accessibility, enable ${host}, then restart it.`,
  screen: `Screen Recording permission is missing. Open System Settings → Privacy & Security → Screen & System Audio Recording, enable ${host}, then restart it.`,
};

// Only positive results are cached: a denied permission is re-checked each
// call so granting it takes effect without restarting the server.
const granted = { ax: false, screen: false };
async function need(kind: 'ax' | 'screen') {
  if (granted[kind]) return;
  Object.assign(granted, await mac.permissions());
  if (!granted[kind]) throw new Error(PERM_HELP[kind]);
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

async function resolve(a: { id?: string; label?: string; role?: string; app?: string }): Promise<number[]> {
  if (a.id) return parseId(a.id);
  if (!a.label && !a.role) throw new Error('Pass id, label, or role.');
  const { nodes } = await mac.inspect(a.app, 12, 2000); // fresh tree, so the match isn't stale
  return parseId(findElement(nodes, a.label, a.role).id);
}

function createServer(): McpServer {
  const server = new McpServer({ name: 'claude-background-control', version: '0.1.0' });

  server.registerTool('screenshot', {
    description: 'Capture the main screen (or a region) as PNG. Image pixels equal screen points, so coordinates read off it can be passed to click as-is.',
    inputSchema: z.object({
      x: z.number().optional(), y: z.number().optional(),
      w: z.number().positive().optional(), h: z.number().positive().optional(),
    }),
  }, tool(async ({ x, y, w, h }) => {
    const parts = [x, y, w, h].filter((v) => v !== undefined).length;
    if (parts !== 0 && parts !== 4) throw new Error('Pass all of x, y, w, h for a region, or none for the full screen.');
    await need('screen');
    const data = await mac.screenshot(parts ? { x: x!, y: y!, w: w!, h: h! } : undefined);
    return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
  }));

  server.registerTool('inspect', {
    description: 'List UI elements (id, role, label, value, frame) of an app via the accessibility tree. The preferred way to find what to click.',
    inputSchema: z.object({
      app: target.app,
      maxDepth: z.number().int().min(0).max(30).default(10),
      maxNodes: z.number().int().min(1).max(3000).default(400),
    }),
  }, tool(async ({ app, maxDepth, maxNodes }) => {
    await need('ax');
    const r = await mac.inspect(app, maxDepth, maxNodes);
    return text(formatTree(r.app, r.nodes, r.truncated));
  }));

  server.registerTool('click_element', {
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
    description: 'Set a text field\'s value directly through accessibility. Works in background apps and with any language, without touching the keyboard or clipboard.',
    inputSchema: z.object({ ...target, value: z.string() }),
  }, tool(async (a) => {
    await need('ax');
    const hit = await mac.actOn(a.app, await resolve(a), 'set_value', a.value);
    return text(`Set value of ${hit.role} "${hit.name ?? ''}".`);
  }));

  server.registerTool('click', {
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

  server.registerTool('type', {
    description: 'Type text into the focused element of the frontmost app (via paste, so Korean and other IME text work). Prefer set_value for plain text fields.',
    inputSchema: z.object({ text: z.string().min(1) }),
  }, tool(async (a) => {
    await need('ax');
    await mac.typeText(a.text);
    return text(`Typed ${a.text.length} characters.`);
  }));

  server.registerTool('key', {
    description: 'Press a key or combo in the frontmost app, e.g. "return", "cmd+s", "cmd+shift+t", "esc", "down".',
    inputSchema: z.object({ combo: z.string() }),
  }, tool(async ({ combo }) => {
    const { code, mods } = parseCombo(combo);
    await need('ax');
    await mac.keyCode(code, mods);
    return text(`Pressed ${combo}.`);
  }));

  server.registerTool('activate_app', {
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

# claude-background-control

An MCP server that lets Claude Code use your Mac's GUI: read what's on
screen, click things, and type. It uses only built-in macOS tools
(`osascript`, `screencapture`, `sips`), so there are no native npm
dependencies to break on install.

It goes through the accessibility tree first. That way it can press
buttons and fill in text fields in **background apps** without moving
your mouse or taking focus away from what you're doing. Real mouse and
keyboard events are only the fallback.

## Install

```bash
claude mcp add computer-control -- npx -y claude-background-control
```

Requires macOS and Node 22.18+.

## Permissions (first run)

macOS has to allow the app that runs Claude Code (Terminal, iTerm,
the Claude app, …):

1. **System Settings → Privacy & Security → Accessibility**: turn it on
   for that app. Every tool except `screenshot` needs this.
2. **System Settings → Privacy & Security → Screen & System Audio
   Recording**: turn it on for that app. Needed for `screenshot`.
3. Restart that app.

If a permission is missing, the tool tells you exactly which one.

## Tools

| Tool | What it does |
|---|---|
| `inspect(app?)` | Lists UI elements with an id, role, label, value, and frame. Start here. |
| `click_element(id \| label, role?, app?)` | Presses a button or focuses a field via accessibility, with no mouse movement. Falls back to a real click. |
| `set_value(id \| label, value, app?)` | Sets a text field's value directly. Works in background apps and with any language. |
| `type(text)` | Types into the focused field by pasting, so Korean and other IME input comes through correctly. |
| `key(combo)` | Sends key codes like `cmd+s` or `return`, so shortcuts work even when a Korean input source is active. |
| `click(x, y, button?, clicks?)` | Real mouse click (CoreGraphics) for canvas or Electron content. |
| `screenshot(x?, y?, w?, h?)` | PNG of the main screen. Image pixels equal screen points, so `click` can use coordinates from it as-is. |
| `activate_app(name)` | Launches an app or brings it to the front. |

`app` is the process name (e.g. `"TextEdit"`). If you leave it out, the
frontmost app is used.

## Develop

```bash
npm install
npm test        # pure-logic unit tests
npm run build
```

After changing `src/mac.ts`, run the manual GUI checklist in
[scripts/smoke-test.md](scripts/smoke-test.md).

## Limits (v0.1)

- Main display only.
- The menu bar's contents aren't inspected; use `key` shortcuts for menus.
- `type` restores the clipboard only if it held text.
- No drag or scroll yet.

Design notes: [docs/superpowers/specs/2026-09-30-computer-control-mcp-design.md](docs/superpowers/specs/2026-09-30-computer-control-mcp-design.md)

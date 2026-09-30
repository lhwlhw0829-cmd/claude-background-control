# claude-background-control — Design Spec

## Problem

Claude Code can edit files and run shell commands, but it cannot drive a
GUI: click a button, type into a native app's text field, or read what's
on screen outside a browser/simulator context. The user wants an MCP
server that closes this gap on macOS, installable with one command, so
both beginners and developers can hand Claude Code real GUI control.

## Goal (v1 scope)

- One MCP server, added to Claude Code via `claude mcp add`.
- Runs on macOS only. No Windows/Linux support in v1.
- Target client: Claude Code only. Codex or other MCP clients are future
  work — the server is plain MCP-over-stdio, so nothing here blocks it,
  but v1 is not tested against Codex.
- Zero native npm dependencies for the automation backend (see
  "Automation backend" below) — install must never fail due to a
  prebuilt-binary/Node-version/architecture mismatch, which is the most
  common failure beginners hit with tools like nut.js/robotjs.

## Non-goals (v1)

- Drag-and-drop, scroll gestures, multi-touch.
- Automating apps with no accessibility support (canvas/WebGL-heavy
  apps) beyond the coordinate-click fallback.
- A fully automated test suite for real GUI interaction — see Testing.
- Any Windows/Linux backend.

## Automation backend

Two macOS-native mechanisms, no third-party automation library:

1. **Accessibility tree control**, via `osascript` (JXA) driving
   `System Events`. This can enumerate UI elements (role, name/label,
   position) of the frontmost app and target them by label/role instead
   of raw coordinates — the same principle as this session's own iOS
   Simulator `inspect` tool. This is the primary path: more robust to
   window resizing, DPI changes, and layout shifts than pixel coordinates.
2. **Coordinate fallback**, also via `osascript`/System Events
   (`click at {x, y}`), for elements that don't expose an accessibility
   name/role (rare, but happens with some canvas/Electron content).

Screenshots use the macOS-builtin `screencapture` CLI — no dependency,
always present.

Both are invoked via Node's `child_process`, so the only runtime
dependency is Node itself plus the MCP SDK.

## Components

- `src/server.ts` — MCP server entrypoint (stdio transport), registers
  the tools below.
- `src/accessibility.ts` — builds and runs the JXA scripts for
  `inspect` and `click_element`; parses their JSON-ish output back into
  structured results.
- `src/coordinate.ts` — JXA script for coordinate click/move, and shells
  out to `screencapture` for screenshots.
- `src/keyboard.ts` — JXA script for `type` (keystroke) and `key`
  (keystroke with modifiers, e.g. `cmd+a`).
- `src/permissions.ts` — checks Accessibility permission status before
  running any tool call; returns a clear, actionable error (which
  System Settings pane, which app to allow) instead of a silent no-op
  or opaque OS error.

## Tools exposed (MVP)

| Tool | Purpose |
|---|---|
| `screenshot` | Capture full screen (or a region) as an image, for visual confirmation. |
| `inspect` | Return the frontmost app's UI element tree (role, label, frame) — the primary way to find what to click. |
| `click_element(label, role?)` | Click the element matching label (and optional role) from the current tree. |
| `click(x, y)` | Coordinate-based fallback click. |
| `type(text)` | Type a text string into whatever has focus. |
| `key(combo)` | Press a key or key combination, e.g. `"cmd+a"`, `"return"`. |

`inspect` + `click_element` are the recommended path; `click` stays as
the escape hatch. This mirrors the design already validated by this
session's own iOS Simulator control tool (inspect-then-tap-by-marker).

## Data flow

```
Claude Code --(MCP stdio)--> server.ts --(child_process)--> osascript (JXA)
                                                         \-> screencapture
osascript/screencapture --(stdout)--> server.ts --(MCP result)--> Claude Code
```

## Permissions & setup UX

macOS requires the process running automation (in practice, the
terminal app or Node binary Claude Code spawns) to be granted
**Accessibility** permission (System Settings → Privacy & Security →
Accessibility), and **Screen Recording** permission for `screenshot`.

On every tool call, `permissions.ts` checks status first. If missing,
the tool returns an error string naming the exact System Settings pane
and which app to enable — never a bare OS error code. The README also
walks through this with the exact pane names, since this is the single
biggest first-run blocker for non-developers.

## Error handling

- Missing permission → actionable error as above, not a silent failure.
- `click_element` target not found in current tree → error naming what
  was searched for and a hint to call `inspect` again (UI may have
  changed).
- Coordinate outside the screen bounds → validated before dispatch,
  explicit error instead of a no-op click.
- `osascript`/`screencapture` process failure (non-zero exit) → stderr
  surfaced verbatim in the tool error.

## Installation / distribution

Published as an npm package, run via `npx` — no global install:

```bash
claude mcp add computer-control -- npx -y claude-background-control
```

One command for setup; the permissions walkthrough in the README covers
the rest.

## Testing / verification

Real GUI automation resists full unit testing. Split:

- **Unit-testable, pure logic**: coordinate bounds validation, JXA
  script string building, tree-parsing from JXA's stdout — these get
  ordinary unit tests (no OS calls).
- **Manual smoke test**: a `scripts/smoke-test.md` checklist / small
  script that opens TextEdit, calls `inspect`, `click_element` on the
  text area, `type`s a known string, and asserts (by reading it back via
  `inspect` or a screenshot) that it landed. Run by hand after any change
  to the accessibility or coordinate layers, since this is exactly the
  kind of logic ponytail's "leave one runnable check" rule targets.

## Future work (explicitly out of scope for v1)

- Codex CLI support (should work as-is over MCP, but untested).
- Windows/Linux backends.
- Drag/scroll/multi-touch gestures.
- Automated (non-manual) end-to-end GUI test harness.

## Implementation notes (v0.1, supersedes parts above)

- Files collapsed to three: `src/server.ts` (tools, permission gate),
  `src/mac.ts` (all osascript/screencapture/sips calls),
  `src/logic.ts` (pure logic, unit-tested in `src/logic.test.ts`).
- Coordinate clicks use CoreGraphics `CGEventPost` through the JXA ObjC
  bridge instead of System Events `click at`, which only hits
  accessibility elements and misses canvas/Electron content.
- `click_element` tries accessibility actions first (focus for text
  inputs, `AXPress` otherwise), so it works on background apps without
  moving the mouse. It clicks the element's center only as a fallback.
- Added `set_value` (direct AXValue write) and `activate_app`.
- `type` pastes through the clipboard and restores it afterwards.
  `keystroke` garbles Hangul, and when a Korean input source is active
  it even turns ASCII into Hangul. `key` sends key codes for the same
  reason.
- `inspect` fetches each attribute once per sibling list (batched Apple
  Events), limits depth and node count, and skips the menu bar's contents.
- Screenshots are resampled so that 1 image pixel equals 1 screen point.
- Screen Recording is checked via `CGPreflightScreenCaptureAccess`,
  bound manually with `ObjC.bindFunction` because it isn't in the bridge
  metadata.

## v0.2 notes

- Added `menu` (browse or click the menu bar by names; works on
  background apps), `scroll` (line-based wheel events), and `drag`.
- Synthetic mouse events need pauses. When the down, dragged, and up
  events for a drag or double-click are posted back-to-back, AppKit can
  miss the mouse-up. That left TextEdit stuck in `NSTextView mouseDown`
  tracking, ignoring Apple Events, and later mouse-ups couldn't free it
  (it had to be killed). `click` now waits 30ms after each event;
  `drag` waits 100ms after the down, 20ms per step, and 100ms before
  the up.
- CI (GitHub Actions, macOS) runs unit tests and the build. GUI checks
  stay manual (scripts/smoke-test.md).

## v0.2.1 notes

- Permission errors name the app macOS actually charges the grant to (the
  TCC "responsible process", found with the private
  `responsibility_get_pid_responsible_for_pid`). The Claude desktop app
  launches Claude Code through a `disclaimer` helper, so enabling "Claude"
  isn't enough: the grant belongs on the inner
  `.../claude-code/<version>/claude.app`. Falls back to `TERM_PROGRAM` if
  the call is unavailable.
- `screenshot` verified live: a 2048-point main display gives a 2048px
  image.

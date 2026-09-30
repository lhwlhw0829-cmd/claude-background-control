# Manual GUI smoke test

Run after any change to `src/mac.ts`. You need Accessibility and Screen
Recording permission (see README).

1. `npm run build`, then register the local build:
   `claude mcp add cbc-dev -- node $PWD/dist/server.js`
2. Open TextEdit with a new empty document, then switch back to Claude Code.
   TextEdit is now in the **background**.
3. Ask Claude to do each of the following and check the result:
   - [ ] `inspect(app: "TextEdit")` lists an `AXTextArea`.
   - [ ] `set_value(role: "AXTextArea", app: "TextEdit", value: "안녕 hello")`:
         the text appears in TextEdit while your mouse and focus stay put.
   - [ ] Copy an image, then `type("x")`: the image is still on the clipboard afterwards.
   - [ ] `wait_for(app: "TextEdit", find: "AXSheet")`, then press cmd+w on an edited document: it
         reports the save sheet. After esc, `wait_for(..., gone: true)` reports it gone.
   - [ ] `click_element(label: "중앙 정렬", app: "TextEdit")` (or "Center" in English):
         alignment flips in the background; a fresh `inspect` shows its value = "1".
   - [ ] `activate_app("TextEdit")`, then `key("cmd+a")` and `type("한글 입력 테스트")`:
         the document now reads exactly `한글 입력 테스트`, even with the Korean input source on.
   - [ ] `screenshot()`: a sharp image of the screen, not just the wallpaper.
   - [ ] `screenshot(app: "TextEdit")` with another window covering TextEdit: you get the whole
         TextEdit window. With Stage Manager on and TextEdit in the side strip, you get the thumbnail
         warning instead.
   - [ ] `inspect(app: "TextEdit", find: "Center")` (or "정렬") lists only the alignment controls.
   - [ ] `click` on a point taken from that screenshot lands on that spot.
   - [ ] `menu(app: "TextEdit", path: ["File"])` lists items; `path: ["File", "New"]` opens a new
         document while TextEdit stays in the background.
   - [ ] Double-click a word → it gets selected. `drag` across a line → the text is selected,
         and TextEdit still responds afterwards (a lost mouse-up leaves it stuck in mouse tracking).
   - [ ] In a long document, `scroll(direction: "down", amount: 20)` over the text moves it.
   - [ ] `click(x: 99999, y: 0)` returns an "outside the main screen" error.
4. `claude mcp remove cbc-dev`

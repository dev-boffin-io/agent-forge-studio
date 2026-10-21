# yt-browser

Drive the real YouTube Studio UI in the shared visible Chromium window (browser_* tools).
Use this when the Data API cannot do the job: channel customization, end screens, cards,
Info/Settings tabs, some upload dialogs, comments moderation quirks. The human watches the
window — act like a person, not a script.

## First run
1. `browser_navigate` → https://studio.youtube.com
2. If you land on a sign-in page: tell the human to sign in inside the opened window, then
   call `browser_save_state`. The login persists in the `.auth` session file
   (`~/.ytstudio/<channel>/browser/youtube.auth.json`) — every later run starts signed in.
3. Otherwise you are already in. `browser_snapshot` to orient.

## How to drive the page
- Always `browser_snapshot` after navigation or a big UI change. It returns elements with
  role, name and a ready selector — paste that selector into click/type/wait.
- Selector cheat-sheet:
  - `#upload-button` — CSS id
  - `text=Create` / `text="Upload videos"` — visible text (quotes = exact)
  - `role=button[name="Create"]` — accessibility role+name
  - `aria-label=Upload videos` — by aria-label
  - `input[type=file]` — the hidden file input YouTube uses for uploads
- Slow UI: `browser_wait` after clicks that open dialogs; `browser_scroll` to reveal
  "Visibility" radios or the Description box; `browser_press Escape` to close menus.
- YouTube is shadow-DOM heavy — Playwright selectors pierce open shadow roots automatically;
  the snapshot already walks it for you.

## Standard flows

### Upload a video through the UI
1. `browser_navigate` https://studio.youtube.com/channel/CHANNELID/videos (or click Create →
   Upload videos from the snapshot).
2. `browser_upload` with selector `input[type=file]` and the workspace-relative file path —
   this bypasses the OS file dialog.
3. `browser_snapshot` → find the Details fields. `browser_type` the title (first ~90 chars),
   description, tags. Wait for the upload/processing progress element between steps.
4. Scroll the dialog down (`browser_scroll`) until Visibility is visible; click the wanted
   radio (`text=Private` / `Public` / `Unlisted`).
5. Step through the wizard buttons (Next / Next / Next / Publish) with snapshot → click.
6. `browser_screenshot` at the end so the human sees the result; `browser_save_state`.

### Fix something on an existing video
1. Navigate to the video's edit page (`https://studio.youtube.com/video/VIDEOID/edit`).
2. snapshot → change fields with type/click → click "Save".

## Rules
- Never click monetization, delete, or channel-monetization confirmations without the human
  explicitly asking in this session.
- Prefer the API tools (yt_upload, yt_set_visibility) for plain upload/visibility — the UI
  is the fallback for what they cannot reach.
- If a selector fails, the error lists nearby labels — retry with one of those instead of
  guessing blindly.
- Close with `browser_close` when the task is done (state is saved first).

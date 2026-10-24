# agent-forge-studio

Autonomous Agent Assistant for any Ollama/OpenAI-compatible endpoint — research, planning, content creation, scripts, edit decision lists, retention reading, niche research, browser automation, and direct multi-platform operation across YouTube, Instagram, Facebook, and Google. Install GitHub skills on demand. One dependency: Playwright (only loaded when the browser tools are used).

## Quick start
1. Start Ollama (or any OpenAI-compatible server).
2. Run `npx --yes agent-forge-studio` or `node server.js --dir /your/channel`.
3. Open the browser UI, pick a model, and start a session. The default agent `create` writes files to your channel workspace; `analyze` is read-only.

## Configuration
Copy the template and edit it:
```sh
cp config.example.json config.json
```
`config.json` is gitignored — it holds your endpoint, model and any API keys. Everything is
optional: any key you leave out falls back to the built-in default in `lib/config.js`.

Key fields:
- `endpoint` — your Ollama / OpenAI-compatible server (default `http://localhost:11434`).
- `model` — default model ref; `smallModel` is an optional cheaper model for titles + summaries.
- `providers` — extra backends, e.g. `{ "openai": { "type": "openai", "apiKeyEnv": "OPENAI_API_KEY" } }` (`type` is `ollama` | `openai` | `anthropic`).
- `permission` — `allow` | `ask` | `deny` per rule (`bash` accepts a pattern map; last match wins).
- `youtube` — your Google OAuth **client id + secret** for the channel tools. You can either
  put them here or click through the UI's YouTube setup; keep the real secret out of git.
- `facebook` / `instagram` — the Meta app **client id + secret** used by Facebook Pages and
  Instagram Business/Creator publishing.
- `google` — Google OAuth **client id + secret** for account identity and read-only Business
  Profile access.

## Facebook, Instagram and Google connections

Open **Providers & Platform credentials** and paste each provider's OAuth client id + secret.
The redirect URI must be registered exactly in the provider console:

- Facebook: `http://localhost:4312/auth/facebook/callback`
- Instagram: `http://localhost:4312/auth/instagram/callback`
- Google: `http://localhost:4312/auth/google/callback`

If you run on another port, either update the registered redirect URI or set
`facebook.redirectUri`, `instagram.redirectUri`, or `google.redirectUri` in `config.json`.
The server never derives these from the request `Host` header.

**Facebook Pages** — create a Meta app with Facebook Login. Request `pages_show_list`,
`pages_manage_posts`, and `pages_read_engagement`. The callback exchanges the short-lived
user token for a long-lived token, reads `me/accounts`, and stores each Page token under
`token.pages[pageId]`. Posting tools publish to a Page, not a personal profile.

**Instagram Business/Creator** — use the same Meta app and connect the Instagram account to a
Facebook Page. Request `instagram_basic`, `instagram_content_publish`, `pages_show_list`, and
`pages_read_engagement`. The callback finds `instagram_business_account` on the linked Page and
stores the Page token plus `igUserId`. Photo posts and Reels wait for Meta's media container to
reach `FINISHED` before publishing (default timeout: 2 minutes).

**Google** — enable the Google Identity and Business Profile APIs. Request `openid`, `email`,
`profile`, and `https://www.googleapis.com/auth/business.manage`. Google is used for account
identity and read-only Business Profile account/location listing. Offline access is requested at
consent, so the access token refreshes automatically.

Tokens are stored only under `~/.ytstudio/<channel>-<hash>/config/` with directory mode `0700`
and file mode `0600`. OAuth `state` values are signed, expire after 10 minutes, and can only be
used once. Posting to Pages you do not own or manage may require Meta app review; the tools only
use Pages your logged-in account already administers.

## Features
- Real agent loop with tool calling (no mock). Deterministic analyzers: hook_score, title_lint, edit_list, chapters_from_transcript, retention_read, viral_rank.
- Voice-aware agent that reads `voice.md` from the channel workspace (start from `templates/voice.md`).
- Slash commands map to skills (`/script`, `/plan`, `/retention`, etc).
- Sessions, SSE streaming, permission gating, compaction.
- One folder per channel: `~/.ytstudio/<channel>-<hash>/` for sessions/outputs, channel workspace for content (`scripts/`, `transcripts/`, `analytics/`, `packages/`, `plans/`).
- Multi-platform operation: upload videos/posts (YouTube, Instagram, Facebook), manage visibility/settings, and read stats. YouTube, Facebook Pages, Instagram Business/Creator, and Google Business Profile use their APIs; browser automation remains available as a fallback.
- Browser Automation Skill (`skills/yt-browser`): the agent drives a **visible** Chromium window on the real Studio UI — navigate, snapshot the page, click, type, upload files like a human, with the login persisted in `~/.ytstudio/<channel>/browser/youtube.auth.json`. Install browsers once with `npx playwright install chromium`.

## Notes
- Publishing happens only when you ask the agent to publish; the `publish` permission defaults to **ask** for the main agent and is denied for read-only subagents.
- GitHub skills are always previewed at a pinned commit SHA first: the UI shows every file, the full `SKILL.md` and warning flags, and nothing is written until you press **Confirm install**. Installed GitHub skills are marked untrusted; their bundled scripts, publish actions and browser writes still require an explicit permission prompt. Use `skills install <source> --yes` for the CLI equivalent.
- The Studio UI window is the fallback for what the Data API cannot do (channel customization, end screens, cards, some upload dialogs). The human watches it work.
- `yt-dlp`/`whisper`/`ffmpeg` can be run via `bash` if present (policy-gated).
- Ported faithfully from https://github.com/Jakeschincariol/youtube-agent-skill.

## Scripts
- `node server.js` — start UI
- `node scripts/check.js` — syntax + smoke check
- `npm test` — run tests
- `npm run build` — Node SEA single executable

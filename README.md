# youtube-forge-studio

Agentic YouTube studio for any Ollama endpoint — scripts, title/thumbnail linting, edit decision lists, retention reading, niche research, and direct channel operation. One dependency: Playwright (only loaded when the browser tools are used).

## Quick start
1. Start Ollama (or any OpenAI-compatible server).
2. Run `npx --yes youtube-forge-studio` or `node server.js --dir /your/channel`.
3. Open the browser UI, pick a model, and start a session. The default agent `create` writes files to your channel workspace; `analyze` is read-only.

## Features
- Real agent loop with tool calling (no mock). Deterministic analyzers: hook_score, title_lint, edit_list, chapters_from_transcript, retention_read, viral_rank.
- Voice-aware agent that reads `voice.md` from the channel workspace.
- Slash commands map to skills (`/script`, `/plan`, `/retention`, etc).
- Sessions, SSE streaming, permission gating, compaction.
- One folder per channel: `~/.ytstudio/<channel>-<hash>/` for sessions/outputs, channel workspace for content (`scripts/`, `transcripts/`, `analytics/`, `packages/`, `plans/`).
- YouTube Studio Agent: upload (`yt_upload`), set visibility (`yt_set_visibility`), list videos and read stats via the Data API — no confirmation beyond the permission gate.
- Browser Automation Skill (`skills/yt-browser`): the agent drives a **visible** Chromium window on the real Studio UI — navigate, snapshot the page, click, type, upload files like a human, with the login persisted in `~/.ytstudio/<channel>/browser/youtube.auth.json`. Install browsers once with `npx playwright install chromium`.

## Notes
- Publishing happens only when you ask the agent to publish; the `publish` permission defaults to allow for the main agent and is denied for read-only subagents.
- The Studio UI window is the fallback for what the Data API cannot do (channel customization, end screens, cards, some upload dialogs). The human watches it work.
- `yt-dlp`/`whisper`/`ffmpeg` can be run via `bash` if present (policy-gated).
- Ported faithfully from https://github.com/Jakeschincariol/youtube-agent-skill.

## Scripts
- `node server.js` — start UI
- `node scripts/check.js` — syntax + smoke check
- `npm test` — run tests
- `npm run build` — Node SEA single executable

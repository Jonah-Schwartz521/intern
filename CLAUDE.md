# CLAUDE.md

Operating manual for Claude Code on the Intern project. Read this at the start of every session.

## What Intern Is

A lightweight, hotkey-summoned desktop AI agent. The user hits a shortcut, asks for a quick task (create a meeting, set a reminder, find a file, transcribe a video), and Intern executes it. It is a quick-task tool, not a chat app you sit in. Full detail in docs/NORTH_STAR.md.

## How to Work With Me

- Keep prompts and changes small and scoped. One concern at a time.
- Always show a diff before applying edits. Do not apply without showing.
- Do not touch `overflow`, `z-index`, `position`, or `background-color` in CSS unless I explicitly ask. These have broken layouts before.
- No em dashes anywhere in code, comments, or docs. Use commas, colons, or parentheses.
- Be direct and opinionated. If there is a clearly better option, say so and pick it. Skip exhaustive lists.
- Ask before assuming file paths, calendar details, or config values.
- When you finish a unit of work, update docs/PROGRESS.md. When you make a non-obvious decision, log it in docs/PROJECT_MEMORY.md.

## Framework: Tauri (important constraints)

This is a Tauri 2.x app, not Electron. The whole reason we chose it is the lean footprint, so protect that.

- **Keep Rust exposure near zero.** Prefer the frontend (JS/TS) plus official `@tauri-apps` plugins for everything. If a task seems to require writing custom Rust commands, STOP and ask first. There is usually a JS-side or plugin path. Custom Rust is a last resort, not a default.
- Use official plugins where they exist:
  - global hotkey: `@tauri-apps/plugin-global-shortcut`
  - filesystem: `@tauri-apps/plugin-fs`
  - file picker / dialogs: `@tauri-apps/plugin-dialog`
  - reminders / notifications: `@tauri-apps/plugin-notification`
  - run ffmpeg and other binaries: `@tauri-apps/plugin-shell`
  - outbound HTTP (Claude, transcription): `@tauri-apps/plugin-http` if frontend fetch hits CORS or needs native client
  - local storage of keys/prefs: `@tauri-apps/plugin-store`
- Capabilities are opt-in in Tauri. When a feature needs a permission, add the narrowest capability that works, not a broad one.
- Remember the webview is OS-native (WebView2 on Windows). We are Windows-first, so target that and do not assume Chromium-only behavior if we later add Mac/Linux.

## Tech Stack

- Framework: Tauri 2.x
- Frontend: Vue or React + TypeScript (DECISION PENDING, see PROJECT_MEMORY.md)
- Backend: Rust in `src-tauri`, kept minimal
- LLM: Claude API over HTTP, model-agnostic behind a router (see LLM cost rules below)
- Speech-to-text: local whisper.cpp (no per-minute cost), shelled out like ffmpeg
- Audio extraction: ffmpeg via the shell plugin
- Integrations: Calendar API (Google or Outlook, DECISION PENDING), reminders, filesystem
- Storage: Tauri store plugin or local config file

## LLM Cost Rules (keep the bill near zero)

- Route by difficulty. Default routine intent parsing (set reminder, find file, simple calendar create) to Haiku 4.5. Escalate to Opus 4.8 only when a request is ambiguous, multi-step, or needs reasoning over calendar context. Do not send every call to Opus.
- Keep the model behind a thin abstraction so the chosen model is a config value, not hardcoded at call sites.
- Cache the static system prompt (instructions + tool definitions). It is identical every call, so it should be cached and read at the discounted cache-read rate rather than reprocessed.
- Keep system prompts tight and ask for compact structured output (JSON for the parsed intent), with a sane max_tokens cap so output cost stays small.
- Do not use the Batch API. It is async (up to 24h) and Intern is real-time.

## Design Language

- Accent: copper / amber `#c07840`
- Base: near-black warm dark
- Type: monospace for code and file paths, sans-serif for UI text
- One window, one input, one chat stream. Minimal chrome.

## Architecture (intended flow)

Hotkey press -> capture input (typed or voice) -> frontend routes intent to Claude API over HTTP -> Claude returns parsed intent + action -> frontend executes the action via the relevant Tauri plugin (calendar / reminder / file), or runs the local transcription pipeline (ffmpeg extract -> whisper.cpp) -> result shown in UI.

Start with a single Claude call that routes intent. Do not split into sub-agents until the loop works and a single prompt gets unwieldy. Keep orchestration in the frontend; only reach into Rust if a plugin genuinely cannot do the job.

## How to Run

TODO: fill in once the skeleton exists. Likely `npm install` then `npm run tauri dev` for development and `npm run tauri build` for a release build. Confirm and update.

## Where Things Live

- docs/NORTH_STAR.md      the scope and design language (rarely changes)
- docs/PROGRESS.md        what is shipped and what is next (update every session)
- docs/PROJECT_MEMORY.md  decisions, blockers, open questions
- src-tauri/              Rust backend and Tauri config
- config/.env.example     template of required keys (the real .env is gitignored)
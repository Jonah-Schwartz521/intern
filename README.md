# Intern

A lightweight, hotkey-summoned desktop AI agent. Hit a shortcut, ask it to do a quick task (create a meeting, set a reminder, find a file, transcribe a video), and it handles it. Intern is the junior helper you hand quick tasks to: you summon it, get the thing done, and it gets out of your way.

## Status

Pre-build. Scaffolding the Tauri app. See `docs/PROGRESS.md` for the current checklist.

## What it does (MVP)

- Calendar management: create, modify, view, and search events from natural language
- Reminders: set reminders with smart due-date parsing
- File search and access: fuzzy-find and open local files
- Calendar context: read the schedule and suggest open slots
- Voice input: speak a request instead of typing
- Audio and video transcription: extract text from audio/video files

## Tech stack

- Framework: Tauri 2.x (OS-native webview + Rust backend, lean footprint)
- Frontend: Vue or React + TypeScript
- Backend: Rust (`src-tauri`), kept minimal, leaning on official `@tauri-apps` plugins
- LLM: Claude API (cloud reasoning) over HTTP
- Speech-to-text: cloud transcription (Whisper API or equivalent)
- Audio extraction: ffmpeg via the Tauri shell plugin

## Project structure
- /intern
- /src       ->   frontend (UI, intent routing, API clients, integrations)
- /src-tauri ->   Rust backend and Tauri config (minimal)
- /docs      ->   NORTH_STAR, PROGRESS, PROJECT_MEMORY
- /config    ->  .env.example (real .env is gitignored)
- CLAUDE.md    ->   operating manual for Claude Code

## Docs

- `docs/NORTH_STAR.md` the scope and design language
- `docs/PROGRESS.md` what is shipped and what is next
- `docs/PROJECT_MEMORY.md` decisions, rationale, blockers
- `CLAUDE.md` how Claude Code should work in this repo

## Development

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # produce a release build
```

(Commands assume the Tauri scaffold is in place. Update once confirmed.)
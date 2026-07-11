# Progress

Living log of what is built and what is next. Update at the end of every session.

## Status: MVP feature-complete (end-to-end test + polish remain)

## MVP Checklist

- [x] Scaffold Tauri app (React + TS)
- [x] Global hotkey (Ctrl+Shift+Space) + window summoning, tray residence, close-to-tray
- [x] Minimal chat UI (input + history), Markdown-rendered replies, custom frameless titlebar
- [x] Claude API client (HTTP) + intent routing (Haiku default, Opus escalation) + prompt caching
- [x] Reminders (Windows Task Scheduler via schtasks)
- [x] File search + open (PowerShell Get-ChildItem, opener plugin)
- [x] Outlook auth (Microsoft Graph, PKCE, personal account, /consumers endpoint)
- [x] Calendar: list / create / update / delete events (Graph)
- [x] Stateful Outlook connection control (titlebar pill)
- [x] File transcription (bundled Const-me/Whisper + ggml-base.bin, no ffmpeg, no network)
- [x] Voice input (mic -> mp4/AAC -> whisper -> input box)
- [x] System audio capture (Stereo Mix loopback -> transcript bubble)
- [x] Input row redesign (send-default, mic + voice/system source, overflow menu)
- [x] Email drafting (Graph create-draft, inline prefilled compose card, opens via webLink)
- [ ] End-to-end test of the full flow

## Done (highlights, most recent session)

- **File transcription:** bundled Const-me/Whisper (GPU, Direct3D) + ggml-base.bin, both shipped as `$RESOURCE`-bundled Tauri resources. No ffmpeg (Media Foundation decodes mp3/mp4/wav directly), no network download.
- **Voice input:** mic -> MediaRecorder `audio/mp4` -> whisper -> transcript dropped into the input box (a command to review and send).
- **System audio:** Stereo Mix loopback deviceId -> whisper -> transcript bubble. Verified clean off muted/headphone playback (real digital loopback, not acoustic pickup).
- **Input row redesign:** `[mic] [overflow menu] [input] [send]`; source (voice/system) and Transcribe file live in the overflow menu.
- **Email drafting:** `draft_email` tool -> inline prefilled compose card (editable To/Subject/Body) -> Graph create-draft -> opens the draft via webLink in Outlook. Draft-and-handoff (no Mail.Send). Escalates to Opus.

(Earlier: hotkey + tray, chat UI, reminders, file search/open, Outlook calendar CRUD, autostart, Markdown rendering, model routing + prompt caching.)

## Done: /resume with browsable history

- [x] **Stage 1, session persistence.** `src/session.ts` wraps the store plugin (`sessions.json`), serializing each conversation (id + createdAt + updatedAt + messages) keyed by id, plus a `currentId` pointer. App restores the current session on launch and saves on every change (empty conversations are not persisted; no-op renders do not rewrite). No `/` command or list UI yet.
- [x] **Stage 2, `/` command system + `/resume` list.** Input starting with `/` routes through a command registry (`commands` map in `App.tsx`) instead of Claude; unknown commands show a transient notice. `/resume` renders an inline list (no modal) of saved conversations (placeholder title = first user message truncated, plus timestamp), each row loads that conversation. `/new` and two overflow-menu buttons (New conversation, Resume conversation) start a fresh session. All switch paths call `persistCurrent()` first so the outgoing conversation is saved before the view is cleared.
- [x] **Stage 3, auto-generated titles.** When a conversation reaches 3+ messages and has no title yet, `generateTitle()` makes one small Haiku call (no tools, no cached system prompt, `max_tokens: 16`, only the trimmed opening turns sent) and caches the 3-5 word result on the session. Never regenerated; conversations under 3 messages stay on the first-message placeholder. `sessionTitle()` prefers the stored title, so the `/resume` list shows generated titles automatically. Cost: one tiny Haiku call per titled conversation.

## Next Up

1. **End-to-end test of the full flow** (exercise every tool in one session).
2. **Settings panel** (the overflow menu item is currently a placeholder that says "not available yet").
3. **Distribution:** `tauri build` a real installer and verify the bundled binaries + model resolve via `$RESOURCE` in an installed build (so far only run via `tauri dev`).

## Notes / Blockers

- **Stereo Mix (system audio) ships DISABLED by default** on most Windows machines. Fine for personal use; a distributable build would need a manual-enable step or guidance.
- **Const-me/Whisper is pinned to its last release (1.12.0, 2023)** - functional but stale.
- See PROJECT_MEMORY.md for the transcription decisions and the Azure app-registration saga.

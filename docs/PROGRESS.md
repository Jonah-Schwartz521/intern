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
- [x] Clipboard as an input (read_clipboard tool: "explain this error", "format this", "summarize this")
- [ ] End-to-end test of the full flow

## Done (highlights, most recent session)

- **File transcription:** bundled Const-me/Whisper (GPU, Direct3D) + ggml-base.bin, both shipped as `$RESOURCE`-bundled Tauri resources. No ffmpeg (Media Foundation decodes mp3/mp4/wav directly), no network download.
- **Voice input:** mic -> MediaRecorder `audio/mp4` -> whisper -> transcript dropped into the input box (a command to review and send).
- **System audio:** Stereo Mix loopback deviceId -> whisper -> transcript bubble. Verified clean off muted/headphone playback (real digital loopback, not acoustic pickup).
- **Input row redesign:** `[mic] [overflow menu] [input] [send]`; source (voice/system) and Transcribe file live in the overflow menu.
- **Email drafting:** `draft_email` tool -> inline prefilled compose card (editable To/Subject/Body) -> Graph create-draft -> opens the draft via webLink in Outlook. Draft-and-handoff (no Mail.Send). Escalates to Opus.

(Earlier: hotkey + tray, chat UI, reminders, file search/open, Outlook calendar CRUD, autostart, Markdown rendering, model routing + prompt caching.)

## Done: context bin (data + ingestion layer, no UI yet)

- [x] **Ingestion + storage.** `src/contextBin.ts` (records + store + public API) and `src/extract.ts` (text extraction). Supported types: `.txt` / `.md` (UTF-8), `.pdf` (pdfjs-dist), `.docx` (mammoth). Unsupported types are skipped with a reason, never fail the batch. Records `{ id, filename, path, mimeType, extractedText, charCount, tokenCount, addedAt }` persist to `context-bin.json` via tauri-plugin-store (source of truth). Token count is a `chars/4` estimate (TODO: real tokenizer). Public API: `addFiles(paths)`, `removeFile(id)`, `listFiles()`, `getTotalTokens()`, plus `pickContextFiles()` (dialog-plugin picker). All frontend, no Rust.
- [x] **Capability:** added `fs:allow-read-file` scoped to `**` in `capabilities/desktop.json` (a picked reference file can live anywhere; read only, no write). Flagged for narrowing if desired.
- [x] **Wired into the Claude request path.** `assembleContextBlock()` concatenates every bin file wrapped as `<context_file name="...">...</context_file>`, injected as a SECOND cached system segment after base instructions, with its own `cache_control` breakpoint. Cache prefix order (API-fixed): tools -> system[0] base instructions (breakpoint A) -> system[1] context block (breakpoint B); the per-call user message stays in `messages`, never cached. Budget guard: `assembleContextForRequest()` compares `getTotalTokens()` to a configurable budget (default 50000, `DEFAULT_CONTEXT_TOKEN_BUDGET`); over budget it warns via the inline notice bar + `console.warn` and still sends. Model routing untouched (applies to Haiku and Opus alike).
- [x] **UI: collapsible Context panel** below the titlebar (`ContextPanel` in App.tsx). Click the head to expand/collapse; head always shows the running total token count, colored neutral / amber (>= 80% budget) / red (over budget). Add files via the `+ Add files` button (dialog picker) or by dragging files onto the window (native Tauri `onDragDropEvent`, which yields real paths; a drag auto-opens the panel and highlights the dropzone). Each file row: filename (mono, ellipsis, full path on hover) + token count + remove (x). Empty state is one sans line explaining the feature. Skipped files (unsupported/empty) report via the inline notice bar. All routes through the prompt-1 ingestion module; frontend only. Labels sans (`--sans` added), filenames/paths/counts mono.

## Done: syntax-highlighted chat code blocks

- [x] **Shiki highlighting + language label.** Fenced code blocks in chat replies render through a `CodeBlock` component (App.tsx) via a react-markdown `pre` override. `src/highlight.ts` owns a single lazily-created Shiki highlighter (theme `github-dark`), reused across blocks; grammars lazy-load on first use of each language (Vite splits each grammar + the wasm engine into its own chunk, so startup does not pull 235 languages). Language comes from the fence (```ts, ```python); unknown or missing language falls back to plain text with no highlighting and no label (no guessing). Header row per block: language name top-left (mono, copper `#c07840`, small), Copy top-right (reuses `.copy-btn`), `margin-left:auto` keeps Copy right when the label is hidden. Removed `takeawayContent`/message-level copy for code replies (each block now owns its Copy); transcript copy bubbles are unchanged. Frontend only, no Rust.

## Done: /resume with browsable history

- [x] **Stage 1, session persistence.** `src/session.ts` wraps the store plugin (`sessions.json`), serializing each conversation (id + createdAt + updatedAt + messages) keyed by id, plus a `currentId` pointer. App restores the current session on launch and saves on every change (empty conversations are not persisted; no-op renders do not rewrite). No `/` command or list UI yet.
- [x] **Stage 2, `/` command system + `/resume` list.** Input starting with `/` routes through a command registry (`commands` map in `App.tsx`) instead of Claude; unknown commands show a transient notice. `/resume` renders an inline list (no modal) of saved conversations (placeholder title = first user message truncated, plus timestamp), each row loads that conversation. `/new` and two overflow-menu buttons (New conversation, Resume conversation) start a fresh session. All switch paths call `persistCurrent()` first so the outgoing conversation is saved before the view is cleared.
- [x] **Command palette.** Typing `/` at the start of an empty input opens a small dropdown above the input row, listing every command in the registry with a one-line description. Filters as you type (`/re` narrows), arrow keys navigate, Enter or click runs, Escape or deleting the `/` dismisses. Derived from the `commands` map, so a new command appears in the palette with no extra wiring.
- [x] **`/clear`.** Wipes the current conversation from view AND deletes it from the store, so throwaway chats never reach the resume list. Distinct from `/new`, which saves first. Destructive and unrecoverable, so it asks first with an inline confirm bar (no modal); Cancel, sending a message, or switching conversations all dismiss the pending confirm. Appears in the palette automatically, like any registry entry.
- [x] **Stage 3, auto-generated titles.** When a conversation reaches 3+ messages and has no title yet, `generateTitle()` makes one small Haiku call (no tools, no cached system prompt, `max_tokens: 16`, only the trimmed opening turns sent) and caches the 3-5 word result on the session. Never regenerated; conversations under 3 messages stay on the first-message placeholder. `sessionTitle()` prefers the stored title, so the `/resume` list shows generated titles automatically. Cost: one tiny Haiku call per titled conversation.

## Done: clipboard as a first-class input

- [x] **`read_clipboard` tool.** `@tauri-apps/plugin-clipboard-manager` (read-only permission), wired the standard four places (Cargo.toml, lib.rs, package.json, capability). A system-prompt rule teaches Claude that a demonstrative with no referent in the conversation ("explain this error", "format this JSON", "summarize this") means the clipboard, so it calls the tool instead of asking the user to paste. Empty or non-text clipboards answer in one line rather than dumping an error. Clipboard text is capped at 8,000 characters before it is sent to the model.
- [x] **Copyable output for takeaway content.** A reply that is essentially one fenced block (reformatted JSON, rewritten text, fixed code) renders as a copy-button bubble; prose answers stay unboxed. `max_tokens` went 1024 -> 2048 so echoing a mid-size payload back is not truncated.

## Done: Spotlight-style summoning

- [x] **Predictable window placement on hotkey.** `src/summon.ts` positions the window before showing it: horizontally centered, top edge 22% down the work area (upper third, not dead center), on the monitor under the mouse cursor (`cursorPosition` + `monitorFromPoint`, falling back to current then primary monitor). Uses `workArea` so it clears the taskbar, and clamps so it never hangs off the bottom. The input is focused on summon, so the user can type immediately. Pure JS window API, no Rust; needed one new capability, `core:window:allow-set-position`.

## Done: chat stream follows new content

- [x] **Auto-scroll, split by who caused the content.** User-initiated actions (send a message, run a command, switch conversations) always jump to the bottom: you acted, so you see the result. Passive arrivals (the reply, a background result, the thinking line) only follow if you are already within 64px of the bottom, so scrolling up to read while a reply is in flight does not get yanked. Exception: the `/clear` confirm always scrolls into view, since it asks a question.
- [x] **Jump to latest.** A small circular copper-on-hover button floats above the input row, on the right, only while the user is scrolled up. Click scrolls smoothly to the bottom. Hidden while the command palette is open (same corner).

## Next Up

1. **End-to-end test of the full flow** (exercise every tool in one session).
2. **Settings panel** (the overflow menu item is currently a placeholder that says "not available yet").
3. **Distribution:** `tauri build` a real installer and verify the bundled binaries + model resolve via `$RESOURCE` in an installed build (so far only run via `tauri dev`).

## Notes / Blockers

- **Stereo Mix (system audio) ships DISABLED by default** on most Windows machines. Fine for personal use; a distributable build would need a manual-enable step or guidance.
- **Const-me/Whisper is pinned to its last release (1.12.0, 2023)** - functional but stale.
- See PROJECT_MEMORY.md for the transcription decisions and the Azure app-registration saga.

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

## Done: edge-docked slide-in panel (supersedes Spotlight summoning)

- [x] **Window shell is now a docked sidebar, not a floating window.** The window is borderless (`decorations: false`), `transparent: true`, `skipTaskbar: true`, `alwaysOnTop: true`, `resizable: false`, and starts `visible: false` (so the ONLY way it appears is the hotkey, and the slide-in animation always runs from a clean off-screen start). No custom Rust: pure `@tauri-apps/api/window` + `@tauri-apps/plugin-global-shortcut`. First `npm run tauri dev` shows no window until you press the hotkey, by design.
- [x] **`src/dock.ts` replaces `src/summon.ts`.** Reads the target monitor's `workArea` (usable area minus taskbar) and docks flush to an edge. Config values at the top: `DOCK_EDGE` ("right" default, also "left"/"top"), `SIZE_FRACTION` (0.30), `MIN_SIZE_PX` (360 logical px), `DOCK_ANIM_MS` (180). Math (physical px throughout, matching monitor geometry; logical min converted via `scaleFactor`): side dock width = `min(areaW, max(360*scale, round(areaW*0.30)))`, height = full `areaH`, x = right edge (`areaX+areaW-width`) or left edge (`areaX`); top dock = full width, 30%-of-height strip. Recomputed on every show, so a monitor/resolution/DPI change since last summon is picked up. Target monitor = the one under the cursor at summon (`cursorPosition`+`monitorFromPoint`, fallback current->primary), so multi-monitor docks where you are.
- [x] **Hotkey toggles.** `CmdOrCtrl+Shift+Space`: if hidden, dock+show+focus the input; if visible, hide. Also **hide on Esc** (deferring to the command palette's own Esc when it's open) and **hide on blur** (`onFocusChanged`), so it behaves like a summon/dismiss overlay. Blur-hide is suppressed while one of our own native dialogs is open (file picker, Outlook OAuth) via a `duringModal()` guard in dock.ts, since those steal focus without the user leaving Splerm; wrapped the 3 picker `open()` sites and `login()`.
- [x] **Slide animation, pure CSS.** `.container` gets `transition: transform 180ms ease-out`; per-`[data-dock]` rules set the resting off-edge transform (`translateX(100%)` for right, etc.) and round only the two INNER corners (`border-radius: 10px 0 0 10px` for right) so the screen-edge side stays square and it reads as docked. Adding `.shown` (driven by React state, set a frame after `show()`) slides it to `translate(0,0)`; removing it slides out, and the window actually hides only after `DOCK_ANIM_MS`. A re-summon during slide-out cancels the pending hide.
- [x] **Reserved CSS props, flagged per CLAUDE.md.** `background: transparent` on `body` + `background: var(--bg)` on `.container` (needed so the rounded corners reveal the desktop), and `overflow: hidden` on `.container` (clips the rounded corners). No changes to `position`/`z-index`. The existing chat UI, context bar, and input are untouched inside the panel.
- [x] **NOT built: true screen-space reservation (Windows AppBar).** Deliberately left out; see PROJECT_MEMORY. Hook-point comment sits in `dockWindow()`.
- [x] **New capability:** `core:window:allow-set-size` (we now call `setSize` as well as `setPosition`).
- [x] **NOT verified in the running GUI.** tsc + `vite build` pass; the Tauri window (transparency in WebView2, the slide, blur/Esc/dialog-guard behavior, multi-monitor docking) was not launched here. Confirm on first `npm run tauri dev`.

## Done: dock position setting (right / left / top / bottom)

- [x] **Dock edge is now a user setting, persisted.** `dock.ts`'s old build-constant `DOCK_EDGE` became a live runtime value with `getDockEdge()` / `loadDockEdge()` / `setDockEdge()`. Stored in its own tiny `settings.json` (tauri store, `store:default` already covers it, no new capability), restored on launch, default `right` for a fresh install (invalid/missing value falls back to right). `DockEdge` type gained `"bottom"`.
- [x] **Control lives in the `···` menu.** A "Dock" label + a 4-up segmented control (Right / Left / Top / Bottom); the active edge reads via copper text+border (no background fill, so no background-color added to an interactive element). Picking one persists it, updates the CSS orientation (`data-dock`), and, if the panel is up, re-docks immediately (`dockWindow()` reads the live edge, updated synchronously before the awaited save).
- [x] **Two orientations.** Right/left = VERTICAL (full work-area height, ~30% width, `SIDE_FRACTION`), the primary polished layout; left is right mirrored so the chat UI is identical. Top/bottom = HORIZONTAL (full work-area width, ~35% height, `HORIZ_FRACTION`), secondary/experimental. Both clamp the variable dimension to `MIN_SIZE_PX` (360 logical px).
- [x] **Horizontal-layout guards (don't disturb vertical).** `.history { min-height: 0 }` so the message list actually shrinks and scrolls inside a short-but-wide window instead of overflowing and pushing the input off-screen (a flex child defaults to `min-height: auto`; harmless in the tall docks). Plus a `max-width: 680px` cap on messages only in top/bottom so bubbles don't stretch to an unreadable line length. Vertical docks untouched.
- [x] **Slide + corners follow the edge.** CSS `[data-dock="bottom"]` added: slides in from the bottom (`translateY(100%)`) and rounds only the top (inner) corners; right/left/top already did their edges. Every edge rounds only the two inner corners (screen-border side stays square).
- [x] **Work-area math (physical px, per edge).** Vertical: `width = min(areaW, max(360*scale, round(areaW*0.30)))`, full height; `x = areaX+areaW-width` (right) or `areaX` (left). Horizontal: `height = min(areaH, max(360*scale, round(areaH*0.35)))`, full width; `y = areaY+areaH-height` (bottom) or `areaY` (top). Recomputed every summon on the cursor's monitor.

## Done: local image format conversion (ffmpeg)

- [x] **New `src/imageConvert.ts`.** Converts images locally by shelling a bundled full ffmpeg (`ffmpeg-run` command) via the Tauri shell plugin. No Rust. Inputs decode FROM png/jpg/jpeg/webp/bmp/tiff/gif/heic/heif/avif/svg; outputs encode TO png/jpg/webp/avif ONLY (svg and heic are input-only by design). Never throws: results come back as `{ input, output?, ok, error? }`.
- [x] **ffmpeg build is a NEW bundled binary, not the old (nonexistent) one.** Correction: the project did not actually bundle or shell ffmpeg (`binaries/ffmpeg` was empty; transcription uses Const-me/Whisper via Media Foundation, not ffmpeg). This adds a full static `ffmpeg.exe` at `src-tauri/resources/ffmpeg/ffmpeg.exe` (gyan.dev "full" or BtbN), bundled via `resources/ffmpeg/*` and run through the new `ffmpeg-run` shell capability. **The exe is not in git** (gitignored, ~150MB); drop it in per `resources/ffmpeg/README.md`. Until then, conversion reports a clean "ffmpeg isn't available" and the startup probe logs it.
- [x] **Startup probe.** On launch runs `ffmpeg -formats` / `-decoders` and logs `[imageConvert] probe: svg=? avif=? heif=?`. Cached; used to enrich a failed conversion with "this ffmpeg build can't read .heic" rather than raw stderr. Best-effort, never blocks.
- [x] **Two triggers.** (1) Natural language via a new `convert_image` tool (paths[], format, optional quality, optional max_dimension) wired into `TOOLS`/`runTool`; the system-prompt-style tool description tells Claude to resolve a bare filename via `search_files` first. (2) Drag-drop or the new `Convert image` overflow-menu item: images route to an inline `ConvertPicker` (PNG/JPG/WEBP/AVIF buttons); non-image drops still go to the context bin (images were never ingestable there, so nothing regresses).
- [x] **Output + safety.** Written next to the input (same folder/stem, new ext). Existing target is never overwritten: adds ` (1)`, ` (2)`, ... A zero-exit that produced no file counts as failure. Batch supported (sequential; AVIF is CPU heavy), and the result reports how many of N succeeded.
- [x] **Result card + reveal.** A `ConversionCard` shows each output filename with a per-file "Reveal" button (opens the containing folder via `openPath`); failures show the input name + a short reason. The model gets a summary and is told not to re-list paths.
- [x] **ffmpeg commands (verify quality here).** `-frames:v 1` (single still; animated GIF -> first frame). PNG: lossless, no quality. JPG: `-q:v <2..31>` (from quality, default 90 -> ~5) `-pix_fmt yuvj420p`. WEBP: `-c:v libwebp -quality <0..100> -compression_level 6`. AVIF: `-c:v libaom-av1 -still-picture 1 -crf <0..63> -b:v 0 -cpu-used 6 -pix_fmt yuv420p`. Optional resize: `-vf scale='min(iw,MAX)':'min(ih,MAX)':force_original_aspect_ratio=decrease` (never upscales); jpg/avif also get a trailing `scale=trunc(iw/2)*2:trunc(ih/2)*2` so 4:2:0 never trips on odd dimensions.
- [x] **New capabilities:** `ffmpeg-run` shell entry (cmd = `$RESOURCE/resources/ffmpeg/ffmpeg.exe`, `args:true`) and `fs:allow-exists` (for the collision check). `tsc` + `vite build` pass.
- [x] **NOT verified in the running GUI / against a real ffmpeg** (no binary present in this environment). Drop the exe, then confirm the probe line and a real HEIC/AVIF/SVG conversion on next `npm run tauri dev`.

## Done: conversion card (file-selection + staging step)

- [x] **All three entry points now converge on one inline card** (`ConvertPicker`, no longer a bare format-button row). It lists each selected file with a thumbnail + monospace name, a selectable PNG/JPG/WEBP/AVIF format picker, an optional quality slider (shown only for the lossy encoders; png is lossless), and an explicit Convert button. Batch: one format applies to all, header reads "Convert N files to:".
- [x] **`··· menu` → Convert image:** already opened the native picker (multi-select, filtered to the supported input exts); it now lands on the enriched card instead of converting on the first format click.
- [x] **Drag-drop:** unchanged path, skips the picker and opens the card with the dropped image(s) preselected.
- [x] **Natural language:** `convert_image` tool's `format` is now OPTIONAL. Given a clear format it converts directly (as before); with no/invalid format (e.g. user said "svg") it stages the file(s) in the card via a new `uiConvert` sink and returns a "pick a format" message, instead of erroring. Tool + schema descriptions updated to tell Claude to omit `format` when the user did not name one.
- [x] **Thumbnails, no new capability.** `ConvertThumb` reads file bytes via `fs` `readFile` (already scoped `**`) into a revoked blob URL, for webview-decodable exts only (png/jpg/jpeg/webp/gif/bmp/avif/svg); heic/heif/tiff and any read/decode failure fall back to a bordered image glyph. No asset protocol, no Rust.
- [x] **Result card + reveal-in-folder** and the `convertBatch` path are unchanged; `runQueuedConversion` now also forwards the card's quality choice.

## Done: file-picker rework (native dialog + drag-drop are dead on this machine)

Verified working end to end in the GUI (real ffmpeg, real PNG -> WEBP into Downloads). Getting there took ruling out a chain of red herrings; the important findings are in PROJECT_MEMORY under "Image conversion: getting a file INTO the app".

- [x] **The native Tauri file dialog returns `null` here, and native drag-drop shows the red no-drop cursor.** Independently confirmed it is NOT: elevation (app runs non-admin), window transparency, `dragDropEnabled` (true), the build being stale (title-marker proved fresh), `multiple:true`, or the type filter. `open()` from `@tauri-apps/plugin-dialog` just returns null on a real pick on this Windows setup, and Explorer -> webview drops are rejected at the OS/WebView2 level.
- [x] **Menu "Convert image" now uses an HTML `<input type="file">`** (Chromium's picker), which DOES return files where the native dialog did not. It hands back `File` objects (bytes, no path), so `onHtmlFilesPicked` writes each to a temp copy under `$TEMP/splerm-conv/<originalname>` via `fs` `writeFile`/`mkdir`, then feeds those temp paths into the existing card + `convertBatch`.
- [x] **Output goes to Downloads** for HTML-picked files (a temp copy has no "original folder"). `ConvertOptions.outDir` was added; `convertQueue` carries `{ paths, outDir? }` so temp-copy inputs redirect output to `downloadDir()` while real-path inputs (drag-drop, natural language) still write next to the original. Output filename stays clean because the temp copy keeps the original name.
- [x] **Drag-drop listener fixed anyway** (was on `getCurrentWindow`, now `getCurrentWebview().onDragDropEvent`, the correct target in Tauri 2) so it works on machines that allow OS drops; here it is moot.
- [x] **ffmpeg dev-resolution fixed.** Under `tauri dev` the `$RESOURCE` copy of `ffmpeg.exe` can be missing; `imageConvert.ts` now probes `ffmpeg-run` (bundled) then `ffmpeg-run-dev` / `ffmpeg-run-dev-root` (in-tree source relative to the working dir) and caches the first that runs, logging the resolved path + existence at startup.
- [x] **Capabilities added:** `fs:allow-mkdir` + widened `fs:allow-write-file` (`$TEMP/splerm-conv/*`), `core:path:default` (for `tempDir`/`downloadDir`/`resolveResource`), and the two `ffmpeg-run-dev*` shell entries. `tsc` passes.

## Next Up

1. **End-to-end test of the full flow** (exercise every tool in one session).
2. **Settings panel** (the overflow menu item is currently a placeholder that says "not available yet").
3. **Distribution:** `tauri build` a real installer and verify the bundled binaries + model resolve via `$RESOURCE` in an installed build (so far only run via `tauri dev`).

## Notes / Blockers

- **Stereo Mix (system audio) ships DISABLED by default** on most Windows machines. Fine for personal use; a distributable build would need a manual-enable step or guidance.
- **Const-me/Whisper is pinned to its last release (1.12.0, 2023)** - functional but stale.
- See PROJECT_MEMORY.md for the transcription decisions and the Azure app-registration saga.

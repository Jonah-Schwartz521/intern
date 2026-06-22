# Project Memory

Decisions, rationale, blockers, and open questions. The point of this file is so no session has to relitigate a choice or rediscover a fix.

## Open Decisions (resolve before or early in build)

1. **Frontend framework: Vue vs React.**
   Either renders fine in the Tauri webview. Pick the one you want to live in.
   Status: UNRESOLVED.

2. **Target OS first: Windows or Mac.**
   Screenshots suggest Windows is the primary machine. Pick one to build and test against first, since hotkey registration, file paths, and reminders differ per OS. Note: Tauri uses the OS-native webview (WebView2 on Windows), so going Windows-first avoids cross-webview rendering surprises.
   Status: leaning Windows, UNCONFIRMED.

3. **Calendar provider: Google Calendar or Outlook.**
   Determines the first real integration and the OAuth flow. Pick the one tied to the calendar you actually live in.
   Status: UNRESOLVED.

4. **Reminders backend.**
   Tauri notification plugin for the surfacing, but decide whether reminders are stored locally (store plugin) or pushed to a cloud/calendar provider.
   Status: UNRESOLVED.

## Decisions Made

- **Framework: Tauri 2.x.** Chosen over Electron. Intern is an always-resident hotkey/tray utility, the textbook Tauri-shaped product: lean footprint matters because it runs all day, and the Rust backend suits the audio/transcription work. Accepted tradeoff: to keep Rust exposure near zero, lean on official @tauri-apps plugins and the JS frontend, and treat "I need custom Rust" as a stop-and-ask signal. Windows-first sidesteps Tauri's main downside (per-OS webview rendering differences).
- **Name: Intern.** Checked for conflicting apps; no single product owns the name (InternLM is a model family, "AI intern" is common marketing copy but not a product). Fine for a personal tool. Logged so we do not revisit.
- **Scope boundaries.** Email, Slack/Teams sending, mutual-availability scheduling, autonomous execution without confirmation, and live real-time video transcription are explicitly OUT of MVP. See NORTH_STAR.md.
- **Transcription order.** Start with file-based and playback-triggered transcription. Live streaming transcription is a later, bigger lift.
- **Architecture.** Single Claude call that routes intent to start. No internal sub-agents until the loop works. Orchestration lives in the frontend; reach into Rust only if a plugin genuinely cannot do the job.
- **LLM model routing + caching.** Use a smart model cost-effectively rather than picking a cheap-everything model. Default routine intent parsing to Haiku 4.5; escalate to Opus 4.8 only for ambiguous, multi-step, or context-heavy requests. Cache the static system prompt (instructions + tool definitions) so repeated input bills at the cache-read rate. Keep the model behind a thin abstraction (config value, not hardcoded). No Batch API (it is async, Intern is real-time). Estimated cost at ~50 commands/day: roughly $2/month routed, ~$16/month if everything went through Opus. Rationale: intent parsing is mostly classification/extraction, which the cheap tier handles well; Opus is reserved for the requests that justify it.
- **Transcription: local whisper.cpp.** Run transcription on-device via whisper.cpp instead of a paid per-minute API. Zero per-minute cost, works offline, private. Pipeline: ffmpeg extracts audio -> whisper.cpp transcribes -> text. Shelled out from Tauri like ffmpeg. Optional cloud fallback (e.g. Groq Whisper) can be added later, not MVP. This was the cost line item that actually mattered (audio is billed per minute), so removing it removes the only real recurring cost.

## Blockers / Gotchas

(none yet, log them here as they come up with the fix that worked)
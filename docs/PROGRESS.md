# Progress

Living log of what is built and what is next. Update at the end of every session.

## Status: Shell working (hotkey toggle live)

## MVP Checklist

- [x] Scaffold Tauri app (create-tauri-app, Vue or React + TS)
- [x] Register global hotkey (global-shortcut plugin) + window summoning
- [x] Minimal chat UI (input + history)
- [ ] Claude API client wired (HTTP) + intent routing
- [ ] Intent parsing: calendar create
- [ ] Intent parsing: reminder set
- [ ] Intent parsing: file search
- [~] Outlook auth (Microsoft Graph, PKCE) — code complete, pending live login test
- [ ] Calendar API read access (list_events)
- [ ] Calendar API write access (create_event)
- [ ] Voice input (mic -> speech-to-text -> intent)
- [ ] Audio file transcription
- [ ] Video transcription (ffmpeg via shell plugin -> speech-to-text)
- [ ] End-to-end test of full flow

## Done

- Scaffolded Tauri + React + TS app, toolchain working on Windows (Rust, Node, WebView2)
- Global hotkey toggle: Ctrl+Shift+Space shows/hides the window from anywhere. global-shortcut plugin wired (Cargo.toml + lib.rs + package.json + capability permissions), window show/hide/focus permissions granted, useEffect cleanup prevents double-registration.

## Next Up

1. Test Outlook login: `npm run tauri dev`, click "Connect Outlook", complete browser sign-in, confirm token logs to console. (First run downloads 3 new Rust crates.)
2. Once login verified: add `list_events` tool (Graph calendarview).
3. Then `create_event` tool (Graph POST /me/events), and remove the temporary Connect Outlook button.

## Notes / Blockers

(none yet)

# Progress

Living log of what is built and what is next. Update at the end of every session.

## Status: Shell working (hotkey toggle live)

## MVP Checklist

- [x] Scaffold Tauri app (create-tauri-app, Vue or React + TS)
- [x] Register global hotkey (global-shortcut plugin) + window summoning
- [ ] Minimal chat UI (input + history)
- [ ] Claude API client wired (HTTP) + intent routing
- [ ] Intent parsing: calendar create
- [ ] Intent parsing: reminder set
- [ ] Intent parsing: file search
- [ ] Calendar API read access
- [ ] Voice input (mic -> speech-to-text -> intent)
- [ ] Audio file transcription
- [ ] Video transcription (ffmpeg via shell plugin -> speech-to-text)
- [ ] End-to-end test of full flow

## Done

- Scaffolded Tauri + React + TS app, toolchain working on Windows (Rust, Node, WebView2)
- Global hotkey toggle: Ctrl+Shift+Space shows/hides the window from anywhere. global-shortcut plugin wired (Cargo.toml + lib.rs + package.json + capability permissions), window show/hide/focus permissions granted, useEffect cleanup prevents double-registration.

## Next Up

1. Commit + push the hotkey work (uncommitted as of this session)
2. Build the minimal chat UI: scrollable history + bottom input, copper/dark theme (#c07840 on near-black, monospace). Pure frontend, no Rust.
3. Wire the Claude API client (HTTP) + basic intent routing

## Notes / Blockers

(none yet)

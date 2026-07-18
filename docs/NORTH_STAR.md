# Splerm: Project Scope

**Version:** 1.3
**Date:** July 6, 2026

---

## North Star

Splerm is a lightweight, always-accessible AI agent that lives on your desktop. Hit a keyboard shortcut, ask it to do something (create a meeting, set a reminder, find a file, transcribe a video), and it handles it. No friction, no navigation, just intent and execution.

Splerm is the junior helper you hand quick tasks to. You summon it, get the thing done, and it gets out of your way. It is not a chat app you open and sit in.

---

## Core Capabilities (MVP)

**Calendar Management**
Create, modify, view, and search calendar events. Parse natural language like "meeting with Uyen next Tuesday at 2 PM" or "block 30 minutes after my Medtronic call."

**Reminders**
Create reminders with smart due dates, notes, and recurrence. Understand "remind me about the CodeBrew diff panel next Monday" without requiring structured input.

**File Search and Access**
Fuzzy search your local filesystem. Open files, show recent files, or retrieve snippets from project folders (CodeBrew, coursework, internship docs).

**Calendar Context**
Read your calendar to understand your schedule and offer proactive suggestions ("you have a gap Thursday afternoon if you want to schedule something").

**Voice Input**
Speak your request via microphone instead of typing. Splerm transcribes your speech in real time and passes it to the reasoning layer for intent parsing and execution.

**Audio Transcription**
Upload or select an audio file. Splerm transcribes the content and displays it as text you can copy, search, or reference.

**Video Transcription**
Point Splerm at a video file (or play a video and hit a button). It transcribes the spoken content and returns clean copyable text.

**System Audio Transcription**
Capture and transcribe what is currently playing (a call, a video, a lecture) via the system loopback rather than the microphone. Record-then-transcribe, so it works even with the system muted or on headphones.

**Email Drafting**
Draft an email from a natural-language request. Splerm generates the recipient, subject, and a full first-pass body, shows an editable compose card, then creates the draft in Outlook for you to review and send. Draft-and-handoff: Splerm never sends, you send from Outlook.

**Intent Parsing**
Understand what the user actually wants, even when phrased casually or ambiguously. Clarify when needed rather than guessing.

---

## Tech Stack

- **Framework:** Tauri 2.x (OS-native webview + Rust backend, lean footprint)
- **Frontend:** Vue or React (web tech rendered in the system webview)
- **Backend:** Rust (`src-tauri`), kept minimal. Prefer official `@tauri-apps` plugins and JS over custom Rust.
- **LLM:** Claude API over HTTP, model-agnostic behind a small router. Default to Haiku 4.5 for routine intent parsing, escalate to Opus 4.8 only for genuinely hard requests (ambiguous, multi-step, reasoning over calendar context). Cache the static system prompt (instructions + tool definitions) so repeated input bills at the cache-read rate.
- **Speech-to-text:** local transcription via whisper.cpp (no per-minute API cost, runs offline). Invoked from the shell plugin like ffmpeg. Optional cloud fallback (e.g. Groq Whisper) can be added later, not MVP.
- **Audio extraction:** ffmpeg, invoked via the Tauri shell plugin (pull audio from video before transcription)
- **Integrations:** Calendar API (Google or Outlook, DECISION PENDING), Reminders (Tauri notification plugin), filesystem (Tauri fs plugin)
- **Storage:** Tauri store plugin or a local config file for API keys, recent files, prefs

---

## UI / UX Constraints

- Hotkey triggered (e.g. Ctrl+Shift+Space or Cmd+Shift+Space), registered via the Tauri global-shortcut plugin
- Minimal chrome: chat-style interface, no modals or complex navigation
- Input field + chat history + a mic button for voice + a transcribe button for files
- Quick response time (cloud LLM handles heavy lifting; local layer stays snappy)
- Dark theme (align with CodeBrew aesthetic)

---

## Design Language

- **Primary accent:** Copper / amber `#c07840`
- **Base:** near-black warm dark
- **Typography:** monospace for code and file paths, sans-serif for UI text
- **Simplicity:** one window, one input field, one chat stream

---

## Splerm's Role (How the AI Should Behave)

You are Splerm, the reasoning engine behind a desktop quick-task assistant. Your job:

- Parse user intent from casual, natural-language input (typed or spoken)
- Map intent to specific actions (calendar create, reminder set, file search, transcription)
- Provide clear, concise responses or ask clarifying questions when ambiguous
- Suggest proactive actions when you have calendar context
- Keep responses conversational and brief (one or two sentences)
- Never assume file paths or calendar details, ask if unclear
- Act like a sharp junior assistant: fast, low-friction, no over-explaining

---

## Example Interactions

**User (speaking):** "Make a meeting with Muna Monday at 10."
**Splerm:** "I'll create a meeting with Muna for Monday at 10 AM. What's the title and how long should it be?"

**User (uploads video):** "Transcribe this lecture."
**Splerm:** "Transcribing now... done. Here's the transcript, you can copy it or search within it."

**User (plays a video, hits transcribe):** "Get me the text from this."
**Splerm:** "Pulled the audio and transcribed it. Full text is below, ready to copy."

**User (speaking):** "Remind me about the EditPlanner pipeline in two weeks."
**Splerm:** "Reminder set for July 4 to follow up on EditPlanner pipeline."

**User:** "Find my Medtronic presentation."
**Splerm:** "Found your Medtronic intro slide deck in Documents/Medtronic. Want me to open it?"

---

## Scope Boundaries (NOT MVP)

- Autonomous email sending (Splerm drafts and hands off; you send from Outlook)
- Slack or Teams message sending
- Advanced scheduling (finding mutual availability with others)
- Autonomous task execution without confirmation
- Web browsing or external data fetching beyond calendar, mail, and file access
- Live real-time transcription of a stream as it plays. Record-then-transcribe (files, voice, and system audio) is in scope; transcribing a live stream in real time is not.

---

## Project Structure (Initial)
/intern

/src                   frontend (Vue/React components, UI)

/ui                  chat window, input, history

/lib                 intent routing, Claude + transcription API clients (JS)

/integrations        calendar, filesystem, reminders (JS wrappers over Tauri plugins)

/transcription       audio extraction (ffmpeg via shell plugin) + speech-to-text

/src-tauri             Rust backend (kept minimal, plugin config, app entry)

/docs

NORTH_STAR.md        this scope + design language (rarely changes)

PROGRESS.md          what is shipped, what is next (update every session)

PROJECT_MEMORY.md    decisions, blockers, open questions

/config

.env.example         template of required keys (real .env is gitignored)

---

## First Steps

1. Scaffold the Tauri app (`create-tauri-app`, pick Vue or React + TS)
2. Register the global hotkey (Tauri global-shortcut plugin) and get the window summoning
3. Build the minimal chat UI (input + history)
4. Wire the Claude API client (HTTP) and basic intent routing
5. Intent parsing: calendar create, reminder set, file search
6. Calendar API read access
7. Voice input (mic capture -> speech-to-text -> intent)
8. File-based audio and video transcription (ffmpeg extract -> local whisper.cpp -> text)
9. End-to-end test of full flow
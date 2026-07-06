import { useState, useEffect, useRef } from "react";
import {
  register,
  unregister,
  ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Command } from "@tauri-apps/plugin-shell";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open } from "@tauri-apps/plugin-dialog";
import { login, disconnect, isConnected, getAccount, refreshAccount } from "./msauth";
import { listEvents, createEvent, deleteEvent, updateEvent } from "./calendar";
import { transcribe } from "./transcribe";
import { writeTempAudio, removeTempAudio } from "./voice";
import "./App.css";

const HOTKEY = "CmdOrCtrl+Shift+Space";

// Recordings smaller than this are treated as empty (an accidental tap or no
// audio), and skipped before hitting whisper.
const MIN_AUDIO_BYTES = 2048;

const HAIKU = "claude-haiku-4-5-20251001";
const OPUS = "claude-opus-4-8";

const SYSTEM_PROMPT = `You are Intern, the reasoning engine behind a desktop quick-task assistant.

The current date and time is ${new Date().toString()}. Use this to resolve relative times like "tomorrow at 3pm" into exact timestamps.

Your job:
- Parse user intent from casual, natural-language input (typed or spoken).
- Map intent to specific actions (calendar create, reminder set, file search, file open, transcription).
- Provide clear, concise responses or ask clarifying questions when ambiguous.
- When you search files and find results, list the top matches with their paths concisely.
- When the user asks to open a file you found earlier, call open_file with that exact path.
- Never assume file paths or calendar details; ask if unclear.
- Before creating a calendar event, resolve the exact date. If the user names a vague day like "Friday" without saying which week, or gives a time that has already passed relative to the current date/time, do NOT call create_event yet. Ask a clarifying question first, e.g. "It's already past noon today, did you mean next Friday?" Confirm the actual date before booking, and never silently assume "today" or guess the week.
- To update or delete an event you must first find it with list_events. Each event it returns includes an internal id in brackets like [id:...]. Use that id for update_event and delete_event, but never show the id to the user; it is for your use only.
- Before deleting an event, ALWAYS confirm with the user exactly which event you will delete (by name and time) and wait for their yes. Never call delete_event on a guess or without explicit confirmation.
- Act like a sharp junior assistant: fast, low-friction, no over-explaining.`;

const TOOLS = [
  {
    name: "create_reminder",
    description:
      "Create a reminder for the user. Use whenever the user asks to be reminded of something.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "What to remind the user about, e.g. 'call the dentist'",
        },
        due_iso: {
          type: "string",
          description:
            "The exact time to fire the reminder, as an ISO 8601 timestamp, e.g. '2026-07-01T15:00:00'. Compute this from the user's request and the current date/time.",
        },
      },
      required: ["text", "due_iso"],
    },
  },
  {
    name: "search_files",
    description:
      "Search the user's files by name. Use when the user wants to find a file, document, or folder. Returns matching file paths.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A word or partial filename to search for, e.g. 'medtronic', 'resume', 'budget'. Matches filenames containing this text.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "open_file",
    description:
      "Open a file or folder in its default application. Use when the user asks to open a file, usually one found by a previous search. Provide the full path.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The full absolute path to the file to open, e.g. 'C:\\\\Users\\\\Jonah\\\\Documents\\\\resume.pdf'.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_events",
    description:
      "List the user's Outlook calendar events. Use when the user asks what's on their calendar, their schedule, or upcoming events. Defaults to today through the next 7 days if no range is given.",
    input_schema: {
      type: "object",
      properties: {
        start_iso: {
          type: "string",
          description:
            "Optional start of the range as an ISO 8601 timestamp, e.g. '2026-07-03T00:00:00'. Defaults to the start of today. Compute from the user's request and the current date/time.",
        },
        end_iso: {
          type: "string",
          description:
            "Optional end of the range as an ISO 8601 timestamp. Defaults to 7 days after the start.",
        },
      },
      required: [],
    },
  },
  {
    name: "create_event",
    description:
      "Create an event on the user's Outlook calendar. Use when the user asks to add, schedule, or put something on their calendar. Compute start and end from the request and the current date/time, the same way reminders are computed.",
    input_schema: {
      type: "object",
      properties: {
        subject: {
          type: "string",
          description: "Title of the event, e.g. 'Lunch with Sam'.",
        },
        start_iso: {
          type: "string",
          description:
            "Event start as an ISO 8601 timestamp, e.g. '2026-07-10T12:00:00'. Compute from the user's request and the current date/time.",
        },
        end_iso: {
          type: "string",
          description:
            "Event end as an ISO 8601 timestamp. If the user gives only a start time, default to one hour after the start.",
        },
        location: {
          type: "string",
          description: "Optional location or meeting place.",
        },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of attendee email addresses to invite.",
        },
      },
      required: ["subject", "start_iso", "end_iso"],
    },
  },
  {
    name: "update_event",
    description:
      "Update an existing Outlook calendar event: reschedule (change start/end), rename (subject), or relocate (location). Requires the event id from a prior list_events result. Only include the fields that change.",
    input_schema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "The id of the event to update, from a prior list_events result.",
        },
        subject: { type: "string", description: "New title, if renaming." },
        start_iso: {
          type: "string",
          description:
            "New start as an ISO 8601 timestamp, if rescheduling. Compute from the request and the current date/time.",
        },
        end_iso: {
          type: "string",
          description:
            "New end as an ISO 8601 timestamp, if rescheduling. Default to one hour after the start if only a start is given.",
        },
        location: { type: "string", description: "New location, if relocating." },
      },
      required: ["event_id"],
    },
  },
  {
    name: "delete_event",
    description:
      "Delete an event from the user's Outlook calendar. Requires the event id from a prior list_events result. Only call this after the user has explicitly confirmed which event to delete; never on a guess.",
    input_schema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "The id of the event to delete, from a prior list_events result.",
        },
      },
      required: ["event_id"],
    },
  },
  {
    name: "transcribe_file",
    description:
      "Transcribe an audio or video file to text using local (on-device) speech-to-text. Use when the user asks to transcribe, get a transcript, or turn audio/video into text. Works on mp3, mp4, wav, m4a, mov, and most media. If no path is given, a file picker opens for the user to choose.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Full path to the audio or video file. Omit to open a file picker for the user to choose a file.",
        },
      },
      required: [],
    },
  },
];

type Message = {
  role: "user" | "intern";
  text: string;
  // When set, the message is a transcript (content, not a command) and renders a
  // copy button that copies this raw text.
  copyText?: string;
};

// UI sinks so runTool (which lives outside the component) can report progress and
// push a message. Registered by the App component on mount.
let uiStatus: ((s: string) => void) | null = null;
let uiPush: ((m: Message) => void) | null = null;

// Copy text to the clipboard; falls back to a hidden textarea when the async
// Clipboard API is unavailable. Returns whether it succeeded.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function pickModel(userText: string): string {
  const t = userText.toLowerCase();
  const longish = userText.length > 240;
  const multiStep =
    t.includes(" and then ") ||
    t.includes(" after that ") ||
    t.includes(" first ") ||
    (t.match(/,/g) || []).length >= 3;
  const reasoningWords =
    t.includes("compare") ||
    t.includes("analyze") ||
    t.includes("figure out") ||
    t.includes("which should") ||
    t.includes("plan ");
  return longish || multiStep || reasoningWords ? OPUS : HAIKU;
}

async function scheduleReminderTask(text: string, due: Date): Promise<string> {
  const taskName = `InternReminder_${due.getTime()}`;

  const hh = String(due.getHours()).padStart(2, "0");
  const mm = String(due.getMinutes()).padStart(2, "0");
  const startTime = `${hh}:${mm}`;
  const startDate = `${String(due.getMonth() + 1).padStart(2, "0")}/${String(
    due.getDate()
  ).padStart(2, "0")}/${due.getFullYear()}`;

  const safeText = text.replace(/"/g, "").slice(0, 200);
  const trCommand = `msg * ${safeText}`;

  const out = await Command.create("schtasks", [
    "/create",
    "/tn",
    taskName,
    "/tr",
    trCommand,
    "/sc",
    "once",
    "/st",
    startTime,
    "/sd",
    startDate,
    "/f",
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`schtasks failed (code ${out.code}): ${out.stderr}`);
  }
  return taskName;
}

async function searchFiles(query: string): Promise<string> {
  const safeQuery = query.replace(/'/g, "").slice(0, 100);

  const script =
    `Get-ChildItem -Path $HOME -Recurse -File -ErrorAction SilentlyContinue ` +
    `-Filter '*${safeQuery}*' | Select-Object -First 15 -ExpandProperty FullName`;

  const out = await Command.create("powershell", [
    "-NoProfile",
    "-Command",
    script,
  ]).execute();

  if (out.code !== 0) {
    return `Search failed: ${out.stderr}`;
  }

  const results = out.stdout.trim();
  if (results === "") {
    return `No files found matching "${query}".`;
  }
  return `Found these files:\n${results}`;
}

async function fireNotification(text: string) {
  let granted = await isPermissionGranted();
  if (!granted) {
    const perm = await requestPermission();
    granted = perm === "granted";
  }
  if (granted) {
    sendNotification({ title: "Intern reminder", body: text });
  }
}

async function runTool(name: string, input: any): Promise<string> {
  if (name === "create_reminder") {
    const due = new Date(input.due_iso);
    const now = new Date();

    if (isNaN(due.getTime())) {
      return `Could not understand the time "${input.due_iso}".`;
    }

    if (due.getTime() <= now.getTime()) {
      await fireNotification(input.text);
      return `That time has passed, so I reminded you now: "${input.text}".`;
    }

    try {
      await scheduleReminderTask(input.text, due);
      return `Reminder scheduled: "${input.text}" for ${due.toLocaleString()}. It will fire even if Intern is closed.`;
    } catch (e) {
      return `Could not schedule the reminder: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (name === "search_files") {
    try {
      return await searchFiles(input.query);
    } catch (e) {
      return `Search failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (name === "open_file") {
    try {
      await openPath(input.path);
      return `Opened: ${input.path}`;
    } catch (e) {
      return `Could not open the file: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (name === "list_events") {
    try {
      const events = await listEvents(input.start_iso, input.end_iso);
      if (events.length === 0) return "No events found in that range.";
      const lines = events.map((e) => {
        const when =
          e.isAllDay && e.end && e.end !== e.start
            ? `${e.start} to ${e.end} (all day)`
            : e.isAllDay
            ? `${e.start} (all day)`
            : `${e.start} to ${e.end}`;
        const loc = e.location ? ` @ ${e.location}` : "";
        return `- [id:${e.id}] ${e.subject}: ${when}${loc}`;
      });
      return `Events:\n${lines.join("\n")}`;
    } catch (e) {
      return `Could not fetch calendar: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (name === "create_event") {
    try {
      return await createEvent({
        subject: input.subject,
        startIso: input.start_iso,
        endIso: input.end_iso,
        location: input.location,
        attendees: input.attendees,
      });
    } catch (e) {
      return `Could not create the event: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (name === "update_event") {
    try {
      return await updateEvent({
        id: input.event_id,
        subject: input.subject,
        startIso: input.start_iso,
        endIso: input.end_iso,
        location: input.location,
      });
    } catch (e) {
      return `Could not update the event: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (name === "delete_event") {
    try {
      return await deleteEvent(input.event_id);
    } catch (e) {
      return `Could not delete the event: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (name === "transcribe_file") {
    try {
      let path: string | undefined = input.path;
      if (!path) {
        const picked = await open({
          multiple: false,
          directory: false,
          title: "Choose audio or video to transcribe",
          filters: [
            {
              name: "Audio/Video",
              extensions: [
                "mp3", "mp4", "wav", "m4a", "mov", "mkv", "flac",
                "ogg", "webm", "avi", "aac", "wma", "wmv",
              ],
            },
          ],
        });
        if (!picked || Array.isArray(picked)) return "No file was selected.";
        path = picked;
      }

      const text = await transcribe(path, (s) => uiStatus?.(s));
      if (!text) return "That file transcribed to empty text (no speech detected).";

      // Show the full transcript directly (it can be long and would otherwise be
      // truncated by the model's max_tokens); Claude just confirms.
      const fileName = path.split(/[\\/]/).pop() || path;
      uiPush?.({ role: "intern", text: `**Transcript** (${fileName}):\n\n${text}`, copyText: text });

      const words = text.split(/\s+/).filter(Boolean).length;
      return `Transcription complete: ${words} words. The full transcript has been shown to the user above; confirm briefly and do not repeat it.`;
    } catch (e) {
      // Log the full error (incl. whisper stderr); return a short, clean message.
      console.error("transcribe_file failed:", e);
      return "The transcription failed. Tell the user to try again.";
    }
  }

  return `Unknown tool: ${name}`;
}

async function askClaude(history: Message[]): Promise<string> {
  const apiMessages: any[] = history.map((m) => ({
    role: m.role === "intern" ? "assistant" : "user",
    content: m.text,
  }));

  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const model = pickModel(lastUser ? lastUser.text : "");

  while (true) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: model,
        max_tokens: 1024,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: TOOLS,
        messages: apiMessages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API ${response.status}: ${err}`);
    }

    const data = await response.json();

    if (data.stop_reason === "tool_use") {
      apiMessages.push({ role: "assistant", content: data.content });

      const toolResults = [];
      for (const block of data.content) {
        if (block.type === "tool_use") {
          const result = await runTool(block.name, block.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result,
          });
        }
      }

      apiMessages.push({ role: "user", content: toolResults });
      continue;
    }

    const textBlock = data.content.find((b: any) => b.type === "text");
    return textBlock ? textBlock.text : "(no response)";
  }
}

type ConnState = "disconnected" | "connecting" | "connected";

// Middle-truncate an email so the domain stays visible, e.g.
// "jonahschwartz521@outlook.com" -> "jonahsch…@outlook.com". Falls back to a
// generic head/tail elision if there's no "@" or the domain alone is too long.
function truncateEmail(email: string, max = 22): string {
  if (email.length <= max) return email;
  const at = email.lastIndexOf("@");
  const genericMiddle = () => {
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    return email.slice(0, head) + "…" + email.slice(email.length - tail);
  };
  if (at === -1) return genericMiddle();
  const local = email.slice(0, at);
  const domain = email.slice(at); // includes "@"
  const budget = max - domain.length - 1; // room for local head + the ellipsis
  if (budget < 1) return genericMiddle(); // domain itself is too long
  return local.slice(0, budget) + "…" + domain;
}

// Stateful Outlook connection control in the titlebar. Reads connection state
// from whether valid tokens exist in the store.
function OutlookStatus() {
  const [state, setState] = useState<ConnState>("disconnected");
  const [account, setAccount] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const syncState = async () => {
    if (await isConnected()) {
      setState("connected");
      let acct = await getAccount();
      if (!acct) {
        // Backfill for sessions connected before the account was stored.
        await refreshAccount();
        acct = await getAccount();
      }
      setAccount(acct);
    } else {
      setState("disconnected");
      setAccount(null);
    }
  };

  useEffect(() => {
    syncState();
  }, []);

  // Close the dropdown when clicking outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const connect = async () => {
    setState("connecting");
    try {
      await login();
      await syncState();
    } catch (e) {
      console.error("Outlook connect failed:", e);
      setState("disconnected");
    }
  };

  const disconnectNow = async () => {
    await disconnect();
    setMenuOpen(false);
    await syncState();
  };

  if (state === "connecting") {
    return <span className="oa-pill oa-connecting">Connecting...</span>;
  }

  if (state === "connected") {
    const label = account ?? "Connected";
    const short = account ? truncateEmail(account) : "Connected";
    return (
      <div className="oa-wrap" ref={wrapRef}>
        <button
          className="oa-pill oa-connected"
          title={label}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <svg
            className="oa-mail"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10z" />
            <path d="M3 7l9 6l9 -6" />
          </svg>
          <span className="oa-email">{short}</span>
          <span className="oa-dot" aria-hidden="true">&#x25CF;</span>
        </button>
        {menuOpen && (
          <div className="oa-menu">
            <button className="oa-menu-item" onClick={disconnectNow}>
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <button className="win-btn oa-connect" onClick={connect} title="Connect Outlook">
      Connect Outlook
    </button>
  );
}

// Resolve the Stereo Mix loopback deviceId for system-audio capture. Unlocks
// device labels with a brief mic grant if they're hidden.
async function findStereoMixId(): Promise<string | null> {
  const pick = (ds: MediaDeviceInfo[]) =>
    ds.find((d) => d.kind === "audioinput" && /stereo mix/i.test(d.label));
  let stereo = pick(await navigator.mediaDevices.enumerateDevices());
  if (!stereo) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    stereo = pick(await navigator.mediaDevices.enumerateDevices());
  }
  return stereo?.deviceId ?? null;
}

// Line icons (Tabler), stroke = currentColor so they follow the button color.
const IconMic = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 2m0 3a3 3 0 0 1 3 -3h0a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3h0a3 3 0 0 1 -3 -3z" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <path d="M8 21l8 0" />
    <path d="M12 17l0 4" />
  </svg>
);
const IconStop = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);
const IconSend = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5l0 14" />
    <path d="M16 9l-4 -4" />
    <path d="M8 9l4 -4" />
  </svg>
);
const IconDots = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);
const IconVolume = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 8a5 5 0 0 1 0 8" />
    <path d="M17.7 5a9 9 0 0 1 0 14" />
    <path d="M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5" />
  </svg>
);
const IconFile = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
    <path d="M9 13l6 0" />
    <path d="M9 17l6 0" />
  </svg>
);
const IconSettings = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
    <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
  </svg>
);

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);

  // Let runTool report progress and push messages into this component.
  useEffect(() => {
    uiStatus = setStatus;
    uiPush = (m) => setMessages((prev) => [...prev, m]);
    return () => {
      uiStatus = null;
      uiPush = null;
    };
  }, []);

  // Close the overflow menu when clicking outside it.
  useEffect(() => {
    if (!rowMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rowMenuRef.current && !rowMenuRef.current.contains(e.target as Node)) {
        setRowMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [rowMenuOpen]);

  useEffect(() => {
    const setup = async () => {
      await register(HOTKEY, async (event: ShortcutEvent) => {
        if (event.state !== "Pressed") return;
        const appWindow = getCurrentWindow();
        const visible = await appWindow.isVisible();
        if (visible) {
          await appWindow.hide();
        } else {
          await appWindow.show();
          await appWindow.setFocus();
        }
      });

      // Enable launch-at-startup once (no-op if already enabled).
      try {
        if (!(await isEnabled())) {
          await enable();
        }
      } catch (e) {
        console.error("autostart setup failed:", e);
      }
    };
    setup();
    return () => {
      unregister(HOTKEY);
    };
  }, []);

  const handleCopy = async (text: string, idx: number) => {
    if (await copyToClipboard(text)) {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
    }
  };

  // Overflow menu action: transcribe a file. Opens the picker and runs the same
  // whisper path as the transcribe_file tool; content goes to a transcript bubble.
  const transcribeFileFromMenu = async () => {
    setRowMenuOpen(false);
    const picked = await open({
      multiple: false,
      directory: false,
      title: "Choose audio or video to transcribe",
      filters: [
        {
          name: "Audio/Video",
          extensions: [
            "mp3", "mp4", "wav", "m4a", "mov", "mkv", "flac",
            "ogg", "webm", "avi", "aac", "wma", "wmv",
          ],
        },
      ],
    });
    if (!picked || Array.isArray(picked)) return;
    const path = picked;
    setThinking(true);
    setStatus("Transcribing...");
    try {
      const text = (await transcribe(path, (s) => setStatus(s))).trim();
      const fileName = path.split(/[\\/]/).pop() || path;
      if (text) {
        setMessages((prev) => [
          ...prev,
          { role: "intern", text: `**Transcript** (${fileName}):\n\n${text}`, copyText: text },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "intern", text: "That file transcribed to empty text (no speech detected)." },
        ]);
      }
    } catch (e) {
      console.error("transcribe file (menu) failed:", e);
      setMessages((prev) => [
        ...prev,
        { role: "intern", text: "Transcription failed, try again." },
      ]);
    } finally {
      setThinking(false);
      setStatus("");
    }
  };

  const handleMinimize = () => {
    getCurrentWindow().minimize();
  };

  const handleClose = () => {
    getCurrentWindow().hide();
  };

  // Transcribe the recording. Mic input is a command → goes to the input box for
  // review/send. System audio is captured content → goes to a transcript bubble.
  // Never auto-sends. Temp file is cleaned up after.
  const handleRecordedAudio = async (blob: Blob, src: "mic" | "system") => {
    if (blob.size < MIN_AUDIO_BYTES) {
      setMessages((prev) => [
        ...prev,
        { role: "intern", text: "Didn't catch any audio, try again." },
      ]);
      return;
    }
    setThinking(true);
    setStatus("Transcribing...");
    let tempPath: string | undefined;
    try {
      tempPath = await writeTempAudio(blob);
      const text = (await transcribe(tempPath, (s) => setStatus(s))).trim();
      if (!text) {
        setMessages((prev) => [
          ...prev,
          { role: "intern", text: "I didn't catch any speech in that recording." },
        ]);
      } else if (src === "mic") {
        setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
        inputRef.current?.focus();
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "intern", text: `**Transcript** (system audio):\n\n${text}`, copyText: text },
        ]);
      }
    } catch (e) {
      // Log the full error (incl. whisper stderr) for debugging; never show it.
      console.error("transcription failed:", e);
      setMessages((prev) => [
        ...prev,
        { role: "intern", text: "Transcription failed, try again." },
      ]);
    } finally {
      if (tempPath) {
        try {
          await removeTempAudio(tempPath);
        } catch (err) {
          console.warn("temp cleanup failed", err);
        }
      }
      setThinking(false);
      setStatus("");
    }
  };

  // Start a recording from the given source. Voice uses the default mic; system
  // audio taps the Stereo Mix loopback device. The record button reflects the
  // recording state and stops it; on stop the clip is transcribed.
  const startRecording = async (src: "mic" | "system") => {
    if (recording) return;
    setRowMenuOpen(false);
    try {
      let constraints: MediaStreamConstraints = { audio: true };
      if (src === "system") {
        const deviceId = await findStereoMixId();
        if (!deviceId) {
          setMessages((prev) => [
            ...prev,
            { role: "intern", text: "System audio source (Stereo Mix) not found. Enable Stereo Mix in Windows sound settings." },
          ]);
          return;
        }
        constraints = { audio: { deviceId: { exact: deviceId } } };
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // Record as mp4/AAC, which Media Foundation (whisper's decoder) reads
      // directly, so no conversion step is needed. Fall back to the browser
      // default on any Windows setup that can't record mp4.
      let mr: MediaRecorder;
      if (MediaRecorder.isTypeSupported("audio/mp4")) {
        mr = new MediaRecorder(stream, { mimeType: "audio/mp4" });
      } else {
        console.warn("[voice] audio/mp4 unsupported here; falling back to default recorder format");
        mr = new MediaRecorder(stream);
      }
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const type = mr.mimeType || chunksRef.current[0]?.type || "audio/webm";
        await handleRecordedAudio(new Blob(chunksRef.current, { type }), src);
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
    } catch (e) {
      setRecording(false);
      setMessages((prev) => [
        ...prev,
        { role: "intern", text: `Mic error: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    }
  };

  // Record button: stop if recording, otherwise start a voice recording.
  const toggleMic = () => {
    if (recording) mediaRecorderRef.current?.stop();
    else startRecording("mic");
  };

  const openSettings = () => {
    setRowMenuOpen(false);
    setMessages((prev) => [
      ...prev,
      { role: "intern", text: "Settings are not available yet." },
    ]);
  };

  const send = async () => {
    const text = input.trim();
    if (text === "") return;

    const newHistory: Message[] = [...messages, { role: "user", text }];
    setMessages(newHistory);
    setInput("");
    setThinking(true);

    try {
      const reply = await askClaude(newHistory);
      setMessages((prev) => [...prev, { role: "intern", text: reply }]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "intern", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
      ]);
    } finally {
      setThinking(false);
      setStatus("");
    }
  };

  return (
    <main className="container">
      <header className="titlebar" data-tauri-drag-region>
        <span className="brand">Intern</span>
        <div className="window-controls">
          <OutlookStatus />
          <button className="win-btn" onClick={handleMinimize} title="Minimize">
            &#x2013;
          </button>
          <button className="win-btn win-close" onClick={handleClose} title="Hide to tray">
            &#x2715;
          </button>
        </div>
      </header>
      <div className="history">
        {messages.length === 0 && (
          <div className="empty">Ask Intern to do something.</div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.role}`}>
            {msg.role === "intern" ? (
              <div className="md">
                {msg.copyText != null && (
                  <div className="transcript-head">
                    <button className="copy-btn" onClick={() => handleCopy(msg.copyText!, i)}>
                      {copiedIdx === i ? "Copied" : "Copy"}
                    </button>
                  </div>
                )}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    // Open links in the system browser; a bare <a> click would
                    // navigate the webview away and blank the app.
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (href) openUrl(href);
                        }}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {msg.text}
                </ReactMarkdown>
              </div>
            ) : (
              msg.text
            )}
          </div>
        ))}
        {thinking && (
          <div className="message intern thinking">{status || "..."}</div>
        )}
      </div>
      <div className="input-row">
        <button
          className={`mic-btn${recording ? " recording" : ""}`}
          onClick={toggleMic}
          title={recording ? "Stop recording" : "Record voice"}
        >
          {recording ? <IconStop /> : <IconMic />}
        </button>
        <div className="menu-wrap" ref={rowMenuRef}>
          <button
            className="menu-btn"
            onClick={() => setRowMenuOpen((o) => !o)}
            title="More"
          >
            <IconDots />
          </button>
          {rowMenuOpen && (
            <div className="row-menu">
              <button className="row-menu-item" onClick={() => startRecording("system")} disabled={recording}>
                <IconVolume /> System audio
              </button>
              <button className="row-menu-item" onClick={transcribeFileFromMenu}>
                <IconFile /> Transcribe file
              </button>
              <button className="row-menu-item" onClick={openSettings}>
                <IconSettings /> Settings
              </button>
            </div>
          )}
        </div>
        <input
          ref={inputRef}
          className="input"
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="Ask Intern..."
          autoFocus
        />
        <button
          className="send-btn"
          onClick={send}
          disabled={input.trim() === ""}
          title="Send"
        >
          <IconSend />
        </button>
      </div>
    </main>
  );
}

export default App;
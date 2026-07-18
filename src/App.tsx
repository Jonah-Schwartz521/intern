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
import { createDraft } from "./mail";
import { writeTempAudio, removeTempAudio } from "./voice";
import { summonWindow } from "./summon";
import { isSupportedLang, highlightCode } from "./highlight";
import {
  assembleContextForRequest,
  addFiles,
  removeFile,
  listFiles,
  pickContextFiles,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  type ContextFile,
} from "./contextBin";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import {
  type Message,
  type Session,
  newSessionId,
  loadSessions,
  getCurrentId,
  setCurrentId,
  saveSession,
  deleteSession,
  listSessions,
  sessionTitle,
  formatSessionTime,
} from "./session";
import "./App.css";

const HOTKEY = "CmdOrCtrl+Shift+Space";

// Recordings smaller than this are treated as empty (an accidental tap or no
// audio), and skipped before hitting whisper.
const MIN_AUDIO_BYTES = 2048;

// Cap on how much clipboard text is sent to the model. Long enough for a stack
// trace, a config file, or an article; short enough that a stray copy of a huge
// document does not blow up the token bill.
const MAX_CLIPBOARD_CHARS = 8000;

// How close to the bottom of the stream still counts as "at the bottom", both
// for following new content and for hiding the jump button.
const NEAR_BOTTOM_PX = 64;

const HAIKU = "claude-haiku-4-5-20251001";
const OPUS = "claude-opus-4-8";

const SYSTEM_PROMPT = `You are Splerm, the reasoning engine behind a desktop quick-task assistant.

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
- To draft an email, always call draft_email with a COMPLETE first-pass draft: a specific subject line AND a full, ready-to-edit body written from the request, with all fields prefilled. Never open a blank draft and never ask the user field by field. If you cannot identify the recipient's email address, still draft the subject and body and leave 'to' empty for the user to fill in. Only ask a question first when the request is too vague to draft anything meaningful from. After calling it, just tell the user to review and click Create draft; do not repeat the draft text.
- THE CLIPBOARD IS THE DEFAULT REFERENT. This is a hard rule, not a preference. If the user's message contains a demonstrative ("this", "that", "it", "these", "those") and nothing earlier in the conversation is clearly what it points at, they mean whatever they just copied. ALWAYS call read_clipboard first, before saying anything. Examples that must always call it: "format this", "explain this error", "summarize this", "what's wrong with this code", "fix the grammar in this", "what does this do", "clean it up". Never respond to a demonstrative by asking what they mean ("what do you want me to format?", "what should I look at?", "please paste it"); read the clipboard and act on it. The only case where you skip read_clipboard is when the referent is unmistakably already in the conversation: a file you just found, an event you just listed, a draft you just wrote.
- read_clipboard is stateless. Every call reads the clipboard fresh and returns exactly what is on it at that moment. It has no memory, no cache, and no way to tell whether the contents changed since a previous call. So never talk about the clipboard being unchanged, stale, or having "nothing new"; if the tool returns text, act on that text, even when it is identical to something you read earlier in the conversation.
- When your reply IS content the user will take somewhere else (reformatted JSON, rewritten or corrected text, fixed code), return that content on its own in a single fenced code block, with at most one short lead-in line and no commentary after it. Plain answers, explanations, and summaries stay as normal prose with no code fence.
- Act like a sharp junior assistant: fast, low-friction, no over-explaining.
- Never use em dashes in your responses. Use commas, colons, or parentheses instead.`;

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
  {
    name: "read_clipboard",
    description:
      "Read whatever text is on the user's clipboard right now. Stateless: each call re-reads the clipboard and returns its current contents. There is no cache, no history, and no change detection, so this tool cannot tell you whether the contents are new or the same as before; it just returns the text. ALWAYS call it when the user's message contains a demonstrative ('this', 'that', 'it', 'these') that nothing earlier in the conversation clearly explains: 'format this', 'explain this error', 'summarize this', 'what's wrong with this code', 'fix the grammar in this', 'what does this do'. The clipboard is the default referent for those words. Call it instead of asking the user what they mean or asking them to paste.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "draft_email",
    description:
      "Draft an email for the user to review before it is created in Outlook. Use when the user asks to draft, write, or compose an email. Generate the recipient, a specific subject, and a COMPLETE first-pass body from the request, and prefill all three. Always draft; do not interrogate the user field by field. Only ask a clarifying question if something is genuinely unresolvable (for example a recipient you cannot identify), in which case leave 'to' blank for the user to fill in. This does NOT send or create the draft; it opens an editable compose card the user completes.",
    input_schema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "Recipient email address(es), comma-separated. Fill this in when you know the address; if the user gave only a name you cannot resolve to an address, leave it blank for the user to complete in the card.",
        },
        subject: {
          type: "string",
          description: "A concise, specific subject line drafted from the request.",
        },
        body: {
          type: "string",
          description:
            "The complete first-pass email body drafted from the request, ready for the user to edit. Write the full message, not a placeholder.",
        },
      },
      required: ["subject", "body"],
    },
  },
];

// UI sinks so runTool (which lives outside the component) can report progress and
// push a message. Registered by the App component on mount.
let uiStatus: ((s: string) => void) | null = null;
let uiPush: ((m: Message) => void) | null = null;
// Transient warning sink (context-bin over budget, etc.). Registered by the App
// component; routed to the same inline notice bar used for command notices.
let uiWarn: ((s: string) => void) | null = null;

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

// The model keeps emitting em dashes despite the system-prompt rule, so strip
// them deterministically from anything Claude generates before it reaches the
// UI. Project rule: no em dashes ever. Replaces em dash (and the horizontal bar)
// plus surrounding whitespace with a comma.
function stripEmDashes(text: string): string {
  return text.replace(/\s*[—―]\s*/g, ", ");
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
  // Drafting an email means writing a full body from scratch; use the stronger
  // model so the compose card comes up with a complete, well-written draft.
  const emailDraft =
    (t.includes("email") || t.includes("e-mail")) &&
    (t.includes("draft") ||
      t.includes("write") ||
      t.includes("compose") ||
      t.includes("reply") ||
      t.includes("respond"));
  return longish || multiStep || reasoningWords || emailDraft ? OPUS : HAIKU;
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
    sendNotification({ title: "Splerm reminder", body: text });
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
      return `Reminder scheduled: "${input.text}" for ${due.toLocaleString()}. It will fire even if Splerm is closed.`;
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

  if (name === "read_clipboard") {
    let text: string | null;
    try {
      text = await readText();
    } catch (e) {
      // The plugin throws when the clipboard holds something that is not text
      // (an image, a file, a copied cell range). That is not an error worth
      // dumping, so answer plainly.
      console.error("read_clipboard failed:", e);
      return "The clipboard does not have any text on it right now. Tell the user that, in one line.";
    }
    if (!text || !text.trim()) {
      return "The clipboard is empty. Tell the user that, in one line.";
    }
    if (text.length > MAX_CLIPBOARD_CHARS) {
      return `Clipboard contents, read just now (truncated to the first ${MAX_CLIPBOARD_CHARS} characters of ${text.length}). Act on this:\n\n${text.slice(
        0,
        MAX_CLIPBOARD_CHARS
      )}`;
    }
    return `Clipboard contents, read just now. Act on this:\n\n${text}`;
  }

  if (name === "draft_email") {
    uiPush?.({
      role: "intern",
      text: "",
      draft: {
        to: typeof input.to === "string" ? input.to : "",
        subject: typeof input.subject === "string" ? stripEmDashes(input.subject) : "",
        body: typeof input.body === "string" ? stripEmDashes(input.body) : "",
      },
    });
    return "An editable email compose card has been shown to the user. Do not repeat the draft; briefly tell them to review it and click Create draft.";
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

// Final request layout, and where the cache boundaries fall. The Anthropic API
// builds its cache prefix in a FIXED order regardless of how we order our code:
// tools -> system -> messages. So the cached prefix is:
//
//   [ tools: TOOLS ]                          <- static tool defs
//   [ system[0]: SYSTEM_PROMPT ]  cache_control  <- breakpoint A: caches tools + base instructions
//   [ system[1]: <context_file> block ]  cache_control  <- breakpoint B: caches tools + base + context bin
//   ----------------------------- cache boundary -----------------------------
//   [ messages: conversation ]                <- per-call, NEVER cached
//
// Two breakpoints on purpose: A keeps tools + base instructions cached even when
// the bin changes (they never change), and B extends the cache through the
// context block. Adding/removing a bin file only invalidates from B onward, so
// the base prefix keeps hitting. On repeat calls the whole static prefix bills at
// the cache-read rate. The user's per-call message sits in `messages`, outside
// every breakpoint, so it is never cached. When the bin is empty there is no
// system[1] and the shape is identical to before this feature (single breakpoint).
async function askClaude(history: Message[]): Promise<string> {
  const apiMessages: any[] = history.map((m) => ({
    role: m.role === "intern" ? "assistant" : "user",
    content: m.text,
  }));

  const lastUser = [...history].reverse().find((m) => m.role === "user");
  // Model routing is unchanged: the context bin applies to whichever model
  // pickModel lands on (Haiku or Opus), since it is part of the shared system.
  const model = pickModel(lastUser ? lastUser.text : "");

  // Assemble the context bin once per turn (it does not change across tool-use
  // iterations). Over budget we do NOT silently send: warn the user and log the
  // overage, then send anyway.
  const context = await assembleContextForRequest();
  if (context.overage) {
    const msg =
      `Context bin is ${context.overage.totalTokens.toLocaleString()} tokens, ` +
      `over the ${context.overage.budget.toLocaleString()} budget. Sending anyway; ` +
      `remove files to cut cost.`;
    console.warn(`[context-bin] ${msg}`);
    uiWarn?.(msg);
  }

  // Static, cached system segments in order: base instructions, then the context
  // block (only when the bin is non-empty). Both carry a cache_control breakpoint.
  const system: any[] = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  ];
  if (context.block) {
    system.push({
      type: "text",
      text: context.block,
      cache_control: { type: "ephemeral" },
    });
  }

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
        // Reformatting or rewriting a clipboard payload echoes it back, so 1024
        // was low enough to cut a mid-size JSON blob off. Output bills per token
        // actually generated, so a higher cap costs nothing on short answers.
        max_tokens: 2048,
        system,
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
    return textBlock ? stripEmDashes(textBlock.text) : "(no response)";
  }
}

// Generate a short 3-5 word title for a conversation via Haiku. Deliberately
// cheap: no tools, no big cached system prompt, tiny max_tokens, and only the
// opening turns (trimmed) are sent. Returns null on any failure so the caller
// just keeps the placeholder title. Cost per conversation: one small Haiku call.
async function generateTitle(history: Message[]): Promise<string | null> {
  const transcript = history
    .slice(0, 6)
    .map((m) => `${m.role === "intern" ? "Splerm" : "User"}: ${m.text.slice(0, 300)}`)
    .join("\n");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: HAIKU,
        max_tokens: 16,
        system:
          "Write a 3 to 5 word title summarizing the conversation. Reply with only the title: no quotes, no trailing punctuation, no emojis.",
        messages: [{ role: "user", content: transcript }],
      }),
    });

    if (!response.ok) {
      console.error("title API", response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const block = data.content?.find((b: any) => b.type === "text");
    let title: string = block?.text ?? "";
    title = stripEmDashes(title)
      .trim()
      .replace(/^["']+|["']+$/g, "")
      .replace(/[.]+$/, "")
      .trim();
    if (title.length > 60) title = title.slice(0, 60).trim();
    return title || null;
  } catch (e) {
    console.error("title generation request failed:", e);
    return null;
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
  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path transform="rotate(-45 12 12)" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" />
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
const IconPlus = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5l0 14" />
    <path d="M5 12l14 0" />
  </svg>
);
const IconHistory = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 8l0 4l2 2" />
    <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5" />
  </svg>
);
const IconArrowDown = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5l0 14" />
    <path d="M18 13l-6 6" />
    <path d="M6 13l6 6" />
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
const IconChevron = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6l6 -6" />
  </svg>
);
const IconX = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 6l-12 12" />
    <path d="M6 6l12 12" />
  </svg>
);
const IconSettings = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
    <path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />
  </svg>
);
// Inline email compose card. Prefilled from Claude's draft; the user edits the
// fields here and the edited values are what get sent to createDraft.
function ComposeCard({
  initial,
  onCreate,
}: {
  initial: { to: string; subject: string; body: string };
  onCreate: (fields: { to: string; subject: string; body: string }) => Promise<void>;
}) {
  const [to, setTo] = useState(initial.to);
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [status, setStatus] = useState<"idle" | "creating" | "created">("idle");
  const [error, setError] = useState("");

  const create = async () => {
    setStatus("creating");
    setError("");
    try {
      await onCreate({ to, subject, body });
      setStatus("created");
    } catch (e) {
      console.error("create draft failed:", e);
      setStatus("idle");
      setError("Could not create the draft. Try again.");
    }
  };

  const done = status === "created";
  return (
    <div className="compose-card">
      <label className="compose-label">To</label>
      <input
        className="compose-field"
        value={to}
        onChange={(e) => setTo(e.currentTarget.value)}
        disabled={done}
        placeholder="name@example.com"
      />
      <label className="compose-label">Subject</label>
      <input
        className="compose-field"
        value={subject}
        onChange={(e) => setSubject(e.currentTarget.value)}
        disabled={done}
      />
      <label className="compose-label">Body</label>
      <textarea
        className="compose-field compose-body"
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
        disabled={done}
      />
      {error && <div className="compose-error">{error}</div>}
      <div className="compose-actions">
        <button className="compose-create" onClick={create} disabled={status !== "idle"}>
          {done ? "Draft created" : status === "creating" ? "Creating..." : "Create draft"}
        </button>
      </div>
    </div>
  );
}

// Collapsible Context panel: the reference files fed to the model as steering
// context. Lives below the titlebar as part of the one window (not a modal / not
// a separate view). Filenames + token counts render monospace; labels sans.
function ContextPanel({
  open,
  onToggle,
  files,
  busy,
  dragOver,
  onAdd,
  onRemove,
}: {
  open: boolean;
  onToggle: () => void;
  files: ContextFile[];
  busy: boolean;
  dragOver: boolean;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  const total = files.reduce((sum, f) => sum + f.tokenCount, 0);
  const budget = DEFAULT_CONTEXT_TOKEN_BUDGET;
  // Color the running total only once it matters: amber approaching the budget,
  // red once over it. Neutral (dim) while there is plenty of headroom.
  const tokenState = total > budget ? "over" : total >= budget * 0.8 ? "warn" : "ok";

  return (
    <section className={`context-panel${dragOver ? " drag-over" : ""}`}>
      <button
        className="ctx-head"
        onClick={onToggle}
        aria-expanded={open}
        title={`Context bin: ${total.toLocaleString()} / ${budget.toLocaleString()} token budget`}
      >
        <span className="ctx-head-left">
          <span className={`ctx-chevron${open ? " open" : ""}`}>
            <IconChevron />
          </span>
          <span className="ctx-title">Context</span>
        </span>
        <span className={`ctx-summary ctx-tokens-${tokenState}`}>
          {files.length === 0
            ? "empty"
            : `${files.length} file${files.length === 1 ? "" : "s"} · ${total.toLocaleString()} tokens`}
        </span>
      </button>
      {open && (
        <div className="ctx-body">
          <div className={`ctx-dropzone${dragOver ? " over" : ""}`}>
            <span className="ctx-drop-hint">Drop files here</span>
            <button className="ctx-add-btn" onClick={onAdd} disabled={busy}>
              <IconPlus /> Add files
            </button>
          </div>
          {files.length === 0 ? (
            <p className="ctx-empty">
              Add reference files (.txt, .md, .pdf, .docx) and Splerm steers its
              answers with your own material on every request.
            </p>
          ) : (
            <ul className="ctx-list">
              {files.map((f) => (
                <li key={f.id} className="ctx-file">
                  <span className="ctx-file-name" title={f.path}>
                    {f.filename}
                  </span>
                  <span className="ctx-file-tokens">
                    {f.tokenCount.toLocaleString()} tok
                  </span>
                  <button
                    className="ctx-remove"
                    onClick={() => onRemove(f.id)}
                    title="Remove"
                    aria-label={`Remove ${f.filename}`}
                  >
                    <IconX />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {busy && <div className="ctx-busy">Reading files...</div>}
        </div>
      )}
    </section>
  );
}

// A fenced code block in the chat: a header row (language label left, Copy
// right) over Shiki-highlighted code. The language comes from the markdown fence
// (```ts, ```python). With no language, or one Shiki has no grammar for, it
// renders as plain text with no highlighting and no label (we do not guess).
function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canHighlight = lang != null && isSupportedLang(lang);

  useEffect(() => {
    if (!canHighlight) {
      setHtml(null);
      return;
    }
    // Highlight asynchronously (the grammar may need to load); until it resolves
    // the plain fallback below shows, so code is readable immediately. `alive`
    // drops a result that lands after the block changed or unmounted.
    let alive = true;
    highlightCode(code, lang!)
      .then((h) => alive && setHtml(h))
      .catch(() => alive && setHtml(null));
    return () => {
      alive = false;
    };
  }, [code, lang, canHighlight]);

  const copy = async () => {
    if (await copyToClipboard(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <div className="code-block">
      <div className="code-head">
        {lang && <span className="code-lang">{lang}</span>}
        <button className="copy-btn code-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {html ? (
        <div className="code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-body code-plain">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  // Stage 2: the inline /resume list (null when closed) and a transient one-line
  // notice for command feedback (e.g. unknown command). Neither is persisted.
  const [resumeSessions, setResumeSessions] = useState<Session[] | null>(null);
  const [notice, setNotice] = useState("");
  // /clear is destructive and unrecoverable, so it asks first: this holds the
  // pending confirmation, shown inline in the stream.
  const [confirmClear, setConfirmClear] = useState(false);
  // Whether the stream is scrolled to (or near) the bottom. Drives both the
  // follow-on-new-content behavior and the jump-to-bottom button.
  const [atBottom, setAtBottom] = useState(true);
  // Command palette: highlighted row and whether the user dismissed it (Escape)
  // for the current draft. Which commands show is derived from the registry.
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  // Context bin: the collapsible panel's open state, the ingested files (source
  // of truth on disk, mirrored here for the list), a busy flag during ingestion,
  // and whether a file drag is currently hovering the window.
  const [contextOpen, setContextOpen] = useState(false);
  const [contextFiles, setContextFiles] = useState<ContextFile[]>([]);
  const [contextBusy, setContextBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowMenuRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  // Same value as `atBottom`, readable from effects without making them depend
  // on it (a dependency would re-fire the follow when the flag flips).
  const atBottomRef = useRef(true);
  // Persistence: the current conversation's id and creation time. loadedRef gates
  // saving until the initial restore is done, so we never clobber saved history
  // with the empty starting state.
  const sessionIdRef = useRef<string>("");
  const createdAtRef = useRef<number>(0);
  const loadedRef = useRef(false);
  // Snapshot of the last-persisted messages so restoring on launch (or any
  // no-op render) does not rewrite the session and bump its timestamp.
  const lastSavedRef = useRef<string>("");
  // Stage 3: the current conversation's generated title (cached, never
  // regenerated) and a flag so we only fire one title request at a time.
  const titleRef = useRef<string | undefined>(undefined);
  const titleBusyRef = useRef(false);
  // Always-current messages, so async work (title generation) persists the
  // latest state instead of a stale snapshot captured when it started.
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  // Let runTool report progress and push messages into this component.
  useEffect(() => {
    uiStatus = setStatus;
    uiPush = (m) => setMessages((prev) => [...prev, m]);
    uiWarn = setNotice;
    return () => {
      uiStatus = null;
      uiPush = null;
      uiWarn = null;
    };
  }, []);

  // On launch, restore the last active conversation from disk. If there is none,
  // start a fresh session and mark it current.
  useEffect(() => {
    (async () => {
      try {
        const curId = await getCurrentId();
        if (curId) {
          const all = await loadSessions();
          const cur = all[curId];
          if (cur) {
            sessionIdRef.current = cur.id;
            createdAtRef.current = cur.createdAt;
            titleRef.current = cur.title;
            lastSavedRef.current = JSON.stringify(cur.messages);
            setMessages(cur.messages);
            loadedRef.current = true;
            return;
          }
        }
        const id = newSessionId();
        sessionIdRef.current = id;
        createdAtRef.current = Date.now();
        await setCurrentId(id);
      } catch (e) {
        console.error("session restore failed:", e);
        sessionIdRef.current = sessionIdRef.current || newSessionId();
        createdAtRef.current = createdAtRef.current || Date.now();
      } finally {
        loadedRef.current = true;
      }
    })();
  }, []);

  // Persist the conversation whenever it changes. Skipped until the initial
  // restore finishes, and for empty conversations so throwaway sessions do not
  // litter the store.
  useEffect(() => {
    if (!loadedRef.current || !sessionIdRef.current || messages.length === 0) return;
    const snapshot = JSON.stringify(messages);
    if (snapshot === lastSavedRef.current) return;
    lastSavedRef.current = snapshot;
    const session: Session = {
      id: sessionIdRef.current,
      createdAt: createdAtRef.current,
      updatedAt: Date.now(),
      title: titleRef.current,
      messages,
    };
    saveSession(session).catch((e) => console.error("session save failed:", e));
  }, [messages]);

  // Generate a short title once a conversation has real substance (3+ messages).
  // Cached on the session and never regenerated, so throwaway chats stay
  // untitled and each conversation costs at most one tiny Haiku call.
  useEffect(() => {
    if (!loadedRef.current || titleRef.current || titleBusyRef.current) return;
    if (messages.length < 3 || !sessionIdRef.current) return;
    const sid = sessionIdRef.current;
    titleBusyRef.current = true;
    (async () => {
      try {
        const title = await generateTitle(messagesRef.current);
        // Bail if the user switched conversations while we were waiting.
        if (!title || sessionIdRef.current !== sid) return;
        titleRef.current = title;
        // Save the latest messages (not a stale snapshot) with the new title.
        const latest = messagesRef.current;
        await saveSession({
          id: sid,
          createdAt: createdAtRef.current,
          updatedAt: Date.now(),
          title,
          messages: latest,
        });
        lastSavedRef.current = JSON.stringify(latest);
      } catch (e) {
        console.error("title generation failed:", e);
      } finally {
        titleBusyRef.current = false;
      }
    })();
  }, [messages]);

  // Jump the stream to the bottom. Instant by default (following new content
  // should feel like the content just landed there, not like an animation);
  // smooth when the user asks for it via the button.
  const scrollToBottom = (smooth = false) => {
    const el = historyRef.current;
    if (!el) return;
    atBottomRef.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  // Re-arm the follow, so whatever this action appends pulls the view down with
  // it. Call this for anything the USER just did (sending a message, running a
  // command, switching conversations): they acted, so they want to see the
  // result, wherever they had scrolled to. The actual scroll happens in the
  // follow effect once the new content is in the DOM.
  const stickToBottom = () => {
    atBottomRef.current = true;
    setAtBottom(true);
  };

  // Track how close to the bottom the user is. Near enough counts as at the
  // bottom, so a stray pixel or a partially-scrolled last line does not read as
  // "the user scrolled up to read something".
  const onHistoryScroll = () => {
    const el = historyRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distance <= NEAR_BOTTOM_PX;
    atBottomRef.current = near;
    setAtBottom(near);
  };

  // Follow new content, if the follow is armed. Two ways it gets armed: the user
  // is already near the bottom (passive arrivals, like a reply or a background
  // result, keep up with them), or they just did something (stickToBottom), in
  // which case they see the result no matter where they had scrolled to. What
  // this deliberately does NOT do is yank a user who scrolled up to read while a
  // reply was in flight. Runs after the DOM is updated and before paint, so
  // scrollHeight already includes the new content.
  useEffect(() => {
    const el = historyRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, status, resumeSessions, notice]);

  // Exception: the /clear confirmation asks a question, so it always scrolls
  // into view, wherever the user happens to be.
  useEffect(() => {
    if (confirmClear) scrollToBottom(true);
  }, [confirmClear]);

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

  // Focus the input so the user can type the moment the window appears. The
  // webview only takes keyboard focus after the OS hands the window focus back,
  // so the first attempt can land too early: retry once on the next frame.
  const focusInput = () => {
    inputRef.current?.focus();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  useEffect(() => {
    const setup = async () => {
      await register(HOTKEY, async (event: ShortcutEvent) => {
        if (event.state !== "Pressed") return;
        const appWindow = getCurrentWindow();
        const visible = await appWindow.isVisible();
        if (visible) {
          await appWindow.hide();
        } else {
          await summonWindow();
          focusInput();
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

  // Reload the context bin from disk into the list. Cheap (a single store read),
  // called after every add/remove so the panel stays in sync with the source.
  const refreshContext = async () => {
    setContextFiles(await listFiles());
  };

  // Ingest a set of paths (from the picker or a drop) through the prompt-1
  // ingestion module. Unsupported/empty files come back as skips, which we
  // surface in the inline notice bar rather than failing silently.
  const ingestPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    setContextOpen(true);
    setContextBusy(true);
    try {
      const { skipped } = await addFiles(paths);
      await refreshContext();
      if (skipped.length > 0) {
        const detail = skipped
          .map((s) => `${s.path.split(/[\\/]/).pop()} (${s.reason})`)
          .join("; ");
        setNotice(`Skipped ${skipped.length}: ${detail}`);
      } else {
        setNotice("");
      }
    } catch (e) {
      setNotice(`Could not add files: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setContextBusy(false);
    }
  };

  const addContextFiles = async () => {
    await ingestPaths(await pickContextFiles());
  };

  const removeContextFile = async (id: string) => {
    await removeFile(id);
    await refreshContext();
  };

  // Load the bin on launch, and wire native OS file drops (Tauri gives real
  // filesystem paths here, which DOM drop events do not). A drag over the window
  // opens the panel so the drop target is visible; the drop ingests the paths.
  useEffect(() => {
    void refreshContext();
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setContextOpen(true);
          setDragOver(true);
        } else if (p.type === "drop") {
          setDragOver(false);
          void ingestPaths(p.paths);
        } else {
          setDragOver(false);
        }
      })
      .then((u) => {
        unlisten = u;
      });
    return () => {
      unlisten?.();
    };
  }, []);

  const openSettings = () => {
    setRowMenuOpen(false);
    setMessages((prev) => [
      ...prev,
      { role: "intern", text: "Settings are not available yet." },
    ]);
  };

  // Create the Outlook draft from the compose card's (edited) fields, then open
  // it in Outlook via its webLink. Throws on failure so the card can surface it.
  const handleCreateDraft = async (fields: { to: string; subject: string; body: string }) => {
    const to = fields.to.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const webLink = await createDraft({ subject: fields.subject, body: fields.body, to });
    if (webLink) await openUrl(webLink);
  };

  // Persist the current conversation to the store if it has content and differs
  // from what was last saved. Shared by the new-conversation and resume flows so
  // switching away never loses in-progress work.
  const persistCurrent = async () => {
    if (messages.length === 0 || !sessionIdRef.current) return;
    const snapshot = JSON.stringify(messages);
    if (snapshot === lastSavedRef.current) return;
    lastSavedRef.current = snapshot;
    await saveSession({
      id: sessionIdRef.current,
      createdAt: createdAtRef.current,
      updatedAt: Date.now(),
      title: titleRef.current,
      messages,
    });
  };

  // Start a fresh conversation. CRITICAL: save the current one first so nothing
  // in progress is lost, then clear the view onto a brand new session.
  const startNewConversation = async () => {
    setRowMenuOpen(false);
    setConfirmClear(false);
    stickToBottom();
    await persistCurrent();
    const id = newSessionId();
    sessionIdRef.current = id;
    createdAtRef.current = Date.now();
    titleRef.current = undefined;
    lastSavedRef.current = "";
    await setCurrentId(id);
    setMessages([]);
    setInput("");
    setResumeSessions(null);
    setNotice("");
  };

  // Open the inline list of saved conversations. Excludes the one we are in and
  // any empty sessions.
  const openResumeList = async () => {
    setRowMenuOpen(false);
    setNotice("");
    setConfirmClear(false);
    stickToBottom();
    await persistCurrent();
    const all = await listSessions();
    setResumeSessions(
      all.filter((s) => s.id !== sessionIdRef.current && s.messages.length > 0),
    );
  };

  // Load a saved conversation into the view. Saves the current one first (same
  // reason as new-conversation) before switching.
  const loadConversation = async (sess: Session) => {
    setConfirmClear(false);
    // A conversation switch always lands on the newest message, even if the user
    // was scrolled up in the outgoing one.
    stickToBottom();
    await persistCurrent();
    sessionIdRef.current = sess.id;
    createdAtRef.current = sess.createdAt;
    titleRef.current = sess.title;
    lastSavedRef.current = JSON.stringify(sess.messages);
    await setCurrentId(sess.id);
    setMessages(sess.messages);
    setResumeSessions(null);
    setNotice("");
  };

  // Ask before wiping. Unlike /new, a clear does not save the conversation, so
  // there is no undo and no /resume entry to go back to.
  const requestClear = () => {
    setRowMenuOpen(false);
    setResumeSessions(null);
    setNotice("");
    if (messages.length === 0) {
      setNotice("Nothing to clear, this conversation is already empty.");
      return;
    }
    setConfirmClear(true);
  };

  // Confirmed clear. Autosave has almost certainly already written this
  // conversation to the store, so the record is deleted, not just abandoned,
  // then the view moves onto a brand new session.
  const clearConversation = async () => {
    setConfirmClear(false);
    stickToBottom();
    const old = sessionIdRef.current;
    if (old) await deleteSession(old);
    const id = newSessionId();
    sessionIdRef.current = id;
    createdAtRef.current = Date.now();
    titleRef.current = undefined;
    lastSavedRef.current = "";
    await setCurrentId(id);
    setMessages([]);
    setInput("");
    setNotice("Conversation cleared. It was not saved.");
  };

  // Slash-command registry. Extensible: add a name here and it works from the
  // input box and shows up in the palette, no other wiring needed.
  const commands: Record<string, { description: string; run: () => void | Promise<void> }> = {
    resume: { description: "Browse and reopen past conversations", run: openResumeList },
    new: { description: "Start a new conversation, saving this one", run: startNewConversation },
    clear: { description: "Wipe this conversation without saving it", run: requestClear },
  };

  const runCommand = async (raw: string) => {
    const name = raw.slice(1).split(/\s+/)[0].toLowerCase();
    const cmd = commands[name];
    if (!cmd) {
      setResumeSessions(null);
      setConfirmClear(false);
      const known = Object.keys(commands).map((c) => `/${c}`).join(", ");
      setNotice(`Unknown command: /${name}. Try ${known}.`);
      return;
    }
    await cmd.run();
  };

  // Pick a command from the palette: clear the draft and run it.
  const selectCommand = async (name: string) => {
    setInput("");
    setPaletteIdx(0);
    setPaletteDismissed(false);
    await commands[name]?.run();
  };

  // Command palette state, derived entirely from the registry so any command
  // added to `commands` shows up automatically. Open while the draft is a bare
  // "/" plus command chars (no spaces) and at least one command matches.
  const isCommandDraft = /^\/\S*$/.test(input);
  const paletteItems = isCommandDraft
    ? Object.entries(commands)
        .map(([name, meta]) => ({ name, description: meta.description }))
        .filter((c) => c.name.startsWith(input.slice(1).toLowerCase()))
    : [];
  const paletteOpen = isCommandDraft && !paletteDismissed && paletteItems.length > 0;
  const paletteActiveIdx = Math.min(paletteIdx, paletteItems.length - 1);

  const send = async () => {
    const text = input.trim();
    if (text === "") return;

    // The user just acted, so the result of that action must be visible: send and
    // run-a-command both jump to the bottom no matter where they had scrolled to.
    // (The reply that lands later is a passive arrival and respects wherever they
    // are by then.)
    stickToBottom();

    // Slash commands are handled locally and never sent to Claude.
    if (text.startsWith("/")) {
      setInput("");
      await runCommand(text);
      return;
    }

    setResumeSessions(null);
    setNotice("");
    // Sending a message answers the pending question: they did not mean to clear.
    setConfirmClear(false);
    const newHistory: Message[] = [...messages, { role: "user", text }];
    setMessages(newHistory);
    setInput("");
    setThinking(true);

    try {
      const reply = await askClaude(newHistory);
      setMessages((prev) => [
        ...prev,
        // Code-heavy replies no longer get a message-level copy bubble; each
        // fenced block renders its own header with a language label and Copy.
        { role: "intern", text: reply },
      ]);
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
        <span className="brand">Splerm</span>
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
      <ContextPanel
        open={contextOpen}
        onToggle={() => setContextOpen((o) => !o)}
        files={contextFiles}
        busy={contextBusy}
        dragOver={dragOver}
        onAdd={addContextFiles}
        onRemove={removeContextFile}
      />
      <div className="history" ref={historyRef} onScroll={onHistoryScroll}>
        {messages.length === 0 && (
          <div className="empty">Ask Splerm to do something.</div>
        )}
        {messages.map((msg, i) => {
          // The message-level copy bubble is for transcripts (plain text). If the
          // message has any fenced code block, that block renders its own header
          // Copy, so suppress the message-level one (and its card box) to avoid a
          // second copy button. Old sessions saved a copyText on code replies, so
          // this guard also cleans those up on restore.
          const hasCodeFence = /```/.test(msg.text);
          const showCopyBubble = msg.copyText != null && !hasCodeFence;
          return (
          <div
            key={i}
            className={`message ${msg.role}${
              showCopyBubble || msg.draft != null ? " card" : ""
            }${msg.draft ? " compose" : ""}`}
          >
            {msg.draft ? (
              <ComposeCard initial={msg.draft} onCreate={handleCreateDraft} />
            ) : msg.role === "intern" ? (
              <div className="md">
                {showCopyBubble && (
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
                    // Fenced code blocks route through CodeBlock. Block code is
                    // always the single <code> child of a <pre>, so overriding
                    // pre (not code) cleanly leaves inline `code` untouched. The
                    // language lives on the child's language-xxx className.
                    pre: ({ children }) => {
                      const child: any = Array.isArray(children) ? children[0] : children;
                      const cls: string = child?.props?.className ?? "";
                      const m = /language-([^\s]+)/.exec(cls);
                      const raw = child?.props?.children;
                      const text = Array.isArray(raw) ? raw.join("") : String(raw ?? "");
                      return <CodeBlock lang={m ? m[1] : null} code={text.replace(/\n$/, "")} />;
                    },
                  }}
                >
                  {msg.text}
                </ReactMarkdown>
              </div>
            ) : (
              msg.text
            )}
          </div>
          );
        })}
        {resumeSessions !== null && (
          <div className="resume-list">
            <div className="resume-head">Saved conversations</div>
            {resumeSessions.length === 0 ? (
              <div className="resume-empty">No saved conversations yet.</div>
            ) : (
              resumeSessions.map((s) => (
                <button
                  key={s.id}
                  className="resume-item"
                  onClick={() => loadConversation(s)}
                >
                  <span className="resume-title">{sessionTitle(s)}</span>
                  <span className="resume-time">{formatSessionTime(s.updatedAt)}</span>
                </button>
              ))
            )}
          </div>
        )}
        {confirmClear && (
          <div className="confirm-bar">
            <span className="confirm-text">
              Clear this conversation? It will not be saved, and you cannot get it back.
            </span>
            <div className="confirm-actions">
              <button className="confirm-btn danger" onClick={clearConversation}>
                Clear
              </button>
              <button className="confirm-btn" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {notice && <div className="notice">{notice}</div>}
        {thinking && (
          <div className="message intern thinking">{status || "..."}</div>
        )}
      </div>
      <div className="input-area">
        {!atBottom && !paletteOpen && (
          <button
            className="jump-btn"
            onClick={() => scrollToBottom(true)}
            title="Jump to latest"
            aria-label="Jump to latest"
          >
            <IconArrowDown />
          </button>
        )}
        {paletteOpen && (
          <div className="cmd-palette" role="listbox">
            {paletteItems.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === paletteActiveIdx}
                className={`cmd-item${i === paletteActiveIdx ? " active" : ""}`}
                onMouseEnter={() => setPaletteIdx(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectCommand(c.name)}
              >
                <span className="cmd-name">/{c.name}</span>
                <span className="cmd-desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
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
              <button className="row-menu-item" onClick={startNewConversation}>
                <IconPlus /> New conversation
              </button>
              <button className="row-menu-item" onClick={openResumeList}>
                <IconHistory /> Resume conversation
              </button>
              <button className="row-menu-item" onClick={() => startRecording("system")} disabled={recording}>
                <IconVolume /> Transcribe Audio
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
          onChange={(e) => {
            setInput(e.currentTarget.value);
            setPaletteIdx(0);
            setPaletteDismissed(false);
          }}
          onKeyDown={(e) => {
            if (paletteOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPaletteIdx((i) => Math.min(i + 1, paletteItems.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setPaletteIdx((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                selectCommand(paletteItems[paletteActiveIdx].name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setPaletteDismissed(true);
                return;
              }
            }
            if (e.key === "Enter") send();
          }}
          placeholder="Ask Splerm..."
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
      </div>
    </main>
  );
}

export default App;
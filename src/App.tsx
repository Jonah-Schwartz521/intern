import { useState, useEffect } from "react";
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
import { openPath } from "@tauri-apps/plugin-opener";
import "./App.css";

const HOTKEY = "CmdOrCtrl+Shift+Space";

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
];

type Message = {
  role: "user" | "intern";
  text: string;
};

// Simple heuristic: pick Opus only for requests that look genuinely hard.
// No extra API call, instant, free. Crude on purpose.
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

  return `Unknown tool: ${name}`;
}

async function askClaude(history: Message[]): Promise<string> {
  const apiMessages: any[] = history.map((m) => ({
    role: m.role === "intern" ? "assistant" : "user",
    content: m.text,
  }));

  // Route based on the latest user message.
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

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);

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
    };
    setup();
    return () => {
      unregister(HOTKEY);
    };
  }, []);

  const handleMinimize = () => {
    getCurrentWindow().minimize();
  };

  const handleClose = () => {
    getCurrentWindow().hide();
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
    }
  };

  return (
    <main className="container">
      <header className="titlebar" data-tauri-drag-region>
        <span className="brand">intern</span>
        <div className="window-controls">
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
            {msg.text}
          </div>
        ))}
        {thinking && <div className="message intern thinking">...</div>}
      </div>
      <input
        className="input"
        value={input}
        onChange={(e) => setInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
        }}
        placeholder="Ask Intern..."
        autoFocus
      />
    </main>
  );
}

export default App;
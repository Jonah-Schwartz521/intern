import { useState, useEffect } from "react";
import {
  register,
  unregister,
  ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

const HOTKEY = "CmdOrCtrl+Shift+Space";

const SYSTEM_PROMPT = `You are Intern, the reasoning engine behind a desktop quick-task assistant.

Your job:
- Parse user intent from casual, natural-language input (typed or spoken).
- Map intent to specific actions (calendar create, reminder set, file search, transcription).
- Provide clear, concise responses or ask clarifying questions when ambiguous.
- Suggest proactive actions when you have calendar context.
- Keep responses conversational and brief (one or two sentences).
- Never assume file paths or calendar details; ask if unclear.
- Act like a sharp junior assistant: fast, low-friction, no over-explaining.`;

type Message = {
  role: "user" | "intern";
  text: string;
};

async function askClaude(history: Message[]): Promise<string> {
  const apiMessages = history.map((m) => ({
    role: m.role === "intern" ? "assistant" : "user",
    content: m.text,
  }));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: apiMessages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.content[0].text;
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
      <header className="topbar">
        <span className="brand">intern</span>
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
import { useState, useEffect } from "react";
import {
  register,
  unregister,
  ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

const HOTKEY = "CmdOrCtrl+Shift+Space";

type Message = {
  role: "user" | "intern";
  text: string;
};

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");

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

  const send = () => {
    if (input.trim() === "") return;
    setMessages([...messages, { role: "user", text: input }]);
    setInput("");
  };

  return (
    <main className="container">
      <header className="topbar">
        <span className="brand">Intern</span>
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
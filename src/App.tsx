import { useEffect } from "react";
import {
  register,
  unregister,
  ShortcutEvent,
} from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

const HOTKEY = "CmdOrCtrl+Shift+Space";

function App() {
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

  return (
    <main className="container">
      <h1>Intern</h1>
      <p>Press Ctrl+Shift+Space to toggle.</p>
    </main>
  );
}

export default App;
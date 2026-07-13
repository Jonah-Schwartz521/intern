// Spotlight-style window summoning. The window should land in a predictable
// place every time the hotkey fires: horizontally centered, in the upper third,
// on whichever monitor the user is actually working on (the one the mouse is
// on). All of this is doable from JS via the Tauri window API, so there is no
// Rust involved.
import {
  getCurrentWindow,
  cursorPosition,
  monitorFromPoint,
  currentMonitor,
  primaryMonitor,
  PhysicalPosition,
  type Monitor,
} from "@tauri-apps/api/window";

// How far down the work area the window's top edge sits. Dead center (0.5)
// looks low and heavy; the upper third reads as a launcher.
const TOP_FRACTION = 0.22;

// The display the user is working on: the one under the mouse cursor. Falls
// back to the window's current monitor, then the primary one, so a failed
// cursor lookup never blocks the summon.
async function targetMonitor(): Promise<Monitor | null> {
  try {
    const cursor = await cursorPosition();
    const under = await monitorFromPoint(cursor.x, cursor.y);
    if (under) return under;
  } catch (e) {
    console.error("cursor monitor lookup failed:", e);
  }
  return (await currentMonitor()) ?? (await primaryMonitor());
}

// Move the window into place, then show and focus it. Positioning happens
// before show() so the window never appears at its old spot and jumps.
export async function summonWindow(): Promise<void> {
  const win = getCurrentWindow();
  try {
    const mon = await targetMonitor();
    if (mon) {
      // Monitor geometry and outerSize are both physical pixels, so they can be
      // compared directly without touching the scale factor. workArea excludes
      // the taskbar, which keeps the window clear of it on any DPI.
      const size = await win.outerSize();
      const area = mon.workArea;
      const x = area.position.x + Math.round((area.size.width - size.width) / 2);
      const wanted = area.position.y + Math.round(area.size.height * TOP_FRACTION);
      // Clamp so a window taller than the remaining space never hangs off the
      // bottom of the display.
      const maxY = area.position.y + Math.max(0, area.size.height - size.height);
      await win.setPosition(new PhysicalPosition(x, Math.min(wanted, maxY)));
    }
  } catch (e) {
    // Positioning is a nicety: if it fails, still summon the window.
    console.error("window positioning failed:", e);
  }
  await win.show();
  await win.setFocus();
}

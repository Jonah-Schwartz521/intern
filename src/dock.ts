// Edge-docked panel geometry and summon control. Splerm docks flush to a screen
// edge like a sidebar: sized to the monitor's WORK AREA (usable space minus the
// taskbar), on whichever monitor the cursor is on when summoned. All pure Tauri
// (window + monitor APIs); no Rust.
import {
  getCurrentWindow,
  cursorPosition,
  monitorFromPoint,
  currentMonitor,
  primaryMonitor,
  PhysicalPosition,
  PhysicalSize,
  type Monitor,
} from "@tauri-apps/api/window";
import { load } from "@tauri-apps/plugin-store";

// Which screen edge the panel docks against. A user setting now (persisted), not
// a build constant: right/left are the vertical docks, top/bottom the horizontal
// ones. Right is the default for a fresh install.
export type DockEdge = "right" | "left" | "top" | "bottom";
export const DEFAULT_DOCK_EDGE: DockEdge = "right";

const VALID_EDGES: readonly DockEdge[] = ["right", "left", "top", "bottom"];

// Live value, read by dockRect on every summon. Seeded to the default and
// overwritten by loadDockEdge() on launch / setDockEdge() from the menu.
let dockEdge: DockEdge = DEFAULT_DOCK_EDGE;

// Persistence for the dock setting. Its own tiny store file, kept apart from
// conversation data. autoSave off: we save() explicitly on change.
const SETTINGS_FILE = "settings.json";
const DOCK_KEY = "dockEdge";
let settingsPromise: ReturnType<typeof load> | null = null;
function settings() {
  if (!settingsPromise)
    settingsPromise = load(SETTINGS_FILE, { defaults: {}, autoSave: false });
  return settingsPromise;
}

export function getDockEdge(): DockEdge {
  return dockEdge;
}

// Restore the persisted dock edge on launch. Falls back to the default (right)
// for a fresh install or any unreadable / invalid stored value.
export async function loadDockEdge(): Promise<DockEdge> {
  try {
    const stored = await (await settings()).get<string>(DOCK_KEY);
    if (stored && (VALID_EDGES as readonly string[]).includes(stored)) {
      dockEdge = stored as DockEdge;
    }
  } catch (e) {
    console.error("dock edge load failed:", e);
  }
  return dockEdge;
}

// Change the dock edge and persist it. Updates the live value synchronously
// (before the awaited save) so a dockWindow() called right after picks it up.
export async function setDockEdge(edge: DockEdge): Promise<void> {
  dockEdge = edge;
  try {
    const s = await settings();
    await s.set(DOCK_KEY, edge);
    await s.save();
  } catch (e) {
    console.error("dock edge save failed:", e);
  }
}

// Panel size as a fraction of the work area along its variable axis: width for
// the vertical (right/left) docks, height for the horizontal (top/bottom) ones.
// Both clamp to MIN_SIZE_PX so the panel never gets uselessly thin on a small
// display. MIN_SIZE_PX is LOGICAL (CSS) px, converted to physical via the
// monitor's scale factor at compute time.
const SIDE_FRACTION = 0.3; // vertical docks: ~30% of work-area width
const HORIZ_FRACTION = 0.35; // horizontal docks: ~35% of work-area height
const MIN_SIZE_PX = 360;

// Slide animation duration (ms). Kept in sync with the CSS transition on
// `.container` so the window only actually hides after the content has finished
// sliding out.
export const DOCK_ANIM_MS = 180;

// The display the user is working on: the one under the mouse cursor. Falls back
// to the window's current monitor, then the primary one, so a failed cursor
// lookup never blocks the summon.
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

// Compute the docked rectangle (physical px) from a monitor's work area.
// workArea excludes the taskbar, so the panel never overlaps it. Monitor
// geometry is already physical px, so DPI needs no special handling beyond
// converting the logical min size to physical via the scale factor.
function dockRect(mon: Monitor) {
  const area = mon.workArea;
  const scale = mon.scaleFactor;
  const minPhysical = Math.round(MIN_SIZE_PX * scale);
  const edge = dockEdge;

  if (edge === "top" || edge === "bottom") {
    // Horizontal panel: full work-area WIDTH, ~35% height, flush to that edge.
    // Bottom is top pushed down by (workArea height - panel height).
    const height = Math.min(
      area.size.height,
      Math.max(minPhysical, Math.round(area.size.height * HORIZ_FRACTION)),
    );
    const y =
      edge === "bottom"
        ? area.position.y + area.size.height - height
        : area.position.y;
    return { x: area.position.x, y, width: area.size.width, height };
  }

  // Vertical panel (right / left): full work-area HEIGHT, ~30% width, flush to
  // that side. Left is right mirrored across the work area.
  const width = Math.min(
    area.size.width,
    Math.max(minPhysical, Math.round(area.size.width * SIDE_FRACTION)),
  );
  const x =
    edge === "right"
      ? area.position.x + area.size.width - width
      : area.position.x;
  return { x, y: area.position.y, width, height: area.size.height };
}

// Size + position the window flush to the docked edge for the monitor under the
// cursor. Recomputed on every show, so a monitor / resolution / DPI change since
// the last summon is picked up. Size is set before position because on some
// platforms a resize nudges the top-left, so position must land last.
export async function dockWindow(): Promise<void> {
  const win = getCurrentWindow();
  const mon = await targetMonitor();
  if (!mon) return;
  const r = dockRect(mon);
  await win.setSize(new PhysicalSize(r.width, r.height));
  await win.setPosition(new PhysicalPosition(r.x, r.y));

  // NOT BUILT: true screen-space reservation (other windows permanently resize
  // AROUND the panel) is the Windows AppBar API: SHAppBarMessage with
  // ABM_NEW / ABM_SETPOS, plus reacting to ABN_POSCHANGED. That is Win32-only and
  // unreachable from JS or any official @tauri-apps plugin, so it would require a
  // custom Rust command in src-tauri (link user32, register the AppBar, hand it a
  // rect, keep it positioned). Left out on purpose to keep this 100% pure Tauri.
  // Hook point: pass the same `r` computed above into that Rust command here.
}

// Blur-to-hide guard. Our own native dialogs (the file picker, the Outlook OAuth
// window) take focus away from the panel WITHOUT the user leaving Splerm, which
// would otherwise trip hide-on-blur and dismiss the panel underneath. Bump the
// depth around those calls via duringModal(); the blur handler checks isModalOpen.
let modalDepth = 0;

export function isModalOpen(): boolean {
  return modalDepth > 0;
}

export async function duringModal<T>(fn: () => Promise<T>): Promise<T> {
  modalDepth++;
  try {
    return await fn();
  } finally {
    modalDepth = Math.max(0, modalDepth - 1);
  }
}

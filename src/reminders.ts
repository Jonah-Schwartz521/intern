// Desktop sticky-note reminders. Reminders are app-managed: create_reminder
// persists a record here and arms an in-app timer; when the timer fires (or a
// past-due reminder is found on launch) we open a small always-on-top sticky
// note window that stays until the user dismisses it. All pure Tauri, no Rust:
// window creation (WebviewWindow), cross-window events, and the store plugin.
//
// This module is the single source of truth. The main window owns ALL record
// mutations, the timers, and window lifecycle (cascade + soft cap). Note windows
// (StickyNote.tsx) are dumb views: they read their record, persist their own
// position, and emit dismiss/snooze events back here.
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  getCurrentWindow,
  currentMonitor,
  primaryMonitor,
  PhysicalPosition,
  type Monitor,
} from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export type ReminderRecord = {
  id: string;
  text: string;
  dueAt: number; // ms epoch: the time it was set for
  createdAt: number;
  firedAt: number | null; // null = still pending; set when the note is surfaced
  overdue: boolean; // fired after dueAt (app was closed when it came due)
  pos: { x: number; y: number } | null; // last window position (physical px)
  snoozeCount: number;
};

// Compact shape the pile window renders from (sent over the event payload so the
// pile never has to re-read a possibly-stale store from another window).
export type PileItem = { id: string; text: string; dueAt: number; overdue: boolean };

// Note window geometry (logical/CSS px) and how far each cascaded note is offset
// from the previous so they never fully overlap.
export const NOTE_W = 240;
export const NOTE_H = 210;
const CASCADE_OFFSET = 28;
const CASCADE_MARGIN = 24;

// Soft cap: at most this many individual note windows. Extra active reminders
// collapse into a single pile window instead of spawning a webview each.
export const MAX_INDIVIDUAL_NOTES = 6;

export const SNOOZE_MINUTES = 10;
const SNOOZE_MS = SNOOZE_MINUTES * 60 * 1000;

// setTimeout caps out around 24.8 days (a 32-bit ms delay); anything longer is
// armed in one capped hop and re-armed for the remainder.
const MAX_TIMEOUT = 2_147_483_647;

const NOTE_LABEL_PREFIX = "note-";
const PILE_LABEL = "note-pile";

// Cross-window events. Child windows emit closed/snoozed; the main window emits
// pile-update to the pile; the pile announces ready so it gets an initial fill.
const EV_NOTE_CLOSED = "splerm://note-closed";
const EV_NOTE_SNOOZED = "splerm://note-snoozed";
const EV_PILE_UPDATE = "splerm://pile-update";
const EV_PILE_READY = "splerm://pile-ready";

// ---------------------------------------------------------------------------
// Store (reminders.json). Its own file, kept apart from sessions/settings.
// autoSave off: we save() explicitly on every mutation.
// ---------------------------------------------------------------------------
const STORE_FILE = "reminders.json";
const NOTES_KEY = "notes";
const TOAST_KEY = "alsoShowToast";

let storePromise: ReturnType<typeof load> | null = null;
function store() {
  if (!storePromise) storePromise = load(STORE_FILE, { defaults: {}, autoSave: false });
  return storePromise;
}

export async function loadNotes(): Promise<Record<string, ReminderRecord>> {
  const s = await store();
  return (await s.get<Record<string, ReminderRecord>>(NOTES_KEY)) ?? {};
}

export async function getNote(id: string): Promise<ReminderRecord | null> {
  const all = await loadNotes();
  return all[id] ?? null;
}

async function putNote(rec: ReminderRecord): Promise<void> {
  const s = await store();
  const all = (await s.get<Record<string, ReminderRecord>>(NOTES_KEY)) ?? {};
  all[rec.id] = rec;
  await s.set(NOTES_KEY, all);
  await s.save();
}

async function removeNote(id: string): Promise<void> {
  const s = await store();
  const all = (await s.get<Record<string, ReminderRecord>>(NOTES_KEY)) ?? {};
  if (!(id in all)) return;
  delete all[id];
  await s.set(NOTES_KEY, all);
  await s.save();
}

// Persist a note's dragged position. Called from the note window itself; guarded
// so a save on a note the main window has already deleted is a no-op.
export async function saveNotePos(id: string, x: number, y: number): Promise<void> {
  const s = await store();
  const all = (await s.get<Record<string, ReminderRecord>>(NOTES_KEY)) ?? {};
  const rec = all[id];
  if (!rec) return;
  rec.pos = { x, y };
  all[id] = rec;
  await s.set(NOTES_KEY, all);
  await s.save();
}

// ---------------------------------------------------------------------------
// Toast setting ("also show a one-time toast at fire", default on).
// ---------------------------------------------------------------------------
let alsoShowToast = true;

export function getAlsoShowToast(): boolean {
  return alsoShowToast;
}

export async function loadToastSetting(): Promise<boolean> {
  try {
    const v = await (await store()).get<boolean>(TOAST_KEY);
    if (typeof v === "boolean") alsoShowToast = v;
  } catch (e) {
    console.error("toast setting load failed:", e);
  }
  return alsoShowToast;
}

export async function setAlsoShowToast(on: boolean): Promise<void> {
  alsoShowToast = on;
  try {
    const s = await store();
    await s.set(TOAST_KEY, on);
    await s.save();
  } catch (e) {
    console.error("toast setting save failed:", e);
  }
}

async function pingToast(text: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title: "Splerm reminder", body: text });
  } catch (e) {
    console.error("toast failed:", e);
  }
}

// ===========================================================================
// Everything below runs in the MAIN window only.
// ===========================================================================

// Timers for pending reminders, keyed by id so a snooze/dismiss can cancel one.
const timers = new Map<string, number>();

// Which reminder occupies each individual-note slot (index = cascade position),
// and which active reminders are collapsed into the pile. slot === null is free.
const slots: (string | null)[] = new Array(MAX_INDIVIDUAL_NOTES).fill(null);
let pileIds: string[] = [];

function freeSlotIndex(): number {
  return slots.indexOf(null);
}
function slotOf(id: string): number {
  return slots.indexOf(id);
}

function cancelTimer(id: string): void {
  const h = timers.get(id);
  if (h !== undefined) {
    window.clearTimeout(h);
    timers.delete(id);
  }
}

function armTimer(id: string, dueAt: number): void {
  cancelTimer(id);
  const delay = dueAt - Date.now();
  if (delay <= 0) {
    void fireReminder(id, { overdue: true });
    return;
  }
  const capped = Math.min(delay, MAX_TIMEOUT);
  const handle = window.setTimeout(() => {
    timers.delete(id);
    if (capped < delay) armTimer(id, dueAt); // long horizon: re-arm remainder
    else void fireReminder(id, { overdue: false });
  }, capped);
  timers.set(id, handle);
}

// The display the notes should appear on: the window's current monitor, falling
// back to the primary. Physical geometry throughout, matching dock.ts.
async function targetMonitor(): Promise<Monitor | null> {
  try {
    return (await currentMonitor()) ?? (await primaryMonitor());
  } catch (e) {
    console.error("monitor lookup failed:", e);
    return null;
  }
}

// Cascade position (LOGICAL px, since WebviewWindow options take logical) for a
// given slot: anchored near the work-area top-right, stepping down-left so notes
// stack without fully overlapping.
function cascadeLogical(mon: Monitor | null, slot: number): { x: number; y: number } {
  if (!mon) return { x: 60 + slot * CASCADE_OFFSET, y: 60 + slot * CASCADE_OFFSET };
  const scale = mon.scaleFactor || 1;
  const ax = mon.workArea.position.x / scale;
  const ay = mon.workArea.position.y / scale;
  const aw = mon.workArea.size.width / scale;
  const baseX = ax + aw - NOTE_W - CASCADE_MARGIN;
  const baseY = ay + CASCADE_MARGIN;
  return {
    x: Math.round(baseX - slot * CASCADE_OFFSET),
    y: Math.round(baseY + slot * CASCADE_OFFSET),
  };
}

// Open one individual sticky-note window for a record at the given slot. If a
// saved position exists we create hidden, place it, then show, to avoid a flash
// at the cascade default.
async function openNoteWindow(rec: ReminderRecord, slot: number): Promise<void> {
  const label = NOTE_LABEL_PREFIX + rec.id;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.setFocus().catch(() => {});
    return;
  }
  const mon = await targetMonitor();
  const at = cascadeLogical(mon, slot);
  const win = new WebviewWindow(label, {
    url: `index.html?note=${encodeURIComponent(rec.id)}`,
    title: "Reminder",
    width: NOTE_W,
    height: NOTE_H,
    x: at.x,
    y: at.y,
    decorations: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focus: false,
    visible: !rec.pos,
  });
  win.once("tauri://error", (e) =>
    console.error("note window error", rec.id, e.payload),
  );
  if (rec.pos) {
    const pos = rec.pos;
    win.once("tauri://created", async () => {
      try {
        await win.setPosition(new PhysicalPosition(pos.x, pos.y));
      } catch (e) {
        console.error("note reposition failed:", e);
      }
      try {
        await win.show();
      } catch (e) {
        console.error("note show failed:", e);
      }
    });
  }
}

// Place an active reminder on screen: into a free individual slot, or, once the
// soft cap is hit, into the pile.
async function surface(rec: ReminderRecord): Promise<void> {
  if (slotOf(rec.id) !== -1 || pileIds.includes(rec.id)) return; // already shown
  const idx = freeSlotIndex();
  if (idx !== -1) {
    slots[idx] = rec.id;
    await openNoteWindow(rec, idx);
  } else {
    pileIds.push(rec.id);
    console.warn(
      `[reminders] soft cap reached (${MAX_INDIVIDUAL_NOTES} notes); collapsing ${pileIds.length} extra reminder(s) into the pile`,
    );
    await syncPileWindow();
  }
}

// Mark a pending reminder fired and show its note. opts.overdue is true when the
// due time had already passed (fired at launch, not by a live timer). A one-time
// toast pings here if enabled; re-surfacing an already-fired note on launch goes
// through surface() directly and does NOT re-toast.
export async function fireReminder(
  id: string,
  opts?: { overdue?: boolean },
): Promise<void> {
  const rec = await getNote(id);
  if (!rec) return;
  cancelTimer(id);
  if (rec.firedAt === null) {
    rec.firedAt = Date.now();
    rec.overdue = !!opts?.overdue;
    await putNote(rec);
  }
  await surface(rec);
  if (alsoShowToast) await pingToast(rec.text);
}

// Create + schedule a reminder. Called from the create_reminder tool.
export async function createReminder(text: string, dueAt: number): Promise<ReminderRecord> {
  const now = Date.now();
  const rec: ReminderRecord = {
    id: crypto.randomUUID(),
    text,
    dueAt,
    createdAt: now,
    firedAt: null,
    overdue: false,
    pos: null,
    snoozeCount: 0,
  };
  await putNote(rec);
  if (dueAt <= now) await fireReminder(rec.id, { overdue: true });
  else armTimer(rec.id, dueAt);
  return rec;
}

// ---------------------------------------------------------------------------
// Pile window: a single window listing the overflow reminders. It renders from
// the payload we push, so it never reads another window's store.
// ---------------------------------------------------------------------------
async function pileItems(): Promise<PileItem[]> {
  const all = await loadNotes();
  return pileIds
    .map((id) => all[id])
    .filter((r): r is ReminderRecord => !!r)
    .map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt, overdue: r.overdue }));
}

async function syncPileWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel(PILE_LABEL);
  if (pileIds.length === 0) {
    if (existing) await existing.close().catch(() => {});
    return;
  }
  if (!existing) {
    const mon = await targetMonitor();
    const at = cascadeLogical(mon, 0);
    const win = new WebviewWindow(PILE_LABEL, {
      url: "index.html?note=pile",
      title: "Reminders",
      width: NOTE_W,
      height: NOTE_H + 30,
      x: at.x,
      y: at.y + CASCADE_OFFSET * MAX_INDIVIDUAL_NOTES,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: false,
    });
    win.once("tauri://error", (e) => console.error("pile window error", e.payload));
    // The pile announces itself ready; we answer with the current items.
  } else {
    await emit(EV_PILE_UPDATE, { records: await pileItems() });
  }
}

// After a note leaves the screen, fill any freed individual slot from the pile.
async function promoteFromPile(): Promise<void> {
  while (pileIds.length > 0) {
    const free = freeSlotIndex();
    if (free === -1) break;
    const id = pileIds.shift()!;
    const rec = await getNote(id);
    if (rec) {
      slots[free] = id;
      await openNoteWindow(rec, free);
    }
  }
}

async function onNoteClosed(id: string): Promise<void> {
  await removeNote(id);
  cancelTimer(id);
  const idx = slotOf(id);
  if (idx !== -1) slots[idx] = null;
  pileIds = pileIds.filter((x) => x !== id);
  if (idx !== -1) await promoteFromPile();
  await syncPileWindow();
}

async function onNoteSnoozed(id: string): Promise<void> {
  const rec = await getNote(id);
  if (rec) {
    rec.dueAt = Date.now() + SNOOZE_MS;
    rec.firedAt = null;
    rec.overdue = false;
    rec.snoozeCount = (rec.snoozeCount ?? 0) + 1;
    await putNote(rec);
    armTimer(id, rec.dueAt);
  }
  const idx = slotOf(id);
  if (idx !== -1) slots[idx] = null;
  pileIds = pileIds.filter((x) => x !== id);
  if (idx !== -1) await promoteFromPile();
  await syncPileWindow();
}

let listenersReady = false;
const unlisteners: UnlistenFn[] = [];

async function registerNoteEventListeners(): Promise<void> {
  if (listenersReady) return;
  listenersReady = true;
  unlisteners.push(
    await listen<{ id: string }>(EV_NOTE_CLOSED, (e) => {
      void onNoteClosed(e.payload.id);
    }),
    await listen<{ id: string }>(EV_NOTE_SNOOZED, (e) => {
      void onNoteSnoozed(e.payload.id);
    }),
    await listen(EV_PILE_READY, async () => {
      await emit(EV_PILE_UPDATE, { records: await pileItems() });
    }),
  );
}

// Called once from the main window on launch: restore undismissed notes, fire
// anything that came due while closed (flagged overdue), and re-arm the rest.
// Guarded so React StrictMode's double-mount (dev) can't run it twice and race
// on slot assignment / spawn duplicate windows.
let inited = false;
export async function initReminders(): Promise<void> {
  if (inited) return;
  inited = true;
  await loadToastSetting();
  const notes = await loadNotes();
  const recs = Object.values(notes);
  const now = Date.now();

  // Already-fired, undismissed notes reopen first, in fire order, so their
  // cascade slots are stable across restarts.
  const fired = recs
    .filter((r) => r.firedAt !== null)
    .sort((a, b) => (a.firedAt ?? 0) - (b.firedAt ?? 0));
  for (const rec of fired) await surface(rec);

  // Pending reminders: overdue ones fire now, future ones re-arm.
  for (const rec of recs.filter((r) => r.firedAt === null)) {
    if (rec.dueAt <= now) await fireReminder(rec.id, { overdue: true });
    else armTimer(rec.id, rec.dueAt);
  }

  await registerNoteEventListeners();
}

// ===========================================================================
// Helpers called from the note / pile windows (StickyNote.tsx).
// ===========================================================================

// Dismiss this note: tell the main window (it deletes the record + reconciles
// the pile), then close our own window.
export async function requestDismiss(id: string): Promise<void> {
  await emit(EV_NOTE_CLOSED, { id });
  await getCurrentWindow().close().catch(() => {});
}

// Snooze this note: main reschedules it; we just close.
export async function requestSnooze(id: string): Promise<void> {
  await emit(EV_NOTE_SNOOZED, { id });
  await getCurrentWindow().close().catch(() => {});
}

// Dismiss a single reminder from within the pile window (the pile stays open;
// main closes it when it empties).
export async function dismissPileItem(id: string): Promise<void> {
  await emit(EV_NOTE_CLOSED, { id });
}

// Pile window: subscribe to item updates, and announce readiness so main sends
// the initial fill.
export function onPileUpdate(cb: (records: PileItem[]) => void): Promise<UnlistenFn> {
  return listen<{ records: PileItem[] }>(EV_PILE_UPDATE, (e) => cb(e.payload.records));
}
export async function announcePileReady(): Promise<void> {
  await emit(EV_PILE_READY);
}

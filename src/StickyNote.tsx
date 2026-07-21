// The note-only view, rendered in the separate sticky-note windows (main.tsx
// routes here on ?note=<id> / ?note=pile). It is deliberately tiny and shares
// no state with App: it reads its record from reminders.ts, persists its own
// dragged position, and emits dismiss/snooze events the main window acts on.
import { useEffect, useState, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getNote,
  saveNotePos,
  requestDismiss,
  requestSnooze,
  dismissPileItem,
  onPileUpdate,
  announcePileReady,
  SNOOZE_MINUTES,
  type ReminderRecord,
  type PileItem,
} from "./reminders";
import "./StickyNote.css";

function formatDue(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// One reminder = one window.
function SingleNote({ id }: { id: string }) {
  const [rec, setRec] = useState<ReminderRecord | null>(null);
  const [missing, setMissing] = useState(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    getNote(id).then((r) => (r ? setRec(r) : setMissing(true)));
  }, [id]);

  // Remember where the user drags the note (debounced), so it reopens there.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onMoved(({ payload }) => {
        if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          void saveNotePos(id, payload.x, payload.y);
        }, 300);
      })
      .then((fn) => (unlisten = fn));
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      unlisten?.();
    };
  }, [id]);

  if (missing) {
    // The record is gone (dismissed elsewhere); just close.
    void getCurrentWindow().close();
    return null;
  }
  if (!rec) return <div className="note note-loading" data-tauri-drag-region />;

  return (
    <div className={`note${rec.overdue ? " overdue" : ""}`}>
      <div className="note-head" data-tauri-drag-region>
        <span className="note-kicker">
          {rec.overdue ? "Overdue reminder" : "Reminder"}
        </span>
        <button
          className="note-x"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={() => requestDismiss(id)}
        >
          &times;
        </button>
      </div>
      <div className="note-body" data-tauri-drag-region>
        <p className="note-text">{rec.text}</p>
      </div>
      <div className="note-foot">
        <span className="note-time">Set for {formatDue(rec.dueAt)}</span>
        <button className="note-snooze" onClick={() => requestSnooze(id)}>
          Snooze {SNOOZE_MINUTES}m
        </button>
      </div>
    </div>
  );
}

// The overflow pile: one window listing the reminders past the soft cap.
function PileNote() {
  const [items, setItems] = useState<PileItem[]>([]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onPileUpdate(setItems).then((fn) => (unlisten = fn));
    void announcePileReady();
    return () => unlisten?.();
  }, []);

  if (items.length === 0) {
    void getCurrentWindow().close();
    return null;
  }

  return (
    <div className="note pile">
      <div className="note-head" data-tauri-drag-region>
        <span className="note-kicker">{items.length} more reminders</span>
      </div>
      <div className="pile-list">
        {items.map((it) => (
          <div key={it.id} className={`pile-row${it.overdue ? " overdue" : ""}`}>
            <div className="pile-row-main">
              <span className="pile-row-text">{it.text}</span>
              <span className="pile-row-time">{formatDue(it.dueAt)}</span>
            </div>
            <button
              className="note-x"
              title="Dismiss"
              aria-label="Dismiss"
              onClick={() => dismissPileItem(it.id)}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function StickyNote() {
  const note = new URLSearchParams(window.location.search).get("note");
  if (note === "pile") return <PileNote />;
  if (note) return <SingleNote id={note} />;
  return null;
}

// Conversation persistence. Each conversation is one Session, serialized to disk
// via the store plugin (sessions.json in the app's data dir). Stage 1 keeps the
// current session alive across restarts; later stages add the /resume list and
// generated titles, which is why sessions are stored keyed by id from the start.
import { load } from "@tauri-apps/plugin-store";

export type Message = {
  role: "user" | "intern";
  text: string;
  // When set, the message is a transcript (content, not a command) and renders a
  // copy button that copies this raw text.
  copyText?: string;
  // When set, the message renders an editable email compose card prefilled with
  // Claude's draft; the user edits and creates the draft from there.
  draft?: { to: string; subject: string; body: string };
};

export type Session = {
  id: string;
  createdAt: number;
  updatedAt: number;
  // Generated in Stage 3; absent for short/throwaway conversations.
  title?: string;
  messages: Message[];
};

const STORE_FILE = "sessions.json";
const SESSIONS_KEY = "sessions";
const CURRENT_KEY = "currentId";

// Lazy singleton so every caller shares one in-memory store handle.
let storePromise: ReturnType<typeof load> | null = null;
function store() {
  if (!storePromise) storePromise = load(STORE_FILE, { defaults: {}, autoSave: false });
  return storePromise;
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

export async function loadSessions(): Promise<Record<string, Session>> {
  const s = await store();
  return (await s.get<Record<string, Session>>(SESSIONS_KEY)) ?? {};
}

export async function getCurrentId(): Promise<string | null> {
  const s = await store();
  return (await s.get<string>(CURRENT_KEY)) ?? null;
}

export async function setCurrentId(id: string): Promise<void> {
  const s = await store();
  await s.set(CURRENT_KEY, id);
  await s.save();
}

export async function saveSession(session: Session): Promise<void> {
  const s = await store();
  const all = (await s.get<Record<string, Session>>(SESSIONS_KEY)) ?? {};
  all[session.id] = session;
  await s.set(SESSIONS_KEY, all);
  await s.save();
}

// Remove a conversation from the store for good. Used by /clear, which wipes a
// throwaway conversation instead of keeping it in the resume list. Autosave
// means the conversation is usually already on disk by the time it is cleared,
// so forgetting the id is not enough; the record has to go.
export async function deleteSession(id: string): Promise<void> {
  const s = await store();
  const all = (await s.get<Record<string, Session>>(SESSIONS_KEY)) ?? {};
  if (!(id in all)) return;
  delete all[id];
  await s.set(SESSIONS_KEY, all);
  await s.save();
}

// All saved conversations, most recently updated first.
export async function listSessions(): Promise<Session[]> {
  const all = await loadSessions();
  return Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);
}

// Display title for a conversation. Uses the generated title once Stage 3 sets
// one; until then falls back to the first user message, truncated.
export function sessionTitle(s: Session): string {
  if (s.title) return s.title;
  const firstUser = s.messages.find((m) => m.role === "user");
  const base = (firstUser?.text ?? "New conversation").trim();
  return base.length > 44 ? base.slice(0, 44) + "..." : base;
}

// Short, human date/time for a conversation row.
export function formatSessionTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Microsoft Graph calendar access. Reads go through @tauri-apps/plugin-http
// (Rust-side, CORS-free) with a Bearer token from msauth. See PROJECT_MEMORY for
// why the Origin header is stripped.

import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { getValidAccessToken } from "./msauth";

const GRAPH = "https://graph.microsoft.com/v1.0";

// plugin-http injects an Origin header from the webview URL; Origin: "" makes it
// strip that (crate built with unsafe-headers). Graph tolerates Origin, but we
// keep the token/Graph calls consistent. See msauth.ts TOKEN_HEADERS.
const STRIP_ORIGIN = { Origin: "" };

const DAY_MS = 24 * 60 * 60 * 1000;

export type EventSummary = {
  id: string; // Graph event id, for update/delete. Internal, not shown to user.
  subject: string;
  start: string; // human-readable, local time
  end: string;
  isAllDay: boolean;
  location?: string;
};

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Graph returns dateTime with no offset (e.g. "2026-07-03T18:00:00.0000000") in
// the timezone we requested. We request UTC, so append "Z" and convert to local.
function toLocal(dateTime: string, isAllDay: boolean): string {
  if (isAllDay) {
    // All-day events sit at UTC midnight; a timezone shift would move the
    // calendar date, so format straight from the date parts.
    const [y, m, d] = dateTime.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  return new Date(dateTime.slice(0, 19) + "Z").toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// TEMPORARY debug: confirm which account Connect Outlook authed as. Remove once
// the account is verified.
export async function debugWhoAmI(): Promise<void> {
  const token = await getValidAccessToken();
  const res = await httpFetch(`${GRAPH}/me`, {
    method: "GET",
    headers: { ...STRIP_ORIGIN, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error("GET /me failed:", res.status, await res.text());
    return;
  }
  const me = await res.json();
  console.log("Authed account -> userPrincipalName:", me.userPrincipalName, "| mail:", me.mail);
}

/**
 * List calendar events between two instants. Defaults to start-of-today through
 * 7 days later. start/end are ISO 8601 strings (Claude computes them).
 */
export async function listEvents(
  startIso?: string,
  endIso?: string
): Promise<EventSummary[]> {
  const token = await getValidAccessToken();

  const start = startIso ? new Date(startIso) : startOfToday();
  const end = endIso ? new Date(endIso) : new Date(start.getTime() + 7 * DAY_MS);

  const url = new URL(`${GRAPH}/me/calendarview`);
  url.searchParams.set("startDateTime", start.toISOString());
  url.searchParams.set("endDateTime", end.toISOString());
  url.searchParams.set("$select", "id,subject,start,end,isAllDay,location");
  url.searchParams.set("$orderby", "start/dateTime");
  url.searchParams.set("$top", "50");

  // TEMPORARY debug: exact range sent to Graph + raw response. Remove once fixed.
  console.log("[list_events] local timezone:", Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log("[list_events] startIso arg:", startIso, "| endIso arg:", endIso);
  console.log(
    "[list_events] startDateTime (UTC sent):", start.toISOString(),
    "=> local:", start.toLocaleString()
  );
  console.log(
    "[list_events] endDateTime (UTC sent):", end.toISOString(),
    "=> local:", end.toLocaleString()
  );
  console.log("[list_events] full URL:", url.toString());

  const res = await httpFetch(url.toString(), {
    method: "GET",
    headers: {
      ...STRIP_ORIGIN,
      Authorization: `Bearer ${token}`,
      // Force UTC so our "append Z" conversion is deterministic.
      Prefer: 'outlook.timezone="UTC"',
    },
  });

  const rawBody = await res.text();
  console.log("[list_events] status:", res.status, "| raw response:", rawBody);

  if (!res.ok) {
    throw new Error(`Graph calendarView failed: ${res.status} ${rawBody}`);
  }

  const data = JSON.parse(rawBody);
  const items: any[] = data.value ?? [];

  return items.map((e) => {
    const isAllDay = !!e.isAllDay;
    // All-day end is exclusive (next-day midnight); pull it back a day so the
    // range reads inclusively.
    const rawEnd = e.end?.dateTime ?? "";
    const endDisplay =
      isAllDay && rawEnd
        ? toLocal(new Date(new Date(rawEnd.slice(0, 10)).getTime() - DAY_MS).toISOString(), true)
        : toLocal(rawEnd, false);
    return {
      id: e.id,
      subject: e.subject || "(no subject)",
      start: toLocal(e.start?.dateTime ?? "", isAllDay),
      end: endDisplay,
      isAllDay,
      location: e.location?.displayName || undefined,
    };
  });
}

// Format a Date as a naive local wall-clock string ("2026-07-10T12:00:00"), to
// pair with an explicit IANA timeZone in the Graph event body. This makes the
// event land at the intended local time regardless of how Claude formatted the
// incoming ISO (naive local or UTC with Z).
function toLocalNaive(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Create a calendar event on the default calendar. start/end are ISO 8601
 * strings (Claude computes them, same as create_reminder). Returns a short
 * confirmation string.
 */
export async function createEvent(args: {
  subject: string;
  startIso: string;
  endIso: string;
  location?: string;
  attendees?: string[];
}): Promise<string> {
  const token = await getValidAccessToken();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const start = new Date(args.startIso);
  const end = new Date(args.endIso);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error(`Invalid start or end time (${args.startIso} / ${args.endIso}).`);
  }

  // Belt-and-suspenders: refuse to book in the past even if the prompt guidance
  // didn't catch it. Return (not throw) so Claude relays the question.
  if (start.getTime() < Date.now()) {
    return "That time is in the past, want me to pick a future date?";
  }

  const body: Record<string, unknown> = {
    subject: args.subject,
    start: { dateTime: toLocalNaive(start), timeZone: tz },
    end: { dateTime: toLocalNaive(end), timeZone: tz },
  };
  if (args.location) body.location = { displayName: args.location };
  if (args.attendees && args.attendees.length) {
    body.attendees = args.attendees.map((address) => ({
      emailAddress: { address },
      type: "required",
    }));
  }

  const res = await httpFetch(`${GRAPH}/me/events`, {
    method: "POST",
    headers: {
      ...STRIP_ORIGIN,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Graph create event failed: ${res.status} ${await res.text()}`);
  }

  const created = await res.json();
  const when = start.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `Created "${created.subject ?? args.subject}" for ${when}.`;
}

/**
 * Delete an event by its Graph id. Callers (Claude) must confirm with the user
 * before invoking this; there is no undo.
 */
export async function deleteEvent(id: string): Promise<string> {
  const token = await getValidAccessToken();

  const res = await httpFetch(`${GRAPH}/me/events/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...STRIP_ORIGIN, Authorization: `Bearer ${token}` },
  });

  // Successful delete is 204 No Content.
  if (!res.ok) {
    throw new Error(`Graph delete event failed: ${res.status} ${await res.text()}`);
  }
  return "Event deleted.";
}

/**
 * Update an event by its Graph id: reschedule (start/end), rename (subject),
 * relocate (location). Only the provided fields are changed.
 */
export async function updateEvent(args: {
  id: string;
  subject?: string;
  startIso?: string;
  endIso?: string;
  location?: string;
}): Promise<string> {
  const token = await getValidAccessToken();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const body: Record<string, unknown> = {};
  if (args.subject !== undefined) body.subject = args.subject;
  if (args.location !== undefined) body.location = { displayName: args.location };
  if (args.startIso !== undefined) {
    const start = new Date(args.startIso);
    if (isNaN(start.getTime())) throw new Error(`Invalid start time (${args.startIso}).`);
    body.start = { dateTime: toLocalNaive(start), timeZone: tz };
  }
  if (args.endIso !== undefined) {
    const end = new Date(args.endIso);
    if (isNaN(end.getTime())) throw new Error(`Invalid end time (${args.endIso}).`);
    body.end = { dateTime: toLocalNaive(end), timeZone: tz };
  }

  if (Object.keys(body).length === 0) {
    return "Nothing to update, tell me what to change (time, title, or location).";
  }

  const res = await httpFetch(`${GRAPH}/me/events/${encodeURIComponent(args.id)}`, {
    method: "PATCH",
    headers: {
      ...STRIP_ORIGIN,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Graph update event failed: ${res.status} ${await res.text()}`);
  }
  const updated = await res.json();
  return `Updated "${updated.subject ?? args.subject ?? "event"}".`;
}

// Microsoft Graph email drafting. Creates a DRAFT in Outlook (POST /me/messages);
// it does NOT send. Sending stays a manual step in Outlook, so we only hold the
// Mail.ReadWrite scope, never Mail.Send. Same plumbing as calendar.ts: plugin-http
// (CORS-free), Bearer token from msauth, Origin stripped.

import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { getValidAccessToken } from "./msauth";

const GRAPH = "https://graph.microsoft.com/v1.0";
const STRIP_ORIGIN = { Origin: "" };

/**
 * Create a draft email in the user's Outlook Drafts folder. Returns the draft's
 * webLink (or id) so it can be opened. Does not send.
 */
export async function createDraft(args: {
  subject: string;
  body: string;
  to: string[];
}): Promise<string> {
  const token = await getValidAccessToken();

  const message = {
    subject: args.subject,
    body: { contentType: "Text", content: args.body },
    toRecipients: args.to.map((address) => ({ emailAddress: { address } })),
  };

  const res = await httpFetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: {
      ...STRIP_ORIGIN,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    throw new Error(`Graph create draft failed: ${res.status} ${await res.text()}`);
  }

  const created = await res.json();
  return created.webLink || created.id || "(created)";
}

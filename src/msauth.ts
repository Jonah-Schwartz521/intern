// Microsoft identity (Graph) auth: PKCE authorization-code flow for a public
// native client. No client secret. Tokens live in a local tauri-plugin-store
// file; the access token is refreshed via the offline_access refresh token.
//
// Transport note: token exchange and refresh go through @tauri-apps/plugin-http
// (Rust-side fetch), NOT browser fetch. The Azure app is a native client, and
// Microsoft only returns CORS headers on /token for the SPA platform, so a
// webview fetch would be blocked. plugin-http sidesteps CORS.

import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { load, Store } from "@tauri-apps/plugin-store";
import { start, cancel, onUrl } from "@fabianlars/tauri-plugin-oauth";

const CLIENT_ID = "233ef4ee-3fc3-40a3-bd83-1cef84ea8b90";
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPES = "Calendars.ReadWrite offline_access User.Read";
const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";

const STORE_FILE = "ms-tokens.json";

// Headers for the form-encoded token calls. The empty Origin is load-bearing:
// plugin-http's Rust side otherwise injects an Origin header from the webview
// URL, which makes Microsoft reject the request as a browser cross-origin token
// redemption (AADSTS90023). Origin: "" + the crate's unsafe-headers feature
// makes the plugin strip Origin before sending. Do NOT remove it.
const TOKEN_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Origin: "",
};
// Refresh this many ms before the real expiry, to avoid using a token that
// expires mid-request.
const EXPIRY_SKEW_MS = 60_000;

// ---------- PKCE helpers (Web Crypto, no library) ----------

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr); // 43-char base64url string
}

async function challengeFrom(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

// ---------- token storage ----------

let storePromise: Promise<Store> | null = null;
function tokenStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE, { defaults: {}, autoSave: false });
  return storePromise;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

async function saveTokens(data: TokenResponse): Promise<void> {
  const store = await tokenStore();
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - EXPIRY_SKEW_MS;
  await store.set("access_token", data.access_token);
  // Refresh token is only returned on the first exchange and on rotation; keep
  // the old one if a refresh response omits it.
  if (data.refresh_token) await store.set("refresh_token", data.refresh_token);
  await store.set("expires_at", expiresAt);
  await store.save();
}

export async function isConnected(): Promise<boolean> {
  const store = await tokenStore();
  return (await store.get<string>("refresh_token")) != null;
}

// The email of the connected account, for display. Null if unknown/disconnected.
export async function getAccount(): Promise<string | null> {
  const store = await tokenStore();
  return (await store.get<string>("account")) ?? null;
}

// Clears stored tokens so the next login starts fresh (e.g. to switch accounts).
export async function disconnect(): Promise<void> {
  const store = await tokenStore();
  await store.delete("access_token");
  await store.delete("refresh_token");
  await store.delete("expires_at");
  await store.delete("account");
  await store.save();
}

// Look up the signed-in account and store its email so the UI can show it.
// Called after login, and as a backfill for sessions connected before this
// field existed. Non-fatal.
export async function refreshAccount(): Promise<void> {
  try {
    const token = await getValidAccessToken();
    const res = await httpFetch(GRAPH_ME, {
      method: "GET",
      headers: { Origin: "", Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const me = await res.json();
    const store = await tokenStore();
    await store.set("account", me.mail || me.userPrincipalName || null);
    await store.save();
  } catch {
    // Ignore: the pill will just show "Connected" without an email.
  }
}

// ---------- login (interactive) ----------

export async function login(): Promise<void> {
  const verifier = randomVerifier();
  const challenge = await challengeFrom(verifier);

  // Spin up the localhost server first so we know which port to register as the
  // redirect. Azure ignores the port on http://localhost loopback redirects, so
  // the random port matches the registered http://localhost.
  const port = await start();
  const redirectUri = `http://localhost:${port}`;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const unlisten = await onUrl((url) => {
    try {
      const u = new URL(url);
      const err = u.searchParams.get("error");
      if (err) {
        rejectCode(
          new Error(`${err}: ${u.searchParams.get("error_description") ?? ""}`)
        );
        return;
      }
      const code = u.searchParams.get("code");
      if (!code) {
        rejectCode(new Error("No authorization code in redirect."));
        return;
      }
      resolveCode(code);
    } catch (e) {
      rejectCode(e instanceof Error ? e : new Error(String(e)));
    }
  });

  const timeout = setTimeout(
    () => rejectCode(new Error("Login timed out after 2 minutes.")),
    120_000
  );

  try {
    const authUrl = new URL(`${AUTHORITY}/authorize`);
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_mode", "query");
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    // Force the account chooser instead of silently reusing a cached browser
    // session, so the user picks the account whose calendar they mean (personal
    // vs work/school). Without this, common-endpoint SSO can auth the wrong one.
    authUrl.searchParams.set("prompt", "select_account");

    await openUrl(authUrl.toString());
    const code = await codePromise;
    await exchangeCode(code, verifier, redirectUri);
    await refreshAccount();
  } finally {
    clearTimeout(timeout);
    unlisten();
    await cancel(port).catch(() => {});
  }
}

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string
): Promise<void> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    scope: SCOPES,
  });

  const res = await httpFetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  await saveTokens(await res.json());
}

// ---------- access token accessor (refreshes when stale) ----------

export async function getValidAccessToken(): Promise<string> {
  const store = await tokenStore();
  const access = await store.get<string>("access_token");
  const expiresAt = await store.get<number>("expires_at");

  if (access && expiresAt && Date.now() < expiresAt) return access;
  return refresh();
}

async function refresh(): Promise<string> {
  const store = await tokenStore();
  const refreshToken = await store.get<string>("refresh_token");
  if (!refreshToken) {
    throw new Error("Not connected to Outlook. Click Connect Outlook first.");
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPES,
  });

  const res = await httpFetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data: TokenResponse = await res.json();
  await saveTokens(data);
  return data.access_token;
}

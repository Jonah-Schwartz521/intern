// Real-time token + cost tracking. Pure frontend + tauri store, no Rust. We do
// NOT change how API calls are made: askClaude / generateTitle simply hand us the
// usage block off each response and we accumulate it here.
//
// Each of the four token buckets is billed at its OWN per-million-token rate, and
// totals are kept per MODEL (Haiku and Opus cost different amounts). Dollars are
// derived from PRICES on demand, never stored, so a price change is a one-line
// edit and old token totals re-cost correctly.
import { load } from "@tauri-apps/plugin-store";

// These model ids must match the ones askClaude routes to (App.tsx HAIKU / OPUS).
export const HAIKU_ID = "claude-haiku-4-5-20251001";
export const OPUS_ID = "claude-opus-4-8";

export type Prices = {
  input: number; // base input_tokens, per million
  output: number; // output_tokens, per million
  cacheWrite: number; // cache_creation_input_tokens, per million
  cacheRead: number; // cache_read_input_tokens, per million
};

// Per MILLION tokens. Seeded from Anthropic's pricing page (2026-07); update here
// when prices change: https://platform.claude.com/docs/en/about-claude/pricing
export const PRICES: Record<string, Prices> = {
  [HAIKU_ID]: { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  [OPUS_ID]: { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
};

// Friendly names for the readout; falls back to the raw id for anything unlisted.
const LABELS: Record<string, string> = {
  [HAIKU_ID]: "Haiku 4.5",
  [OPUS_ID]: "Opus 4.8",
};
export function modelLabel(model: string): string {
  return LABELS[model] ?? model;
}

// One model's accumulated token counts, split by billing bucket.
export type Buckets = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

// A running total: per-model buckets. $ is computed from PRICES, never stored.
export type Totals = Record<string, Buckets>;

const STORE_FILE = "cost.json";
const ALLTIME_KEY = "allTime";
const SESSION_KEY = "session";

let storePromise: ReturnType<typeof load> | null = null;
function store() {
  if (!storePromise) storePromise = load(STORE_FILE, { defaults: {}, autoSave: false });
  return storePromise;
}

// In-memory copies are the source of truth during a run; persisted after each
// change so a crash never loses the all-time total.
let session: Totals = {};
let allTime: Totals = {};

function emptyBuckets(): Buckets {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
}

// Load the all-time total from disk and RESET the session total (session = since
// this app launch). Call once at startup, before any recordUsage.
export async function initCost(): Promise<void> {
  const s = await store();
  allTime = (await s.get<Totals>(ALLTIME_KEY)) ?? {};
  session = {};
  await s.set(SESSION_KEY, session);
  await s.save();
}

function accumulate(into: Totals, model: string, add: Buckets): void {
  const cur = into[model] ?? emptyBuckets();
  cur.input += add.input;
  cur.cacheWrite += add.cacheWrite;
  cur.cacheRead += add.cacheRead;
  cur.output += add.output;
  into[model] = cur;
}

async function persist(): Promise<void> {
  const s = await store();
  await s.set(ALLTIME_KEY, allTime);
  await s.set(SESSION_KEY, session);
  await s.save();
}

// Accumulate one response's usage into BOTH running totals. `usage` is the
// Anthropic usage block: { input_tokens, cache_creation_input_tokens,
// cache_read_input_tokens, output_tokens }. input_tokens already EXCLUDES the
// cached tokens (those are their own two buckets), so the four never double count.
// No-op when usage is absent (error paths) or all zero. In-memory state updates
// synchronously; only the disk write is awaited, so callers can fire-and-forget.
export async function recordUsage(model: string, usage: any): Promise<void> {
  if (!usage) return;
  const add: Buckets = {
    input: usage.input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
  if (!add.input && !add.cacheWrite && !add.cacheRead && !add.output) return;
  accumulate(session, model, add);
  accumulate(allTime, model, add);
  await persist();
}

// Dollar cost of one bucket set, each token type at its own per-million rate.
// Unknown models cost $0 (tokens still counted) so a new model never crashes the
// readout: add it to PRICES to price it.
export function bucketsCost(model: string, b: Buckets): number {
  const p = PRICES[model];
  if (!p) return 0;
  return (
    (b.input * p.input +
      b.cacheWrite * p.cacheWrite +
      b.cacheRead * p.cacheRead +
      b.output * p.output) /
    1_000_000
  );
}

function bucketsTokens(b: Buckets): number {
  return b.input + b.cacheWrite + b.cacheRead + b.output;
}

// A flattened, display-ready view of one running total.
export type TotalSummary = {
  cost: number;
  tokens: number;
  cacheReadTokens: number; // the cheap ones, called out so caching is visible
  cacheReadCost: number;
  perModel: { model: string; label: string; tokens: number; cost: number }[];
};

function summarize(t: Totals): TotalSummary {
  let cost = 0;
  let tokens = 0;
  let cacheReadTokens = 0;
  let cacheReadCost = 0;
  const perModel = Object.entries(t).map(([model, b]) => {
    const c = bucketsCost(model, b);
    const tk = bucketsTokens(b);
    cost += c;
    tokens += tk;
    cacheReadTokens += b.cacheRead;
    cacheReadCost += ((PRICES[model]?.cacheRead ?? 0) * b.cacheRead) / 1_000_000;
    return { model, label: modelLabel(model), tokens: tk, cost: c };
  });
  perModel.sort((a, b) => b.cost - a.cost); // priciest model first
  return { cost, tokens, cacheReadTokens, cacheReadCost, perModel };
}

// Snapshot both totals for the /cost readout. Reads in-memory state (the source
// of truth), so it is synchronous and safe to call straight from a click.
export function costSnapshot(): { session: TotalSummary; allTime: TotalSummary } {
  return { session: summarize(session), allTime: summarize(allTime) };
}

// Wipe the ALL-TIME counter (the /cost reset affordance). Session is untouched.
export async function resetAllTime(): Promise<void> {
  allTime = {};
  await persist();
}

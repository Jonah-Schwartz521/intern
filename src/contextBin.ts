// The context bin: user-uploaded reference files fed to the model as steering
// context. This module is the data + ingestion layer (no UI). Records live in
// context-bin.json via tauri-plugin-store, which is the single source of truth.
//
// Why the store plugin and not tauri-sql: the bin is a small set (a handful of
// reference files), loaded all at once and never queried relationally, and the
// rest of the app already standardizes on the store plugin (see session.ts).
// SQL would add a Rust dependency and migrations for no benefit at this scale.
//
// Public API: addFiles, removeFile, listFiles, getTotalTokens (+ a dialog-backed
// pickContextFiles helper so files can be selected without any UI yet).

import { load } from "@tauri-apps/plugin-store";
import { open } from "@tauri-apps/plugin-dialog";
import {
  extractFile,
  filenameOf,
  mimeOf,
  isSupported,
  extOf,
  UnsupportedTypeError,
} from "./extract";

// One ingested reference file. This is exactly the record persisted to disk.
export type ContextFile = {
  id: string;
  filename: string;
  path: string;
  mimeType: string;
  extractedText: string;
  charCount: number;
  tokenCount: number;
  addedAt: number;
};

// A file that could not be ingested, with a human-readable reason for the UI.
export type SkippedFile = {
  path: string;
  reason: string;
};

export type AddResult = {
  added: ContextFile[];
  skipped: SkippedFile[];
};

const STORE_FILE = "context-bin.json";
const FILES_KEY = "files";

// Lazy singleton store handle, mirroring session.ts. autoSave off so writes are
// explicit and batched.
let storePromise: ReturnType<typeof load> | null = null;
function store() {
  if (!storePromise) storePromise = load(STORE_FILE, { defaults: {}, autoSave: false });
  return storePromise;
}

async function readAll(): Promise<Record<string, ContextFile>> {
  const s = await store();
  return (await s.get<Record<string, ContextFile>>(FILES_KEY)) ?? {};
}

async function writeAll(all: Record<string, ContextFile>): Promise<void> {
  const s = await store();
  await s.set(FILES_KEY, all);
  await s.save();
}

// Cheap token estimate: ~4 chars per token is a decent first pass for English.
// TODO: swap in a real tokenizer (e.g. @anthropic-ai/tokenizer or tiktoken) so
// the count matches what the model is actually billed for.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Ingest files by path: read, extract text, and persist a record for each.
 * Unsupported types are skipped with a reason rather than failing the batch.
 * Re-adding a path already in the bin replaces its record (keeping the same id)
 * so an edited file can be refreshed by adding it again.
 */
export async function addFiles(paths: string[]): Promise<AddResult> {
  const all = await readAll();
  // Index existing records by path so a re-add updates in place.
  const byPath = new Map(Object.values(all).map((f) => [f.path, f]));

  const added: ContextFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const path of paths) {
    if (!isSupported(path)) {
      const ext = extOf(path);
      skipped.push({
        path,
        reason: `Unsupported type .${ext || "(none)"} (supported: .txt, .md, .pdf, .docx)`,
      });
      continue;
    }

    try {
      const extractedText = await extractFile(path);
      if (!extractedText) {
        skipped.push({
          path,
          reason: "No extractable text (empty file, or a scanned/image-only PDF)",
        });
        continue;
      }

      const existing = byPath.get(path);
      const record: ContextFile = {
        id: existing?.id ?? crypto.randomUUID(),
        filename: filenameOf(path),
        path,
        mimeType: mimeOf(path),
        extractedText,
        charCount: extractedText.length,
        tokenCount: estimateTokens(extractedText),
        // Preserve the original add time on a refresh.
        addedAt: existing?.addedAt ?? Date.now(),
      };
      all[record.id] = record;
      byPath.set(path, record);
      added.push(record);
    } catch (err) {
      const reason =
        err instanceof UnsupportedTypeError
          ? err.message
          : `Could not read or extract: ${err instanceof Error ? err.message : String(err)}`;
      skipped.push({ path, reason });
    }
  }

  if (added.length) await writeAll(all);
  return { added, skipped };
}

/** Remove a file from the bin by id. No-op if the id is unknown. */
export async function removeFile(id: string): Promise<void> {
  const all = await readAll();
  if (!(id in all)) return;
  delete all[id];
  await writeAll(all);
}

/** All ingested files, most recently added first. */
export async function listFiles(): Promise<ContextFile[]> {
  const all = await readAll();
  return Object.values(all).sort((a, b) => b.addedAt - a.addedAt);
}

/** Total estimated tokens across the whole bin, for a context-budget readout. */
export async function getTotalTokens(): Promise<number> {
  const all = await readAll();
  return Object.values(all).reduce((sum, f) => sum + f.tokenCount, 0);
}

// Default ceiling on total context-bin tokens before we warn. Not a hard block:
// over budget we still send, but surface a warning and log the overage (a bloated
// bin quietly inflating every request is the failure mode we refuse to hide).
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 50000;

/**
 * Concatenate every context-bin file into one steering-context text block, each
 * file wrapped in a labeled tag so the model can tell them apart:
 *
 *   <context_file name="notes.md">
 *   ...extracted text...
 *   </context_file>
 *
 * Returns "" when the bin is empty so the caller can skip adding a system segment
 * entirely (and keep the same cache shape it had before any files were added).
 */
export async function assembleContextBlock(): Promise<string> {
  const files = await listFiles();
  if (files.length === 0) return "";
  return files
    .map(
      (f) =>
        `<context_file name="${f.filename}">\n${f.extractedText}\n</context_file>`
    )
    .join("\n\n");
}

export type ContextForRequest = {
  // The assembled steering block, or "" if the bin is empty.
  block: string;
  totalTokens: number;
  budget: number;
  // Present only when totalTokens > budget; the caller warns + logs but still sends.
  overage: { totalTokens: number; budget: number } | null;
};

/**
 * One call for the request path: the assembled context block plus the budget
 * check. Does NOT decide whether to send, that stays the caller's call; it just
 * reports the overage so the caller can warn the user and log it.
 */
export async function assembleContextForRequest(
  budget: number = DEFAULT_CONTEXT_TOKEN_BUDGET
): Promise<ContextForRequest> {
  const block = await assembleContextBlock();
  const totalTokens = await getTotalTokens();
  return {
    block,
    totalTokens,
    budget,
    overage: totalTokens > budget ? { totalTokens, budget } : null,
  };
}

/**
 * Open the native file picker scoped to the supported types and return the
 * chosen paths. This is the dialog-plugin entry point; pass the result straight
 * to addFiles. Returns [] if the user cancels.
 */
export async function pickContextFiles(): Promise<string[]> {
  const picked = await open({
    multiple: true,
    directory: false,
    title: "Add reference files to the context bin",
    filters: [
      { name: "Documents", extensions: ["txt", "md", "pdf", "docx"] },
    ],
  });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}

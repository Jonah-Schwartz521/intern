// Text extraction for the context bin. Given a file path, read the bytes via the
// fs plugin and turn them into plain text the model can be steered with.
//
// Supported: .txt / .md (decoded as UTF-8), .pdf (pdfjs-dist), .docx (mammoth).
// Everything runs in the webview, no Rust. Unsupported types throw an
// UnsupportedTypeError so the caller can skip and report why.

import { readFile } from "@tauri-apps/plugin-fs";
import * as pdfjs from "pdfjs-dist";
// Vite resolves this "?url" import to the bundled worker asset. pdfjs runs its
// parsing off the main thread and needs the worker wired up explicitly.
import PdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
// Root import: types come from lib/index.d.ts, and Vite auto-applies mammoth's
// "browser" field (it swaps the unzip/file-read internals for browser-safe ones).
import mammoth from "mammoth";

pdfjs.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

// Thrown for a file whose extension we do not know how to read. Carries the
// extension so the caller can put it in a human-readable skip reason.
export class UnsupportedTypeError extends Error {
  constructor(public ext: string) {
    super(`Unsupported file type: ${ext || "(no extension)"}`);
    this.name = "UnsupportedTypeError";
  }
}

// Extension -> mime type for the record. Kept tiny and local: these are the only
// four types we ingest, so a full mime library would be overkill.
const MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function filenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isSupported(path: string): boolean {
  return extOf(path) in MIME;
}

export function mimeOf(path: string): string {
  return MIME[extOf(path)] ?? "application/octet-stream";
}

// Read a .txt / .md file as UTF-8. We use readFile (bytes) + TextDecoder rather
// than readTextFile so the whole module needs only the fs:read-file capability.
async function extractText(bytes: Uint8Array): Promise<string> {
  return new TextDecoder("utf-8").decode(bytes);
}

// Pull the text layer out of a PDF, page by page. Image-only (scanned) PDFs have
// no text layer and come back empty or near-empty; that is a real limitation of
// text extraction (OCR would be a separate, heavier path) and is left as a TODO.
async function extractPdf(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(line);
  }
  // Tear down the document and its worker so ingesting many PDFs does not leak.
  await task.destroy();
  return pages.join("\n\n").trim();
}

// Extract raw text from a .docx. mammoth wants an ArrayBuffer; slice to the exact
// view bounds so a Uint8Array that is a window into a larger buffer still works.
async function extractDocx(bytes: Uint8Array): Promise<string> {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.trim();
}

/**
 * Read a file and return its plain-text content. Throws UnsupportedTypeError for
 * types we do not handle so the caller can skip and report the reason.
 */
export async function extractFile(path: string): Promise<string> {
  const ext = extOf(path);
  if (!(ext in MIME)) throw new UnsupportedTypeError(ext);

  const bytes = await readFile(path);
  switch (ext) {
    case "txt":
    case "md":
      return (await extractText(bytes)).trim();
    case "pdf":
      return extractPdf(bytes);
    case "docx":
      return extractDocx(bytes);
    default:
      // Unreachable given the guard above, but keeps the switch total.
      throw new UnsupportedTypeError(ext);
  }
}

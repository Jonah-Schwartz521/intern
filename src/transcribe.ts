// Local file transcription via the bundled Const-me/Whisper CLI (GPU, Direct3D).
// No ffmpeg: Const-me decodes audio/video directly through Media Foundation, and
// prints the transcript to stdout. The ggml model ships as a bundled resource and
// is copied into the app data dir on first use (no network).

import { Command } from "@tauri-apps/plugin-shell";
import { appLocalDataDir, join, resolveResource } from "@tauri-apps/api/path";

const MODEL_FILE = "ggml-base.bin";
// Location of the model inside the bundled resource dir (see tauri.conf.json).
const MODEL_RESOURCE = "resources/ggml-base.bin";
// Exact size of ggml-base.bin; integrity guard on the copy so a truncated file
// can never poison future transcribes.
const MODEL_BYTES = 147951465;

async function modelDir(): Promise<string> {
  return join(await appLocalDataDir(), "models");
}

// File size via the already-scoped powershell command, or -1 if absent.
async function psFileSize(path: string): Promise<number> {
  const safe = path.replace(/'/g, "''");
  const out = await Command.create("powershell", [
    "-NoProfile",
    "-Command",
    `if (Test-Path -LiteralPath '${safe}') { (Get-Item -LiteralPath '${safe}').Length } else { -1 }`,
  ]).execute();
  const n = parseInt(out.stdout.trim(), 10);
  return Number.isNaN(n) ? -1 : n;
}

async function ensureModel(onStatus: (s: string) => void): Promise<string> {
  const dir = await modelDir();
  const dest = await join(dir, MODEL_FILE);
  // Only a complete (exact-size) file counts as cached; a short/corrupt file is
  // replaced by re-copying from the bundle.
  if ((await psFileSize(dest)) === MODEL_BYTES) return dest;

  onStatus("Preparing speech model (one time)...");

  // The model ships with the app as a bundled resource; copy it into the
  // writable app-data dir on first use. No network.
  const src = await resolveResource(MODEL_RESOURCE);
  const safeSrc = src.replace(/'/g, "''");
  const safeDir = dir.replace(/'/g, "''");
  const safeDest = dest.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path '${safeDir}' | Out-Null
Copy-Item -LiteralPath '${safeSrc}' -Destination '${safeDest}' -Force
`.trim();

  const cp = await Command.create("powershell", ["-NoProfile", "-Command", script]).execute();
  if (cp.code !== 0) {
    throw new Error(`Could not copy bundled model: ${(cp.stderr || cp.stdout).trim()}`);
  }
  if ((await psFileSize(dest)) !== MODEL_BYTES) {
    throw new Error("Bundled model failed its integrity check after copy.");
  }
  return dest;
}

/**
 * Transcribe an audio/video file to text. Downloads the model on first use.
 * Returns the transcript (stdout of the whisper CLI). onStatus reports progress
 * for the UI (download / transcribing).
 */
export async function transcribe(
  filePath: string,
  onStatus: (s: string) => void
): Promise<string> {
  const model = await ensureModel(onStatus);

  onStatus("Transcribing...");
  const out = await Command.create("whisper-run", [
    "-m",
    model,
    "-f",
    filePath,
    "-nt",
  ]).execute();

  if (out.code !== 0) {
    throw new Error(`Transcription failed (exit ${out.code}): ${out.stderr || out.stdout}`);
  }
  return out.stdout.trim();
}

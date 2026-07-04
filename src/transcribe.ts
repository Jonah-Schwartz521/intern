// Local file transcription via the bundled Const-me/Whisper CLI (GPU, Direct3D).
// No ffmpeg: Const-me decodes audio/video directly through Media Foundation, and
// prints the transcript to stdout. The ggml model is downloaded once (curl, which
// ships with Windows) into the app data dir and cached.

import { Command } from "@tauri-apps/plugin-shell";
import { appLocalDataDir, join } from "@tauri-apps/api/path";

const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
const MODEL_FILE = "ggml-base.bin";

async function modelDir(): Promise<string> {
  return join(await appLocalDataDir(), "models");
}

// Existence + mkdir go through the already-scoped powershell command.
async function psExists(path: string): Promise<boolean> {
  const safe = path.replace(/'/g, "''");
  const out = await Command.create("powershell", [
    "-NoProfile",
    "-Command",
    `if (Test-Path -LiteralPath '${safe}') { 'yes' } else { 'no' }`,
  ]).execute();
  return out.stdout.trim() === "yes";
}

async function ensureModel(onStatus: (s: string) => void): Promise<string> {
  const dir = await modelDir();
  const path = await join(dir, MODEL_FILE);
  if (await psExists(path)) return path;

  onStatus("Downloading speech model (~142 MB, one time)...");

  const safeDir = dir.replace(/'/g, "''");
  const mk = await Command.create("powershell", [
    "-NoProfile",
    "-Command",
    `New-Item -ItemType Directory -Force -Path '${safeDir}' | Out-Null`,
  ]).execute();
  if (mk.code !== 0) throw new Error(`Could not create model folder: ${mk.stderr}`);

  const dl = await Command.create("curl", [
    "-L",
    "--fail",
    "-sS",
    "-o",
    path,
    MODEL_URL,
  ]).execute();
  if (dl.code !== 0) {
    throw new Error(`Model download failed (curl exit ${dl.code}): ${dl.stderr}`);
  }
  if (!(await psExists(path))) {
    throw new Error("Model download completed but the file is missing.");
  }
  return path;
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

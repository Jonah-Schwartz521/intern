// Voice input helper: persist a captured mic Blob to a temp file that the
// whisper CLI (via transcribe()) can read. Mic capture itself is getUserMedia +
// MediaRecorder in the component; this module only does the Blob-to-disk step
// through @tauri-apps/plugin-fs (scoped to $TEMP/intern-voice-input.*).

import { writeFile, remove, BaseDirectory } from "@tauri-apps/plugin-fs";
import { tempDir, join } from "@tauri-apps/api/path";

const TEMP_BASENAME = "intern-voice-input";

// Map a MediaRecorder Blob mime type to a file extension. whisper/Media
// Foundation sniff content, but a matching extension avoids surprises.
function extFromType(type: string): string {
  const t = type.toLowerCase();
  if (t.includes("webm")) return "webm";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("mp4") || t.includes("aac") || t.includes("m4a")) return "mp4";
  if (t.includes("wav")) return "wav";
  return "webm";
}

/** Write the recorded audio Blob to a temp file. Returns its absolute path. */
export async function writeTempAudio(blob: Blob): Promise<string> {
  const name = `${TEMP_BASENAME}.${extFromType(blob.type)}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeFile(name, bytes, { baseDir: BaseDirectory.Temp });
  return join(await tempDir(), name);
}

/** Delete a temp audio file created by writeTempAudio. Best-effort. */
export async function removeTempAudio(path: string): Promise<void> {
  await remove(path);
}

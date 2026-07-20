// Local image format conversion via two bundled binaries, both pure JS + the
// Tauri shell plugin, no Rust. ffmpeg (command `ffmpeg-run`, a resource-dir
// ffmpeg.exe) handles the common formats plus svg/avif. Our ffmpeg build reports
// heif=false and cannot read HEIC, so HEIC/HEIF inputs route to ImageMagick
// (command `magick-run`, a resource-dir magick.exe) instead. Scope is
// deliberately narrow: format conversion (plus optional quality / resize), NOT
// image editing.
//
// Inputs (decode FROM): png jpg/jpeg webp bmp tif/tiff gif heic/heif avif svg.
//   heic/heif via ImageMagick; everything else via ffmpeg.
// Outputs (encode TO):  png jpg webp avif  ONLY. SVG (vectorization) and HEIC
// (niche encoder) are input-only on purpose. ImageMagick writes all four output
// formats, so a HEIC can target any of them.

import { Command } from "@tauri-apps/plugin-shell";
import { exists } from "@tauri-apps/plugin-fs";
import { openPath } from "@tauri-apps/plugin-opener";
import { resolveResource } from "@tauri-apps/api/path";

export type OutputFormat = "png" | "jpg" | "webp" | "avif";
export const OUTPUT_FORMATS: OutputFormat[] = ["png", "jpg", "webp", "avif"];

// Everything we are willing to decode. heic and heif are the same container;
// jpeg/jpg and tif/tiff are aliases.
const INPUT_EXTS = new Set([
  "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff",
  "gif", "heic", "heif", "avif", "svg",
]);

export type ConvertOptions = {
  // 1..100, higher is better. Applies to jpg/webp/avif; ignored for png
  // (lossless). Defaults to DEFAULT_QUALITY.
  quality?: number;
  // Cap on the longest side in px; larger images scale down keeping aspect
  // (never upscales). Omit for no resize.
  maxDimension?: number;
  // Directory to write the output into. Omit to write next to the input (the
  // default). Used when the input is a temp copy (HTML-picked file) and the real
  // output belongs somewhere findable like Downloads. The output filename stem is
  // still taken from the input, so a temp input named after the original keeps a
  // clean output name.
  outDir?: string;
};

export type ConvertResult = {
  input: string;
  output?: string;
  ok: boolean;
  error?: string;
};

const DEFAULT_QUALITY = 90;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function filenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isConvertibleImage(path: string): boolean {
  return INPUT_EXTS.has(extOf(path));
}

// Split a Windows-or-POSIX path into its directory, filename stem, and the
// separator to rebuild with. Kept local so this module needs no path helpers.
function splitPath(p: string): { dir: string; stem: string; sep: string } {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  const dir = idx >= 0 ? p.slice(0, idx) : "";
  const base = idx >= 0 ? p.slice(idx + 1) : p;
  const sep = p.includes("\\") ? "\\" : "/";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return { dir, stem, sep };
}

// Output goes next to the input (same folder + stem, new extension). If that
// name is taken we add " (1)", " (2)", ... rather than overwriting silently.
async function freeOutputPath(
  dir: string, stem: string, sep: string, ext: string,
): Promise<string> {
  const first = `${dir}${sep}${stem}.${ext}`;
  if (!(await exists(first))) return first;
  for (let n = 1; n < 1000; n++) {
    const candidate = `${dir}${sep}${stem} (${n}).${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("too many existing files with that name");
}

// ---- ffmpeg binary resolution --------------------------------------------

// We launch ffmpeg through a named shell-scope command. `ffmpeg-run` targets the
// bundled resource ($RESOURCE/resources/ffmpeg/ffmpeg.exe). Under `tauri dev` that
// resolved copy is often MISSING (the resource copy step does not reliably re-run
// when the exe is dropped into the glob dir), so we also allow dev fallbacks that
// point at the in-tree source, resolved against the working dir (src-tauri under
// `tauri dev`, or the repo root if cwd differs). We probe these in order once at
// startup and cache the first that actually runs, used for every later spawn.
const FFMPEG_CMDS = ["ffmpeg-run", "ffmpeg-run-dev", "ffmpeg-run-dev-root"] as const;
let ffmpegCmd: string = FFMPEG_CMDS[0];

export function ffmpegCommandName(): string {
  return ffmpegCmd;
}

// Log where the bundled resource resolves and whether it exists (a direct answer
// to "which absolute path is it looking at?"), then pick the shell command that
// successfully launches ffmpeg: bundled resource first, in-tree dev source next.
async function resolveFfmpegCommand(): Promise<void> {
  try {
    const resPath = await resolveResource("resources/ffmpeg/ffmpeg.exe");
    const ok = await exists(resPath);
    console.log(`[imageConvert] resource ffmpeg path: ${resPath} (exists: ${ok})`);
  } catch (e) {
    console.warn("[imageConvert] resolveResource(ffmpeg) failed:", e);
  }

  for (const cmd of FFMPEG_CMDS) {
    try {
      const out = await Command.create(cmd, ["-hide_banner", "-version"]).execute();
      if (out.code === 0) {
        ffmpegCmd = cmd;
        console.log(`[imageConvert] ffmpeg launches via shell command '${cmd}'`);
        return;
      }
      console.warn(`[imageConvert] '${cmd}' ran but exited ${out.code}`);
    } catch (e) {
      console.warn(`[imageConvert] shell command '${cmd}' failed to spawn:`, e);
    }
  }
  console.error(`[imageConvert] no working ffmpeg command (tried: ${FFMPEG_CMDS.join(", ")})`);
}

// ---- magick binary resolution --------------------------------------------

// ImageMagick is wired exactly like ffmpeg: a bundled resource
// ($RESOURCE/resources/imagemagick/magick.exe) with two in-tree dev fallbacks,
// probed in order once at startup. Used only for HEIC/HEIF inputs. magickReady
// records whether any command launched, so the HEIC path can give a precise
// "ImageMagick isn't installed" error instead of a generic ffmpeg one.
const MAGICK_CMDS = ["magick-run", "magick-run-dev", "magick-run-dev-root"] as const;
let magickCmd: string = MAGICK_CMDS[0];
let magickReady = false;

export function magickCommandName(): string {
  return magickCmd;
}

export function magickAvailable(): boolean {
  return magickReady;
}

// Log where the bundled resource resolves, then pick the shell command that
// successfully launches magick (bundled resource first, in-tree dev source next).
async function resolveMagickCommand(): Promise<void> {
  try {
    const resPath = await resolveResource("resources/imagemagick/magick.exe");
    const ok = await exists(resPath);
    console.log(`[imageConvert] resource magick path: ${resPath} (exists: ${ok})`);
  } catch (e) {
    console.warn("[imageConvert] resolveResource(magick) failed:", e);
  }

  for (const cmd of MAGICK_CMDS) {
    try {
      const out = await Command.create(cmd, ["-version"]).execute();
      if (out.code === 0) {
        magickCmd = cmd;
        magickReady = true;
        console.log(`[imageConvert] magick launches via shell command '${cmd}'`);
        return;
      }
      console.warn(`[imageConvert] '${cmd}' ran but exited ${out.code}`);
    } catch (e) {
      console.warn(`[imageConvert] shell command '${cmd}' failed to spawn:`, e);
    }
  }
  magickReady = false;
  console.error(`[imageConvert] no working magick command (tried: ${MAGICK_CMDS.join(", ")})`);
}

// ---- availability probe ---------------------------------------------------

export type ProbeResult = {
  ok: boolean; // did the ffmpeg binary run at all?
  svg: boolean; // ffmpeg
  avif: boolean; // ffmpeg
  heif: boolean; // ImageMagick lists HEIC (covers heic/heif); NOT ffmpeg
};

let probe: ProbeResult | null = null;

export function probeResult(): ProbeResult | null {
  return probe;
}

// Probe both engines and remember which tricky decoders are present. Best-effort:
// used to LOG at startup and to enrich an error later, not to hard-block (the real
// test is attempting the conversion). svg/avif come from ffmpeg; heif (HEIC) now
// comes from ImageMagick, since our ffmpeg build cannot read HEIC. Cached after
// the first run. Name kept as probeFfmpeg to avoid churn at the single call site.
export async function probeFfmpeg(): Promise<ProbeResult> {
  // Resolve which shell command actually launches each binary (prod resource vs
  // dev source) before probing capabilities, and use those for every spawn below.
  await resolveFfmpegCommand();
  await resolveMagickCommand();

  let ffOk = false;
  let svg = false;
  let avif = false;
  try {
    const fmts = await Command.create(ffmpegCmd, ["-hide_banner", "-formats"]).execute();
    const decs = await Command.create(ffmpegCmd, ["-hide_banner", "-decoders"]).execute();
    const F = (fmts.stdout + " " + fmts.stderr).toLowerCase();
    const D = (decs.stdout + " " + decs.stderr).toLowerCase();
    ffOk = true;
    svg = /\bsvg\b/.test(F) || D.includes("librsvg");
    avif = F.includes("avif") && (D.includes(" av1") || D.includes("libdav1d") || D.includes("libaom"));
  } catch (e) {
    console.error("ffmpeg probe failed (binary missing or not permitted):", e);
  }

  // HEIC support: magick is present AND lists the HEIC format.
  let heif = false;
  if (magickReady) {
    try {
      const list = await Command.create(magickCmd, ["-list", "format"]).execute();
      const L = (list.stdout + " " + list.stderr).toLowerCase();
      heif = L.includes("heic");
    } catch (e) {
      console.warn("magick format probe failed:", e);
    }
  }

  probe = { ok: ffOk, svg, avif, heif };
  console.log(
    `[imageConvert] engines: ffmpeg=${ffOk} (svg/avif/common), magick=${magickReady} (heic=${heif})`,
  );
  return probe;
}

// Whether the current build is known to LACK a decoder for this input ext. Only
// returns true when the probe actually ran and came back negative, so a failed /
// absent probe never wrongly blocks a conversion.
function knownMissingDecoder(ext: string): boolean {
  if (!probe || !probe.ok) return false;
  if (ext === "svg") return !probe.svg;
  if (ext === "avif") return !probe.avif;
  if (ext === "heic" || ext === "heif") return !probe.heif;
  return false;
}

// ---- command construction -------------------------------------------------

// jpg quality -> mjpeg qscale (2 best .. 31 worst).
function jpgQscale(quality: number): number {
  return clamp(Math.round(31 - (quality / 100) * 29), 2, 31);
}
// avif quality -> libaom crf (0 best .. 63 worst).
function avifCrf(quality: number): number {
  return clamp(Math.round(((100 - quality) / 100) * 63), 0, 63);
}

// Build the -vf filter chain: optional downscale (never upscales), then, for the
// 4:2:0 outputs (jpg/avif), round to even dimensions so the encoder never trips
// on an odd width/height. Returns null when no filter is needed.
function videoFilter(fmt: OutputFormat, maxDimension?: number): string | null {
  const parts: string[] = [];
  if (maxDimension && maxDimension > 0) {
    parts.push(
      `scale='min(iw,${maxDimension})':'min(ih,${maxDimension})':force_original_aspect_ratio=decrease`,
    );
  }
  if (fmt === "jpg" || fmt === "avif") {
    parts.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");
  }
  return parts.length ? parts.join(",") : null;
}

function buildArgs(
  input: string, output: string, fmt: OutputFormat, quality: number, maxDimension?: number,
): string[] {
  // -frames:v 1 = a single still image. Animated inputs (GIF) contribute their
  // first frame; preserving animation is out of scope.
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-frames:v", "1"];
  const vf = videoFilter(fmt, maxDimension);
  if (vf) args.push("-vf", vf);

  switch (fmt) {
    case "png":
      break; // lossless; no quality knob
    case "jpg":
      args.push("-q:v", String(jpgQscale(quality)), "-pix_fmt", "yuvj420p");
      break;
    case "webp":
      args.push("-c:v", "libwebp", "-quality", String(quality), "-compression_level", "6");
      break;
    case "avif":
      args.push(
        "-c:v", "libaom-av1", "-still-picture", "1",
        "-crf", String(avifCrf(quality)), "-b:v", "0",
        "-cpu-used", "6", "-pix_fmt", "yuv420p",
      );
      break;
  }
  args.push(output);
  return args;
}

// ImageMagick args for a HEIC/HEIF input: `magick INPUT [-resize] [-quality] OUTPUT`.
// Order is input, operators, output. `-resize WxH>` shrinks to fit the longest side
// and the `>` suffix means never upscale (parity with the ffmpeg path). Quality maps
// straight through for jpg/webp/avif (magick's -quality is 0..100, higher is better);
// png is lossless so it gets no quality flag.
function buildMagickArgs(
  input: string, output: string, fmt: OutputFormat, quality: number, maxDimension?: number,
): string[] {
  const args = [input];
  if (maxDimension && maxDimension > 0) {
    args.push("-resize", `${maxDimension}x${maxDimension}>`);
  }
  if (fmt !== "png") {
    args.push("-quality", String(quality));
  }
  args.push(output);
  return args;
}

// Turn a raw ffmpeg failure into a short, human message (the raw stderr is
// logged, never shown). Calls out a known-missing decoder specifically.
function friendlyError(ext: string, stderr: string): string {
  const s = stderr.toLowerCase();
  if (knownMissingDecoder(ext) || /decoder|codec|no such|not compiled|unknown/.test(s)) {
    return `This ffmpeg build can't read .${ext} files. Replace the bundled ffmpeg with a full build (gyan.dev "full").`;
  }
  if (/invalid data|does not contain|moov atom|corrupt|end of file/.test(s)) {
    return "The file couldn't be read; it may be corrupt or an unsupported variant.";
  }
  return "Conversion failed.";
}

// Same idea for the ImageMagick (HEIC) path: a missing HEIC delegate is the
// notable failure; otherwise fall back to a corrupt-file or generic message.
function friendlyMagickError(ext: string, stderr: string): string {
  const s = stderr.toLowerCase();
  if (knownMissingDecoder(ext) || /no decode delegate|delegate|not authorized|unable to open/.test(s)) {
    return `This ImageMagick build can't read .${ext} files (missing HEIC delegate).`;
  }
  if (/corrupt|improper image header|insufficient image data|unexpected end/.test(s)) {
    return "The file couldn't be read; it may be corrupt or an unsupported variant.";
  }
  return "Conversion failed.";
}

// ---- public API -----------------------------------------------------------

// Convert one image. Never throws: failures come back as { ok:false, error }.
export async function convertImage(
  input: string, fmt: OutputFormat, opts: ConvertOptions = {},
): Promise<ConvertResult> {
  const ext = extOf(input);
  if (!INPUT_EXTS.has(ext)) {
    return { input, ok: false, error: `${ext ? `.${ext}` : "This file"} is not a supported image type.` };
  }
  // HEIC/HEIF decode via ImageMagick; everything else via ffmpeg.
  const isHeic = ext === "heic" || ext === "heif";
  if (isHeic && !magickReady) {
    return {
      input, ok: false,
      error: "ImageMagick isn't installed (needed for HEIC), drop magick.exe in resources/imagemagick",
    };
  }
  if (!isHeic && knownMissingDecoder(ext)) {
    return { input, ok: false, error: `This ffmpeg build can't read .${ext} files.` };
  }

  const { dir, stem, sep } = splitPath(input);
  // Write next to the input unless an explicit output dir is given (temp-copy
  // inputs redirect their output to e.g. Downloads). Normalize any trailing
  // separator and pick the separator style that matches the chosen dir.
  const outDir = opts.outDir ? opts.outDir.replace(/[\\/]+$/, "") : dir;
  const outSep = outDir.includes("\\") ? "\\" : outDir.includes("/") ? "/" : sep;
  let output: string;
  try {
    output = await freeOutputPath(outDir, stem, outSep, fmt);
  } catch {
    return { input, ok: false, error: "Couldn't find a free output filename." };
  }

  const quality = clamp(opts.quality ?? DEFAULT_QUALITY, 1, 100);
  const cmd = isHeic ? magickCmd : ffmpegCmd;
  const args = isHeic
    ? buildMagickArgs(input, output, fmt, quality, opts.maxDimension)
    : buildArgs(input, output, fmt, quality, opts.maxDimension);

  let out;
  try {
    out = await Command.create(cmd, args).execute();
  } catch (e) {
    console.error(`${isHeic ? "magick" : "ffmpeg"} spawn failed (command '${cmd}'):`, e);
    return {
      input, ok: false,
      error: isHeic
        ? "ImageMagick isn't installed (needed for HEIC), drop magick.exe in resources/imagemagick"
        : "The image converter (ffmpeg) isn't available. See setup.",
    };
  }
  if (out.code !== 0) {
    console.error(`${isHeic ? "magick" : "ffmpeg"} exit ${out.code} for ${input}:\n${out.stderr}`);
    return { input, ok: false, error: isHeic ? friendlyMagickError(ext, out.stderr) : friendlyError(ext, out.stderr) };
  }
  // A zero exit with no file (or an empty file) still counts as a failure.
  if (!(await exists(output))) {
    return { input, ok: false, error: "Conversion produced no output." };
  }
  return { input, output, ok: true };
}

// Convert many images to the same format, sequentially (AVIF encoding is CPU
// heavy; serial keeps the machine responsive). onProgress reports 1-based index.
export async function convertBatch(
  inputs: string[], fmt: OutputFormat, opts: ConvertOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<ConvertResult[]> {
  const results: ConvertResult[] = [];
  for (let i = 0; i < inputs.length; i++) {
    onProgress?.(i + 1, inputs.length);
    results.push(await convertImage(inputs[i], fmt, opts));
  }
  return results;
}

// Open the folder that contains a converted file (our "reveal in folder").
export async function revealInFolder(filePath: string): Promise<void> {
  const { dir } = splitPath(filePath);
  await openPath(dir);
}

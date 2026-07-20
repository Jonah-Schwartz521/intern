# Bundled ffmpeg (image conversion + future media work)

Drop a **full** static Windows `ffmpeg.exe` in this folder:

```
src-tauri/resources/ffmpeg/ffmpeg.exe
```

## Which build

Use a "full" build so HEIC/HEIF, AVIF, and SVG all decode. Either works:

- **gyan.dev** "ffmpeg-release-full" (https://www.gyan.dev/ffmpeg/builds/) — grab
  the `full` (not `essentials`) build, unzip, copy `bin/ffmpeg.exe` here.
- **BtbN** ffmpeg-master-latest-win64-gpl (https://github.com/BtbN/FFmpeg-Builds/releases).

Both ship a single statically linked `ffmpeg.exe` (no side DLLs), which is why
only this one file is needed. Expect ~120-170 MB.

## Why it isn't checked in

The binary is large and license/build-specific, so it is not committed. The app
bundles whatever `ffmpeg.exe` is present here at build time
(`tauri.conf.json` -> `bundle.resources` -> `resources/ffmpeg/*`) and shells it via
the `ffmpeg-run` capability. Until it is present, image conversion reports a clean
"ffmpeg isn't available" message and the startup probe logs that the build is
missing.

## Verifying the build is good

On launch the app runs `ffmpeg -formats` / `-decoders` and logs whether **svg**,
**avif**, and **heif/heic** decoding are available. Check the devtools console for
a line like `[imageConvert] probe: svg=true avif=true heif=true`.

import express from "express";
import cors from "cors";
import multer from "multer";
import archiver from "archiver";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

/**
 * Stateless DubForge backend.
 *
 * One request to /process-part is fully self-contained:
 *   - video        (single file)
 *   - clips        (JSON: [{ index, start, end, duration, audioName }])
 *   - settings     (JSON)
 *   - audios       (one file per clip, same order as clips)
 *   - partIndex    (1-based)
 *
 * No sessionId, no sid, no token, no database, no separate upload step.
 * The backend processes the assigned clips and returns a downloadable ZIP.
 */

const PORT = Number(process.env.PORT || 8080);
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), "dubforge");
const DOWNLOAD_DIR = path.join(WORK_DIR, "downloads");
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024; // 50GB

// Smart Hybrid & audio defaults (can be overridden per-request via settings).
const AUDIO_SAFE_MIN = Number(process.env.AUDIO_SAFE_MIN || 0.85);
const AUDIO_SAFE_MAX = Number(process.env.AUDIO_SAFE_MAX || 1.25);
const LOUDNESS_TARGET = Number(process.env.LOUDNESS_TARGET || -16);
const FADE_IN_SEC = Number(process.env.FADE_IN_SEC || 0.03);
const FADE_OUT_SEC = Number(process.env.FADE_OUT_SEC || 0.03);
const VIDEO_CRF = Number(process.env.VIDEO_CRF || 18);
const VIDEO_PRESET = process.env.VIDEO_PRESET || "veryfast";

await fs.mkdir(WORK_DIR, { recursive: true });
await fs.mkdir(DOWNLOAD_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

// ===== Types =====
interface ClipMeta {
  index?: number;
  start: number;
  end: number;
  duration?: number;
  audioName?: string;
}

interface PartSettings {
  loudnessTarget?: number;
  fadeDuration?: number;
  minTempo?: number;
  maxTempo?: number;
}

// ===== Helpers =====
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} failed (${code}): ${stderr.slice(-1500)}`));
    });
  });
}

function probeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file,
    ]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe: ${err}`));
      resolve(parseFloat(out.trim()) || 0);
    });
  });
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function zipDirectory(dir: string, zipPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    // level 0 (store) — clips are already compressed video, avoid recompress.
    const archive = archiver("zip", { zlib: { level: 0 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(dir, false);
    archive.finalize();
  });
}


// ===== Multer (in-memory disk temp) =====
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      // A per-request scratch dir is created in the handler; multer needs a
      // destination up front, so use a request-scoped temp dir.
      const anyReq = req as express.Request & { _scratch?: string };
      if (!anyReq._scratch) {
        anyReq._scratch = await fs.mkdtemp(path.join(WORK_DIR, "req-"));
        await fs.mkdir(path.join(anyReq._scratch, "in"), { recursive: true });
      }
      cb(null, path.join(anyReq._scratch, "in"));
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
});

// ===== Routes =====
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    ffmpeg: true,
    ffprobe: true,
    routes: ["/health", "/process-part", "/download/:filename", "/files/:filename"],
  })
);

const partUpload = upload.fields([
  { name: "video", maxCount: 1 },
  { name: "audios", maxCount: 100000 },
]);

app.post("/process-part", partUpload, async (req, res) => {
  const anyReq = req as express.Request & { _scratch?: string };
  const scratch = anyReq._scratch;
  const files = req.files as
    | { video?: Express.Multer.File[]; audios?: Express.Multer.File[] }
    | undefined;

  try {
    const videoFile = files?.video?.[0];
    const audioFiles = files?.audios || [];

    if (!videoFile) {
      return res.status(400).json({
        ok: false,
        error:
          "No video file received. Expected FormData field 'video' with the video file.",
        receivedFileFields: files ? Object.keys(files) : [],
      });
    }

    let clips: ClipMeta[] = [];
    try {
      clips = JSON.parse((req.body.clips as string) || "[]");
    } catch {
      return res
        .status(400)
        .json({ ok: false, error: "Invalid 'clips' JSON." });
    }

    let settings: PartSettings = {};
    try {
      settings = JSON.parse((req.body.settings as string) || "{}");
    } catch {
      settings = {};
    }

    const partIndex = Number(req.body.partIndex || 1);
    const safeMin = settings.minTempo ?? AUDIO_SAFE_MIN;
    const safeMax = settings.maxTempo ?? AUDIO_SAFE_MAX;
    const loudness = settings.loudnessTarget ?? LOUDNESS_TARGET;
    const fadeIn = settings.fadeDuration ?? FADE_IN_SEC;
    const fadeOut = settings.fadeDuration ?? FADE_OUT_SEC;

    if (!scratch) {
      return res
        .status(500)
        .json({ ok: false, error: "Internal scratch dir not created." });
    }

    // Match audios to clips: prefer audioName, fallback to upload order.
    const byName = new Map<string, Express.Multer.File>();
    for (const f of audioFiles) {
      // multer prefixes filename; match against original name we appended.
      byName.set(f.originalname, f);
    }

    const warnings: string[] = [];
    const pairCount = Math.min(clips.length, audioFiles.length);
    if (audioFiles.length < clips.length) {
      warnings.push(
        `${clips.length - audioFiles.length} clip(s) skipped because audio files were missing.`
      );
    } else if (audioFiles.length > clips.length) {
      warnings.push(
        `${audioFiles.length - clips.length} extra audio file(s) ignored.`
      );
    }

    const outDir = path.join(scratch, "out");
    await fs.mkdir(outDir, { recursive: true });

    let cursor = 0;
    let completed = 0;
    let failed = 0;

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= pairCount) return;
        const clip = clips[i];
        // Prefer matching by name, else positional.
        const audio =
          (clip.audioName && byName.get(clip.audioName)) || audioFiles[i];
        if (!audio) {
          failed++;
          continue;
        }

        const globalIdx = clip.index ?? i;
        const stem = String(globalIdx + 1).padStart(5, "0");

        try {
          const tmpClip = path.join(outDir, `.tmp_clip_${stem}.mp4`);
          const tmpAudio = path.join(outDir, `.tmp_aud_${stem}.m4a`);
          const tmpAudioProcessed = path.join(outDir, `.tmp_audp_${stem}.m4a`);
          const finalOut = path.join(outDir, `${stem}.mp4`);

          // (1) Cut the video segment without re-encoding.
          await run("ffmpeg", [
            "-y",
            "-ss", String(clip.start),
            "-to", String(clip.end),
            "-i", videoFile!.path,
            "-c:v", "copy",
            "-an",
            "-avoid_negative_ts", "make_zero",
            tmpClip,
          ]);

          const videoDur = await probeDuration(tmpClip);
          const audioDur = await probeDuration(audio.path);
          const requiredTempo = videoDur > 0 ? audioDur / videoDur : 1.0;

          // Smart hybrid sync.
          let usedAudioTempo = requiredTempo;
          let videoReencoded = false;
          let videoSetPtsFactor = 1.0;

          if (requiredTempo >= safeMin && requiredTempo <= safeMax) {
            // Case 1: keep video as-is, only change audio tempo.
            usedAudioTempo = requiredTempo;
            videoReencoded = false;
          } else {
            // Case 2: clamp audio, change video speed to match.
            usedAudioTempo = clamp(requiredTempo, safeMin, safeMax);
            const adjustedAudioDur = audioDur / usedAudioTempo;
            videoSetPtsFactor = adjustedAudioDur / videoDur;
            videoReencoded = true;
          }

          // (2a) Tempo + loudness.
          const tempoChain = buildAtempoChain(usedAudioTempo);
          const tempFilter = `${tempoChain},loudnorm=I=${loudness}:TP=-1.5:LRA=11`;
          await run("ffmpeg", [
            "-y", "-i", audio.path,
            "-filter:a", tempFilter,
            "-ac", "2", "-ar", "48000",
            "-c:a", "aac", "-b:a", "192k",
            tmpAudio,
          ]);

          // (2b) Fade in/out using the actual adjusted duration.
          const adjustedAudioDur = await probeDuration(tmpAudio);
          const fadeOutStart = Math.max(0, adjustedAudioDur - fadeOut);
          const fadeFilter = `afade=t=in:st=0:d=${fadeIn},afade=t=out:st=${fadeOutStart}:d=${fadeOut}`;
          await run("ffmpeg", [
            "-y", "-i", tmpAudio,
            "-filter:a", fadeFilter,
            "-ac", "2", "-ar", "48000",
            "-c:a", "aac", "-b:a", "192k",
            tmpAudioProcessed,
          ]);

          // (3) Mux (and re-encode the video clip only when needed).
          const muxArgs = [
            "-y",
            "-i", tmpClip,
            "-i", tmpAudioProcessed,
            "-map", "0:v:0", "-map", "1:a:0",
          ];
          if (videoReencoded) {
            muxArgs.push("-filter:v", `setpts=${videoSetPtsFactor}*PTS`);
            muxArgs.push("-c:v", "libx264");
            muxArgs.push("-crf", String(VIDEO_CRF));
            muxArgs.push("-preset", VIDEO_PRESET);
            muxArgs.push("-pix_fmt", "yuv420p");
          } else {
            muxArgs.push("-c:v", "copy");
          }
          muxArgs.push("-c:a", "aac", "-b:a", "192k");
          muxArgs.push("-shortest");
          muxArgs.push("-movflags", "+faststart");
          muxArgs.push(finalOut);
          await run("ffmpeg", muxArgs);

          await fs.unlink(tmpClip).catch(() => {});
          await fs.unlink(tmpAudio).catch(() => {});
          await fs.unlink(tmpAudioProcessed).catch(() => {});
          completed++;
        } catch (e) {
          failed++;
          console.error(`part ${partIndex} clip ${globalIdx} failed:`, (e as Error).message);
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, Math.max(1, pairCount)) },
      worker
    );
    await Promise.all(workers);

    if (failed > 0) {
      warnings.push(`${failed} clip(s) failed during processing.`);
    }

    // Zip the produced clips.
    const zipName = `part-${partIndex}.zip`;
    const zipPath = path.join(DOWNLOAD_DIR, zipName);
    await zipDirectory(outDir, zipPath);

    // Clean up the request scratch dir (keep only the zip in DOWNLOAD_DIR).
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});

    res.json({
      ok: true,
      partIndex,
      clipStart: 1,
      clipEnd: pairCount,
      totalProcessed: completed,
      downloadUrl: `/download/${zipName}`,
      warnings,
    });
  } catch (e) {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/**
 * ffmpeg atempo supports 0.5..2.0 per filter instance. Chain for wider ranges.
 */
function buildAtempoChain(tempo: number): string {
  if (!isFinite(tempo) || tempo <= 0) return "atempo=1.0";
  const parts: string[] = [];
  let t = tempo;
  while (t > 2.0) { parts.push("atempo=2.0"); t /= 2.0; }
  while (t < 0.5) { parts.push("atempo=0.5"); t /= 0.5; }
  parts.push(`atempo=${t.toFixed(6)}`);
  return parts.join(",");
}

// Download the produced ZIP for a part.
app.get("/download/:filename", async (req, res) => {
  const name = path.basename(req.params.filename).replace(/[^a-zA-Z0-9._-]/g, "");
  const file = path.join(DOWNLOAD_DIR, name);
  if (!existsSync(file)) {
    return res.status(404).json({ ok: false, error: "File not found" });
  }
  const stat = await fs.stat(file);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  createReadStream(file).pipe(res);
});

// Serve an individual produced file.
app.get("/files/:filename", async (req, res) => {
  const name = path.basename(req.params.filename).replace(/[^a-zA-Z0-9._-]/g, "");
  const file = path.join(DOWNLOAD_DIR, name);
  if (!existsSync(file)) {
    return res.status(404).json({ ok: false, error: "File not found" });
  }
  const stat = await fs.stat(file);
  const type = name.endsWith(".zip") ? "application/zip" : "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  createReadStream(file).pipe(res);
});

// Periodic cleanup of old downloads (24 hours).
setInterval(async () => {
  try {
    const entries = await fs.readdir(DOWNLOAD_DIR);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const e of entries) {
      const p = path.join(DOWNLOAD_DIR, e);
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await fs.rm(p, { recursive: true, force: true }).catch(() => {});
      }
    }
    // Also sweep stale request scratch dirs.
    const root = await fs.readdir(WORK_DIR);
    for (const e of root) {
      if (!e.startsWith("req-")) continue;
      const p = path.join(WORK_DIR, e);
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await fs.rm(p, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {}
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`DubForge stateless backend on :${PORT}`);
  console.log(`  work=${WORK_DIR}`);
  console.log(`  downloads=${DOWNLOAD_DIR}`);
  console.log(`  concurrency=${CONCURRENCY}`);
  console.log(`  audio safe range: ${AUDIO_SAFE_MIN}-${AUDIO_SAFE_MAX}`);
  console.log(`  loudness target: ${LOUDNESS_TARGET} LUFS`);
  console.log(`  routes: /health, /process-part, /download/:filename, /files/:filename`);
});

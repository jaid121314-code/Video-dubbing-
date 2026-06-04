import express from "express";
import cors from "cors";
import multer from "multer";
import archiver from "archiver";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8080);
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), "dubforge");
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024; // 50GB

// Smart Hybrid & Audio settings
const AUDIO_SAFE_MIN = Number(process.env.AUDIO_SAFE_MIN || 0.85);
const AUDIO_SAFE_MAX = Number(process.env.AUDIO_SAFE_MAX || 1.25);
const LOUDNESS_TARGET = Number(process.env.LOUDNESS_TARGET || -16);
const FADE_IN_SEC = Number(process.env.FADE_IN_SEC || 0.03);
const FADE_OUT_SEC = Number(process.env.FADE_OUT_SEC || 0.03);
const VIDEO_CRF = Number(process.env.VIDEO_CRF || 18);
const VIDEO_PRESET = process.env.VIDEO_PRESET || "veryfast";

await fs.mkdir(WORK_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

// ===== Types =====
interface JobStatus {
  total: number;
  completed: number;
  failed: number;
  status: "running" | "done" | "error";
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface ClipLog {
  clip: number;
  start?: number;
  end?: number;
  videoDur?: number;
  audioDur?: number;
  adjustedAudioDur?: number;
  requiredTempo?: number;
  usedAudioTempo?: number;
  videoReencoded?: boolean;
  status: "done" | "failed";
  error?: string;
}

interface HybridWarning {
  clip: number;
  requiredTempo: number;
  usedAudioTempo: number;
  videoReencoded: boolean;
  reason: string;
}

const jobs = new Map<string, JobStatus>();

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

async function probeDuration(file: string): Promise<number> {
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

function sessionDir(sid: string): string {
  const safe = sid.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(WORK_DIR, safe);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Build an atempo filter chain for natural/aggressive modes.
 * For smart_hybrid, this is handled separately.
 */
function buildTempoChain(
  tempo: number,
  mode: "natural" | "aggressive"
): { chain: string; effective: number } {
  if (!isFinite(tempo) || tempo <= 0) return { chain: "atempo=1.0", effective: 1.0 };

  const SAFE_MIN = AUDIO_SAFE_MIN;
  const SAFE_MAX = AUDIO_SAFE_MAX;
  const HARD_MIN = 0.5;
  const HARD_MAX = 2.0;

  // Within safe range: one step, sounds great.
  if (tempo >= SAFE_MIN && tempo <= SAFE_MAX) {
    return { chain: `atempo=${tempo.toFixed(4)}`, effective: tempo };
  }

  if (mode === "natural") {
    // Clamp softly
    const ACCEPT_MIN = 0.75, ACCEPT_MAX = 1.35;
    const target = Math.min(ACCEPT_MAX, Math.max(ACCEPT_MIN, tempo));
    if (target >= SAFE_MIN && target <= SAFE_MAX) {
      return { chain: `atempo=${target.toFixed(4)}`, effective: target };
    }
    // Two-step chain inside safe band
    const root = Math.sqrt(target);
    const r = Math.min(SAFE_MAX, Math.max(SAFE_MIN, root));
    const effective = r * r;
    return { chain: `atempo=${r.toFixed(4)},atempo=${r.toFixed(4)}`, effective };
  }

  // aggressive: chain within hard limits
  const steps: number[] = [];
  let remaining = tempo;
  while (remaining > SAFE_MAX) {
    const step = Math.min(HARD_MAX, Math.max(SAFE_MAX, Math.sqrt(remaining)));
    steps.push(step);
    remaining /= step;
  }
  while (remaining < SAFE_MIN) {
    const step = Math.max(HARD_MIN, Math.min(SAFE_MIN, Math.sqrt(remaining)));
    steps.push(step);
    remaining /= step;
  }
  steps.push(remaining);
  const effective = steps.reduce((a, b) => a * b, 1);
  return { chain: steps.map((s) => `atempo=${s.toFixed(4)}`).join(","), effective };
}

/**
 * Build audio filter chain for smart_hybrid or natural/aggressive with loudness + fade.
 * Note: For natural/audio-to-video mode, never re-encode video.
 */
function buildAudioFilterChain(
  tempo: number,
  mode: "natural" | "aggressive" | "smart_hybrid"
): string {
  let chain = "";

  // Step 1: Tempo adjustment
  if (mode === "smart_hybrid") {
    // For smart_hybrid, clamp audio to safe range
    const clampedTempo = clamp(tempo, AUDIO_SAFE_MIN, AUDIO_SAFE_MAX);
    chain = `atempo=${clampedTempo.toFixed(4)}`;
  } else {
    const { chain: tempoChain } = buildTempoChain(tempo, mode);
    chain = tempoChain;
  }

  // Step 2: Loudness normalization
  chain += `,loudnorm=I=${LOUDNESS_TARGET}:TP=-1.5:LRA=11`;

  // Step 3: Fade in/out
  chain += `,afade=t=in:st=0:d=${FADE_IN_SEC}`;
  // NOTE: Using END is not supported by FFmpeg. We'll calculate fadeOutStart dynamically.
  // For now, add a placeholder that we'll replace after probing adjusted duration
  chain += `,afade=t=out:st=__FADE_OUT_START__:d=${FADE_OUT_SEC}`;

  return chain;
}

/**
 * Build final audio filter with fade-out calculated from actual adjusted duration.
 */
function buildAudioFilterChainWithFadeOut(
  tempo: number,
  mode: "natural" | "aggressive" | "smart_hybrid",
  adjustedAudioDuration: number
): string {
  let chain = "";

  // Step 1: Tempo adjustment
  if (mode === "smart_hybrid") {
    const clampedTempo = clamp(tempo, AUDIO_SAFE_MIN, AUDIO_SAFE_MAX);
    chain = `atempo=${clampedTempo.toFixed(4)}`;
  } else {
    const { chain: tempoChain } = buildTempoChain(tempo, mode);
    chain = tempoChain;
  }

  // Step 2: Loudness normalization
  chain += `,loudnorm=I=${LOUDNESS_TARGET}:TP=-1.5:LRA=11`;

  // Step 3: Fade in/out with correct fade-out start
  chain += `,afade=t=in:st=0:d=${FADE_IN_SEC}`;
  const fadeOutStart = Math.max(0, adjustedAudioDuration - FADE_OUT_SEC);
  chain += `,afade=t=out:st=${fadeOutStart}:d=${FADE_OUT_SEC}`;

  return chain;
}

// ===== Multer Configuration =====
const uploadSingle = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const sid = (req.body.sessionId || req.query.sessionId || "default") as string;
      const dir = path.join(sessionDir(sid), "in");
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // Accept any video file type
    cb(null, true);
  },
});

const uploadBatch = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const sid = (req.body.sessionId || req.query.sessionId || "default") as string;
      const dir = path.join(sessionDir(sid), "in");
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
    },
  }),
  limits: { fileSize: MAX_FILE_SIZE },
});

// ===== Endpoints =====
app.get("/health", (_req, res) => res.json({
  ok: true,
  ffmpeg: true,
  ffprobe: true,
  routes: [
    "/upload-video",
    "/process-batch",
    "/api/batch/process",
    "/job/:id",
    "/download-zip/:sid",
    "/download-final/:sid",
    "/download-all/:sid",
    "/merge/:sid",
    "/file/:sid/:name",
    "/cleanup"
  ],
}));

/**
 * IMPROVED: Upload base video with better error reporting
 * Accepts field name: video
 * Returns clear error messages
 */
app.post("/upload-video", uploadSingle.single("video"), async (req, res) => {
  try {
    const sid = (req.body.sessionId || req.query.sessionId) as string | undefined;
    
    // Error 1: Missing sessionId
    if (!sid) {
      return res.status(400).json({
        error: "Missing sessionId",
        details: "sessionId is required in FormData (form.append('sessionId', value))",
        received: { sessionId: req.body.sessionId, querySessionId: req.query.sessionId },
      });
    }

    // Error 2: No file received
    if (!req.file) {
      const bodyKeys = Object.keys(req.body);
      return res.status(400).json({
        error: "No video file received",
        details: "Expected FormData field 'video' with video file",
        hints: [
          "Check that form.append('video', videoBlob, filename) was called",
          "File must be less than 50GB",
          "MIME type should be video/* (e.g., video/mp4, video/quicktime)",
        ],
        received: {
          body: bodyKeys,
          file: null,
        },
      });
    }

    const dir = sessionDir(sid);
    await fs.mkdir(dir, { recursive: true });
    
    // Remove any previous source
    for (const f of await fs.readdir(dir)) {
      if (f.startsWith("source")) {
        await fs.unlink(path.join(dir, f)).catch(() => {});
      }
    }

    // Save the file
    const dest = path.join(dir, "source" + path.extname(req.file.originalname));
    await fs.rename(req.file.path, dest);

    res.json({
      ok: true,
      message: "Video uploaded successfully",
      sessionId: sid,
      filename: path.basename(dest),
      size: req.file.size,
    });
  } catch (e) {
    const errorMsg = (e as Error).message;
    console.error("Upload error:", errorMsg);
    res.status(500).json({
      error: "Upload failed",
      message: errorMsg,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Normalize mode from frontend: accept both "syncMode" and "mode"
 * Mapping: "audio-to-video" => "natural", others stay as-is
 * Default to "natural" for stable first testing
 */
function normalizeMode(syncMode?: string, mode?: string): "natural" | "aggressive" | "smart_hybrid" {
  // Try syncMode first
  if (syncMode) {
    if (syncMode === "audio-to-video") return "natural";
    if (syncMode === "smart_hybrid") return "smart_hybrid";
  }
  
  // Try mode second
  if (mode) {
    if (mode === "natural") return "natural";
    if (mode === "aggressive") return "aggressive";
    if (mode === "smart_hybrid") return "smart_hybrid";
  }
  
  // Default to natural for stable first testing
  return "natural";
}

/**
 * 2) Process a batch of clips with smart hybrid mode support.
 * Body (multipart):
 *   sessionId: string
 *   batchIndex: number
 *   mode or syncMode: "natural" | "aggressive" | "smart_hybrid" (default: natural)
 *   clips: JSON string of [{ start, end, index }]
 *   audio: files
 *   settings: optional JSON { audioSafeMin, audioSafeMax, loudnessTarget, fadeInSec, fadeOutSec, crf, preset }
 */
async function processBatchHandler(req: express.Request, res: express.Response) {
  const sid = req.body.sessionId as string;
  const batchIndex = Number(req.body.batchIndex || 0);
  const syncMode = (req.body.syncMode || req.body.mode) as string | undefined;
  const processMode = normalizeMode(syncMode, req.body.mode);
  const clipsRaw = req.body.clips as string;
  const settingsRaw = req.body.settings as string | undefined;

  try {
    if (!sid || !clipsRaw) return res.status(400).json({ error: "sessionId + clips required" });
    const clips: { start: number; end: number; index?: number }[] = JSON.parse(clipsRaw);
    const audioFiles = (req.files as Express.Multer.File[]) || [];
    if (audioFiles.length !== clips.length) {
      return res.status(400).json({
        error: `Audio count ${audioFiles.length} != clips ${clips.length}`,
      });
    }
    audioFiles.sort((a, b) => {
      const ai = parseInt(a.originalname.split("_")[0], 10);
      const bi = parseInt(b.originalname.split("_")[0], 10);
      return ai - bi;
    });

    const dir = sessionDir(sid);
    const sourceCandidates = (await fs.readdir(dir)).filter((f) => f.startsWith("source"));
    if (!sourceCandidates.length) return res.status(400).json({ error: "Source video not uploaded" });
    const source = path.join(dir, sourceCandidates[0]);

    const clipsOut = path.join(dir, "clips");
    await fs.mkdir(clipsOut, { recursive: true });

    // Parse optional settings
    let settings: any = {};
    if (settingsRaw) {
      try {
        settings = JSON.parse(settingsRaw);
      } catch {}
    }

    const jobId = `${sid}_b${batchIndex}_${Date.now()}`;
    jobs.set(jobId, { total: clips.length, completed: 0, failed: 0, status: "running", startedAt: Date.now() });
    res.json({ jobId, total: clips.length });

    processInBackground(jobId, source, clips, audioFiles, clipsOut, processMode, dir, settings).catch((e) => {
      const j = jobs.get(jobId);
      if (j) { j.status = "error"; j.error = (e as Error).message; j.finishedAt = Date.now(); }
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}

app.post("/process-batch", uploadBatch.array("audio", 2000), processBatchHandler);
app.post("/api/batch/process", uploadBatch.array("audio", 2000), processBatchHandler);

async function processInBackground(
  jobId: string,
  source: string,
  clips: { start: number; end: number; index?: number }[],
  audioFiles: Express.Multer.File[],
  clipsOut: string,
  mode: "natural" | "aggressive" | "smart_hybrid",
  sessionDir: string,
  settings: any = {}
) {
  const job = jobs.get(jobId)!;
  let cursor = 0;
  const logs: ClipLog[] = [];
  const warnings: HybridWarning[] = [];

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= clips.length) return;
      const clip = clips[i];
      const audio = audioFiles[i];
      const globalIdx = clip.index ?? i;
      const stem = String(globalIdx + 1).padStart(5, "0");

      const clipLog: ClipLog = {
        clip: globalIdx,
        start: clip.start,
        end: clip.end,
        status: "done",
      };

      try {
        const tmpClip = path.join(clipsOut, `.tmp_clip_${stem}.mp4`);
        const tmpAudio = path.join(clipsOut, `.tmp_aud_${stem}.m4a`);
        const tmpAudioProcessed = path.join(clipsOut, `.tmp_aud_proc_${stem}.m4a`);
        const finalOut = path.join(clipsOut, `${stem}.mp4`);

        // (1) Cut video without re-encoding
        await run("ffmpeg", [
          "-y",
          "-ss", String(clip.start),
          "-to", String(clip.end),
          "-i", source,
          "-c:v", "copy",
          "-an",
          "-avoid_negative_ts", "make_zero",
          tmpClip,
        ]);

        const videoDur = await probeDuration(tmpClip);
        const audioDur = await probeDuration(audio.path);
        const requiredTempo = videoDur > 0 ? audioDur / videoDur : 1.0;

        clipLog.videoDur = videoDur;
        clipLog.audioDur = audioDur;
        clipLog.requiredTempo = requiredTempo;

        let usedAudioTempo = requiredTempo;
        let videoReencoded = false;
        let videoSetPtsFactor = 1.0;

        if (mode === "smart_hybrid") {
          // Smart Hybrid Logic
          if (requiredTempo >= AUDIO_SAFE_MIN && requiredTempo <= AUDIO_SAFE_MAX) {
            // Within safe range: audio only
            usedAudioTempo = requiredTempo;
            videoReencoded = false;
          } else {
            // Outside safe range: clamp audio, adjust video
            usedAudioTempo = clamp(requiredTempo, AUDIO_SAFE_MIN, AUDIO_SAFE_MAX);
            const newAudioDur = audioDur / usedAudioTempo;
            videoSetPtsFactor = newAudioDur / videoDur;
            videoReencoded = true;
            warnings.push({
              clip: globalIdx,
              requiredTempo,
              usedAudioTempo,
              videoReencoded: true,
              reason: "Audio tempo outside safe range, video re-encoded to match",
            });
          }
        } else if (mode === "natural") {
          // Natural mode: never re-encode video, always keep video copy
          usedAudioTempo = clamp(requiredTempo, AUDIO_SAFE_MIN, AUDIO_SAFE_MAX);
          videoReencoded = false;
        } else {
          // aggressive mode
          const { effective } = buildTempoChain(requiredTempo, mode);
          usedAudioTempo = effective;
          videoReencoded = false;
        }

        clipLog.usedAudioTempo = usedAudioTempo;
        clipLog.videoReencoded = videoReencoded;

        // (2a) Adjust audio with tempo + loudnorm (two-pass for loudnorm)
        // First pass: apply tempo and loudnorm
        const tempFilter = `atempo=${usedAudioTempo.toFixed(4)},loudnorm=I=${LOUDNESS_TARGET}:TP=-1.5:LRA=11`;
        await run("ffmpeg", [
          "-y", "-i", audio.path,
          "-filter:a", tempFilter,
          "-ac", "2", "-ar", "48000",
          "-c:a", "aac", "-b:a", "192k",
          tmpAudio,
        ]);

        // (2b) Probe adjusted audio duration
        const adjustedAudioDur = await probeDuration(tmpAudio);
        clipLog.adjustedAudioDur = adjustedAudioDur;

        // (2c) Now apply fade-in and fade-out with correct start time
        const fadeOutStart = Math.max(0, adjustedAudioDur - FADE_OUT_SEC);
        const fadeFilter = `afade=t=in:st=0:d=${FADE_IN_SEC},afade=t=out:st=${fadeOutStart}:d=${FADE_OUT_SEC}`;
        await run("ffmpeg", [
          "-y", "-i", tmpAudio,
          "-filter:a", fadeFilter,
          "-ac", "2", "-ar", "48000",
          "-c:a", "aac", "-b:a", "192k",
          tmpAudioProcessed,
        ]);

        // (3) Mux: apply video speed if needed
        const ffmpegMuxArgs = [
          "-y",
          "-i", tmpClip,
          "-i", tmpAudioProcessed,
          "-map", "0:v:0", "-map", "1:a:0",
        ];

        if (mode === "natural") {
          // Natural mode: ALWAYS copy video, never re-encode
          ffmpegMuxArgs.push("-c:v", "copy");
        } else if (videoReencoded) {
          // Smart hybrid with video re-encode
          const videoFilter = `setpts=${videoSetPtsFactor}*PTS`;
          ffmpegMuxArgs.push("-filter:v", videoFilter);
          ffmpegMuxArgs.push("-c:v", "libx264");
          ffmpegMuxArgs.push("-crf", String(VIDEO_CRF));
          ffmpegMuxArgs.push("-preset", VIDEO_PRESET);
          ffmpegMuxArgs.push("-pix_fmt", "yuv420p");
        } else {
          // Copy video as-is
          ffmpegMuxArgs.push("-c:v", "copy");
        }

        ffmpegMuxArgs.push("-c:a", "aac", "-b:a", "192k");
        ffmpegMuxArgs.push("-shortest");
        ffmpegMuxArgs.push("-movflags", "+faststart");
        ffmpegMuxArgs.push(finalOut);

        await run("ffmpeg", ffmpegMuxArgs);

        await fs.unlink(tmpClip).catch(() => {});
        await fs.unlink(tmpAudio).catch(() => {});
        await fs.unlink(tmpAudioProcessed).catch(() => {});
        await fs.unlink(audio.path).catch(() => {});
        job.completed++;
        logs.push(clipLog);
      } catch (e) {
        job.failed++;
        clipLog.status = "failed";
        clipLog.error = (e as Error).message;
        logs.push(clipLog);
        console.error(`clip ${globalIdx} failed:`, (e as Error).message);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, clips.length) }, worker);
  await Promise.all(workers);
  job.status = job.failed > 0 && job.completed === 0 ? "error" : "done";
  job.finishedAt = Date.now();

  // Write logs and warnings
  await fs.writeFile(
    path.join(sessionDir, "processing_log.json"),
    JSON.stringify(logs, null, 2)
  ).catch(() => {});
  await fs.writeFile(
    path.join(sessionDir, "warnings.json"),
    JSON.stringify(warnings, null, 2)
  ).catch(() => {});
}

// 3) Job status
app.get("/job/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "unknown job" });
  res.json(j);
});

// 4) Stream the clips/ directory as a ZIP
app.get("/download-zip/:sid", async (req, res) => {
  const sid = req.params.sid.replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(sessionDir(sid), "clips");
  if (!existsSync(dir)) return res.status(404).send("No clips for session");

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="final_clips.zip"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => { console.error(err); res.status(500).end(); });
  archive.pipe(res);
  archive.directory(dir, "clips");
  await archive.finalize();
});

// 5) Merge clips into final video
app.post("/merge/:sid", async (req, res) => {
  try {
    const sid = req.params.sid.replace(/[^a-zA-Z0-9_-]/g, "");
    const sid_dir = sessionDir(sid);
    const clipsDir = path.join(sid_dir, "clips");

    if (!existsSync(clipsDir)) {
      return res.status(400).json({ error: "No clips found for session" });
    }

    const files = await fs.readdir(clipsDir);
    const mp4Files = files
      .filter((f) => f.endsWith(".mp4") && !f.startsWith("."))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/[^0-9]/g, ""), 10);
        const numB = parseInt(b.replace(/[^0-9]/g, ""), 10);
        return numA - numB;
      });

    if (mp4Files.length === 0) {
      return res.status(400).json({ error: "No MP4 clips found" });
    }

    const concatFile = path.join(clipsDir, "concat.txt");
    const lines = mp4Files.map((f) => `file '${path.join(clipsDir, f)}'`);
    await fs.writeFile(concatFile, lines.join("\n"));

    const finalOutput = path.join(sid_dir, "final_output.mp4");
    await run("ffmpeg", [
      "-f", "concat",
      "-safe", "0",
      "-i", concatFile,
      "-c", "copy",
      finalOutput,
    ]);

    await fs.unlink(concatFile).catch(() => {});

    res.json({
      ok: true,
      file: "final_output.mp4",
      downloadUrl: `/file/${sid}/final_output.mp4`,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// 6) Download final merged video
app.get("/download-final/:sid", async (req, res) => {
  try {
    const sid = req.params.sid.replace(/[^a-zA-Z0-9_-]/g, "");
    const finalFile = path.join(sessionDir(sid), "final_output.mp4");

    if (!existsSync(finalFile)) {
      return res.status(404).json({ error: "final_output.mp4 not found" });
    }

    const stat = await fs.stat(finalFile);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Content-Disposition", `attachment; filename="final_output.mp4"`);
    createReadStream(finalFile).pipe(res);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// 7) Download all (clips + final output + logs)
app.get("/download-all/:sid", async (req, res) => {
  try {
    const sid = req.params.sid.replace(/[^a-zA-Z0-9_-]/g, "");
    const sid_dir = sessionDir(sid);
    const clipsDir = path.join(sid_dir, "clips");

    if (!existsSync(clipsDir)) {
      return res.status(404).json({ error: "No clips for session" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="dubforge_export.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err) => { console.error(err); res.status(500).end(); });
    archive.pipe(res);

    // Add clips
    archive.directory(clipsDir, "clips");

    // Add final output if exists
    const finalOutput = path.join(sid_dir, "final_output.mp4");
    if (existsSync(finalOutput)) {
      archive.file(finalOutput, { name: "final_output.mp4" });
    }

    // Add logs if they exist
    const logFile = path.join(sid_dir, "processing_log.json");
    if (existsSync(logFile)) {
      archive.file(logFile, { name: "processing_log.json" });
    }

    const warningsFile = path.join(sid_dir, "warnings.json");
    if (existsSync(warningsFile)) {
      archive.file(warningsFile, { name: "warnings.json" });
    }

    await archive.finalize();
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// 8) Direct file fetch
app.get("/file/:sid/:name", async (req, res) => {
  const sid = req.params.sid.replace(/[^a-zA-Z0-9_-]/g, "");
  const name = req.params.name.replace(/[^a-zA-Z0-9_.-]/g, "");
  const filePath = path.join(WORK_DIR, sid, name);
  if (!existsSync(filePath)) return res.status(404).send("Not found");
  const stat = await fs.stat(filePath);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  createReadStream(filePath).pipe(res);
});

// 9) Cleanup
app.post("/cleanup", async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  await fs.rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
  res.json({ ok: true });
});

// Periodic cleanup (24 hours)
setInterval(async () => {
  try {
    const entries = await fs.readdir(WORK_DIR);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const e of entries) {
      const p = path.join(WORK_DIR, e);
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await fs.rm(p, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {}
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`DubForge backend on :${PORT}`);
  console.log(`  work=${WORK_DIR}`);
  console.log(`  concurrency=${CONCURRENCY}`);
  console.log(`  mode support: natural (default) | aggressive | smart_hybrid`);
  console.log(`  loudness target: ${LOUDNESS_TARGET} LUFS`);
  console.log(`  audio safe range: ${AUDIO_SAFE_MIN}–${AUDIO_SAFE_MAX}`);
  console.log(`  fade in/out: ${FADE_IN_SEC}s / ${FADE_OUT_SEC}s`);
});

// unused helper kept for noUnusedLocals tolerance
void createWriteStream;

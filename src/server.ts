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

await fs.mkdir(WORK_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

// ===== Job tracking =====
interface JobStatus {
  total: number;
  completed: number;
  failed: number;
  status: "running" | "done" | "error";
  error?: string;
  startedAt: number;
  finishedAt?: number;
}
const jobs = new Map<string, JobStatus>();

// ===== Helpers =====
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
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

/**
 * Build an atempo filter chain that approximates the target tempo while
 * keeping each individual atempo step within a "natural" range so the voice
 * doesn't sound robotic or chipmunky.
 *
 * mode = "natural":  clamps each factor to [0.85, 1.20] and may not reach
 *                    the exact target — caller can pad/trim to fit.
 * mode = "aggressive": chains factors within [0.5, 2.0] (FFmpeg's hard limit)
 *                     to reach the target exactly.
 *
 * Returns { chain: "atempo=...,atempo=...", effectiveTempo: number }
 */
function buildTempoChain(
  tempo: number,
  mode: "natural" | "aggressive"
): { chain: string; effective: number } {
  if (!isFinite(tempo) || tempo <= 0) return { chain: "atempo=1.0", effective: 1.0 };

  const SAFE_MIN = 0.85, SAFE_MAX = 1.20;
  const HARD_MIN = 0.5,  HARD_MAX = 2.0;

  // Within safe range: one step, sounds great.
  if (tempo >= SAFE_MIN && tempo <= SAFE_MAX) {
    return { chain: `atempo=${tempo.toFixed(4)}`, effective: tempo };
  }

  if (mode === "natural") {
    // Clamp softly to acceptable range (0.75..1.35) using up to two safe steps.
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

  // aggressive: chain within hard limits, prefer steps near safe range
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

// ===== Multer =====
const upload = multer({
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
  limits: { fileSize: 50 * 1024 * 1024 * 1024 },
});

// ===== Endpoints =====
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// 1) Upload base video once per session
app.post("/upload-video", upload.single("video"), async (req, res) => {
  try {
    const sid = req.body.sessionId as string;
    if (!sid || !req.file) return res.status(400).json({ error: "sessionId and video required" });
    const dir = sessionDir(sid);
    await fs.mkdir(dir, { recursive: true });
    // remove any previous source
    for (const f of await fs.readdir(dir)) {
      if (f.startsWith("source")) await fs.unlink(path.join(dir, f)).catch(() => {});
    }
    const dest = path.join(dir, "source" + path.extname(req.file.originalname));
    await fs.rename(req.file.path, dest);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * 2) Process a batch of clips.
 * Body (multipart):
 *   sessionId: string
 *   batchIndex: number (used for output filename offset)
 *   mode: "natural" | "aggressive"  (audio sync strategy)
 *   clips: JSON string of [{ start, end, index }]
 *   audio: files (one per clip), filename MUST start with "<i>_" matching clip array order
 *
 * For each clip:
 *   - Cut video with -c:v copy -an (no re-encode, perfect quality)
 *   - Build atempo chain from audio_duration / video_duration
 *   - Mux with -c:v copy + AAC audio (-shortest)
 *   - Save as clips/NNNN.mp4 inside session dir
 */
app.post("/process-batch", upload.array("audio", 2000), async (req, res) => {
  const sid = req.body.sessionId as string;
  const batchIndex = Number(req.body.batchIndex || 0);
  const mode: "natural" | "aggressive" =
    req.body.mode === "aggressive" ? "aggressive" : "natural";
  const clipsRaw = req.body.clips as string;

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

    const jobId = `${sid}_b${batchIndex}_${Date.now()}`;
    jobs.set(jobId, { total: clips.length, completed: 0, failed: 0, status: "running", startedAt: Date.now() });
    // Respond immediately; processing continues in background.
    res.json({ jobId, total: clips.length });

    processInBackground(jobId, source, clips, audioFiles, clipsOut, mode).catch((e) => {
      const j = jobs.get(jobId);
      if (j) { j.status = "error"; j.error = (e as Error).message; j.finishedAt = Date.now(); }
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

async function processInBackground(
  jobId: string,
  source: string,
  clips: { start: number; end: number; index?: number }[],
  audioFiles: Express.Multer.File[],
  clipsOut: string,
  mode: "natural" | "aggressive"
) {
  const job = jobs.get(jobId)!;
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= clips.length) return;
      const clip = clips[i];
      const audio = audioFiles[i];
      const globalIdx = clip.index ?? i;
      const stem = String(globalIdx + 1).padStart(5, "0");

      try {
        const tmpClip  = path.join(clipsOut, `.tmp_clip_${stem}.mp4`);
        const tmpAudio = path.join(clipsOut, `.tmp_aud_${stem}.m4a`);
        const finalOut = path.join(clipsOut, `${stem}.mp4`);

        // (1) Cut video without re-encoding. Place -ss after -i for accurate cut with copy
        // when keyframes don't align we still need accuracy, so use input-seek + output-seek combo.
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
        const tempo = videoDur > 0 ? audioDur / videoDur : 1.0;
        const { chain } = buildTempoChain(tempo, mode);

        // (2) Adjust audio tempo, encode to AAC
        await run("ffmpeg", [
          "-y", "-i", audio.path,
          "-filter:a", chain,
          "-ac", "2", "-ar", "48000",
          "-c:a", "aac", "-b:a", "192k",
          tmpAudio,
        ]);

        // (3) Mux: video copy + new audio, trim to video duration
        await run("ffmpeg", [
          "-y",
          "-i", tmpClip,
          "-i", tmpAudio,
          "-map", "0:v:0", "-map", "1:a:0",
          "-c:v", "copy",
          "-c:a", "aac", "-b:a", "192k",
          "-shortest",
          "-movflags", "+faststart",
          finalOut,
        ]);

        await fs.unlink(tmpClip).catch(() => {});
        await fs.unlink(tmpAudio).catch(() => {});
        await fs.unlink(audio.path).catch(() => {});
        job.completed++;
      } catch (e) {
        job.failed++;
        console.error(`clip ${globalIdx} failed:`, (e as Error).message);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, clips.length) }, worker);
  await Promise.all(workers);
  job.status = job.failed > 0 && job.completed === 0 ? "error" : "done";
  job.finishedAt = Date.now();
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

// 5) Direct file fetch (compat with existing frontend)
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

// 6) Cleanup
app.post("/cleanup", async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  await fs.rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
  res.json({ ok: true });
});

// Periodic cleanup
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
  console.log(`DubForge backend on :${PORT} | work=${WORK_DIR} | concurrency=${CONCURRENCY}`);
});

// unused helper kept for noUnusedLocals tolerance
void createWriteStream;

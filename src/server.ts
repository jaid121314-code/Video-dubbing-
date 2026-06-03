import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { JobStore, ProcessStage } from "./jobs.js";
import { parseSrt } from "./srt.js";
import { collectAudioFiles, extractZip } from "./zip.js";
import { processJob } from "./processor.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || "./storage");
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || `${16 * 1024 * 1024 * 1024}`, 10);
const UPLOAD_CHUNK_BYTES = parseInt(process.env.UPLOAD_CHUNK_BYTES || `${2 * 1024 * 1024}`, 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

await mkdir(STORAGE_DIR, { recursive: true });

const store = new JobStore();
const app = express();

app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",") }));
app.use(express.json({ limit: "2mb" }));

type UploadKind = "video" | "srt" | "zip";

function isUploadKind(kind: string): kind is UploadKind {
  return kind === "video" || kind === "srt" || kind === "zip";
}

function assetPatch(kind: UploadKind, filePath: string) {
  if (kind === "video") return { videoPath: filePath };
  if (kind === "srt") return { srtPath: filePath };
  return { zipPath: filePath };
}

function safeExtension(fileName: string): string {
  return path.extname(fileName).replace(/[^.a-zA-Z0-9_-]/g, "").slice(0, 16);
}

// Multer storage per-job
function uploader(field: "video" | "srt" | "zip") {
  const storage = multer.diskStorage({
    destination: async (req, _file, cb) => {
      const jobId = (req.params as any).jobId;
      const job = store.get(jobId);
      if (!job) return cb(new Error("Job not found"), "");
      const dir = path.join(job.workDir, "uploads");
      await mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${field}${path.extname(file.originalname) || ""}`),
  });
  return multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } }).single(field);
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Create a job (returns id; client uploads files under /api/upload-*)
app.post("/api/jobs", async (_req, res) => {
  const jobIdDir = path.join(STORAGE_DIR, `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(jobIdDir, { recursive: true });
  const job = store.create(jobIdDir);
  res.json({ jobId: job.id, workDir: job.workDir });
});

function withJob(req: Request, res: Response): { ok: true; job: ReturnType<JobStore["get"]> & {} } | { ok: false } {
  const jobId = req.params.jobId;
  const job = store.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return { ok: false };
  }
  return { ok: true, job };
}

app.post("/api/upload-video/:jobId", (req, res, next) => {
  uploader("video")(req, res, (err) => {
    if (err) return next(err);
    const r = withJob(req, res); if (!r.ok) return;
    r.job.assets.videoPath = req.file!.path;
    store.update(r.job.id, { stage: ProcessStage.Uploading, assets: r.job.assets });
    res.json({ ok: true, path: req.file!.path, size: req.file!.size });
  });
});

app.post("/api/upload-srt/:jobId", (req, res, next) => {
  uploader("srt")(req, res, (err) => {
    if (err) return next(err);
    const r = withJob(req, res); if (!r.ok) return;
    r.job.assets.srtPath = req.file!.path;
    store.update(r.job.id, { assets: r.job.assets });
    res.json({ ok: true, path: req.file!.path, size: req.file!.size });
  });
});

app.post("/api/upload-zip/:jobId", (req, res, next) => {
  uploader("zip")(req, res, (err) => {
    if (err) return next(err);
    const r = withJob(req, res); if (!r.ok) return;
    r.job.assets.zipPath = req.file!.path;
    store.update(r.job.id, { assets: r.job.assets });
    res.json({ ok: true, path: req.file!.path, size: req.file!.size });
  });
});

app.post(
  "/api/upload-chunk/:jobId/:kind",
  express.raw({ type: "*/*", limit: UPLOAD_CHUNK_BYTES + 1024 }),
  async (req, res) => {
    const r = withJob(req, res); if (!r.ok) return;
    const kind = req.params.kind;
    if (!isUploadKind(kind)) return res.status(400).json({ error: "Invalid upload type" });

    const fileName = String(req.header("x-file-name") || kind);
    const fileSize = Number(req.header("x-file-size"));
    const chunkIndex = Number(req.header("x-chunk-index"));
    const totalChunks = Number(req.header("x-total-chunks"));
    const chunkStart = Number(req.header("x-chunk-start"));
    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);

    if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: "File is too large or invalid" });
    }
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || !Number.isInteger(chunkStart) || chunkIndex < 0 || totalChunks < 1 || chunkStart < 0) {
      return res.status(400).json({ error: "Invalid chunk metadata" });
    }
    if (chunk.length === 0 || chunk.length > UPLOAD_CHUNK_BYTES) {
      return res.status(413).json({ error: "Invalid chunk size" });
    }

    const uploadDir = path.join(r.job.workDir, "uploads");
    await mkdir(uploadDir, { recursive: true });
    const partialPath = path.join(uploadDir, `${kind}.part`);
    const finalPath = path.join(uploadDir, `${kind}${safeExtension(fileName)}`);

    const handle = await open(partialPath, chunkIndex === 0 ? "w" : "a+");
    try {
      await handle.write(chunk, 0, chunk.length, chunkStart);
    } finally {
      await handle.close();
    }

    if (chunkIndex === totalChunks - 1) {
      const partialStat = await stat(partialPath);
      if (partialStat.size < fileSize) {
        return res.status(409).json({ error: "Upload incomplete, retry the last chunk" });
      }
      await rename(partialPath, finalPath);
      r.job.assets = { ...r.job.assets, ...assetPatch(kind, finalPath) };
      store.update(r.job.id, {
        stage: kind === "video" ? ProcessStage.Uploading : r.job.stage,
        assets: r.job.assets,
      });
      return res.json({ ok: true, complete: true, path: finalPath, size: fileSize });
    }

    store.update(r.job.id, { stage: ProcessStage.Uploading });
    res.json({ ok: true, complete: false, received: chunkStart + chunk.length });
  }
);

app.post("/api/process/:jobId", async (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  const job = r.job;
  const {
    keepBackgroundMusic = false,
    backgroundVolume = 0.15,
    mode = "manhua",
    batchSize = 100,
    loudnessLufs = -16,
  } = req.body ?? {};

  if (!job.assets.videoPath || !job.assets.srtPath || !job.assets.zipPath) {
    return res.status(400).json({ error: "Missing video, srt, or zip upload" });
  }

  res.json({ ok: true, jobId: job.id });

  // Run async
  (async () => {
    try {
      store.update(job.id, { stage: ProcessStage.Analyzing, progress: 2 });
      const segments = await parseSrt(job.assets.srtPath!);

      const extractDir = path.join(job.workDir, "audio");
      await extractZip(job.assets.zipPath!, extractDir);
      const audioFiles = await collectAudioFiles(extractDir);

      store.update(job.id, {
        totalSegments: segments.length,
        processedSegments: 0,
      });

      if (audioFiles.length !== segments.length) {
        throw new Error(`Mismatch: ${segments.length} SRT segments vs ${audioFiles.length} audio files`);
      }

      const safeBatch = Math.max(1, Math.min(500, Number(batchSize) || 100));
      const safeLufs = Math.max(-30, Math.min(-9, Number(loudnessLufs) || -16));

      await processJob({
        jobId: job.id,
        workDir: job.workDir,
        videoPath: job.assets.videoPath!,
        segments,
        audioFiles,
        keepBackgroundMusic: !!keepBackgroundMusic,
        backgroundVolume: Number(backgroundVolume) || 0.15,
        mode: mode === "anime" ? "anime" : "manhua",
        batchSize: safeBatch,
        loudnessLufs: safeLufs,
        store,
      });
    } catch (e: any) {
      console.error("[job failed]", job.id, e);
      store.fail(job.id, e?.message || String(e));
    }
  })();
});

app.get("/api/status/:jobId", (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  const j = r.job;
  res.json({
    id: j.id,
    stage: j.stage,
    progress: j.progress,
    error: j.error,
    processedSegments: j.processedSegments,
    totalSegments: j.totalSegments,
    currentBatch: j.currentBatch,
    totalBatches: j.totalBatches,
    preview: j.preview,
    hasOutput: !!j.finalPath,
  });
});

app.get("/api/download/:jobId", async (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  const j = r.job;
  if (!j.finalPath || !existsSync(j.finalPath)) {
    return res.status(404).json({ error: "Output not ready" });
  }
  const s = await stat(j.finalPath);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", s.size.toString());
  res.setHeader("Content-Disposition", `attachment; filename="autodub_${j.id}.mp4"`);
  createReadStream(j.finalPath).pipe(res);
});

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api error]", err);
  res.status(500).json({ error: err?.message || "Internal error" });
});

app.listen(PORT, () => {
  console.log(`AutoDub backend listening on :${PORT}`);
  console.log(`Storage dir: ${STORAGE_DIR}`);
});

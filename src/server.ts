import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import archiver from "archiver";
import path from "node:path";
import { mkdir, stat, writeFile, rm, readdir } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { JobStore, ProcessStage, JobValidation } from "./jobs.js";
import { parseSrt, normalizeSegments } from "./srt.js";
import { collectAudioFiles, extractZip } from "./zip.js";
import { processJob } from "./processor.js";
import { probeVideo } from "./ffmpeg.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || "./storage");
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || `${16 * 1024 * 1024 * 1024}`, 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const CLEANUP_AFTER_HOURS = parseInt(process.env.CLEANUP_AFTER_HOURS || "24", 10);

await mkdir(STORAGE_DIR, { recursive: true });

const store = new JobStore();
const app = express();

app.use(cors({
  origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(","),
  exposedHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
}));
app.use(express.json({ limit: "2mb" }));

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

app.post("/api/jobs", async (_req, res) => {
  const jobIdDir = path.join(STORAGE_DIR, `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(jobIdDir, { recursive: true });
  const job = store.create(jobIdDir);
  res.json({ ok: true, jobId: job.id, workDir: job.workDir });
});

function withJob(req: Request, res: Response) {
  const jobId = req.params.jobId;
  const job = store.get(jobId);
  if (!job) {
    res.status(404).json({ ok: false, error: "Job not found" });
    return { ok: false as const };
  }
  return { ok: true as const, job };
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

async function buildValidation(job: ReturnType<JobStore["get"]>): Promise<JobValidation> {
  if (!job) throw new Error("Job missing");
  if (!job.assets.videoPath || !job.assets.srtPath || !job.assets.zipPath) {
    throw new Error("Missing video, srt, or zip upload");
  }
  const probe = await probeVideo(job.assets.videoPath);
  const { segments } = await parseSrt(job.assets.srtPath);
  const normalized = normalizeSegments(segments, probe.durationSec);

  // Extract zip if not yet extracted
  const extractDir = path.join(job.workDir, "audio");
  if (!existsSync(extractDir)) {
    await extractZip(job.assets.zipPath, extractDir);
  }
  const audioFiles = await collectAudioFiles(extractDir);

  const countMatch = audioFiles.length === normalized.segments.length;
  const passed = countMatch && normalized.invalid.length === 0;

  const validation: JobValidation = {
    videoDuration: probe.durationSec,
    srtSegments: normalized.segments.length,
    audioFiles: audioFiles.length,
    countMatch,
    timestampWarnings: normalized.warnings,
    invalidSegments: normalized.invalid,
    passed,
  };
  store.update(job.id, { validation });
  return validation;
}

app.post("/api/analyze/:jobId", async (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  try {
    store.update(r.job.id, { stage: ProcessStage.Validating });
    const validation = await buildValidation(r.job);
    res.json({ ok: true, jobId: r.job.id, validation });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/process/:jobId", async (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  const job = r.job;
  const { keepBackgroundMusic = false, backgroundVolume = 0.15 } = req.body ?? {};

  if (!job.assets.videoPath || !job.assets.srtPath || !job.assets.zipPath) {
    return res.status(400).json({ ok: false, error: "Missing video, srt, or zip upload" });
  }

  // Validate first
  let validation: JobValidation;
  try {
    store.update(job.id, { stage: ProcessStage.Validating, progress: 1 });
    validation = await buildValidation(job);
  } catch (e: any) {
    store.fail(job.id, e?.message || String(e));
    return res.status(400).json({ ok: false, error: e?.message || String(e) });
  }

  if (!validation.countMatch) {
    const msg = `Mismatch: ${validation.srtSegments} SRT segments vs ${validation.audioFiles} audio files`;
    store.fail(job.id, msg);
    return res.status(400).json({ ok: false, error: msg, validation });
  }
  if (validation.invalidSegments.length > 0) {
    const msg = `Invalid segments: ${validation.invalidSegments.map((s) => s.index).join(", ")}`;
    store.fail(job.id, msg);
    return res.status(400).json({ ok: false, error: msg, validation });
  }

  res.json({
    ok: true,
    jobId: job.id,
    validation: {
      videoDuration: validation.videoDuration,
      srtSegments: validation.srtSegments,
      audioFiles: validation.audioFiles,
      countMatch: validation.countMatch,
      timestampWarnings: validation.timestampWarnings,
    },
  });

  (async () => {
    try {
      const videoProbe = await probeVideo(job.assets.videoPath!);
      const { segments } = await parseSrt(job.assets.srtPath!);
      const normalized = normalizeSegments(segments, videoProbe.durationSec);
      const extractDir = path.join(job.workDir, "audio");
      const audioFiles = await collectAudioFiles(extractDir);

      store.update(job.id, {
        totalSegments: normalized.segments.length,
        processedSegments: 0,
      });

      const { finalPath, report } = await processJob({
        jobId: job.id,
        workDir: job.workDir,
        videoPath: job.assets.videoPath!,
        videoProbe,
        segments: normalized.segments,
        audioFiles,
        keepBackgroundMusic: !!keepBackgroundMusic,
        backgroundVolume: Number(backgroundVolume) || 0.15,
        store,
      });

      // Write reports
      const reportPath = path.join(job.workDir, "output", "sync_report.json");
      await writeFile(reportPath, JSON.stringify({
        jobId: job.id,
        videoDuration: videoProbe.durationSec,
        outputFps: parseInt(process.env.OUTPUT_FPS || "30", 10),
        timestampWarnings: normalized.warnings,
        segments: report,
      }, null, 2));

      const audioReportPath = path.join(job.workDir, "output", "audio_files_report.json");
      await writeFile(audioReportPath, JSON.stringify({
        jobId: job.id,
        count: audioFiles.length,
        files: audioFiles.map((f) => path.basename(f)),
      }, null, 2));

      store.update(job.id, {
        stage: ProcessStage.Completed,
        progress: 100,
        finalPath,
        segmentReport: report,
        completedAt: Date.now(),
      });
    } catch (e: any) {
      console.error("[job failed]", job.id, e);
      const j = store.get(job.id);
      store.fail(job.id, e?.message || String(e), j?.errorSegment);
    }
  })();
});

app.get("/api/status/:jobId", (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  const j = r.job;
  res.json({
    ok: true,
    id: j.id,
    stage: j.stage,
    progress: j.progress,
    error: j.error,
    errorSegment: j.errorSegment,
    retryingSegment: j.retryingSegment,
    processedSegments: j.processedSegments,
    totalSegments: j.totalSegments,
    preview: j.preview,
    validation: j.validation,
    hasOutput: !!j.finalPath,
  });
});

// Inline streaming for in-browser playback (watch before download)
app.get("/api/preview/:jobId", async (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  const j = r.job;
  if (!j.finalPath || !existsSync(j.finalPath)) {
    return res.status(404).json({ ok: false, error: "Output not ready" });
  }
  const s = await stat(j.finalPath);
  const size = s.size;
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", `inline; filename="preview_${j.id}.mp4"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) { res.status(416).setHeader("Content-Range", `bytes */${size}`); return res.end(); }
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (isNaN(start) || isNaN(end) || start > end || end >= size) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`); return res.end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(j.finalPath, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", String(size));
    createReadStream(j.finalPath).pipe(res);
  }
});

// Simple HTML watch page so users can preview in any browser before downloading
app.get("/watch/:jobId", (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  const j = r.job;
  if (!j.finalPath || !existsSync(j.finalPath)) {
    return res.status(404).send("Output not ready");
  }
  const src = `/api/preview/${j.id}`;
  const dl = `/api/download/${j.id}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AutoDub Preview ${j.id}</title>
<style>html,body{margin:0;background:#0b0b0b;color:#eee;font-family:system-ui,sans-serif;height:100%}
.wrap{max-width:960px;margin:0 auto;padding:16px}
video{width:100%;max-height:70vh;background:#000;border-radius:8px}
a.btn{display:inline-block;margin-top:12px;padding:10px 16px;background:#3b82f6;color:#fff;text-decoration:none;border-radius:6px}
</style></head><body><div class="wrap">
<h2>Preview — Job ${j.id}</h2>
<video src="${src}" controls playsinline preload="metadata"></video>
<div><a class="btn" href="${dl}">Download MP4</a></div>
</div></body></html>`);
});

// Range-aware MP4 download (mobile + browser safe for large files)
app.get("/api/download/:jobId", async (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  const j = r.job;
  if (!j.finalPath || !existsSync(j.finalPath)) {
    return res.status(404).json({ ok: false, error: "Output not ready" });
  }
  const s = await stat(j.finalPath);
  const size = s.size;
  const filename = `autodub_${j.id}.mp4`;

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`);
      return res.end();
    }
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (isNaN(start) || isNaN(end) || start > end || end >= size) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`);
      return res.end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(j.finalPath, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", String(size));
    createReadStream(j.finalPath).pipe(res);
  }
});

// Optional ZIP download: final.mp4 + reports
app.get("/api/download-zip/:jobId", async (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  const j = r.job;
  if (!j.finalPath || !existsSync(j.finalPath)) {
    return res.status(404).json({ ok: false, error: "Output not ready" });
  }
  const outDir = path.dirname(j.finalPath);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="autodub_${j.id}.zip"`);
  const zip = archiver("zip", { zlib: { level: 6 } });
  zip.on("error", (err) => {
    console.error("[zip error]", err);
    try { res.status(500).end(); } catch {}
  });
  zip.pipe(res);
  zip.file(j.finalPath, { name: "final.mp4" });
  const syncReport = path.join(outDir, "sync_report.json");
  if (existsSync(syncReport)) zip.file(syncReport, { name: "sync_report.json" });
  const audioReport = path.join(outDir, "audio_files_report.json");
  if (existsSync(audioReport)) zip.file(audioReport, { name: "audio_files_report.json" });
  await zip.finalize();
});

// Manual cleanup
app.post("/api/cleanup/:jobId", async (req, res) => {
  const r = withJob(req, res); if (!r.ok) return;
  await rm(r.job.workDir, { recursive: true, force: true }).catch(() => {});
  store.delete(r.job.id);
  res.json({ ok: true });
});

// Periodic cleanup of completed/failed jobs older than CLEANUP_AFTER_HOURS
async function periodicCleanup() {
  const cutoff = Date.now() - CLEANUP_AFTER_HOURS * 3600 * 1000;
  for (const j of store.all()) {
    const ts = j.completedAt ?? j.createdAt;
    if (
      ts < cutoff &&
      (j.stage === ProcessStage.Completed || j.stage === ProcessStage.Failed)
    ) {
      await rm(j.workDir, { recursive: true, force: true }).catch(() => {});
      store.delete(j.id);
    }
  }
  // Also remove orphan job_ dirs not tracked in memory (after restart)
  try {
    const entries = await readdir(STORAGE_DIR, { withFileTypes: true });
    const known = new Set(store.all().map((j) => path.basename(j.workDir)));
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith("job_")) continue;
      if (known.has(e.name)) continue;
      const dirPath = path.join(STORAGE_DIR, e.name);
      const st = await stat(dirPath).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await rm(dirPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {}
}
setInterval(periodicCleanup, 60 * 60 * 1000).unref?.();

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api error]", err);
  res.status(500).json({ ok: false, error: err?.message || "Internal error" });
});

app.listen(PORT, () => {
  console.log(`AutoDub backend listening on :${PORT}`);
  console.log(`Storage dir: ${STORAGE_DIR}`);
});

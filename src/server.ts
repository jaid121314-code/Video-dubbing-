import express, { type Request, type Response } from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8080);
const WORK_DIR = process.env.WORK_DIR || path.join(os.tmpdir(), "dubforge");

await fs.mkdir(WORK_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ===== Helpers =====

function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-2000)}`));
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
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err}`));
      resolve(parseFloat(out.trim()) || 0);
    });
  });
}

function sessionDir(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(WORK_DIR, safe);
}

// ===== Multer storage =====
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
  limits: { fileSize: 50 * 1024 * 1024 * 1024 }, // 50GB
});

// ===== Endpoints =====

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Upload base video once per session
app.post("/upload-video", upload.single("video"), async (req, res) => {
  try {
    const sid = req.body.sessionId as string;
    if (!sid || !req.file) return res.status(400).json({ error: "sessionId and video required" });
    const dir = sessionDir(sid);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, "source" + path.extname(req.file.originalname));
    await fs.rename(req.file.path, dest);
    res.json({ ok: true, path: dest });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Process a batch of clips
app.post("/process-batch", upload.array("audio", 1000), async (req, res) => {
  const sid = req.body.sessionId as string;
  const batchIndex = Number(req.body.batchIndex);
  const mode = (req.body.mode as "comic" | "movie") || "comic";
  const loudness = Number(req.body.loudness ?? -16);
  const fadeMs = Number(req.body.fadeMs ?? 25);
  const clipsRaw = req.body.clips as string;

  try {
    if (!sid || isNaN(batchIndex) || !clipsRaw) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const clips: { start: number; end: number }[] = JSON.parse(clipsRaw);
    const audioFiles = (req.files as Express.Multer.File[]) || [];
    if (audioFiles.length !== clips.length) {
      return res.status(400).json({ error: `Audio count ${audioFiles.length} != clips ${clips.length}` });
    }

    // Sort audio files by leading index prefix we set on the client (i_<name>)
    audioFiles.sort((a, b) => {
      const ai = parseInt(a.originalname.split("_")[0], 10);
      const bi = parseInt(b.originalname.split("_")[0], 10);
      return ai - bi;
    });

    const dir = sessionDir(sid);
    const sourceCandidates = (await fs.readdir(dir)).filter((f) => f.startsWith("source"));
    if (!sourceCandidates.length) return res.status(400).json({ error: "Source video not uploaded" });
    const source = path.join(dir, sourceCandidates[0]);

    const batchDir = path.join(dir, `batch_${batchIndex}`);
    await fs.mkdir(batchDir, { recursive: true });

    const sourceDuration = await probeDuration(source);
    const segmentPaths: string[] = [];
    let prevEnd = 0;

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const audio = audioFiles[i];

      // In movie mode, keep the gap from prevEnd to clip.start untouched.
      if (mode === "movie" && clip.start > prevEnd + 0.001) {
        const gapPath = path.join(batchDir, `gap_${i}.mp4`);
        await run("ffmpeg", [
          "-y", "-ss", String(prevEnd), "-to", String(clip.start),
          "-i", source,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          "-c:a", "aac", "-b:a", "192k",
          "-avoid_negative_ts", "make_zero",
          gapPath,
        ]);
        segmentPaths.push(gapPath);
      }

      // Normalize + fade the narration audio
      const normAudio = path.join(batchDir, `aud_${i}.m4a`);
      await run("ffmpeg", [
        "-y", "-i", audio.path,
        "-af", `loudnorm=I=${loudness}:TP=-1.5:LRA=11,afade=t=in:st=0:d=${fadeMs / 1000},areverse,afade=t=in:st=0:d=${fadeMs / 1000},areverse`,
        "-ac", "2", "-ar", "48000",
        "-c:a", "aac", "-b:a", "192k",
        normAudio,
      ]);

      const audioDur = await probeDuration(normAudio);
      const videoDur = Math.max(0.01, clip.end - clip.start);

      // Cut video segment for this clip
      const rawSeg = path.join(batchDir, `raw_${i}.mp4`);
      await run("ffmpeg", [
        "-y", "-ss", String(clip.start), "-to", String(clip.end),
        "-i", source,
        "-an",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-avoid_negative_ts", "make_zero",
        rawSeg,
      ]);

      // Speed-match video to audio: setpts factor = audioDur / videoDur
      const ptsFactor = audioDur / videoDur;
      const matchedSeg = path.join(batchDir, `seg_${i}.mp4`);
      await run("ffmpeg", [
        "-y", "-i", rawSeg, "-i", normAudio,
        "-filter_complex", `[0:v]setpts=${ptsFactor.toFixed(6)}*PTS[v]`,
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        matchedSeg,
      ]);
      segmentPaths.push(matchedSeg);

      // Cleanup intermediate
      await fs.unlink(rawSeg).catch(() => {});
      await fs.unlink(normAudio).catch(() => {});

      prevEnd = clip.end;
    }

    // If this is the LAST clip and movie mode, the tail gap is preserved during finalize (not here)
    // Concat all segments using concat demuxer (re-encode to ensure perfect joins)
    const listFile = path.join(batchDir, "list.txt");
    await fs.writeFile(
      listFile,
      segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
    );
    const batchOut = path.join(dir, `batch_${batchIndex}.mp4`);
    await run("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k",
      batchOut,
    ]);

    // Cleanup batch dir
    await fs.rm(batchDir, { recursive: true, force: true }).catch(() => {});
    for (const f of audioFiles) await fs.unlink(f.path).catch(() => {});

    const base = `${req.protocol}://${req.get("host")}`;
    res.json({
      batchId: `batch_${batchIndex}`,
      outputUrl: `${base}/file/${path.basename(dir)}/batch_${batchIndex}.mp4`,
      sourceDuration,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// Finalize: download partials from URLs, concat
app.post("/finalize", async (req: Request, res: Response) => {
  try {
    const { sessionId, partials } = req.body as { sessionId: string; partials: string[] };
    if (!sessionId || !Array.isArray(partials)) {
      return res.status(400).json({ error: "sessionId + partials required" });
    }
    const dir = sessionDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const localPartials: string[] = [];

    for (let i = 0; i < partials.length; i++) {
      const url = partials[i];
      const local = path.join(dir, `partial_${i}.mp4`);
      if (url.startsWith(`${req.protocol}://${req.get("host")}`) || url.includes(path.basename(dir))) {
        // Local file potentially
        const localName = url.split("/file/")[1];
        if (localName) {
          const candidate = path.join(WORK_DIR, localName);
          if (existsSync(candidate)) {
            localPartials.push(candidate);
            continue;
          }
        }
      }
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Failed to fetch partial: ${url}`);
      const buf = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(local, buf);
      localPartials.push(local);
    }

    const listFile = path.join(dir, "final_list.txt");
    await fs.writeFile(
      listFile,
      localPartials.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n")
    );
    const finalOut = path.join(dir, "final.mp4");
    await run("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listFile,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
      finalOut,
    ]);

    const base = `${req.protocol}://${req.get("host")}`;
    res.json({ downloadUrl: `${base}/file/${path.basename(dir)}/final.mp4` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e as Error).message });
  }
});

// Serve files
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

// Cleanup endpoint
app.post("/cleanup", async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  await fs.rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => {});
  res.json({ ok: true });
});

// Periodic cleanup of sessions older than 24h
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
  console.log(`DubForge backend listening on :${PORT} (work=${WORK_DIR})`);
});

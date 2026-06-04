import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { Segment } from "./srt.js";
import { getDurationSec, runFfmpeg } from "./ffmpeg.js";
import { JobStore, ProcessStage } from "./jobs.js";

export type DubMode = "manhua" | "anime";

export interface ProcessOptions {
  jobId: string;
  workDir: string;
  videoPath: string;
  segments: Segment[];
  audioFiles: string[];
  keepBackgroundMusic: boolean;
  backgroundVolume: number; // 0..1
  mode: DubMode;
  batchSize: number;       // parallel segments per batch (manhua)
  loudnessLufs: number;    // target integrated loudness, e.g. -16
  store: JobStore;
}

// Loudnorm filter shared by every per-segment encode and the anime track.
function loudnormFilter(lufs: number): string {
  const I = Math.max(-30, Math.min(-9, lufs));
  return `loudnorm=I=${I}:TP=-1.5:LRA=11`;
}

export async function processJob(opts: ProcessOptions): Promise<string> {
  if (opts.mode === "anime") return processAnime(opts);
  return processManhua(opts);
}

/* ------------------------------------------------------------------ */
/* MANHUA MODE — video stretches/compresses to match narration length */
/* ------------------------------------------------------------------ */

async function processManhua(opts: ProcessOptions): Promise<string> {
  const {
    jobId, workDir, videoPath, segments, audioFiles,
    keepBackgroundMusic, backgroundVolume, batchSize, loudnessLufs, store,
  } = opts;

  if (segments.length !== audioFiles.length) {
    throw new Error(`Segment/audio count mismatch: ${segments.length} vs ${audioFiles.length}`);
  }

  const segDir = path.join(workDir, "segments");
  const outDir = path.join(workDir, "output");
  await mkdir(segDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  store.update(jobId, { stage: ProcessStage.Analyzing, progress: 4 });

  // Probe durations + preview
  const previews: { index: number; videoDur: number; audioDur: number; speed: number }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const audioDur = await getDurationSec(audioFiles[i]);
    const videoDur = segments[i].durationSec;
    previews.push({ index: i + 1, videoDur, audioDur, speed: videoDur / audioDur });
  }
  store.update(jobId, { preview: previews, totalSegments: segments.length, processedSegments: 0 });

  store.update(jobId, { stage: ProcessStage.Syncing, progress: 8 });

  const segOutputs: string[] = new Array(segments.length);
  let completed = 0;
  const total = segments.length;
  const batches = Math.ceil(total / batchSize);
  store.update(jobId, { totalBatches: batches, currentBatch: 0 });

  for (let b = 0; b < batches; b++) {
    const start = b * batchSize;
    const end = Math.min(total, start + batchSize);
    store.update(jobId, { currentBatch: b + 1 });

    await Promise.all(
      Array.from({ length: end - start }, (_, k) => start + k).map(async (i) => {
        const seg = segments[i];
        const audio = audioFiles[i];
        const audioDur = previews[i].audioDur;
        const segOut = path.join(segDir, `seg_${String(i).padStart(6, "0")}.mp4`);
        const slicePath = path.join(segDir, `slice_${i}.mp4`);

        await runFfmpeg([
          "-y",
          "-ss", seg.startSec.toFixed(3),
          "-to", seg.endSec.toFixed(3),
          "-i", videoPath,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an",
          slicePath,
        ]);

        const ptsFactor = audioDur / seg.durationSec;
        const ln = loudnormFilter(loudnessLufs);
        const videoFilter = `[0:v]setpts=${ptsFactor.toFixed(6)}*PTS[v]`;

        const args = ["-y", "-i", slicePath, "-i", audio];
        if (keepBackgroundMusic) {
          args.push("-ss", seg.startSec.toFixed(3), "-to", seg.endSec.toFixed(3), "-i", videoPath);
          const vol = Math.max(0, Math.min(1, backgroundVolume));
          const combined =
            `${videoFilter};` +
            `[1:a]${ln}[na];` +
            `[2:a]atempo=${(1 / ptsFactor).toFixed(6)},volume=${vol}[bg];` +
            `[na][bg]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.97[a]`;
          args.push("-filter_complex", combined, "-map", "[v]", "-map", "[a]");
        } else {
          const combined = `${videoFilter};[1:a]${ln},alimiter=limit=0.97[a]`;
          args.push("-filter_complex", combined, "-map", "[v]", "-map", "[a]");
        }

        args.push(
          "-t", audioDur.toFixed(3),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
          "-movflags", "+faststart",
          segOut,
        );

        await runFfmpeg(args);
        await rm(slicePath, { force: true });
        segOutputs[i] = segOut;

        completed++;
        const pct = 8 + Math.round((completed / total) * 80);
        store.update(jobId, {
          stage: ProcessStage.Syncing,
          progress: pct,
          processedSegments: completed,
        });
      }),
    );
  }

  store.update(jobId, { stage: ProcessStage.Merging, progress: 90 });

  const concatListPath = path.join(workDir, "concat.txt");
  await writeFile(
    concatListPath,
    segOutputs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
  );

  const finalPath = path.join(outDir, "final.mp4");
  await runFfmpeg([
    "-y", "-f", "concat", "-safe", "0", "-i", concatListPath,
    "-c", "copy", "-movflags", "+faststart", finalPath,
  ]);

  store.update(jobId, { stage: ProcessStage.Completed, progress: 100, finalPath });
  await rm(segDir, { recursive: true, force: true }).catch(() => {});
  return finalPath;
}

/* ------------------------------------------------------------------ */
/* ANIME MODE — preserve original timeline, mix narration at SRT times */
/* ------------------------------------------------------------------ */

async function processAnime(opts: ProcessOptions): Promise<string> {
  const {
    jobId, workDir, videoPath, segments, audioFiles,
    keepBackgroundMusic, backgroundVolume, loudnessLufs, store,
  } = opts;

  if (segments.length !== audioFiles.length) {
    throw new Error(`Segment/audio count mismatch: ${segments.length} vs ${audioFiles.length}`);
  }

  const outDir = path.join(workDir, "output");
  const tmpDir = path.join(workDir, "anime");
  await mkdir(outDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  store.update(jobId, { stage: ProcessStage.Analyzing, progress: 5 });
  const videoDur = await getDurationSec(videoPath);

  // Preview
  const previews = [];
  for (let i = 0; i < segments.length; i++) {
    const audioDur = await getDurationSec(audioFiles[i]);
    previews.push({
      index: i + 1,
      videoDur: segments[i].durationSec,
      audioDur,
      speed: 1, // anime mode does not stretch
    });
  }
  store.update(jobId, {
    preview: previews,
    totalSegments: segments.length,
    processedSegments: 0,
    stage: ProcessStage.Syncing,
    progress: 10,
  });

  // 1. Normalize each narration clip to wav at 48k stereo and trim if longer than gap to next cue.
  const normDir = path.join(tmpDir, "norm");
  await mkdir(normDir, { recursive: true });
  const normalized: { path: string; dur: number; start: number }[] = [];

  const ln = loudnormFilter(loudnessLufs);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextStart = i + 1 < segments.length ? segments[i + 1].startSec : videoDur;
    const maxDur = Math.max(0.1, nextStart - seg.startSec); // never overlap next cue
    const outWav = path.join(normDir, `n_${String(i).padStart(6, "0")}.wav`);
    await runFfmpeg([
      "-y", "-i", audioFiles[i],
      "-af", `${ln},alimiter=limit=0.97`,
      "-t", maxDur.toFixed(3),
      "-ar", "48000", "-ac", "2",
      outWav,
    ]);
    const dur = await getDurationSec(outWav);
    normalized.push({ path: outWav, dur, start: seg.startSec });

    if ((i + 1) % 25 === 0 || i === segments.length - 1) {
      const pct = 10 + Math.round(((i + 1) / segments.length) * 40);
      store.update(jobId, { progress: pct, processedSegments: i + 1 });
    }
  }

  // 2. Build full-length narration track by concatenating silence + clip + silence ...
  store.update(jobId, { stage: ProcessStage.Merging, progress: 55 });
  const partsList = path.join(tmpDir, "parts.txt");
  const parts: string[] = [];
  let cursor = 0;
  const silenceDir = path.join(tmpDir, "sil");
  await mkdir(silenceDir, { recursive: true });

  async function silenceWav(seconds: number, idx: number): Promise<string> {
    const out = path.join(silenceDir, `s_${idx}.wav`);
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-t", seconds.toFixed(3), out,
    ]);
    return out;
  }

  for (let i = 0; i < normalized.length; i++) {
    const n = normalized[i];
    const gap = n.start - cursor;
    if (gap > 0.01) parts.push(await silenceWav(gap, i));
    parts.push(n.path);
    cursor = n.start + n.dur;
  }
  const tail = videoDur - cursor;
  if (tail > 0.01) parts.push(await silenceWav(tail, normalized.length));

  await writeFile(
    partsList,
    parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"),
  );

  const narrationTrack = path.join(tmpDir, "narration.wav");
  await runFfmpeg([
    "-y", "-f", "concat", "-safe", "0", "-i", partsList,
    "-ar", "48000", "-ac", "2", narrationTrack,
  ]);

  store.update(jobId, { progress: 80 });

  // 3. Mux narration with the original video (video stream copied, no re-encode).
  const finalPath = path.join(outDir, "final.mp4");
  if (keepBackgroundMusic) {
    const vol = Math.max(0, Math.min(1, backgroundVolume));
    await runFfmpeg([
      "-y", "-i", videoPath, "-i", narrationTrack,
      "-filter_complex",
      `[0:a]volume=${vol}[bg];[1:a][bg]amix=inputs=2:duration=longest:dropout_transition=0,alimiter=limit=0.97[a]`,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-shortest", "-movflags", "+faststart",
      finalPath,
    ]);
  } else {
    await runFfmpeg([
      "-y", "-i", videoPath, "-i", narrationTrack,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
      "-shortest", "-movflags", "+faststart",
      finalPath,
    ]);
  }

  store.update(jobId, { stage: ProcessStage.Completed, progress: 100, finalPath });
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  return finalPath;
}

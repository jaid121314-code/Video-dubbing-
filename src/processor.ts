import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { Segment } from "./srt.js";
import { getDurationSec, runFfmpeg } from "./ffmpeg.js";
import { JobStore, ProcessStage } from "./jobs.js";

export interface ProcessOptions {
  jobId: string;
  workDir: string;
  videoPath: string;
  segments: Segment[];
  audioFiles: string[];
  keepBackgroundMusic: boolean;
  backgroundVolume: number; // 0..1
  store: JobStore;
}

// atempo accepts 0.5..100 per filter; chain to reach extreme ratios.
function clampAtempo(ratio: number): string {
  if (!isFinite(ratio) || ratio <= 0) return "1.0";
  return Math.max(0.5, Math.min(2.0, ratio)).toFixed(6);
}

export async function processJob(opts: ProcessOptions): Promise<string> {
  const { jobId, workDir, videoPath, segments, audioFiles, keepBackgroundMusic, backgroundVolume, store } = opts;

  if (segments.length !== audioFiles.length) {
    throw new Error(`Segment/audio count mismatch: ${segments.length} segments vs ${audioFiles.length} audio files`);
  }

  const segDir = path.join(workDir, "segments");
  const outDir = path.join(workDir, "output");
  await mkdir(segDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  store.update(jobId, { stage: ProcessStage.Analyzing, progress: 5 });

  // Probe audio durations + compute speed factors (preview)
  const previews: { index: number; videoDur: number; audioDur: number; speed: number }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const audioDur = await getDurationSec(audioFiles[i]);
    const videoDur = segments[i].durationSec;
    const speed = videoDur / audioDur;
    previews.push({ index: i + 1, videoDur, audioDur, speed });
  }
  store.update(jobId, { preview: previews });

  // Cut + sync each segment
  store.update(jobId, { stage: ProcessStage.Cutting, progress: 10 });
  const concatListPath = path.join(workDir, "concat.txt");
  const concatLines: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const audio = audioFiles[i];
    const audioDur = previews[i].audioDur;
    const segOut = path.join(segDir, `seg_${String(i).padStart(6, "0")}.mp4`);

    // setpts factor = audioDur / videoDur (>1 slows video, <1 speeds it up)
    const ptsFactor = audioDur / seg.durationSec;

    // Single-pass: seek source video, trim, speed-adjust, replace audio.
    // Fast seek (-ss before -i) keeps memory low; -t bounds the read.
    const args: string[] = [
      "-y",
      "-ss", seg.startSec.toFixed(3),
      "-t", seg.durationSec.toFixed(3),
      "-i", videoPath,
      "-i", audio,
    ];

    const videoFilter = `[0:v]setpts=${ptsFactor.toFixed(6)}*PTS[v]`;

    if (keepBackgroundMusic) {
      const vol = Math.max(0, Math.min(1, backgroundVolume));
      const combined = `${videoFilter};[0:a]atempo=${clampAtempo(1 / ptsFactor)},volume=${vol}[bg];[1:a][bg]amix=inputs=2:duration=first:dropout_transition=0[a]`;
      args.push(
        "-filter_complex", combined,
        "-map", "[v]", "-map", "[a]",
      );
    } else {
      args.push(
        "-filter_complex", videoFilter,
        "-map", "[v]", "-map", "1:a",
      );
    }

    args.push(
      "-t", audioDur.toFixed(3),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "160k",
      "-ar", "48000",
      "-movflags", "+faststart",
      "-threads", "1",
      segOut,
    );

    await runFfmpeg(args);



    concatLines.push(`file '${segOut.replace(/'/g, "'\\''")}'`);

    const pct = 10 + Math.round(((i + 1) / segments.length) * 75);
    store.update(jobId, {
      stage: ProcessStage.Syncing,
      progress: pct,
      processedSegments: i + 1,
      totalSegments: segments.length,
    });
  }

  await writeFile(concatListPath, concatLines.join("\n"));

  store.update(jobId, { stage: ProcessStage.Merging, progress: 88 });

  const finalPath = path.join(outDir, "final.mp4");
  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-c", "copy",
    "-movflags", "+faststart",
    finalPath,
  ]);

  store.update(jobId, { stage: ProcessStage.Completed, progress: 100, finalPath });

  // Cleanup intermediate segments to save space
  await rm(segDir, { recursive: true, force: true }).catch(() => {});

  return finalPath;
}

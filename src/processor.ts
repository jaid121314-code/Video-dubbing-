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

    // Cut video slice
    const slicePath = path.join(segDir, `slice_${i}.mp4`);
    await runFfmpeg([
      "-y",
      "-ss", seg.startSec.toFixed(3),
      "-to", seg.endSec.toFixed(3),
      "-i", videoPath,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-an",
      slicePath,
    ]);

    // Compute setpts factor = audioDur / videoDur (slows when audio longer)
    const ptsFactor = audioDur / seg.durationSec;

    // Build filter: speed-adjust video to match audio duration exactly, replace audio.
    const filter = `[0:v]setpts=${ptsFactor.toFixed(6)}*PTS[v]`;

    const args = [
      "-y",
      "-i", slicePath,
      "-i", audio,
    ];

    if (keepBackgroundMusic) {
      // Take original audio from the slice's source video at low volume + narration
      args.push("-ss", seg.startSec.toFixed(3), "-to", seg.endSec.toFixed(3), "-i", videoPath);
      const vol = Math.max(0, Math.min(1, backgroundVolume));
      const combined = `${filter};[2:a]atempo=${(1 / ptsFactor).toFixed(6)},volume=${vol}[bg];[1:a][bg]amix=inputs=2:duration=first:dropout_transition=0[a]`;
      args.push(
        "-filter_complex", combined,
        "-map", "[v]", "-map", "[a]",
      );
    } else {
      args.push(
        "-filter_complex", filter,
        "-map", "[v]", "-map", "1:a",
      );
    }

    args.push(
      "-t", audioDur.toFixed(3),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "48000",
      "-movflags", "+faststart",
      segOut,
    );

    await runFfmpeg(args);
    await rm(slicePath, { force: true });

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

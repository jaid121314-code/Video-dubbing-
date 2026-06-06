import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Segment } from "./srt.js";
import {
  getDurationSec,
  probeVideo,
  runFfmpeg,
  smartCrf,
  VideoProbe,
} from "./ffmpeg.js";
import { JobStore, ProcessStage, SegmentReport } from "./jobs.js";

export interface ProcessOptions {
  jobId: string;
  workDir: string;
  videoPath: string;
  videoProbe: VideoProbe;
  segments: Segment[];
  audioFiles: string[];
  keepBackgroundMusic: boolean;
  backgroundVolume: number; // 0..1
  store: JobStore;
}

const ENV_PRESET = process.env.FFMPEG_PRESET || "veryfast";
const ENV_CRF = parseInt(process.env.VIDEO_CRF || "27", 10);
const ENV_AUDIO_BR = process.env.AUDIO_BITRATE || "128k";
const ENV_FPS = parseInt(process.env.OUTPUT_FPS || "30", 10);
const SEGMENT_RETRIES = parseInt(process.env.SEGMENT_RETRIES || "3", 10);

function clampAtempo(ratio: number): string {
  if (!isFinite(ratio) || ratio <= 0) return "1.0";
  return Math.max(0.5, Math.min(2.0, ratio)).toFixed(6);
}

async function ffprobeOk(file: string): Promise<boolean> {
  try {
    const d = await getDurationSec(file);
    return d > 0;
  } catch {
    return false;
  }
}

export async function processJob(opts: ProcessOptions): Promise<{ finalPath: string; report: SegmentReport[] }> {
  const {
    jobId, workDir, videoPath, videoProbe, segments, audioFiles,
    keepBackgroundMusic, backgroundVolume, store,
  } = opts;

  if (segments.length !== audioFiles.length) {
    throw new Error(`Segment/audio count mismatch: ${segments.length} segments vs ${audioFiles.length} audio files`);
  }

  const segDir = path.join(workDir, "segments");
  const outDir = path.join(workDir, "output");
  await mkdir(segDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const fps = ENV_FPS > 0 ? ENV_FPS : Math.round(videoProbe.fps || 30);
  const crf = smartCrf(videoProbe, ENV_CRF);

  store.update(jobId, { stage: ProcessStage.Processing, progress: 10 });

  // Probe audio durations
  const previews: { index: number; videoDur: number; audioDur: number; speed: number }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const audioDur = await getDurationSec(audioFiles[i]);
    const videoDur = segments[i].durationSec;
    const speed = videoDur / audioDur;
    previews.push({ index: i + 1, videoDur, audioDur, speed });
  }
  store.update(jobId, { preview: previews });

  const concatListPath = path.join(workDir, "concat.txt");
  const concatLines: string[] = [];
  const report: SegmentReport[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const audio = audioFiles[i];
    const audioDur = previews[i].audioDur;
    const segOut = path.join(segDir, `seg_${String(i).padStart(6, "0")}.mp4`);
    const ptsFactor = audioDur / seg.durationSec;

    const videoFilter =
      `[0:v]setpts=${ptsFactor.toFixed(6)}*PTS,fps=${fps},format=yuv420p[v]`;

    const baseArgs = (): string[] => {
      const a: string[] = [
        "-y",
        "-ss", seg.startSec.toFixed(3),
        "-t", seg.durationSec.toFixed(3),
        "-i", videoPath,
        "-i", audio,
      ];
      if (keepBackgroundMusic) {
        const vol = Math.max(0, Math.min(1, backgroundVolume));
        const combined =
          `${videoFilter};[0:a]atempo=${clampAtempo(1 / ptsFactor)},volume=${vol}[bg];` +
          `[1:a][bg]amix=inputs=2:duration=first:dropout_transition=0[a]`;
        a.push("-filter_complex", combined, "-map", "[v]", "-map", "[a]");
      } else {
        a.push("-filter_complex", videoFilter, "-map", "[v]", "-map", "1:a");
      }
      a.push(
        "-t", audioDur.toFixed(3),
        "-r", String(fps),
        "-vsync", "cfr",
        "-c:v", "libx264",
        "-preset", ENV_PRESET,
        "-crf", String(crf),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", ENV_AUDIO_BR,
        "-ar", "48000",
        "-movflags", "+faststart",
        "-threads", "1",
        segOut,
      );
      return a;
    };

    let lastErr: Error | null = null;
    let succeeded = false;
    for (let attempt = 1; attempt <= SEGMENT_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          store.update(jobId, { stage: ProcessStage.Retrying, retryingSegment: i + 1 });
        }
        await runFfmpeg(baseArgs());
        if (!(await ffprobeOk(segOut))) {
          throw new Error(`Segment ${i + 1} produced unreadable file`);
        }
        succeeded = true;
        break;
      } catch (e: any) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
    if (!succeeded) {
      store.update(jobId, { stage: ProcessStage.FailedSegment, errorSegment: i + 1 });
      throw new Error(
        `Segment ${i + 1} failed after ${SEGMENT_RETRIES} attempts: ${lastErr?.message ?? "unknown"}`,
      );
    }

    const outDur = await getDurationSec(segOut).catch(() => audioDur);
    report.push({
      segmentNumber: i + 1,
      srtStart: seg.origStartSec,
      srtEnd: seg.origEndSec,
      correctedStart: seg.startSec,
      correctedEnd: seg.endSec,
      videoDuration: seg.durationSec,
      audioDuration: audioDur,
      speedFactor: ptsFactor,
      outputDuration: outDur,
    });

    concatLines.push(`file '${segOut.replace(/'/g, "'\\''")}'`);

    const pct = 10 + Math.round(((i + 1) / segments.length) * 70);
    store.update(jobId, {
      stage: ProcessStage.Processing,
      progress: pct,
      processedSegments: i + 1,
      totalSegments: segments.length,
      retryingSegment: undefined,
    });
  }

  await writeFile(concatListPath, concatLines.join("\n"));

  // Merge step (concat copy, lossless)
  store.update(jobId, { stage: ProcessStage.Merging, progress: 85 });
  const mergedPath = path.join(outDir, "merged.mp4");
  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-c", "copy",
    "-movflags", "+faststart",
    mergedPath,
  ]);

  // Final normalization re-encode — phone/browser/VLC/YouTube safe MP4
  store.update(jobId, { stage: ProcessStage.FinalEncoding, progress: 92 });
  const finalPath = path.join(outDir, "final.mp4");
  await runFfmpeg([
    "-y",
    "-i", mergedPath,
    "-c:v", "libx264",
    "-preset", ENV_PRESET,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-vsync", "cfr",
    "-c:a", "aac",
    "-b:a", ENV_AUDIO_BR,
    "-ar", "48000",
    "-movflags", "+faststart",
    finalPath,
  ]);

  // Health check
  if (!(await ffprobeOk(finalPath))) {
    throw new Error("Final MP4 failed ffprobe health check");
  }
  const fs = await stat(finalPath);
  if (fs.size < 1024) throw new Error("Final MP4 is suspiciously small");

  // Cleanup intermediates
  await rm(segDir, { recursive: true, force: true }).catch(() => {});
  await rm(mergedPath, { force: true }).catch(() => {});

  return { finalPath, report };
}

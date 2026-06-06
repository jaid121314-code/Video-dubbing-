import { spawn } from "node:child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export function runFfmpeg(args: string[], onProgress?: (line: string) => void): Promise<void> {
  return run(FFMPEG, args, onProgress);
}

export function runFfprobeJson(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function run(bin: string, args: string[], onProgress?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let err = "";
    p.stderr.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (onProgress) s.split(/\r|\n/).forEach((l: string) => l && onProgress(l));
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`${bin} exited ${code}: ${err.slice(-2000)}`));
      else resolve();
    });
  });
}

export async function getDurationSec(file: string): Promise<number> {
  const info = await runFfprobeJson([
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    file,
  ]);
  const d = parseFloat(info?.format?.duration ?? "0");
  if (!isFinite(d) || d <= 0) throw new Error(`Invalid duration for ${file}`);
  return d;
}

export interface VideoProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number; // bps; 0 if unknown
  totalBitrate: number; // bps; 0 if unknown
  hasAudio: boolean;
  codec: string;
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 0;
  const [a, b] = rate.split("/").map((n) => parseFloat(n));
  if (!isFinite(a) || !b || !isFinite(b)) return 0;
  return a / b;
}

export async function probeVideo(file: string): Promise<VideoProbe> {
  const info = await runFfprobeJson([
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-of", "json",
    file,
  ]);
  const streams: any[] = info?.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("No video stream found");

  const durationSec = parseFloat(info?.format?.duration ?? v?.duration ?? "0");
  if (!isFinite(durationSec) || durationSec <= 0) throw new Error(`Invalid video duration for ${file}`);

  const fps = parseFps(v.avg_frame_rate) || parseFps(v.r_frame_rate) || 0;
  const videoBitrate = parseInt(v.bit_rate ?? "0", 10) || 0;
  const totalBitrate = parseInt(info?.format?.bit_rate ?? "0", 10) || 0;

  return {
    durationSec,
    width: parseInt(v.width ?? "0", 10) || 0,
    height: parseInt(v.height ?? "0", 10) || 0,
    fps,
    videoBitrate,
    totalBitrate,
    hasAudio: !!a,
    codec: v.codec_name ?? "",
  };
}

/** Smart CRF: pick a CRF that keeps the output close to source quality
 *  without exploding. Higher source resolution/bitrate -> slightly higher CRF
 *  (smaller file) but never lower than env VIDEO_CRF floor. */
export function smartCrf(probe: VideoProbe, envCrf: number): number {
  let crf = envCrf;
  const pixels = probe.width * probe.height;
  if (pixels >= 3840 * 2160) crf = Math.max(crf, 28); // 4K
  else if (pixels >= 1920 * 1080) crf = Math.max(crf, 27);
  else if (pixels >= 1280 * 720) crf = Math.max(crf, 25);
  else crf = Math.max(crf, 24);

  // If source bitrate is already low (heavily compressed), don't over-compress
  if (probe.videoBitrate > 0 && probe.videoBitrate < 1_500_000) {
    crf = Math.min(crf, 25);
  }
  return crf;
}

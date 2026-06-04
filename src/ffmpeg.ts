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

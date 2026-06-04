import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import unzipper from "unzipper";

const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"]);

export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: destDir }))
      .on("close", resolve)
      .on("error", reject);
  });
}

export async function collectAudioFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }
  await walk(dir);
  // Natural sort by basename so file2 < file10
  out.sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: "base" })
  );
  // If still ambiguous, fall back to ctime
  const withStat = await Promise.all(out.map(async (f) => ({ f, ct: (await stat(f)).ctimeMs })));
  // Only reorder if no numeric token detected
  const hasNumbers = out.every((f) => /\d/.test(path.basename(f)));
  if (!hasNumbers) {
    withStat.sort((a, b) => a.ct - b.ct);
    return withStat.map((x) => x.f);
  }
  return out;
}

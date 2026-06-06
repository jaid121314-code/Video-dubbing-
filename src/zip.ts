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

/** Collect audio files from a directory, ignoring images / json / txt / hidden / __MACOSX,
 *  and sort by leading numeric token naturally: 1, 2, 10, 100 (not 1, 10, 100, 2). */
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

  // Prefer numeric token at start of basename for natural sort
  const keyed = out.map((f) => {
    const base = path.basename(f);
    const m = base.match(/^(\d+)/);
    const num = m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
    return { f, base, num };
  });

  const allNumeric = keyed.every((k) => isFinite(k.num));
  if (allNumeric) {
    keyed.sort((a, b) => a.num - b.num || a.base.localeCompare(b.base));
  } else {
    keyed.sort((a, b) =>
      a.base.localeCompare(b.base, undefined, { numeric: true, sensitivity: "base" }),
    );
  }
  return keyed.map((k) => k.f);
}

import { readFile } from "node:fs/promises";
import { parseSync } from "subtitle";

export interface Segment {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  text: string;
}

export async function parseSrt(path: string): Promise<Segment[]> {
  const raw = await readFile(path, "utf8");
  const nodes = parseSync(raw);
  const segments: Segment[] = [];
  let i = 0;
  for (const n of nodes) {
    if (n.type !== "cue") continue;
    const start = n.data.start / 1000;
    const end = n.data.end / 1000;
    if (end <= start) continue;
    segments.push({
      index: i++,
      startSec: start,
      endSec: end,
      durationSec: end - start,
      text: typeof n.data.text === "string" ? n.data.text : "",
    });
  }
  if (segments.length === 0) throw new Error("No subtitle cues found in SRT");
  return segments;
}

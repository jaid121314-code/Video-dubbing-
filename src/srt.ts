import { readFile } from "node:fs/promises";
import { parseSync } from "subtitle";

export interface Segment {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  text: string;
  origStartSec: number;
  origEndSec: number;
}

export interface SrtParseResult {
  segments: Segment[];
  warnings: string[];
  invalid: { index: number; reason: string }[];
}

export async function parseSrt(path: string): Promise<{ segments: Segment[] }> {
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
      origStartSec: start,
      origEndSec: end,
      text: typeof n.data.text === "string" ? n.data.text : "",
    });
  }
  if (segments.length === 0) throw new Error("No subtitle cues found in SRT");
  return { segments };
}

/** Normalize and validate SRT timestamps against the real video duration.
 *  Returns the corrected segments plus warnings + a list of invalid segments. */
export function normalizeSegments(
  segments: Segment[],
  videoDurationSec: number,
): SrtParseResult {
  const warnings: string[] = [];
  const invalid: { index: number; reason: string }[] = [];

  // Sort defensively
  segments.sort((a, b) => a.startSec - b.startSec);

  // Clamp first start
  if (segments[0].startSec < 0) {
    warnings.push(`First SRT start (${segments[0].startSec.toFixed(3)}s) was < 0; clamped to 0`);
    segments[0].startSec = 0;
  }

  // Clamp last end to video duration
  const last = segments[segments.length - 1];
  if (last.endSec > videoDurationSec + 0.05) {
    warnings.push(
      `Last SRT end (${last.endSec.toFixed(3)}s) exceeds video duration (${videoDurationSec.toFixed(3)}s); clamped`,
    );
    last.endSec = videoDurationSec;
  } else if (last.endSec < videoDurationSec - 0.5) {
    // not an error, just note
    warnings.push(
      `Last SRT end (${last.endSec.toFixed(3)}s) ends before video duration (${videoDurationSec.toFixed(3)}s)`,
    );
  } else if (last.endSec > videoDurationSec) {
    last.endSec = videoDurationSec;
  }

  // Clamp every end that exceeds video duration
  for (const s of segments) {
    if (s.endSec > videoDurationSec) {
      s.endSec = videoDurationSec;
    }
  }

  // Recompute durations and mark invalids
  for (const s of segments) {
    s.durationSec = s.endSec - s.startSec;
    if (s.durationSec <= 0) {
      invalid.push({ index: s.index + 1, reason: `Segment ${s.index + 1} has non-positive duration after clamping` });
    }
  }

  return { segments, warnings, invalid };
}

# DubForge Backend (v3 — Smart Hybrid Sync + Merge)

Fast, parallel FFmpeg pipeline that replaces narration on a long-form video **without unnecessary re-encoding**. 
Output is individual dubbed MP4 clips at original quality, merged into a final video with comprehensive logging.

## What's New (v3)

✨ **Smart Hybrid Mode** (default):
- Analyzes each clip's audio/video duration mismatch
- If mismatch is natural (0.85–1.25×): adjusts audio tempo only, keeps video copied
- If mismatch is extreme: clamps audio to safe range, re-encodes video only for that clip
- Generates warnings for re-encoded clips

✨ **Loudness Normalization**:
- All narration audio normalized to -16 LUFS (configurable)
- Prevents audio level jumps between clips
- Uses FFmpeg `loudnorm` filter

✨ **Audio Fades**:
- Tiny fade-in (0.03 sec) and fade-out (0.03 sec) on every narration track
- Eliminates clicks, pops, and glitches
- Fully configurable

✨ **Merge Endpoint**:
- `/merge/:sid` — concatenates all processed clips into `final_output.mp4`
- `/download-final/:sid` — direct download of merged video
- `/download-all/:sid` — ZIP with clips + final video + logs

✨ **Comprehensive Logging**:
- `processing_log.json` — per-clip details (tempo, duration, re-encode status)
- `warnings.json` — clips that triggered smart hybrid video re-encoding

## How Smart Hybrid Works

For each clip:

```
videoDur = duration of cut video clip
audioDur = duration of narration audio
requiredTempo = audioDur / videoDur

IF 0.85 ≤ requiredTempo ≤ 1.25 THEN
  ✅ Keep video untouched (use -c:v copy)
  ✅ Adjust audio tempo only
  ❌ NO video re-encoding

IF requiredTempo < 0.85 OR requiredTempo > 1.25 THEN
  ✅ Clamp audio tempo to [0.85, 1.25]
  ✅ Calculate adjusted audio duration
  ✅ Speed up/down video to match
  ⚠️  RE-ENCODE VIDEO (once per affected clip)
  📋 Log warning
```

**Result:** Most clips use `-c:v copy` (instant, lossless). Only clips with extreme mismatch are re-encoded at high quality (CRF 18, veryfast preset).

## Endpoints

| Method | Path | Purpose |
|--------|------|----------|
| GET | `/health` | Liveness check |
| POST | `/upload-video` | multipart: `sessionId`, `video` (1 file) |
| POST | `/process-batch` | multipart: `sessionId`, `batchIndex`, `mode`, `clips` (JSON), `audio[]` |
| GET | `/job/:id` | Poll progress: `{ total, completed, failed, status }` |
| POST | `/merge/:sid` | Concatenate all processed clips → `final_output.mp4` |
| GET | `/download-final/:sid` | Stream `final_output.mp4` |
| GET | `/download-zip/:sid` | Stream ZIP of all processed clips (legacy) |
| GET | `/download-all/:sid` | Stream ZIP: `clips/`, `final_output.mp4`, `processing_log.json`, `warnings.json` |
| GET | `/file/:sid/:name` | Download any file from session |
| POST | `/cleanup` | Delete a session's working files |

### POST /process-batch

**Multipart Form:**
```
sessionId:   string (required)
batchIndex:  number (optional, default 0)
mode:        "natural" | "aggressive" | "smart_hybrid" (default: smart_hybrid)
clips:       JSON string of [{ "start": 5.43, "end": 10.86, "index": 0 }, ...]
settings:    optional JSON {"audioSafeMin": 0.85, "audioSafeMax": 1.25, "loudnessTarget": -16, ...}
audio:       1 or more files (must match clips count)
```

**Response:** `{ "jobId": "...", "total": 5 }`

### POST /merge/:sid

Merges all clips in `clips/` directory into `final_output.mp4`.

**Response:** `{ "ok": true, "file": "final_output.mp4", "downloadUrl": "/file/:sid/final_output.mp4" }`

### processing_log.json

```json
[
  {
    "clip": 0,
    "start": 5.43,
    "end": 10.86,
    "videoDur": 5.43,
    "audioDur": 6.73,
    "requiredTempo": 1.24,
    "usedAudioTempo": 1.24,
    "videoReencoded": false,
    "status": "done"
  },
  {
    "clip": 1,
    "videoDur": 3.5,
    "audioDur": 5.2,
    "requiredTempo": 1.49,
    "usedAudioTempo": 1.25,
    "videoReencoded": true,
    "status": "done"
  }
]
```

### warnings.json

```json
[
  {
    "clip": 1,
    "requiredTempo": 1.49,
    "usedAudioTempo": 1.25,
    "videoReencoded": true,
    "reason": "Audio tempo outside safe range, video re-encoded to match"
  }
]
```

## Install (Local)

Requires **Node 20+** and **FFmpeg** (with ffprobe) on PATH.

```bash
cd backend
npm install
npm run dev          # tsx src/server.ts
# or production:
npm run build && npm start
```

Verify FFmpeg:
```bash
ffmpeg -version
ffprobe -version
```

## Environment Variables

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `8080` | HTTP port |
| `WORK_DIR` | `/data` (Docker) / tmp | Where sessions + clips are stored |
| `CONCURRENCY` | `8` | Parallel FFmpeg workers per request |
| `AUDIO_SAFE_MIN` | `0.85` | Minimum safe audio tempo (no video re-encode below) |
| `AUDIO_SAFE_MAX` | `1.25` | Maximum safe audio tempo (no video re-encode above) |
| `LOUDNESS_TARGET` | `-16` | Target loudness in LUFS |
| `FADE_IN_SEC` | `0.03` | Audio fade-in duration (seconds) |
| `FADE_OUT_SEC` | `0.03` | Audio fade-out duration (seconds) |
| `VIDEO_CRF` | `18` | H.264 quality for re-encoded clips (0–51, lower = better) |
| `VIDEO_PRESET` | `veryfast` | H.264 encoding speed (ultrafast..slow) |
| `NODE_ENV` | `production` | (Docker) |

**Tuning CONCURRENCY:**
- ~1× CPU cores: safe, slower
- ~1.5–2× CPU cores: recommended for balanced performance
- ~4× CPU cores: aggressive, may overwhelm system memory
- Example: 4-core machine → try `CONCURRENCY=6` or `8`

## Railway Deployment

1. Push this entire folder (root = repo root) to a Git repo.
2. In Railway:
   - **New Project → Deploy from GitHub repo**
   - Select the repo
3. Railway auto-detects `railway.json` and builds via `Dockerfile`:
   - FFmpeg is pre-installed in the Node 20 Bookworm image
   - Build: TypeScript compilation (`tsc`)
   - Start: `node dist/server.js`
4. **Set environment variables** (optional):
   ```
   CONCURRENCY=12
   WORK_DIR=/data
   LOUDNESS_TARGET=-16
   AUDIO_SAFE_MIN=0.85
   AUDIO_SAFE_MAX=1.25
   ```
5. **Add a Volume** mounted at `/data`:
   - Jobs survive container restarts
   - ZIP downloads remain available
6. Deploy. Health check is `/health`.
7. Use the public Railway URL (e.g. `https://your-app.up.railway.app`) as the backend URL in the frontend.

## Audio Sync Modes

Send `mode` in `/process-batch`:

### `smart_hybrid` (default, recommended)
- **Prioritizes quality & speed**: Keeps video copied when possible.
- Audio tempo clamped to [0.85, 1.25].
- If required tempo is outside range: clamps audio, re-encodes video only.
- Best for most use cases.

### `natural`
- **Prioritizes voice quality**: Audio tempo stays within natural-sounding range [0.85, 1.20].
- If audio can't fit exactly, video remains untouched and muxer trims via `-shortest`.
- Good for strict quality requirements.

### `aggressive`
- **Prioritizes exact timing**: Chains atempo filters to hit any target (within [0.5, 2.0]).
- Voice may sound robotic at extreme speeds.
- Use only when exact sync is mandatory.

## Quality Guarantees

✅ **Normal Clips** (smart_hybrid, within safe range):
- `-c:v copy` (zero re-encoding, lossless)
- Original codec, resolution, bitrate, FPS preserved
- Instant processing

✅ **Re-encoded Clips** (smart_hybrid, outside safe range):
- `-c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p`
- Resolution preserved, zero crop/resize
- FPS preserved
- High quality (CRF 18 ≈ HD/4K visually lossless)

✅ **Final Merge**:
- `-c copy` (concatenate without re-encoding)
- All clips must have matching codec, resolution, FPS, audio format

## Output Structure

After `/process-batch` + `/merge/:sid`:

```
/data/<sessionId>/
├── source.mp4                # uploaded base video
├── in/                       # uploaded audio files (auto-cleaned)
├── clips/
│   ├── 00001.mp4
│   ├── 00002.mp4
│   └── ...
├── final_output.mp4          # merged result
├── processing_log.json       # per-clip logs
└── warnings.json             # re-encoded clip warnings
```

## Troubleshooting

### Merge fails: "Codec mismatch"
- Clips may have different codecs if uploaded from different sources.
- Solution: Re-encode all clips with matching codec before merge.
- Contact backend maintainer for automated codec normalization endpoint.

### One clip fails; should batch fail?
- **No.** Batch continues; failed clip is marked in `processing_log.json`.
- Check `warnings.json` and logs for details.
- Manually re-process that clip.

### Video speed sounds weird
- Check `warnings.json`—video may be re-encoded.
- Adjust `AUDIO_SAFE_MAX` or `AUDIO_SAFE_MIN` env vars (affects when video re-encoding triggers).
- Or switch to `aggressive` mode for smoother audio behavior (trade-off: may be slower/robotic).

### Clips are huge; can I lower quality?
- `VIDEO_CRF`: Higher value = lower quality. Default 18 is high quality; try 22–26 for smaller files.
- `VIDEO_PRESET`: Slower preset = smaller file. Default is veryfast; try `fast` or `medium`.
- Or accept that normal clips use `-c:v copy` and only re-encoded clips vary in size.

## API Compatibility

- Old endpoints (`/download-zip/:sid`, `/file/:sid/:name`) still work.
- Default `/process-batch` mode is now `smart_hybrid` (was `natural`).
- Settings JSON is optional; all defaults work out of the box.
- No breaking changes to existing frontend.

## Performance

- **8 parallel workers, normal clips**: ~5–10 clips/sec (depending on video duration & CPU).
- **Smart hybrid with re-encoding**: Re-encoded clips slower (~30 sec per clip @ 1080p/CRF18).
- **Merge**: 2–5 min depending on total duration (fast, no re-encode).
- **Total for 10 clips (1× re-encoded)**: ~2–3 min processing + merge.

## License

MIT

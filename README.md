# AutoDub Sync Studio — Backend (v1.1)

Production-hardened Node.js + TypeScript + Express + FFmpeg backend. Cuts a source
video by SRT, replaces each segment's audio with a matching narration clip,
speed-adjusts the video to match narration exactly, then re-encodes a single
phone/browser/VLC/YouTube-safe MP4.

## What's new in v1.1

- Safe final encode: `libx264 -preset veryfast -crf 27 -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -ar 48000 -movflags +faststart` (no more ultrafast bloat).
- **Smart CRF**: auto-tunes by source resolution/bitrate so a 350 MB source typically stays ~400 MB–1.2 GB instead of exploding to 7 GB.
- **FPS lock**: probes source with ffprobe, forces output to `OUTPUT_FPS` (default 30), `fps=` filter + `-vsync cfr`. No more variable FPS.
- **Narration is master**: video is speed-adjusted with `setpts=ptsFactor*PTS`, then the segment is hard-cut to `audioDuration`. Narration audio is never time-stretched.
- **Timestamp normalization**: clamps negative starts to 0, clamps overflowing ends to real video duration, marks zero/negative-duration cues invalid. Warnings surface in status.
- **Pre-render validation**: `POST /api/analyze/:jobId` returns SRT count, audio count, video duration, warnings, and whether validation passed. Render is blocked on mismatch.
- **Per-segment retry**: up to `SEGMENT_RETRIES` (default 3). Hard fail names the exact segment + FFmpeg error.
- **ffprobe health check** after final encode.
- **Range download** (HTTP 206) — fixes mobile/browser failed downloads for large MP4s.
- **Optional ZIP**: `GET /api/download-zip/:jobId` returns `final.mp4 + sync_report.json + audio_files_report.json` only (no temp segments).
- **sync_report.json** with per-segment srt/corrected/audio/video/speed/output durations.
- **Auto cleanup** of completed/failed jobs after `CLEANUP_AFTER_HOURS`.
- **Stable storage** at `STORAGE_DIR` (Railway volume friendly, e.g. `/data`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/health` | Liveness |
| POST | `/api/jobs` | Create job → `{ ok, jobId }` |
| POST | `/api/upload-video/:jobId` | Multipart (`video`) |
| POST | `/api/upload-srt/:jobId` | Multipart (`srt`) |
| POST | `/api/upload-zip/:jobId` | Multipart (`zip`) |
| POST | `/api/analyze/:jobId` | Pre-render validation report |
| POST | `/api/process/:jobId` | Start render. Body: `{ keepBackgroundMusic?, backgroundVolume? }` |
| GET  | `/api/status/:jobId` | Poll progress, stage, warnings, validation |
| GET  | `/api/download/:jobId` | MP4 download (Range supported) |
| GET  | `/api/download-zip/:jobId` | ZIP: final.mp4 + reports |
| POST | `/api/cleanup/:jobId` | Delete job working dir |

### `/api/process` response shape (compat-friendly)

```json
{
  "ok": true,
  "jobId": "…",
  "validation": {
    "videoDuration": 1234.56,
    "srtSegments": 120,
    "audioFiles": 120,
    "countMatch": true,
    "timestampWarnings": ["…"]
  }
}
```

### Stages returned by `/api/status`

`uploading` → `analyzing` → `validating` → `processing` → `retrying` →
`failed_segment` → `merging` → `final_encoding` → `completed` / `failed`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg binary |
| `FFPROBE_PATH` | `ffprobe` | Path to ffprobe binary |
| `STORAGE_DIR` | `./storage` | Job working dir root (set to `/data` on Railway with a volume) |
| `VIDEO_CRF` | `27` | Base CRF floor (smart logic may raise for 1080p/4K) |
| `FFMPEG_PRESET` | `veryfast` | x264 preset (don't use ultrafast in prod) |
| `AUDIO_BITRATE` | `128k` | AAC bitrate |
| `OUTPUT_FPS` | `30` | Forced output FPS |
| `MAX_UPLOAD_BYTES` | `17179869184` (16 GB) | Per-file upload cap |
| `CORS_ORIGIN` | `*` | Comma-separated allow list |
| `SEGMENT_RETRIES` | `3` | Per-segment retry attempts |
| `CLEANUP_AFTER_HOURS` | `24` | Hours before completed/failed jobs are removed |

## Local dev

```bash
cd backend
npm install
npm run dev
```

Requires local `ffmpeg` and `ffprobe`.

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo → pick the repo.
3. Set the **Root Directory** to `backend` if frontend lives alongside.
4. Railway auto-uses `railway.json` + `Dockerfile` (FFmpeg included).
5. Add a **Volume** mounted at `/data`.
6. Set env vars (at minimum):
   - `CORS_ORIGIN=https://your-frontend.lovable.app`
   - `STORAGE_DIR=/data`
7. Deploy. Use the public URL as your frontend's API base.

## Output size expectations

For a 350 MB 1080p source, output typically lands ~400 MB–1.2 GB depending on
length and audio. Source-aware CRF avoids the 7 GB ultrafast blowup.

## Notes

- Final MP4 is always re-encoded after `concat` (no `-c copy`-only final). This
  guarantees a clean moov atom and prevents partial / corrupt downloads.
- ZIP audio sort: numeric-prefix natural sort (1, 2, 10, 100). Ignores
  `__MACOSX`, dotfiles, images, JSON, txt.
- Default download is direct MP4. ZIP is opt-in via `/api/download-zip/:jobId`.

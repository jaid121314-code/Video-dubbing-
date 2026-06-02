# AutoDub Sync Studio — Backend

Node.js + TypeScript + Express + FFmpeg backend for AutoDub Sync Studio. Cuts a source video by an SRT, swaps each segment's audio with a matching narration clip, speed-adjusts video to match narration duration exactly, and concatenates everything into a final dubbed MP4.

## Endpoints

All endpoints are JSON unless noted.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/health` | Liveness check |
| `POST` | `/api/jobs` | Create a new job → returns `{ jobId }` |
| `POST` | `/api/upload-video/:jobId` | Multipart upload (field `video`) |
| `POST` | `/api/upload-srt/:jobId` | Multipart upload (field `srt`) |
| `POST` | `/api/upload-zip/:jobId` | Multipart upload (field `zip`) |
| `POST` | `/api/process/:jobId` | Start async processing. Body: `{ keepBackgroundMusic?: boolean, backgroundVolume?: number }` |
| `GET`  | `/api/status/:jobId` | Poll progress + per-segment preview |
| `GET`  | `/api/download/:jobId` | Download final MP4 |

## Local dev

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

You must have `ffmpeg` and `ffprobe` installed locally and either on PATH or set via `FFMPEG_PATH` / `FFPROBE_PATH`.

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway → **New Project → Deploy from GitHub repo** → pick this repo.
3. Set the **Root Directory** to `backend` (if your frontend lives in the same repo).
4. Railway will detect `railway.json` + `Dockerfile` and build the image (FFmpeg is included in the image).
5. Add a **Volume** mounted at `/data` so jobs persist across restarts.
6. Set env vars from `.env.example`. At minimum:
   - `CORS_ORIGIN` = your frontend URL (e.g. `https://your-app.lovable.app`)
   - `STORAGE_DIR` = `/data`
7. Deploy. Note the public URL — that's your `VITE_API_URL` for the frontend.

## Notes

- FFmpeg path is read from `FFMPEG_PATH` / `FFPROBE_PATH` env vars. Never hardcoded.
- Video is re-encoded per segment (libx264, CRF 18, veryfast). Adjust in `src/processor.ts` if you need different quality/speed tradeoffs.
- Speed adjustment uses `setpts` on video only — narration audio is the master timeline and is never time-stretched.
- ZIP audio matching: numeric-aware filename sort. Files with non-numeric names fall back to creation order. Only `.mp3 .wav .m4a .aac .ogg .flac .opus` are kept; images / JSON / thumbnails / `__MACOSX` are ignored.
- 8-hour videos work but require a large Railway plan and persistent volume. Plan ≥ 50 GB for 4K source + intermediates.

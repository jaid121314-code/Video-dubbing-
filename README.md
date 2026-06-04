# DubForge Backend (v2 — Lossless Video Clip Dubber)

Fast, parallel FFmpeg pipeline that replaces narration on a long-form video
**without re-encoding the video stream**. Output is a ZIP of individual dubbed
MP4 clips at original quality (e.g. 720p).

## What it does

For each subtitle:
1. **Cut** the video with `-c:v copy -an` → zero quality loss, no resize, no FPS change.
2. **Match audio to video duration** using a smart `atempo` chain:
   - Safe range (0.85–1.20): single atempo, natural voice.
   - "natural" mode: clamps softly to keep voice quality.
   - "aggressive" mode: chains atempo steps inside [0.5, 2.0] to hit the exact length.
3. **Mux** the cut video + adjusted audio with `-c:v copy -c:a aac -shortest`.
4. **Parallelize** with a worker pool (default 8, configurable).
5. **ZIP** all clips into `final_clips.zip` (`clips/00001.mp4`, `00002.mp4`, …).

## Endpoints

| Method | Path                  | Purpose                                        |
| ------ | --------------------- | ---------------------------------------------- |
| GET    | `/health`             | Liveness check                                 |
| POST   | `/upload-video`       | multipart: `sessionId`, `video` (1 file)       |
| POST   | `/process-batch`      | multipart: `sessionId`, `batchIndex`, `mode`, `clips` (JSON), `audio[]` — returns `{ jobId }` immediately |
| GET    | `/job/:id`            | Poll progress: `{ total, completed, failed, status }` |
| GET    | `/download-zip/:sid`  | Stream `final_clips.zip` of all processed clips |
| POST   | `/cleanup`            | Delete a session's working files               |

Clips array shape:
```json
[{ "start": 5.43, "end": 10.86, "index": 0 }, ...]
```
Audio files must be uploaded with filename prefix `<i>_originalname.mp3`
matching the clip array order. Output names are 1-based: `00001.mp4` …

## Install (local)

Requires Node 20+ and FFmpeg (with ffprobe) on PATH.

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

## Environment variables

| Var          | Default                      | Notes                                  |
| ------------ | ---------------------------- | -------------------------------------- |
| `PORT`       | `8080`                       | HTTP port                              |
| `WORK_DIR`   | `/data` (Docker) / tmp dir   | Where sessions + clips are stored      |
| `CONCURRENCY`| `8`                          | Parallel FFmpeg workers per request    |
| `NODE_ENV`   | `production` (Docker)        |                                         |

Tune `CONCURRENCY` to roughly the number of CPU cores. 8–16 is typical.

## Railway deployment

1. Push this `backend/` folder to a Git repo (root = repo root).
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. Railway auto-detects `railway.json` and builds via `Dockerfile`
   (FFmpeg is installed in the image).
4. Set variables (optional):
   - `CONCURRENCY=12`
   - `WORK_DIR=/data`
5. Add a **Volume** mounted at `/data` so jobs survive restarts and the ZIP
   download is available across requests.
6. Deploy. Health check is `/health`.
7. Use the public URL (e.g. `https://your-app.up.railway.app`) as a backend
   URL in the frontend settings panel.

## Audio sync modes

Send `mode` in `/process-batch`:

- `natural` (default) — prioritizes voice quality. Tempo is clamped to a
  natural-sounding band; if the audio still doesn't fit, the video remains
  untouched and the muxer trims via `-shortest`.
- `aggressive` — prioritizes exact timing. Builds a chained atempo filter
  (`atempo=1.4,atempo=1.42`) to hit any target without pitch shift.

## Output

`GET /download-zip/<sessionId>` streams:

```
final_clips.zip
└── clips/
    ├── 00001.mp4
    ├── 00002.mp4
    └── ...
```

Each MP4 has the **original video stream copied verbatim** (same codec,
resolution, bitrate, FPS) and a freshly encoded AAC audio track sized to
match the video clip duration.

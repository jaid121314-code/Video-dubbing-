# DubForge Backend (Railway)

Long-form video dubbing worker. Stateless: keeps each session in `WORK_DIR` on disk; safe to deploy multiple identical instances on Railway and let the frontend round-robin between them.

## Deploy to Railway

1. Create a new Railway project from this `backend/` folder (or push to a repo and point Railway at it).
2. Railway auto-detects `railway.json` and builds the `Dockerfile` (Node 20 + ffmpeg).
3. Add a Railway **Volume** mounted at `/data` for session storage on long jobs.
4. Copy the generated public URL into the DubForge web UI → Settings → Backends.
5. Repeat across as many Railway accounts as you want; the frontend distributes batches round-robin with automatic failover.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET  | `/health` | Liveness |
| POST | `/upload-video` | Multipart: `sessionId`, `video` |
| POST | `/process-batch` | Multipart: `sessionId`, `batchIndex`, `mode`, `loudness`, `fadeMs`, `clips` (JSON), `audio[]` |
| POST | `/finalize` | JSON: `sessionId`, `partials[]` |
| GET  | `/file/:sid/:name` | Download partial / final MP4 |
| POST | `/cleanup` | Delete session work dir |

## Local dev

```bash
cd backend
npm install
npm run dev
```

Requires `ffmpeg` + `ffprobe` in PATH.

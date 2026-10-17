# Large PDF uploads: 100 MB on free Cloudflare products

Cloudflare Workers + D1 + KV + Queues provide **upload acceptance** of PDFs up to 100,000,000 bytes. This does not promise conversion success on Render Free. Each chunk is 5 MiB (about 20 chunks). Key-value retention is capped at 24 hours, requiring free-plan usage to remain below 1 GB storage / 1,000 writes per day.

## API flow
1. Existing authenticated `POST /v1/upload-tickets` accepts `file_bytes` up to 100,000,000 and returns either single-upload (<=18 MiB) or `upload_mode: chunked`, `chunk_bytes`, and the exact `upload_url` / `finalize_url`. Chunk tokens expire after 2 hours and are scoped to HTTPS Origin.
2. Browser computes SHA-256 of each chunk and `POST /v1/chunks?part=N` with short-lived token in Authorization header, content-type application/octet-stream and X-Chunk-SHA256. D1 controls claim state and retries; request bodies never travel through Vercel.
3. `GET /v1/chunks` with Origin + upload token lists completed chunk numbers for resumable uploads. After all chunks, `POST /v1/chunks/finalize` creates a queued conversion job.
4. Render claims the job and sequentially fetches `GET /internal/files/chunk/{jobId}/{part}` (secret-authenticated), verifying individual SHA-256, to reconstruct the 100 MB PDF on Render ephemeral disk. This keeps Worker memory bounded.
5. Once processed, the EPUB remains limited to 22 MiB. Failing OCR / oversized output produces a clear error rather than fake success.

## Important boundaries
- Existing 18 MiB single-file upload remains unchanged; all other clients keep existing API.
- The browser token is not a permanent API credential, although it grants access to one upload for up to 2 hours.
- At most two reserved large uploads, and at most 700 MB of active reserved source PDFs, to leave room for EPUB output within the Free KV 1 GB quota.
- Existing limit of 12 shared jobs per day is retained; keep an eye on KV write daily quotas.
- Large OCR-heavy files may exceed the free Render 512 MB memory / 0.1 CPU / 9-minute converter cap and could fail.
- Not appropriate for storing private sensitive documents without clear privacy disclosure and operational testing.

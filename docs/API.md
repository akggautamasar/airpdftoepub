# API v1 — contract and integration

Base URL: `https://<your-worker>.workers.dev`. All `/v1/*` calls require
`Authorization: Bearer pe_...` in an HTTPS request. Each application has its
own credential. Never put a secret API key in public browser-side JavaScript;
AirTools' public browser should call an authenticated AirTools backend proxy,
or use a short-lived client token system in a future version.

## POST /v1/convert

Send the PDF **as raw binary body**, with `Content-Type: application/pdf`
and a known `Content-Length`; **not multipart/form-data**. Body max **30 MiB**.
Supported query parameters:

| Name | Type / default | Behavior |
|---|---|---|
| `preset` | `balanced` | `maximum_compression`, `balanced`, `high_fidelity` |
| `ocr_languages` | `eng+hin` | Tesseract language codes, up to four (must be installed in Docker) |
| `title` | optional, max 160 chars | Override PDF metadata title |
| `author` | optional, max 160 chars | Override PDF author |

Optional header: `Idempotency-Key` (8–128 safe ASCII characters). Same client +
key returns existing job, not a second conversion. A key denotes an identical
logical request: clients MUST NOT reuse it for a different PDF or preset.
This implementation does not verify PDF hashes on idempotent replays.

```bash
curl --fail-with-body -X POST \
  'https://YOUR_WORKER.workers.dev/v1/convert?preset=balanced&ocr_languages=eng%2Bhin' \
  -H "Authorization: Bearer $PDFEPUB_API_KEY" \
  -H 'Content-Type: application/pdf' \
  -H 'Idempotency-Key: book-conversion-request-001' \
  --data-binary @book.pdf
```

`202 Accepted`, `Location: /v1/jobs/{id}`:
```json
{
  "job_id":"65f44baf-4db6-4b67-93be-1f83033cf86a",
  "status":"queued","progress_percent":0,"attempts":0,
  "created_at":"2026-10-17T09:00:00.000Z",
  "updated_at":"2026-10-17T09:00:00.000Z",
  "expires_at":"2026-10-18T09:00:00.000Z",
  "links":{
    "status":"/v1/jobs/65f44baf-4db6-4b67-93be-1f83033cf86a",
    "report":"/v1/jobs/65f44baf-4db6-4b67-93be-1f83033cf86a/report",
    "download":null
  }
}
```
Repeat with the same `Idempotency-Key` → `200 OK` with the existing job.

## GET /v1/jobs/{job_id}

Returns the same job envelope with statuses `queued`, `running`, `completed`,
`failed` or `cancelled`; progress ranges 0–100. A complete job includes the
`download` link. A failed job includes:
```json
{
  "job_id":"65f44baf-4db6-4b67-93be-1f83033cf86a",
  "status":"failed","progress_percent":30,"attempts":3,
  "error":{"code":"conversion_failed","message":"OCR page cap exceeded (12); use a stronger worker"},
  "links":{"status":"/v1/jobs/65f44baf-4db6-4b67-93be-1f83033cf86a",
           "report":"/v1/jobs/65f44baf-4db6-4b67-93be-1f83033cf86a/report","download":null}
}
```
(Other time fields are omitted above for readability; the actual endpoint
includes them.)

## GET /v1/jobs/{job_id}/report

`200` only after completion, otherwise `409`:
```json
{
  "status":"completed","pages":42,"native_pages":35,"ocr_pages":7,
  "image_assets":19,"table_candidates":2,
  "quality_preset":"balanced","ocr_languages":"eng+hin",
  "warnings":["Page 8: vector diagrams/equations may not fully reflow"],
  "original_bytes":12582912,"epub_bytes":4321000,
  "reduction_percent":65.66,"compression_ratio":2.912,
  "duration_seconds":208.4,"native_text_coverage":0.994,
  "validation":"structural"
}
```
Numbers above are illustrative examples, **not measured performance claims**.
The implementation computes actual output size from the saved R2 object and
recalculates reduction on completion.

## GET /v1/jobs/{job_id}/download

Returns `200`, `application/epub+zip`, streamed private R2 data and
`Content-Disposition: attachment`; requires the client's API key even when a
user guesses the job UUID. `409` if incomplete, `410` after expiry. There is
no public object bucket or permanent download URL.

## DELETE /v1/jobs/{job_id}

Cancel queued or running job. Returns updated job object. A running child may
continue until it encounters a page-progress heartbeat; cancellation does not
promise instant CPU termination. Already completed/failed jobs return `409`.

## GET /health

No authentication: `{"status":"ok","component":"edge",...}`. This
checks **only the Cloudflare API process**, not whether Render compute is awake.
The Render service exposes `/health` separately.

## Error envelope
```json
{"error":{"code":"file_too_large","message":"Max upload is 30 MiB"}}
```
Status codes: `400` invalid request, `401` missing/invalid API key,
`403` disallowed CORS origin, `404` unknown job/route or cross-client access,
`409` invalid state or output not ready, `410` expired output,
`411` content length required, `413` size cap, `415` unsupported media type,
`422` invalid option, `429` daily quota, `503` storage or temporary failure,
`500` unexpected failure. Cloudflare might also return platform-level limit
errors such as Worker error 1027; those may not use this JSON envelope.

## Browser and server integration

From your own backend (Node.js 18+):
```js
import { readFile } from 'node:fs/promises';
const buf = await readFile('book.pdf');
const response = await fetch(process.env.PDFEPUB_ENDPOINT+'/v1/convert?preset=balanced', {
  method: 'POST', headers: {
    Authorization: `Bearer ${process.env.PDFEPUB_API_KEY}`,
    'Content-Type': 'application/pdf',
    'Idempotency-Key': crypto.randomUUID()
  }, body: buf
});
if (!response.ok) throw new Error(JSON.stringify(await response.json()));
const job = await response.json();
console.log(job.job_id);
```

Poll status at intervals of at least 10–15s; stop after `completed`, `failed`,
`cancelled`, or `410`. Never poll every second. Use a backend proxy for
browser uploads so your permanent API key remains private. Each client may
have its own daily quota and independent idempotency namespace.

## Internal worker protocol

Worker-only authenticated paths (`WORKER_SHARED_SECRET`):
`POST /internal/jobs/{id}/claim`, `/heartbeat`, `/complete`, `/fail`.

1. Queue consumer POSTs `{job_id}` to Render `/internal/kick` using the same
   shared secret.
2. Render claims the D1 job atomically; a successful claim returns a lease
   token and private R2 object keys.
3. Render downloads input from R2 with bucket-scoped credentials, invokes
   the converter subprocess, and heartbeats progress to extend the lease.
4. Render uploads EPUB and submits the report. Cloudflare verifies the output
   object exists, overwrites size stats using R2 HEAD, and commits status.
5. On recoverable error, Render reports `retryable:true`; a free Worker Cron
   requeues abandoned or expired leases at five-minute intervals. Max three
   attempts.

The token is not derived from the public job ID; callbacks must present a
secret lease token. An old worker cannot overwrite the result of a newer claim.

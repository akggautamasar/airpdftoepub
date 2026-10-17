# Direct browser uploads (18 MiB)

The authenticated API `POST /v1/upload-tickets` issues a short-lived (5 minute), single-use upload capability scoped to the client's origin, one predeclared file size, conversion preset, and OCR language.

Ticket request (only from your trusted server, with permanent bearer API key):
```json
{"origin":"https://your-site.example","file_bytes":18874368,"preset":"balanced","ocr_languages":"eng+hin","title":"Optional","author":"Optional"}
```
A 201 response includes `job_id`, `upload_token` and `upload_url`. The trusted server should set an HTTP-only job-session cookie before returning the ticket to the browser.

Direct upload (browser; permanent API key **never** sent to browser):
```
POST <upload_url>
Origin: https://your-site.example
Authorization: Bearer <upload_token>
Content-Type: application/pdf

<raw PDF body, exact file_bytes bytes>
```
The token expires after five minutes, is bound to Origin and exact file length, and is atomically consumed before accepting PDF data. Cloudflare checks the PDF header, reserves the client's existing daily job quota, stores the PDF in KV and enqueues the conversion. The usual `GET /v1/jobs/{id}` remains authenticated using the permanent server key.

**Limits**: 18 MiB maximum, 5 pending tickets per API client, one file per ticket, 12 shared daily conversion jobs on the configured AirTools API client. Tickets require an applied D1 migration `0002_upload_tickets.sql`.

**Privacy**: PDF bytes go directly from browser to Cloudflare KV, are processed by Render and expire after roughly 24 hours. This does not make cloud processing local or eliminate paid-infrastructure limits. Tokens are short-lived but still sensitive; never log or store them. Use HTTPS only.

**Security**: The CORS preflight advertises direct upload for any syntactically valid HTTPS origin, but the actual POST verifies exact equality with the origin securely bound to the ticket in D1. No cookies or ambient credentials are used for Cloudflare uploads, and credentials cannot be reused. A new ticket must be issued after failure. Abuse protection still depends on daily client quotas and optional rate controls.

**Deployment order**: apply D1 migration to the existing database, deploy Worker source with bindings preserved, verify ticket issue and direct upload before switching the AirTools frontend. Keep the legacy authenticated /v1/convert route unchanged for other clients.

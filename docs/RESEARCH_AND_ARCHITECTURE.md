# Research and architectural decision record — 2026-10-17

## Decision

Use **Cloudflare Worker (API and queue consumer) + D1 + R2 + Queues + one Render Free Docker web service**. The client contract and converter Python API remain portable so that Render can be replaced with a self-hosted machine or Google Cloud Run. This is a **low-volume experimental system**, not a guaranteed free production OCR farm.

## Five architectures compared

| Option | Ingress & file placement | Coordination | Execution and failure behavior | Decision |
|---|---|---|---|---|
| CF Worker + Render Free + R2 + D1 + Queues | Worker streams raw PDF to private R2 | D1 jobs; queue push wakes Render | Render cold start/restart; expired leases retried; single job at a time | **Selected** |
| CF Worker + Google Cloud Run | Worker streams to R2 | D1 + Queue; on-demand container invocation | More CPU choices / better isolation; requires billing enabled and charges after free allowance | Good upgrade |
| Cloudflare + home/Android PC worker | Same R2/D1 API | Queue HTTP pull when host is available, or Worker wake webhook | No hosted compute fee; local availability/power/network required | Good for large books |
| Render-only | POST PDF to Render; temporary local files | SQLite/files on ephemeral disk | Cold starts; loss on restart; no durable free background worker | Simplest demo, not durable |
| Cloudflare-only | Worker uploads R2 | D1+Queue | 10-ms Worker Free CPU prevents CPU-heavy OCR; many short tasks do not create free compute | Reject for conversion |

Not selected: using GitHub Actions as arbitrary on-demand conversion hosting (CI automation is not an always-on processing service); Colab free managed runtimes explicitly restrict distributed worker processes; new Hugging Face compute Spaces require an eligible paid plan even though CPU Basic hourly rate is zero. A browser-local version can be privacy friendly but Tesseract.js, WASM memory, file size and low-power Android browsers create substantially lower throughput and less predictable UX.

## Verified platform limits

**Workers Free:** 100,000 requests/day, 10ms CPU/request, 128MB memory, 50 subrequests/request, 6 simultaneous outbound connections/request. Cloudflare zone Free 100MB max request body. Worker CPU budget is for actual compute, not waiting for asynchronous I/O. Fail-open must never be used for the security-sensitive API route. Official: https://developers.cloudflare.com/workers/platform/limits/

**R2 Standard:** included 10GB-month storage, 1m Class A operations/month, 10m Class B operations/month, zero R2 egress fees. Beyond these allowances R2 bills per use. You need to activate an R2 subscription and complete Cloudflare's checkout flow; **do not assume it can be activated without a payment method**. Configure spending alerts and retain documents briefly. Official: https://developers.cloudflare.com/r2/pricing/ and https://developers.cloudflare.com/r2/get-started/

**D1 Free:** 5 million rows read/day, 100,000 rows written/day, 5GB total storage/account; each free D1 DB max 500MB. Exceeding daily quotas produces D1 API errors, effectively making job metadata unavailable until reset. Official: https://developers.cloudflare.com/d1/platform/pricing/ and https://developers.cloudflare.com/d1/platform/limits/

**Queues Free:** 10,000 operations/day (typically 3 operations per delivered message: enqueue/read/ack), payload <=128KB, 24-hour fixed retention. Retries consume additional operations. Queue messages are small job references, never full PDFs. A push-based Worker consumer can call Render; alternatively use an HTTP pull consumer, but cannot configure both consumer types for the same queue. Official: https://developers.cloudflare.com/queues/platform/pricing/, https://developers.cloudflare.com/queues/platform/limits/ and https://developers.cloudflare.com/queues/configuration/pull-consumers/

**Render Free:** 0.1 CPU, 512MB RAM, 750 free instance-hours/workspace/month. Idle web services sleep after 15 minutes without inbound traffic, commonly taking around a minute to wake; free services can restart at any time. Local disk and local SQLite state disappear on sleep/restart/deploy. No free persistent disk, horizontally scaled web service, or managed background-worker service. Free Postgres expires after 30 days and Free Key Value loses data on restarts; neither replaces D1 for this architecture. Outbound bandwidth/build usage is limited separately, and high outbound traffic may cause suspension. Official: https://render.com/docs/free and https://render.com/docs/compute-plans

**GitHub Actions:** standard GitHub-hosted runners are free for public repos; private repo minute/storage quotas vary by plan. Treat as CI/test/build only, not an unrestricted conversion service or interactive job queue. Official: https://docs.github.com/en/actions/concepts/billing-and-usage

**Google Cloud Run alternative:** request-based free tier includes 180,000 vCPU-s, 360,000 GiB-s RAM and 2m requests per month (regional and pricing-model caveats); Cloud Run Jobs have separate free allowances. Requires enabled billing and overage governance. Official: https://cloud.google.com/run/pricing

**Colab:** managed free runtimes can terminate unexpectedly and distributed compute workers are explicitly restricted. https://research.google.com/colaboratory/faq.html

**Hugging Face Spaces:** new Gradio/Docker compute Spaces require eligible paid plan even if CPU Basic hours have $0 rate; sleep and disk are nonpersistent. https://huggingface.co/docs/hub/spaces-overview

## Availability definitions

- **Permanently deployed endpoint:** a Worker DNS route remains deployed across requests.
- **Always-available API:** edge requests usually work while Worker/D1/R2 free quotas remain; not an SLA.
- **Always-on compute process:** NOT provided by Render Free; service sleeps and may restart.
- **Background work independent of client HTTP:** yes, the queue dispatches an asynchronously accepted job; **not guaranteed** once accepted by an ephemeral Render process. The D1 lease/retry architecture provides at-least-once recovery after interruption, subject to queue and compute availability.
- **Free service that sleeps:** Render Free; cold starts mean jobs may remain queued, and best-effort retries are necessary.

## Stage ownership and durable protocol

1. Worker authenticates application key (SHA-256 hash in D1), validates size/options and quota.
2. Worker streams incoming PDF to private R2 under `input/<job_id>.pdf`, verifies object size, records `queued` D1 job, sends compact Queue message.
3. Queue consumer calls Render `/internal/kick` and acknowledges only after Render accepts the work. Render Free cold start delays are expected.
4. Render atomically claims job from Worker `/internal/jobs/<id>/claim`; D1 assigns random lease token. Render downloads R2 PDF to a bounded temp directory; no intermediate file is passed through D1 or the Cloudflare queue.
5. Python child process extracts PDF sequentially and emits JSON-line progress. Render heartbeats D1 through authenticated Worker control endpoint.
6. Python packager writes EPUB to temp disk, validates internal ZIP/XML format; Render uploads completed EPUB to `output/<id>.epub` and callback includes measured report.
7. Worker checks R2 object HEAD and overrides final output size/compression metrics, commits D1 `completed`, and serves private download streaming from R2 to authenticated original client.
8. Workers Cron every five minutes requeues queued / expired-lease jobs, marks exhausted retries failed, and deletes logically expired data. R2 lifecycle TTLs provide a second deletion backstop.

All retries are **at least once**, not exactly once. Only D1 lease winner is allowed to mark complete. Duplicate queue messages may cause unnecessary dispatch calls but cannot result in two authoritative completions. The implementation does not yet persist per-range intermediate checkpoints: interrupted conversions restart from page 1. This is a deliberate simplicity trade-off at the initial low-volume stage.

## Expected concurrency

Render Free has a single bounded processing slot. Extra requests remain in Queues/D1 and may see dispatch retries. Raising Python threads from 1 to 4 does **not** multiply 0.1 CPU or 512MB RAM; it increases contention and OOM risk. If 10 OCR-heavy books arrive simultaneously, queue latency could be hours or jobs may time out. Real capacity must be measured on Render; no fabricated books-per-hour promise is made.

If a worker is killed while converting, its lease expires after 10min. Scheduled retries will eventually claim it again, at most three attempts. If queue's 24h retention is exhausted, D1 still holds queued jobs until 24h job expiry; the cron reconciler can reenqueue while service/quotas are available. If Compute never becomes available before expiration, the client will receive `410 expired` rather than a false completion.

## Choice of Python libraries and licences

| Component | Selected / optional | Why | Licence / notes |
|---|---|---|---|
| pdfplumber / pdfminer.six | Selected | Native text, bounding boxes and bordered tables | MIT |
| pypdfium2 / PDFium | Selected | Render page bitmaps only when necessary | Apache-2.0 / BSD-3-Clause pypdfium2 and bundled dependency notices |
| pypdf | Selected | PDF metadata and encryption recognition | BSD-3-Clause |
| Tesseract | Selected | Offline English/Hindi and other installed language OCR | Apache-2.0, Leptonica BSD-style |
| Pillow | Selected | Image resizing, JPEG/PNG optimization | HPND-compatible permissive licence |
| stdlib zipfile + XML | Selected | EPUB3 packaging without AGPL EbookLib | Python standard library |
| FastAPI + uvicorn | Selected | Internal compute wake/health API | MIT / BSD-style respectively |
| boto3 + httpx | Selected | R2 S3 streaming and callback HTTP | Apache-2.0 / BSD-3-Clause |
| EPUBCheck | Optional/full validation | Official EPUB standard conformance, heavier Java dependency | MIT; install jar when resources permit |
| OCRmyPDF | Optional alternative | Adds searchable text layer to PDF; extra intermediate PDF unnecessary for EPUB | MPL-2.0 |
| PyMuPDF | Not used | Fast text/layout engine, possible paid/open-source option | AGPL-3.0 or commercial licence |
| EbookLib | Not used | Convenient EPUB authoring but copyleft for proprietary service | AGPL-3.0+ |
| calibre | Not used | Mature reference CLI, broader feature set and large Docker footprint | GPL-3.0; assess obligations |
| Docling / PaddleOCR | Future upgrade | Better ML-based layout or Hindi OCR where justified | MIT code (model licences separately) / Apache-2.0 code |
| Surya | Not baseline | Strong document OCR/layout but heavyweight models and licence restrictions | GPL/model licence restrictions—review carefully |

Primary sources: https://github.com/jsvine/pdfplumber ; https://pypdfium2.readthedocs.io/en/stable/readme.html ; https://github.com/tesseract-ocr/tesseract ; https://github.com/ocrmypdf/ocrmypdf ; https://github.com/aerkalov/ebooklib ; https://github.com/pymupdf/PyMuPDF ; https://www.w3.org/publishing/epubcheck/ ; https://github.com/PaddlePaddle/PaddleOCR ; https://github.com/docling-project/docling .

Do not interpret this as formal legal advice. Comply with licence notices, especially bundled PDFium dependencies and all installed model weights if upgrading to ML.

## Algorithm and quality presets

**Preflight:** reject empty/invalid/encrypted files and excessive page count; inspect metadata and per-page selectable text. **Native:** text normally comes from pdfplumber, with a conservative central-gutter test for simple two-column pages; bordered tables become basic XHTML tables. **Scanned:** PDFium renders a page then Tesseract does OCR; no redundant OCR for pages with usable selectable text. **Hybrid:** decision per page. **Visuals:** bounded image-region raster crops, deduplicated by image content hash; high-fidelity retains full-page facsimiles on highly vector-rich pages. **Output:** semantic-ish EPUB3 XHTML, CSS, navigation, metadata and assets; ZIP CRC/XML checks by default, EPUBCheck optionally.

- `maximum_compression`: images up to about 1050 px, JPEG Q55, omit full-page vector facsimiles.
- `balanced`: images up to about 1450 px, JPEG Q75, text-first.
- `high_fidelity`: images up to about 2000 px, JPEG Q88, vector-rich pages retain raster facsimile.

These knobs influence appearance/file size, not guaranteed semantic fidelity. Drawings, math equations, page-spanning tables, captions, diagrams and heading hierarchy may still need human review. Scanned pages retain compressed raster facsimiles alongside OCR text so embedded visual elements are not silently dropped. Current figures are appended after each page's text; fine-grained paragraph anchoring remains a follow-up enhancement.

## What would justify distributed page workers?

When Render is replaced by reliably available compute (e.g., separate Cloud Run Jobs, stronger self-hosted hosts), add D1 `job_parts` rows keyed by `(job_id, start_page, end_page, engine_version)` and R2 assets `parts/<job_id>/<range>/...` with checksums. The coordinator atomically claims page ranges, sends one Queue message per range, validates all part manifests and then assembles in page order. For now, each extra message and worker adds retry, ordering and validation overhead without adding CPU on Render Free.

## Capacity and eventual bills

A hypothetical 20 requests/day × 12MB PDF input × 4MB output, retained for up to 24h, is roughly 320MB steady-state object storage **if evenly submitted** (plus transient copies). R2 operation count is negligible relative to free allowances; compute dominates. This is an illustrative planning calculation, not a benchmark. At 100+ scanned books/day, a single 0.1 CPU Render host is not viable even if object-storage quotas remain free.

An R2 subscription is not the same thing as a guaranteed $0 invoice. D1/Queues/Workers Free generally fail or stop processing at included daily quotas; R2 beyond free usage can incur charges. Set Cloudflare billing alerts and optional R2 usage enforcement; enable a strict account-level budget where supported. Avoid opening a public, unmetered upload endpoint.

## Operational and security limits

Implemented: bearer-token API key hashing, per-client daily quotas, private R2 objects, client-scoped downloads, capped raw request bodies, page/OCR/image caps, queue retry limit, atomic D1 claims, rotating random lease tokens, cancellation by heartbeat, subprocess CPU/file descriptor/file size controls, unprivileged Docker user, short local temp directories, logical expiry and physical R2 cleanup.

Not yet production-hardened: PDF antivirus scanning, content hash deduplication across clients, admission-control byte quotas, fully isolated no-network containers/seccomp policies, separate private networking, deterministic multi-range checkpoints, per-document OCR confidence scoring, strong automated visual diff, or guaranteed full EPUBCheck on free Render. Threat-model the system before unrestricted public signup. Logs should not include PDF content, API credentials or document titles.

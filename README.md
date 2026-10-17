# Free PDF→EPUB API — Cloudflare + Render

A reusable, independently callable Python PDF-to-EPUB3 converter with a versioned
Cloudflare REST API. Designed for **low-volume/experimental free-tier hosting**,
not guaranteed 24/7 processing. Built and locally tested on 17 October 2026.

**Start here:** [Architecture research](docs/RESEARCH_AND_ARCHITECTURE.md),
[API contract and JSON examples](docs/API.md),
[benchmark instructions](docs/TESTING.md).

## Status and honest limitations

- Implemented: native vs OCR decision **per page**, English/Hindi Tesseract OCR,
  basic hybrid PDFs, conservative two-column and bordered-table heuristics,
  selected images, scanned-page facsimiles and vector-rich high-fidelity facsimiles, deduplicated assets,
  XHTML EPUB3 metadata/TOC, per-preset image optimization, ZIP/XML validation,
  measured byte statistics and warnings.
- Implemented: Cloudflare Worker API, KV-backed temporary files, D1 job state/auth/quota,
  Cloudflare Queues push consumer, Render wake/worker endpoint, D1 leases,
  retry reconciliation, cancellation and authenticated download.
- Not solved: universal reading-order recovery, math-to-MathML equations,
  semantically robust borderless tables, exact figure anchors, EPUBCheck by
  default, full page-range checkpoints, unconditional OCR accuracy or zero-loss
  guarantees. For visual textbooks, review warnings and spot-check output.
- Cloudflare D1, Queues and KV have been provisioned on the connected account.
  **The Render service and public Worker have not been deployed**, and no full
  end-to-end conversion has been verified in your accounts.

## Repository

```text
pdfepub-api/
├── README.md
├── Dockerfile                     # Python worker container, non-root
├── render.yaml                    # Render Free web service blueprint
├── python/
│   ├── pyproject.toml
│   ├── pdfepub/
│   │   ├── __init__.py            # Public convert_pdf() import
│   │   ├── converter.py           # Native/OCR/hybrid/layout/image pipeline
│   │   ├── epub.py                # EPUB3 authoring and ZIP/XML checks
│   │   ├── cli.py                 # Local CLI with JSON-line progress
│   │   └── service.py             # Render wake, KV I/O, lease heartbeats
│   └── tests/test_converter.py
├── cloudflare/
│   ├── wrangler.jsonc             # Worker, KV, D1, Queues, Cron
│   ├── package.json
│   ├── migrations/0001_init.sql
│   └── src/index.js              # Public and internal API, consumer/cron
├── scripts/new_client.py         # Generate API key + D1 insertion command
├── docs/API.md
├── docs/RESEARCH_AND_ARCHITECTURE.md
└── docs/TESTING.md
```

## 1. Run the converter locally before any cloud deployment

Prerequisites: Linux/Ubuntu, Python 3.11+, Tesseract with English and Hindi,
Node 20+ for Cloudflare Wrangler. On Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y python3-venv tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e './python[test]'
pytest -q python/tests
# Test a real book you have the right to process:
pdfepub book.pdf book.epub --options '{"preset":"balanced","ocr_languages":"eng+hin"}'
```

Or directly from Python:

```python
from pdfepub import convert_pdf
report = convert_pdf('book.pdf', 'book.epub',
                     {'preset': 'balanced', 'ocr_languages': 'eng+hin'})
print(report['original_bytes'], report['epub_bytes'], report['reduction_percent'])
```

`maximum_compression`, `balanced`, `high_fidelity` are supported. Running
locally defaults to 300 pages / 30 OCR pages; environment variables
`PDFEPUB_MAX_PAGES` and `PDFEPUB_MAX_OCR_PAGES` override the two safeguards.
The Render image defaults to **120 pages and 12 OCR pages** because Render Free
is heavily CPU/memory restricted. A large native PDF can still time out.

## 2. Create a GitHub repository

Create a **new empty** GitHub repo named `pdfepub-api` under your own account,
then from this project's root:

```bash
git init
git add .
git commit -m 'Initial portable PDF-to-EPUB service'
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pdfepub-api.git
git push -u origin main
```

The source includes no real credentials. Keep `.env` files out of Git.
For commercial/proprietary projects, assess all bundled third-party notices.

## 3. Provision Cloudflare card-free resources

This edition replaces R2 with **Workers KV**. Workers KV is available without a credit card.
Storage limits on the free plan: 1 GB total, 25 MiB per value, 1,000 writes/day,
100,000 reads/day. To leave headroom, this API caps a PDF at 18 MiB and an EPUB
at 22 MiB; files auto-expire after 24 hours. KV uses **eventual consistency**,
so other geographic locations can require >60 seconds before reading a new file.

Cloudflare resources ALREADY provisioned in the connected account:

- D1 database `pdfepub-db` id `3803a7bf-5310-4bff-a7d7-edc5732195e8`
- Queue `pdfepub-jobs`
- KV namespace `pdfepub-temp-files` id `c8b9216d235949fdb3d794eb72184fc9`

From `cloudflare/`, install Node dependencies, log in, and apply migrations if
not already run (the connected D1 database already has its schema):

```bash
npm install
npx wrangler login
npx wrangler d1 migrations apply pdfepub-db --remote
```

## 4. Cloudflare Worker and Render deployment

**1.** Set `RENDER_URL` to the newly created Render service public HTTPS URL in
`cloudflare/wrangler.jsonc`; leave `ALLOWED_ORIGINS` blank unless browser clients
require explicit origins.

**2.** Generate a long shared secret using `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
Configure this **same exact** secret in the Worker and the Render service.

**3.** Deploy the Worker and its secret:

```bash
cd cloudflare
npx wrangler secret put WORKER_SHARED_SECRET
npx wrangler deploy
```

**4.** Deploy `Dockerfile` to a Render **Free Web Service**, selecting your source
GitHub repository, using Docker runtime and the same repository-root Dockerfile.
Configure two Render environment variables:

- `EDGE_URL=https://pdfepub-edge.worksbeyondworks.workers.dev`
- `WORKER_SHARED_SECRET` (same random value as the Worker)

**5.** Run `python scripts/new_client.py` to generate a client API key plus the
D1 INSERT command. Apply the INSERT remotely through Wrangler D1. Store
issued API keys privately; give separate keys to AirTools and any Telegram bot.

**6.** Send a small real PDF. Example:

```bash
curl -X POST "https://pdfepub-edge.worksbeyondworks.workers.dev/v1/convert?preset=balanced" \
  -H "Authorization: Bearer YOUR_CLIENT_API_KEY" \
  -H "Content-Type: application/pdf" --data-binary @book.pdf
```

Poll `GET /v1/jobs/{job_id}` with the Bearer key and download from
`GET /v1/jobs/{job_id}/download` after completion. If output temporarily
returns HTTP 503 with `not_yet_visible`, wait and retry: this is KV's
cross-region propagation delay.

## 5. Operations and security

- Do not store secrets in version control or public app bundles.
- Protect the Render internal endpoint with the shared secret.
- Keep no more than one Render conversion active concurrently (single free instance).
- KV content expires independently after 24 hours; cron clears metadata.
- Cloudflare D1 is authoritative for job leases and cancellation; KV is **not** a queue.
- Worker queue dispatch can retry while Render starts (free services may sleep).
- PDF input is untrusted and parsed in a non-root subprocess; further sandboxing
  is necessary for unrestricted public submissions.
- This is an experimental deployment, not guaranteed always-on conversion.

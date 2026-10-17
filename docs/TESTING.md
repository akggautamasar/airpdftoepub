# Testing and benchmark methodology

## Smoke tests

```bash
python -m pip install -e './python[test]'
pytest -q python/tests
node --check cloudflare/src/index.js
```

The tests create their own PDFs and verify: native text fidelity, metadata,
EPUB ZIP/XML, OCR on a scanned page, hybrid processing, image preservation,
bordered table reconstruction, unsafe option rejection, corrupt file rejection.
They do not use personal or copyrighted test books.

## Benchmark data sets

Use 5–20 reference PDFs for each category; publish only data you may share.
Include: (a) native English novels 50/150/300 pages; (b) 10/30/100-page
scans at multiple DPI; (c) image-rich textbooks/photobooks; (d) bilingual
English/Hindi pages with Devanagari; (e) two-column papers; (f) ruled/borderless
tables; (g) math and SVG/vector-heavy pages; (h) corrupt/encrypted PDFs and
oversize PDFs. Manually prepare page-level OCR ground truth for 10+ pages per
language, with text and figure count references.

## Record actual metrics

- PDF size and EPUB size (bytes), percentage reduction **after** output exists.
- Throughput: wall time, CPU seconds, peak RSS via `/usr/bin/time -v`.
- OCR CER (character error rate) and WER against ground truth (Hindi Unicode
  normalization is important); native exact-text token coverage.
- Content recall: manual count of photographs/figures/tables/equations and
  readable captions preserved; no silent empty sections.
- EPUBCheck errors and warnings; reader opening in Calibre, Apple Books or
  Thorium; spot-check reflow at small viewport and larger accessibility text.
- Mixed workloads: p50/p95 queue wait, p50/p95 conversion wall time, success
  rate, retry rate, timeouts, throughput under 1, 5 and 10 simultaneous jobs.
- Recovery: restart Render in mid-OCR, temporarily block R2, cancel in-flight,
  delete an output, force queue retries and repeated idempotency requests.
- Security: cross-tenant authorization, invalid signatures, malformed PDFs,
  30MiB+ upload rejection, query validation, quota enforcement, expired files,
  malicious content and resource exhaustion tests in an isolated environment.

## Example local benchmark command

```bash
/usr/bin/time -v python -m pdfepub.cli bench.pdf bench.epub \
  --options '{"preset":"balanced","ocr_languages":"eng+hin"}' 2> bench-resource.txt
```

Use original input checksums and a unique output directory per run. Repeat at
least three times and report median wall time and peak RSS; cold starts and
queue latency should be measured separately on Render.

## Quality acceptance targets (proposed, not current benchmark results)

| Metric | Proposed goal | Notes |
|---|---|---|
| Native token recall | >=99% on uncomplicated digital books | Computed text token match plus visual review |
| OCR CER English | <=5% on clear 300 DPI pages | Ground-truth set needed |
| OCR CER Hindi | <=10% on clear 300 DPI pages | Tune model/fonts; this is aspirational |
| Images preserved | >=98% of manually identified essential pictures | Vector art may be rasterized in fidelity mode |
| EPUBCheck errors | 0 | Must enable full EPUBCheck to verify |
| Memory | Under 512MB during Render worker tests | Real Render measurement required |
| Completion | >=95% of admitted text-centric PDFs | Must measure; not guaranteed |
| Compression | Report actual signed percentage | Negative percentages are valid |

Targets are not results. Do not advertise compression percentages or OCR
accuracy until benchmark results establish them.

## Cloud integration checks after deployment

1. Submit 2-page digital test PDF, verify `202 → running → completed`.
2. Verify authenticated EPUB download and report byte counts against local files.
3. Submit same idempotency key; check same job ID without extra daily quota debit.
4. Use a different application key: same job ID must return `404`.
5. Submit a scanned PDF, verify `ocr_pages>0` and output text.
6. Stop/restart Render during a job: verify no false `completed` state and
   recovery after lease expiry. For large OCR, job may fail after 3 tries.
7. Cancel during processing; expect `cancelled`, download unavailable.
8. Wait for expiry (or shorten TTL in a disposable test environment);
   verify `410` and later R2 object cleanup.
9. Test quotas, unknown language packs, empty PDF, corrupted PDF and
   Cloudflare platform limits.

## First measured synthetic smoke results (local container, 2026-10-17)

These are actual measured file sizes from the small ReportLab-generated test
fixtures (not production books, and **not** conversion-speed benchmarks):

| Test fixture | Input PDF | Output EPUB | Size reduction |
|---|---:|---:|---:|
| Tiny native-text 2-page PDF | 2,122 bytes | 2,085 bytes | +1.74% |
| Tiny table + image PDF | 2,246 bytes | 2,584 bytes | **−15.05%** |
| Tiny hybrid/scan PDF | 11,902 bytes | 14,819 bytes | **−24.51%** |

The negative reductions matter: adding EPUB structure and preserving scanned
facsimiles can make tiny source PDFs *larger*. Large photo-heavy PDF books may
compress well when resampled, but that is a separate test requiring real
reference material. The system never promises a positive compression ratio.

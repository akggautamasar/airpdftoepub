FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_THREAD_LIMIT=1 PIP_NO_CACHE_DIR=1
# Hindi traineddata adds size; languages are deliberately installed at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY python/pyproject.toml /app/pyproject.toml
COPY python/pdfepub /app/pdfepub
RUN python -m pip install --upgrade pip && python -m pip install .
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin convertuser \
    && mkdir -p /tmp/pdfepub && chown -R convertuser:convertuser /tmp/pdfepub /app
USER 10001
ENV TMPDIR=/tmp/pdfepub
ENV PDFEPUB_MAX_PAGES=120 PDFEPUB_MAX_OCR_PAGES=12
EXPOSE 10000
CMD ["sh", "-c", "uvicorn pdfepub.service:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1 --timeout-keep-alive 10"]

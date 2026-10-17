"""Guard against Render Docker env silently overriding Python OCR limits."""
from pathlib import Path
import re
from pdfepub.converter import Options

DOCKERFILE = Path(__file__).resolve().parents[2] / "Dockerfile"

def test_docker_defaults_match_converter_ocr_limits(monkeypatch):
    contents = DOCKERFILE.read_text(encoding="utf-8")
    settings = {}
    for line in contents.splitlines():
        if line.startswith("ENV "):
            settings.update(dict(re.findall(r"([A-Z_]+)=([0-9]+)", line)))
    assert settings["PDFEPUB_MAX_PAGES"] == "300"
    assert settings["PDFEPUB_MAX_OCR_PAGES"] == "300"
    monkeypatch.setenv("PDFEPUB_MAX_PAGES", settings["PDFEPUB_MAX_PAGES"])
    monkeypatch.setenv("PDFEPUB_MAX_OCR_PAGES", settings["PDFEPUB_MAX_OCR_PAGES"])
    opts = Options.from_dict({"ocr_languages": "eng+hin"})
    assert opts.max_pages == 300
    assert opts.max_ocr_pages == 300

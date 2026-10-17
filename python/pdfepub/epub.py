"""Small EPUB3 packager, no AGPL dependencies.

Produces EPUB3 files with package metadata, navigation, spine, compressed XHTML
and internal assets. For formal conformance use the separate EPUBCheck command.
"""
from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import html
import zipfile
import re
import xml.etree.ElementTree as ET

CSS = """html{font-size:100%}body{font-family:serif;line-height:1.55;margin:5%}p{text-align:justify;margin:.65em 0}h1,h2,h3{line-height:1.25;text-align:left}figure{margin:1em auto}figure img{max-width:100%;height:auto}figcaption{text-align:center;font-size:.85em}table{border-collapse:collapse;max-width:100%;width:100%}th,td{border:1px solid #888;padding:.3em;overflow-wrap:anywhere}pre{white-space:pre-wrap}img{max-width:100%}"""


def build_epub(path: Path, chapters: list[dict], assets: dict[str, bytes], *,
               title: str, author: str = "Unknown", language: str = "en") -> None:
    # EPUB3 uses XML 1.0: strip invalid control chars from untrusted metadata.
    xmlsafe=lambda v: re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]','',str(v))
    title=xmlsafe(title);author=xmlsafe(author);language=xmlsafe(language)
    path = Path(path)
    uid = f"urn:uuid:{uuid4()}"
    modified = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    chapter_items = []
    nav_items = []
    spine = []
    for n, chapter in enumerate(chapters, 1):
        cid = f"ch{n:04d}"
        fname = f"text/{cid}.xhtml"
        chapter_items.append(f'<item id="{cid}" href="{fname}" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="{cid}"/>')
        nav_items.append(f'<li><a href="{html.escape(fname, quote=True)}">{html.escape(xmlsafe(chapter["title"]))}</a></li>')
    asset_items = []
    for i, name in enumerate(sorted(assets), 1):
        media = "image/jpeg" if name.lower().endswith((".jpg", ".jpeg")) else "image/png"
        asset_items.append(f'<item id="img{i}" href="images/{html.escape(name, quote=True)}" media-type="{media}"/>')
    package = f'''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="{html.escape(language,quote=True)}">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:identifier id="pub-id">{uid}</dc:identifier><dc:title>{html.escape(title)}</dc:title><dc:creator>{html.escape(author)}</dc:creator>
  <dc:language>{html.escape(language)}</dc:language><meta property="dcterms:modified">{modified}</meta>
 </metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
 <item id="css" href="styles/book.css" media-type="text/css"/>
 {''.join(chapter_items)}{''.join(asset_items)}
 </manifest><spine>{''.join(spine)}</spine></package>'''
    nav = f'''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{html.escape(language,quote=True)}"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>{''.join(nav_items)}</ol></nav></body></html>'''
    container = '''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'''
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/package.opf", package, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/nav.xhtml", nav, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/styles/book.css", CSS, compress_type=zipfile.ZIP_DEFLATED)
        for i, ch in enumerate(chapters, 1):
            inner = ch['html'] or '<p>No extractable content on this section.</p>'
            xhtml = f'''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{html.escape(language,quote=True)}"><head><title>{html.escape(xmlsafe(ch['title']))}</title><link rel="stylesheet" type="text/css" href="../styles/book.css"/></head><body><h1>{html.escape(xmlsafe(ch['title']))}</h1>{inner}</body></html>'''
            zf.writestr(f"OEBPS/text/ch{i:04d}.xhtml", xhtml, compress_type=zipfile.ZIP_DEFLATED)
        for filename, data in assets.items():
            zf.writestr(f"OEBPS/images/{filename}", data, compress_type=zipfile.ZIP_DEFLATED)


def validate_epub(path: Path) -> list[str]:
    errors = []
    with zipfile.ZipFile(path) as zf:
        if zf.namelist()[0] != "mimetype":
            errors.append("mimetype not first")
        if zf.getinfo('mimetype').compress_type != zipfile.ZIP_STORED:
            errors.append("mimetype compressed")
        if zf.read('mimetype') != b'application/epub+zip':
            errors.append("wrong mimetype")
        bad = zf.testzip()
        if bad:
            errors.append(f"ZIP CRC error: {bad}")
        for name in zf.namelist():
            if name.endswith(('.xhtml', '.opf', '.xml')):
                try:
                    ET.fromstring(zf.read(name))
                except ET.ParseError as exc:
                    errors.append(f"Invalid XML {name}: {exc}")
        if 'OEBPS/nav.xhtml' not in zf.namelist():
            errors.append('Missing navigation')
    return errors

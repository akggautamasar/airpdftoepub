"""Single-process streaming-ish PDF-to-EPUB converter for resource-constrained hosts.

Conservative: meaningful visual elements are retained as cropped images. Not a
pixel-perfect typesetting system and not a perfect equation/table recognizer.
"""
from __future__ import annotations
from dataclasses import dataclass
from collections import Counter
from io import BytesIO
from pathlib import Path
from typing import Callable
from PIL import Image, ImageStat
import hashlib
import html
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time

import pdfplumber
import pypdfium2 as pdfium
from pypdf import PdfReader
from .epub import build_epub, validate_epub

class ConversionError(Exception):
    pass

@dataclass(frozen=True)
class Options:
    preset: str = 'balanced'
    ocr_languages: str = 'eng+hin'
    title: str | None = None
    author: str | None = None
    max_pages: int = 300
    max_ocr_pages: int = 30

    @classmethod
    def from_dict(cls, obj: dict | None) -> 'Options':
        data = obj or {}
        if not isinstance(data, dict):
            raise ConversionError('Invalid options object')
        preset = data.get('preset', 'balanced')
        if preset not in ('maximum_compression','balanced','high_fidelity'):
            raise ConversionError('Unknown preset')
        languages = data.get('ocr_languages','eng+hin')
        if not isinstance(languages,str) or not re.fullmatch(r'[a-z]{3}(\+[a-z]{3}){0,3}',languages):
            raise ConversionError('Invalid OCR language list')
        return cls(preset=preset,ocr_languages=languages,
                   max_pages=int(os.environ.get('PDFEPUB_MAX_PAGES','300')),
                   max_ocr_pages=int(os.environ.get('PDFEPUB_MAX_OCR_PAGES','30')),
                   title=str(data['title'])[:160] if data.get('title') else None,
                   author=str(data['author'])[:160] if data.get('author') else None)


def _render(pdf, index: int, scale: float) -> Image.Image:
    bmp = pdf[index].render(scale=scale, rotation=0)
    image = bmp.to_pil().convert('RGB')
    bmp.close()
    return image


def _ocr(pdf, index: int, language: str, temp: Path) -> str:
    if not shutil.which('tesseract'):
        raise ConversionError('OCR required but Tesseract is not installed')
    image = _render(pdf, index, 1.8)
    img = temp / f'ocr_{index}.png'
    image.save(img, format='PNG')
    image.close()
    env = {**os.environ, 'OMP_THREAD_LIMIT':'1'}
    try:
        proc = subprocess.run(['tesseract',str(img),'stdout','-l',language,'--psm','3'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=env,timeout=50,check=False)
        if proc.returncode != 0:
            raise ConversionError('Tesseract OCR failed: '+proc.stderr.decode('utf8','replace')[-240:])
        return proc.stdout.decode('utf-8', 'replace').strip()
    except subprocess.TimeoutExpired as ex:
        raise ConversionError('OCR timed out on page') from ex
    finally:
        img.unlink(missing_ok=True)


def _text_quality(s: str) -> bool:
    chars = [c for c in s if not c.isspace()]
    if len(chars) < 50:
        return False
    # PDFs with invalid text mapping often expose control/replacement chars.
    illegible = sum(c == '\ufffd' or (ord(c)<32 and c not in '\n\r\t') for c in chars)
    return illegible / max(len(chars),1) < .08


def _extract_columns(page) -> tuple[str,bool]:
    """Detect simple two-column text using a sparsely populated central gutter."""
    try:
        words=page.extract_words() or []
        mid=float(page.width)/2
        left=sum(w['x1'] <= mid-6 for w in words)
        right=sum(w['x0'] >= mid+6 for w in words)
        crossing=sum(w['x0']<mid+6 and w['x1']>mid-6 for w in words)
        if min(left,right)<35 or crossing>max(4,len(words)*.035):
            return page.extract_text() or '',False
        # Column text is ordered left -> right instead of across visual rows.
        left_text=page.crop((0,0,mid-6,float(page.height))).extract_text() or ''
        right_text=page.crop((mid+6,0,float(page.width),float(page.height))).extract_text() or ''
        normal=page.extract_text() or ''
        # Conservative guard against destructive column misclassification.
        if len(left_text)+len(right_text) < len(normal)*.92:
            return normal,False
        return left_text+'\n\n'+right_text,True
    except Exception:
        return page.extract_text() or '',False


def _structured_native(page, index: int, warnings: list[str]) -> tuple[str,list[str],int]:
    """Return native text and ordered XHTML parts; reconstruct bordered tables."""
    out=[]
    ntable=0
    try:
        tables=page.find_tables() if len(page.lines or [])>=4 else []
        good=[]
        for t in tables:
            rows=t.extract() or []
            if len(rows)>=2 and any(any((c or '').strip() for c in row) for row in rows):
                good.append((t.bbox,rows))
        good.sort(key=lambda item:item[0][1])
        cursor=0.0
        for bbox,rows in good[:10]:
            top=max(0.,float(bbox[1])); bottom=min(float(page.height),float(bbox[3]))
            if top<cursor or bottom<=top: continue
            if top>cursor+2:
                region=page.crop((0,cursor,float(page.width),top))
                before,multi=_extract_columns(region)
                if multi:warnings.append(f'Page {index+1}: two-column text detected')
                out.extend(_content_blocks(before))
            cells=[]
            for ri,row in enumerate(rows):
                tag='th' if ri==0 else 'td'
                cells.append('<tr>'+''.join(f'<{tag}>'+_html_text(str(c or ''))+f'</{tag}>' for c in row)+'</tr>')
            out.append('<table><tbody>'+''.join(cells)+'</tbody></table>')
            cursor=bottom;ntable+=1
        if cursor<float(page.height)-2:
            after=page.crop((0,cursor,float(page.width),float(page.height))) if cursor>0 else page
            remaining,multi=_extract_columns(after)
            if multi:warnings.append(f'Page {index+1}: two-column text detected')
            out.extend(_content_blocks(remaining))
        if not out:out=_content_blocks(page.extract_text() or '')
    except Exception as exc:
        warnings.append(f'Page {index+1}: table/column reconstruction fell back to plain text')
        out=_content_blocks(page.extract_text() or '')
    native=page.extract_text() or ''
    return native,out,ntable


def _html_text(s: str) -> str:
    safe=re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]', '', str(s))
    return html.escape(safe, quote=False)


def _content_blocks(text: str) -> list[str]:
    """Simple semantic recovery; preserve content even if classification uncertain."""
    rows = [r.strip() for r in text.splitlines()]
    blocks: list[str] = []
    current: list[str] = []
    def flush():
        if current:
            blocks.append('<p>' + _html_text(' '.join(current)) + '</p>')
            current.clear()
    for row in rows:
        if not row:
            flush(); continue
        if re.match(r'^([\u2022\u25cf\u25aa*]|[-–])\s+',row):
            flush(); blocks.append('<p>• '+_html_text(re.sub(r'^[\u2022\u25cf\u25aa*–-]\s+','',row))+'</p>')
        elif len(row)<95 and (re.match(r'^(chapter|unit|भाग|अध्याय|section)\s*[\dIVX\u0966-\u096f:.-]*\b',row,re.I)
             or (row.isupper() and len(row)>7 and len(row.split())<9)):
            flush(); blocks.append('<h2>'+_html_text(row)+'</h2>')
        else:
            # Explicit line endings and hyphenation common in PDF line extraction.
            if current and current[-1].endswith('-') and row[:1].islower():
                current[-1] = current[-1][:-1] + row
            else:
                current.append(row)
    flush()
    return blocks


def _image_bytes(image: Image.Image, preset: str) -> tuple[bytes,str]:
    widths = {'maximum_compression':1050,'balanced':1450,'high_fidelity':2000}
    quality = {'maximum_compression':55,'balanced':75,'high_fidelity':88}
    img = image.copy()
    img.thumbnail((widths[preset],widths[preset]*2),Image.Resampling.LANCZOS)
    if img.mode not in ('RGB','L'): img=img.convert('RGB')
    # Avoid lossy encoding of sharply-edged line drawings or small graphics.
    quant = img.copy(); quant.thumbnail((150,150))
    colors = quant.convert('RGB').getcolors(maxcolors=128)
    output=BytesIO()
    if colors is not None and len(colors)<=64:
        img.save(output,format='PNG',optimize=True)
        ext = '.png'
    else:
        img.save(output,format='JPEG',quality=quality[preset],optimize=True,progressive=True)
        ext = '.jpg'
    img.close(); quant.close()
    return output.getvalue(), ext


def _extract_images(page, pdf, index: int, preset: str, warnings: list[str]) -> list[tuple[float,bytes,str]]:
    images=[]
    rendered=None
    scale = 1.3 if preset=='maximum_compression' else 1.6
    for bbox in (page.images or [])[:30]:
        x0=max(0,float(bbox['x0'])); x1=min(float(page.width),float(bbox['x1']))
        top=max(0,float(bbox['top'])); bottom=min(float(page.height),float(bbox['bottom']))
        if x1-x0 < 22 or bottom-top < 22: continue
        if (x1-x0)*(bottom-top) > float(page.width)*float(page.height)*.8:
            # OCR scan-background: text was reflowed instead of embedding huge page.
            continue
        try:
            # Render once per page and crop all visual assets from that image.
            if rendered is None: rendered = _render(pdf,index,scale)
            crop = rendered.crop((round(x0*scale),round(top*scale),round(x1*scale),round(bottom*scale)))
            data, ext = _image_bytes(crop,preset)
            crop.close()
            images.append((top,data,ext))
        except Exception as ex:
            warnings.append(f'Page {index+1}: could not preserve image: {str(ex)[:90]}')
    if rendered is not None: rendered.close()
    if len(page.images or []) > 30:
        warnings.append(f'Page {index+1}: image-count cap reached (30)')
    return images


def _asset(data: bytes, ext: str, assets: dict[str, bytes]) -> str:
    name=hashlib.sha256(data).hexdigest()[:24]+ext
    assets.setdefault(name,data)
    return name


def _render_figure(src: str, caption: str) -> str:
    return f'<figure><img src="../images/{src}" alt="{_html_text(caption)}"/><figcaption>{_html_text(caption)}</figcaption></figure>'


def convert_pdf(src: str | Path, dst: str | Path, options: Options | dict | None = None,
                progress: Callable[[int,int],None] | None = None) -> dict:
    """Returns measured report. Caller should apply sandbox/process and upload caps."""
    opts=Options.from_dict(options) if not isinstance(options,Options) else options
    src=Path(src);dst=Path(dst)
    if not src.is_file() or src.stat().st_size==0 or src.stat().st_size > 100_000_000:
        raise ConversionError('PDF missing, empty, or exceeds 100 MB')
    with src.open('rb') as f:
        if f.read(5) != b'%PDF-': raise ConversionError('Not a PDF file')
    started=time.monotonic()
    try:
        reader=PdfReader(str(src),strict=False)
        if reader.is_encrypted:
            raise ConversionError('Password-protected PDFs are not supported')
        metadata = reader.metadata
        metatitle = str(metadata.title or '').strip() if metadata else ''
        metaauthor = str(metadata.author or '').strip() if metadata else ''
    except ConversionError: raise
    except Exception as e: raise ConversionError('PDF metadata could not be parsed') from e
    title=opts.title or metatitle or src.stem
    author=opts.author or metaauthor or 'Unknown'
    report={'status':'completed','pages':0,'native_pages':0,'ocr_pages':0,'image_assets':0,
            'table_candidates':0,'warnings':[],'quality_preset':opts.preset,'ocr_languages':opts.ocr_languages}
    warnings=report['warnings']
    assets:dict[str,bytes]={}
    chapters=[];chapter_fragments=[];chapter_start=1
    source_native_tokens=0;retained_native_tokens=0
    with tempfile.TemporaryDirectory(prefix='pdfepub-') as tdir:
      try:
        with pdfplumber.open(str(src)) as pdf, pdfium.PdfDocument(str(src)) as rend:
          count=len(pdf.pages)
          if count<1 or count>opts.max_pages:
              raise ConversionError(f'PDF must have 1–{opts.max_pages} pages')
          report['pages']=count
          for i,page in enumerate(pdf.pages):
            # Cheap first pass; pdfminer native extraction never invokes OCR.
            try:
                text=page.extract_text(x_tolerance=2,y_tolerance=3) or ''
            except Exception as ex:
                text='';warnings.append(f'Page {i+1}: native text parse failed')
            native=_text_quality(text)
            if native:
                report['native_pages']+=1
                pass
            else:
                if report['ocr_pages'] >= opts.max_ocr_pages:
                    raise ConversionError(f'OCR page cap exceeded ({opts.max_ocr_pages}); use a stronger worker')
                text=_ocr(rend,i,opts.ocr_languages,Path(tdir))
                report['ocr_pages']+=1
                if not text:
                    warnings.append(f'Page {i+1}: OCR extracted no text')
            if native:
                _,paragraphs,table_count=_structured_native(page,i,warnings)
                report['table_candidates']+=table_count
                source=Counter(re.findall(r'\w+',text.lower()))
                rebuilt=html.unescape(re.sub(r'<[^>]*>',' ', ''.join(paragraphs))).lower()
                kept=Counter(re.findall(r'\w+',rebuilt))
                source_native_tokens+=sum(source.values())
                retained_native_tokens+=sum(min(n,kept[t]) for t,n in source.items())
            else:
                paragraphs=_content_blocks(text)
                if len(text.strip())<15:
                    warnings.append(f'Page {i+1}: low OCR text confidence; review this page')
            if len(page.lines or [])>12 and not report['table_candidates']:
                warnings.append(f'Page {i+1}: possible vector/table content not semantically recovered')
            page_images=_extract_images(page,rend,i,opts.preset,warnings)
            # Unlike a lossless PDF conversion, we cannot reconstruct arbitrary
            # vector charts into semantic SVG. Retain the page facsimile on
            # high fidelity when many vector segments exist.
            vec_count=len(page.curves or [])+len(page.lines or [])+len(page.rects or [])
            if vec_count>40 and opts.preset=='high_fidelity':
                bitmap=_render(rend,i,1.0)
                imgdata,ext=_image_bytes(bitmap,opts.preset)
                bitmap.close()
                page_images.append((float(page.height)-.01,imgdata,ext))
                warnings.append(f'Page {i+1}: vector-rich page facsimile retained; review reading order')
            elif vec_count>40:
                warnings.append(f'Page {i+1}: vector diagrams/equations may not fully reflow')
            figures=[]
            for n,(top,data,ext) in enumerate(page_images,1):
                if len(data)>4*1024*1024:
                    warnings.append(f'Page {i+1}: image skipped over 4 MiB')
                    continue
                key=_asset(data,ext,assets)
                figures.append(_render_figure(key,f'Figure on page {i+1} ({n})'))
            if not native:
                # OCR cannot reliably identify photographs or diagrams inside a
                # flattened page scan. Retain compressed page facsimile alongside
                # reflowable OCR text, rather than silently drop these visuals.
                scale = .9 if opts.preset=='maximum_compression' else 1.1
                bitmap=_render(rend,i,scale)
                data,ext=_image_bytes(bitmap,opts.preset);bitmap.close()
                key=_asset(data,ext,assets)
                figures.append(_render_figure(key,f'Scanned page {i+1} facsimile'))
                warnings.append(f'Page {i+1}: scan facsimile retained to preserve non-text visuals')
            # Images presently appended after per-page text to avoid claiming
            # falsely precise region/paragraph semantic anchoring.
            chapter_fragments.append(f'<section id="page-{i+1}">' + ''.join(paragraphs) + ''.join(figures) + '</section>')
            if (i+1)%8==0 or i+1==count:
                end=i+1
                label=f'Pages {chapter_start}–{end}' if end!=chapter_start else f'Page {end}'
                chapters.append({'title':label,'html':''.join(chapter_fragments)})
                chapter_fragments=[];chapter_start=end+1
            # Reclaim per-page parser object caches where supported.
            page.close()
            if progress: progress(i+1,count)
      except ConversionError: raise
      except MemoryError as ex: raise ConversionError('Memory exhausted during parsing') from ex
      except Exception as ex: raise ConversionError('PDF parsing or rendering failed: '+type(ex).__name__) from ex
    if report['ocr_pages'] and report['native_pages']:
        warnings.append('Hybrid PDF detected; OCR and native text were combined per page')
    if report['table_candidates']:
        warnings.append('Bordered tables reconstructed heuristically; complex and borderless tables need review')
    report['image_assets']=len(assets)
    report['native_text_coverage']=round(retained_native_tokens/max(1,source_native_tokens),4) if source_native_tokens else None
    if source_native_tokens and retained_native_tokens/max(1,source_native_tokens)<.97:
        warnings.append('Native text token coverage below 97%; manual review recommended')
    if not chapters:
        raise ConversionError('No pages converted')
    language='hi' if opts.ocr_languages.startswith('hin') else 'en'
    build_epub(dst,chapters,assets,title=title,author=author,language=language)
    validation_errors=validate_epub(dst)
    # EPUBCheck may be supplied as a jar by the deployer. It is not
    # included by default to avoid a heavyweight Java runtime on Render Free.
    checker=os.environ.get('EPUBCHECK_JAR','')
    report['validation']='structural'
    if checker and Path(checker).is_file() and shutil.which('java'):
        try:
            proc=subprocess.run(['java','-jar',checker,str(dst)],capture_output=True,text=True,timeout=65)
            report['validation']='epubcheck'
            if proc.returncode:
                validation_errors.append('EPUBCheck: '+(proc.stderr+' '+proc.stdout)[-600:])
        except subprocess.TimeoutExpired:
            validation_errors.append('EPUBCheck timeout')
    if validation_errors:
        dst.unlink(missing_ok=True)
        raise ConversionError('EPUB validation failed: '+'; '.join(validation_errors))
    original=src.stat().st_size;out=dst.stat().st_size
    report.update(original_bytes=original,epub_bytes=out,
                  reduction_percent=round(100*(original-out)/original,2),
                  duration_seconds=round(time.monotonic()-started,2),
                  compression_ratio=round(original/out,3) if out else None)
    if out>original:
        warnings.append('EPUB is larger than source PDF; no compression saving obtained')
    return report

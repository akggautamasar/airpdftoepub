import zipfile
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from pdfepub import convert_pdf, Options, ConversionError
from pdfepub.epub import validate_epub
import pytest

def test_native_conversion(tmp_path):
    p=tmp_path/'sample.pdf'; c=canvas.Canvas(str(p),pagesize=A4)
    c.setTitle('Integration Test Book');c.setAuthor('Test Author')
    c.setFont('Helvetica',12)
    for i in range(2):
        c.drawString(40,800,'Chapter One: Why convert PDF to EPUB')
        for j in range(7):
            c.drawString(40,760-j*22, 'This is an accessible and reflowable paragraph for the sample book. '+str(j))
        c.showPage()
    c.save();ep=tmp_path/'output.epub'
    report=convert_pdf(p,ep,{'preset':'balanced'})
    assert report['pages']==2
    assert report['native_pages']==2
    assert report['ocr_pages']==0
    assert report['original_bytes']>0 and report['epub_bytes']>0
    assert not validate_epub(ep)
    with zipfile.ZipFile(ep) as z:
        assert 'Chapter One' in z.read('OEBPS/text/ch0001.xhtml').decode()
        assert 'toc' in z.read('OEBPS/nav.xhtml').decode()

def test_invalid_pdf(tmp_path):
    f=tmp_path/'bad.pdf';f.write_text('not a pdf')
    with pytest.raises(ConversionError):convert_pdf(f,tmp_path/'x.epub')

def test_options():
    assert Options.from_dict({'preset':'high_fidelity'}).preset=='high_fidelity'
    with pytest.raises(ConversionError):Options.from_dict({'ocr_languages':'eng;rm -rf /'})

def test_hybrid_with_scan(tmp_path):
    from PIL import Image,ImageDraw,ImageFont
    scan=tmp_path/'scan.png'
    im=Image.new('RGB',(900,500),'white')
    draw=ImageDraw.Draw(im)
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',38)
    draw.text((50,100),'This scanned page contains OCR words.',font=font,fill='black')
    im.save(scan)
    p=tmp_path/'hybrid.pdf';c=canvas.Canvas(str(p),pagesize=A4)
    for i in range(9):c.drawString(45,800-i*30,'The first page contains enough native text for accurate extraction.')
    c.showPage();c.drawImage(str(scan),40,380,width=500,height=280);c.showPage();c.save()
    epub=tmp_path/'hybrid.epub'
    report=convert_pdf(p,epub,{'ocr_languages':'eng'})
    assert report['native_pages']==1 and report['ocr_pages']==1
    assert any('Hybrid' in w for w in report['warnings'])
    with zipfile.ZipFile(epub) as z:
        data=z.read('OEBPS/text/ch0001.xhtml').decode()
        assert 'scanned page' in data.lower()
        assert 'native text' in data.lower()

def test_bordered_table_and_image(tmp_path):
    from PIL import Image,ImageDraw
    pic=tmp_path/'sample.png'; im=Image.new('RGB',(180,120),'white')
    d=ImageDraw.Draw(im);d.rectangle((10,10,170,110),fill='blue');im.save(pic)
    p=tmp_path/'table.pdf'; c=canvas.Canvas(str(p),pagesize=A4)
    c.setFont('Helvetica',12)
    for i in range(9):c.drawString(42,790-i*18,'Some clearly readable text before the table helps native classification.')
    x0,y0=42,475
    for x in (x0,x0+130,x0+260):c.line(x,y0,x,y0+90)
    for y in (y0,y0+45,y0+90):c.line(x0,y,x0+260,y)
    c.drawString(x0+8,y0+66,'Name'); c.drawString(x0+138,y0+66,'Result')
    c.drawString(x0+8,y0+20,'Alpha');c.drawString(x0+138,y0+20,'Pass')
    c.drawImage(str(pic),50,255,width=180,height=120)
    c.save()
    epub=tmp_path/'table.epub';r=convert_pdf(p,epub)
    assert r['image_assets']>=1
    with zipfile.ZipFile(epub) as z:
        content=z.read('OEBPS/text/ch0001.xhtml').decode()
        assert '<table>' in content and '<th>' in content
        assert 'Alpha' in content
        assert any(n.startswith('OEBPS/images/') for n in z.namelist())

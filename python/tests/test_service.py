from io import BytesIO
import json
from pathlib import Path
import zipfile
from reportlab.pdfgen import canvas
from pdfepub import service


def test_compute_worker_roundtrip(monkeypatch,tmp_path):
    """End-to-end Python subprocess+fake KV+fake control; no cloud creds needed."""
    inp=tmp_path/'upload.pdf'
    pdf=canvas.Canvas(str(inp))
    for n in range(9):pdf.drawString(50,750-20*n,'This is enough native text in the sample PDF for our test.')
    pdf.save()
    data=inp.read_bytes()
    store={'input/test.pdf':data}
    calls=[]
    def fake_download(job_id,out,expected):
        out.write_bytes(store['input/test.pdf'])
        assert out.stat().st_size==expected
    def fake_upload(job_id,token,epub):
        store['output/test/test-lease.epub']=epub.read_bytes()
    def fake_control(path,payload):
        calls.append((path,payload))
        if path.endswith('/claim'):
            return {'lease_token':'test-lease','input_key':'input/test.pdf',
                'output_key':'output/test/test-lease.epub','original_bytes':len(data),
                'options':{'preset':'balanced','ocr_languages':'eng'}}
        return {'ok':True}
    monkeypatch.setattr(service,'download_input',fake_download)
    monkeypatch.setattr(service,'upload_output',fake_upload)
    monkeypatch.setattr(service,'control',fake_control)
    monkeypatch.setattr(service,'config',lambda name:'fake-bucket')
    assert service.slot.acquire(blocking=False)
    service.convert_one('12345678-1234-1234-1234-123456789abc')
    result=store['output/test/test-lease.epub']
    assert result.startswith(b'PK')
    with zipfile.ZipFile(BytesIO(result)) as z:
        assert 'OEBPS/package.opf' in z.namelist()
    assert any(path.endswith('/complete') for path,_ in calls)
    assert any(path.endswith('/heartbeat') for path,_ in calls)

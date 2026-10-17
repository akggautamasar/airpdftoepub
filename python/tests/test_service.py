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
    def fake_download(job_id,out,expected,chunks=None):
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


def test_chunk_download_reconstructs_and_checks_sha256(monkeypatch, tmp_path):
    """Regression: real chunk download must verify checksum without NameError."""
    import hashlib
    chunk_size = 5 * 1024 * 1024
    first = b"%PDF-1.7\\n" + b"a" * (chunk_size - len(b"%PDF-1.7\\n"))
    chunks = [first, b"second-part"]
    expected = sum(len(part) for part in chunks)
    calls = []

    class FakeResponse:
        status_code = 200
        def __init__(self, data):
            self.data = data
            self.headers = {"X-Chunk-SHA256": hashlib.sha256(data).hexdigest()}
        def __enter__(self):
            return self
        def __exit__(self, exc_type, exc, tb):
            return False
        def raise_for_status(self):
            pass
        def iter_bytes(self, chunk_size=65536):
            for i in range(0, len(self.data), chunk_size):
                yield self.data[i:i + chunk_size]

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass
        def __enter__(self):
            return self
        def __exit__(self, exc_type, exc, tb):
            return False
        def stream(self, method, url, headers):
            assert method == "GET"
            part = int(url.rsplit("/", 1)[1])
            calls.append(part)
            return FakeResponse(chunks[part])

    monkeypatch.setattr(service.httpx, "Client", FakeClient)
    monkeypatch.setattr(service, "config", lambda k: "https://example.invalid" if k == "EDGE_URL" else "test-secret")
    output = tmp_path / "assembled.pdf"
    service.download_input("12345678-1234-1234-1234-123456789abc", output, expected, chunks=2)
    assert output.read_bytes() == b"".join(chunks)
    assert calls == [0, 1]

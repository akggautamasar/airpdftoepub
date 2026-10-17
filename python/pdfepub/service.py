"""Render free-tier wake endpoint. All durable job state lives on Cloudflare.

IMPORTANT: Render may kill this process at any time. Cloudflare's scheduled
reconciler retries expired leases; this service does not offer guaranteed
background execution or always-on compute.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import os
import resource
import secrets
import subprocess
import sys
import threading
import time
import logging
import queue
import re

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

log=logging.getLogger('pdfepub.worker')
logging.basicConfig(level=logging.INFO)
app=FastAPI(title='PDF-to-EPUB internal compute service',docs_url=None,redoc_url=None)
worker_pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='convert')
slot=threading.BoundedSemaphore(value=1)

class JobKick(BaseModel):
    job_id: str


def config(name: str)->str:
    x=os.environ.get(name,'').strip()
    if not x: raise RuntimeError('Missing environment variable '+name)
    return x


def control(path: str,payload: dict) -> dict:
    url=config('EDGE_URL').rstrip('/')+path
    with httpx.Client(timeout=30) as client:
        r=client.post(url,json=payload,headers={'Authorization':'Bearer '+config('WORKER_SHARED_SECRET')})
        if r.status_code!=200:
            raise RuntimeError(f'Control API status {r.status_code}: {r.text[:200]}')
        return r.json()


def download_input(job_id: str, pdf: Path, expected: int, chunks: int | None = None):
    if chunks:
        if chunks < 2 or chunks > 24 or expected > 100_000_000:
            raise RuntimeError('Invalid segmented upload metadata')
        import hashlib
        endpoint = config('EDGE_URL').rstrip('/')
        headers = {'Authorization': 'Bearer ' + config('WORKER_SHARED_SECRET')}
        total = 0
        with httpx.Client(timeout=90) as client, pdf.open('wb') as out:
            for index in range(chunks):
                expected_part_size = min(5 * 1024 * 1024, expected - index * 5 * 1024 * 1024)
                if expected_part_size <= 0:
                    raise RuntimeError('Bad chunk metadata')
                for attempt in range(7):
                    try:
                        with client.stream('GET', f'{endpoint}/internal/files/chunk/{job_id}/{index}', headers=headers) as response:
                            if response.status_code == 503 and attempt < 6:
                                time.sleep(15)
                                continue
                            response.raise_for_status()
                            digest_header = response.headers.get('X-Chunk-SHA256', '')
                            if not re.fullmatch(r'[0-9a-f]{64}', digest_header):
                                raise RuntimeError('Missing chunk checksum')
                            digest = hashlib.sha256()
                            count = 0
                            for chunk in response.iter_bytes(chunk_size=65536):
                                out.write(chunk)
                                digest.update(chunk)
                                count += len(chunk)
                            if count != expected_part_size or digest.hexdigest() != digest_header:
                                raise RuntimeError('Chunk integrity verification failed')
                            total += count
                            break
                    except httpx.HTTPStatusError as exc:
                        if exc.response.status_code == 503 and attempt < 6:
                            time.sleep(15)
                            continue
                        raise
                else:
                    raise RuntimeError('Uploaded source part is unavailable')
        if total != expected or pdf.stat().st_size != expected:
            raise RuntimeError('Combined PDF length mismatch')
        with pdf.open('rb') as source:
            if source.read(5) != b'%PDF-':
                raise RuntimeError('Combined upload lacks PDF signature')
        return
    url=config('EDGE_URL').rstrip('/')+f'/internal/files/input/{job_id}'
    headers={'Authorization':'Bearer '+config('WORKER_SHARED_SECRET')}
    # Cloudflare KV can require >60s to propagate to another region.
    for attempt in range(7):
        try:
            with httpx.Client(timeout=80) as client:
                with client.stream('GET',url,headers=headers) as r:
                    if r.status_code==503 and attempt<6:
                        time.sleep(15)
                        continue
                    r.raise_for_status()
                    with pdf.open('wb') as out:
                        for chunk in r.iter_bytes(chunk_size=65536):
                            out.write(chunk)
            if pdf.stat().st_size!=expected:
                raise RuntimeError('Stored source size did not match expected length')
            return
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code==503 and attempt<6:
                time.sleep(15)
                continue
            raise
    raise RuntimeError('KV input did not become visible')


def upload_output(job_id: str, token: str, epub: Path):
    size=epub.stat().st_size
    url=config('EDGE_URL').rstrip('/')+f'/internal/files/output/{job_id}/{token}'
    headers={'Authorization':'Bearer '+config('WORKER_SHARED_SECRET'),
             'Content-Type':'application/epub+zip','Content-Length':str(size)}
    with httpx.Client(timeout=120) as client, epub.open('rb') as f:
        r=client.put(url,headers=headers,content=f)
        r.raise_for_status()
        return r.json()


def max_wall_time_for_pdf(original_bytes: int) -> int:
    # A longer, bounded budget for bigger books on free-tier CPUs.
    return 1800 if original_bytes > 18 * 1024 * 1024 else 540

def child_limits():
    # Subprocess isolation, not a substitute for a hardened hostile-PDF sandbox.
    resource.setrlimit(resource.RLIMIT_CPU,(1750,1760))
    resource.setrlimit(resource.RLIMIT_FSIZE,(70*1024*1024,70*1024*1024))
    resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))


def convert_one(job_id: str):
    lease=None
    try:
        claim=control(f'/internal/jobs/{job_id}/claim',{})
        lease=claim['lease_token']
        with TemporaryDirectory(prefix='epub-task-') as directory:
            pdf=Path(directory)/'book.pdf'; epub=Path(directory)/'book.epub'
            log.info('Downloading source job %s',job_id)
            download_input(job_id,pdf,claim['original_bytes'],claim.get('input_chunks'))
            argv=[sys.executable,'-m','pdfepub.cli',str(pdf),str(epub),
                  '--options',json.dumps(claim['options']),'--progress']
            start=time.monotonic()
            max_wall_time=max_wall_time_for_pdf(claim['original_bytes'])
            progress=0
            # Unbuffered stdout; each line carries page progress or final report.
            process=subprocess.Popen(argv,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                text=True,bufsize=1,preexec_fn=child_limits,
                env={**os.environ,'OMP_THREAD_LIMIT':'1','OPENBLAS_NUM_THREADS':'1'})
            report=None
            messages=queue.Queue(maxsize=100)
            def stdout_reader():
                try:
                    for line in process.stdout:
                        messages.put(('line',line))
                finally:
                    messages.put(('eof',None))
            # Drain stderr continuously to avoid a child blocked on pipe writes.
            stderr_tail=[]
            def stderr_reader():
                for line in process.stderr:
                    stderr_tail.append(line[-200:])
                    if len(stderr_tail)>15:stderr_tail.pop(0)
            threading.Thread(target=stdout_reader,daemon=True).start()
            threading.Thread(target=stderr_reader,daemon=True).start()
            heartbeat_at=time.monotonic()
            try:
                while True:
                    if time.monotonic()-start>max_wall_time:
                        raise TimeoutError(f'Conversion exceeded {max_wall_time // 60} minute wall-time cap')
                    try:
                        event,line=messages.get(timeout=3)
                    except queue.Empty:
                        if time.monotonic()-heartbeat_at>90:
                            control(f'/internal/jobs/{job_id}/heartbeat',
                                    {'lease_token':lease,'progress':progress})
                            heartbeat_at=time.monotonic()
                        continue
                    if event=='eof':break
                    try:
                        data=json.loads(line)
                    except ValueError:
                        continue
                    if data.get('event')=='progress':
                        pct=int(90*data['page']/data['total'])
                        if pct>progress:
                            progress=pct
                            control(f'/internal/jobs/{job_id}/heartbeat',
                                    {'lease_token':lease,'progress':pct})
                            heartbeat_at=time.monotonic()
                    elif data.get('event')=='complete':
                        report=data['report']
                    elif data.get('event')=='failed':
                        raise RuntimeError(data.get('error','Conversion failed'))
                code=process.wait(timeout=5)
                if code!=0 or report is None:
                    raise RuntimeError(f'Conversion process exited {code}: {" ".join(stderr_tail)[-150:]}')
            finally:
                if process.poll() is None:
                    process.kill();process.wait(timeout=10)
                if process.stdout: process.stdout.close()
                if process.stderr: process.stderr.close()
            if epub.stat().st_size>22*1024*1024:
                raise RuntimeError('Output exceeds maximum allowed size')
            # Upload only after EPUB ZIP/XML structural checks have passed.
            upload_output(job_id,lease,epub)
            control(f'/internal/jobs/{job_id}/complete',{'lease_token':lease,'report':report})
            log.info('Completed job %s; %s bytes',job_id,epub.stat().st_size)
    except Exception as exc:
        log.exception('Job %s failed',job_id)
        if lease:
            message=str(exc)
            # Never forward internal file keys, Python temp paths, or HTTP client errors
            # into externally accessible job reports.
            if 'OCR page cap exceeded' in message:
                safe_error='OCR page cap exceeded; use a stronger worker'
            elif 'PDF must have' in message:
                safe_error='PDF exceeds maximum page count'
            elif 'Not a PDF' in message:
                safe_error='Input is not a valid PDF'
            elif isinstance(exc,TimeoutError) or 'timed out' in message.lower():
                safe_error='Conversion timed out'
            elif 'Tesseract' in message or 'OCR' in message:
                safe_error='OCR processing failed; review language configuration'
            else:
                safe_error='Conversion or storage failure; inspect worker logs'
            retry=isinstance(exc,(httpx.HTTPError,TimeoutError)) or ('Control API status 5' in message)
            try:
                control(f'/internal/jobs/{job_id}/fail',{'lease_token':lease,
                     'error':safe_error, 'retryable':retry})
            except Exception:
                log.exception('Could not report job failure; lease recovery will handle it')
    finally:
        slot.release()

@app.get('/', response_class=HTMLResponse, include_in_schema=False)
def home():
    return """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PDF-to-EPUB Compute</title><style>body{font-family:system-ui,sans-serif;background:#0b1221;color:#e8f1ff;display:grid;place-items:center;min-height:100vh;margin:0;padding:1rem}main{max-width:570px;padding:2rem;background:#122039;border:1px solid #34405b;border-radius:16px}p{line-height:1.6;color:#b3c6e0}a{color:#91c3ff}</style></head><body><main><h1>PDF-to-EPUB conversion engine</h1><p>This is the internal compute service. Submit PDF conversions through the Cloudflare API, not directly to this server.</p><p><a href="https://pdfepub-edge.worksbeyondworks.workers.dev/">Open the PDF-to-EPUB API & test page</a></p><p><a href="/health">Check compute health</a> · <a href="https://github.com/akggautamasar/airpdftoepub">View source</a></p></main></body></html>"""

@app.get('/health')
def health():
    return {'status':'ok','component':'render-compute','busy':slot._value==0}

@app.post('/internal/kick',status_code=202)
def kick(job:JobKick,authorization: str=Header(default='')):
    # Internal secret must match Cloudflare Queue dispatch secret.
    expected='Bearer '+config('WORKER_SHARED_SECRET')
    if not secrets.compare_digest(authorization,expected):
        raise HTTPException(status_code=401,detail='Unauthorized')
    import re
    if not re.fullmatch(r'[a-f0-9-]{36}',job.job_id):
        raise HTTPException(status_code=422,detail='Invalid job ID')
    if not slot.acquire(blocking=False):
        raise HTTPException(status_code=429,detail='Compute worker busy; retry later')
    try:
        worker_pool.submit(convert_one,job.job_id)
    except Exception:
        slot.release()
        raise HTTPException(status_code=503,detail='Worker unavailable')
    return {'accepted':True,'job_id':job.job_id}

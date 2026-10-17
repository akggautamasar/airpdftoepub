// Copyright (c) 2026; MIT. Public control-plane API for PDF→EPUB jobs.
// Files are stored temporarily in free Workers KV. D1 state is authoritative.
// KV is eventually consistent; reads can temporarily miss after writes.
const HOME_HTML = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>PDF to EPUB · Conversion API</title><style>\n:root{color-scheme:dark;font-family:system-ui,-apple-system,Segoe UI,sans-serif}*{box-sizing:border-box}body{margin:0;background:#080f1c;color:#e8f1ff;min-height:100vh}\nmain{max-width:800px;margin:auto;padding:55px 22px}h1{font-size:clamp(2rem,5vw,3.5rem);line-height:1.1;margin:14px 0}p{color:#9aadc9;line-height:1.65}\n.tag{color:#93c5fd;font-weight:700;letter-spacing:.1em;font-size:12px;text-transform:uppercase}.panel{background:#101c2f;border:1px solid #27364e;border-radius:18px;padding:24px;margin-top:28px}\nform{display:grid;gap:15px}label{font-size:13px;font-weight:650;color:#bed1ec;display:grid;gap:7px}input,select{background:#0a1324;border:1px solid #344866;color:#eaf3ff;padding:13px 12px;border-radius:9px;font:inherit;width:100%}input[type=file]{padding:10px}\n.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}button{padding:14px 22px;border:0;border-radius:9px;background:#69a4ff;color:#061426;font-weight:750;cursor:pointer;font-size:16px}button:disabled{opacity:.55;cursor:wait}\n#out{margin-top:18px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;color:#c7d8ec}a{color:#94c5ff}small{color:#95a6be}footer{margin-top:28px;font-size:13px;color:#99acca}.note{font-size:13px}\n@media(max-width:580px){.grid{grid-template-columns:1fr}main{padding-top:26px}}\n</style></head><body><main>\n<div class=\"tag\">Independent document processing API · v1</div>\n<h1>PDF → EPUB</h1><p>Turn suitable PDFs into reflowable EPUB books. English and Hindi OCR supported. This interface is a simple test client for the reusable API.</p>\n<div class=\"panel\"><form id=\"form\">\n<label>API key <input id=\"key\" type=\"password\" autocomplete=\"off\" required placeholder=\"Paste your private client API key\"><small>Used only in your requests to this service; not saved in browser storage.</small></label>\n<label>PDF file (up to 18 MiB) <input id=\"file\" type=\"file\" accept=\".pdf,application/pdf\" required></label>\n<div class=\"grid\">\n<label>Conversion preset<select id=\"preset\"><option value=\"balanced\">Balanced</option><option value=\"maximum_compression\">Maximum compression</option><option value=\"high_fidelity\">High fidelity</option></select></label>\n<label>OCR languages<select id=\"languages\"><option value=\"eng+hin\">English + Hindi</option><option value=\"eng\">English</option><option value=\"hin\">Hindi</option></select></label>\n</div><button type=\"submit\" id=\"go\">Convert PDF to EPUB</button></form>\n<div id=\"out\" role=\"status\" aria-live=\"polite\">Ready. Processing uses free-tier capacity and may take several minutes or time out.</div></div>\n<footer><a href=\"/health\">API health</a> · <a href=\"https://github.com/akggautamasar/airpdftoepub\" target=\"_blank\" rel=\"noopener noreferrer\">Source code &amp; API documentation</a><p class=\"note\">Private files expire after approximately 24 hours. Some documents cannot be converted accurately; check warnings in the report. No compression ratio is guaranteed.</p></footer>\n</main><script>\nconst form=document.getElementById('form'), out=document.getElementById('out'), go=document.getElementById('go');\nconst message=s=>{out.textContent=s};\nconst auth=()=>({'Authorization':'Bearer '+document.getElementById('key').value.trim()});\nasync function api(url,options={}){const r=await fetch(url,{...options,headers:{...auth(),...(options.headers||{})}});if(!r.ok){let data=await r.json().catch(()=>({}));throw new Error((data.error?.message||data.detail||'HTTP '+r.status)+' (HTTP '+r.status+')');}return r;}\nform.addEventListener('submit',async e=>{\ne.preventDefault();const file=document.getElementById('file').files[0];if(!file)return;\nif(file.size>18*1024*1024){message('This free service accepts at most 18 MiB per PDF.');return;}\ngo.disabled=true;let jobId=null;\ntry{\nmessage('Uploading PDF…');\nconst params=new URLSearchParams({preset:document.getElementById('preset').value,ocr_languages:document.getElementById('languages').value});\nconst submitted=await api('/v1/convert?'+params,{method:'POST',headers:{'Content-Type':'application/pdf'},body:file});\nconst first=await submitted.json();jobId=first.job_id;\nif(!jobId)throw new Error('No job ID returned');\nmessage('Job '+jobId+' submitted. Waiting for the converter…');\nlet job=first;\nfor(let i=0;i<120;i++){\nif(i>0)await new Promise(resolve=>setTimeout(resolve,7000));\njob=await (await api('/v1/jobs/'+jobId)).json();\nmessage('Job: '+jobId+'\\nState: '+job.status+'\\nProgress: '+(job.progress_percent||0)+'%\\nAttempts: '+job.attempts);\nif(job.status==='completed'){\nconst report=await (await api('/v1/jobs/'+jobId+'/report')).json();\nconst res=await api('/v1/jobs/'+jobId+'/download');\nconst blob=await res.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');\na.href=url;a.download=file.name.replace(/\\.pdf$/i,'')+'.epub';a.textContent='Download '+a.download;\nout.appendChild(document.createElement('br'));out.appendChild(a);\nmessage('Completed: '+jobId+'\\nOutput size: '+blob.size+' bytes\\nReduction: '+report.reduction_percent+'%\\nWarnings: '+(report.warnings||[]).join('; '));\nout.appendChild(document.createElement('br'));out.appendChild(a);return;\n}\nif(['failed','cancelled','expired'].includes(job.status))throw new Error(job.error?.message||'Job '+job.status);\n}\nmessage('Job '+jobId+' is still processing. Check its status later using your API key.');\n}catch(err){message('Conversion unavailable: '+err.message+(jobId?'\\nJob ID: '+jobId:''));}\nfinally{go.disabled=false;}\n});\n</script></body></html>";
const MAX_UPLOAD = 18 * 1024 * 1024;
const JOB_TTL = 24 * 60 * 60;
const MAX_CHUNKED_UPLOAD = 100_000_000; // 100 decimal megabytes
const CHUNK_BYTES = 5 * 1024 * 1024;
const CHUNK_TICKET_TTL = 2 * 60 * 60;
const MAX_CHUNKED_PENDING = 2;
const MAX_ACTIVE_INPUT_BYTES = 700_000_000; // leave room in free 1 GB KV for EPUBs
const uploadPartKey=(id,index)=>`input/${id}/part/${index}`;
const chunkCount=bytes=>Math.ceil(bytes/CHUNK_BYTES);
const partLength=(bytes,index)=>Math.min(CHUNK_BYTES, bytes-index*CHUNK_BYTES);
async function uploadedToken(request,env) {
 const origin=request.headers.get('Origin')||'';
 if(!validUploadOrigin(origin))return {error:'An HTTPS browser origin is required'};
 const match=(request.headers.get('Authorization')||'').match(/^Bearer\\s+(up_[a-f0-9]{64})$/i);
 if(!match)return {error:'Upload capability missing'};
 const hash=await sha256(match[1]);
 const ticket=await env.DB.prepare('SELECT * FROM upload_tickets WHERE token_hash=?').bind(hash).first();
 if(!ticket||ticket.origin!==origin||ticket.expires_at<=now()||ticket.state!=='ready')return {error:'Upload authorization is expired or used'};
 if(ticket.file_bytes<=MAX_UPLOAD||ticket.file_bytes>MAX_CHUNKED_UPLOAD)return {error:'Not a chunked upload'};
 return {ticket,hash,headers:directUploadCors(origin)};
}
async function postChunk(request,env,index) {
 const auth=await uploadedToken(request,env);
 if(auth.error)return errorWithHeaders('unauthorized',auth.error,403,validUploadOrigin(request.headers.get('Origin')||'')?directUploadCors(request.headers.get('Origin')):{});
 const {ticket,headers}=auth;
 const fail=(code,message,status)=>errorWithHeaders(code,message,status,headers);
 const count=chunkCount(ticket.file_bytes);
 if(!Number.isSafeInteger(index)||index<0||index>=count)return fail('part_out_of_range','Invalid chunk number',422);
 const size=Number(request.headers.get('Content-Length')),expected=partLength(ticket.file_bytes,index);
 if(size!==expected)return fail('part_size','Incorrect chunk size',413);
 if((request.headers.get('Content-Type')||'').split(';')[0].toLowerCase()!=='application/octet-stream')return fail('media','Use raw chunk bytes',415);
 const expectedDigest=(request.headers.get('X-Chunk-SHA256')||'').toLowerCase();
 if(!/^[a-f0-9]{64}$/.test(expectedDigest))return fail('digest_required','SHA-256 checksum is required',422);
 const key=uploadPartKey(ticket.job_id,index);
 let data;
 try{
   data=new Uint8Array(await request.arrayBuffer());
   if(data.byteLength!==expected)return fail('part_size','Chunk length mismatch',422);
   if(index===0 && new TextDecoder().decode(data.subarray(0,5))!=='%PDF-')return fail('pdf_header','First chunk does not start with PDF signature',422);
   const actualDigest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('');
   if(actualDigest!==expectedDigest)return fail('digest_mismatch','Chunk checksum mismatch',422);
 }catch{return fail('chunk_read','Unable to validate chunk',422);}
 const previous=await env.DB.prepare('SELECT state,digest,bytes FROM upload_chunks WHERE job_id=? AND part=?')
   .bind(ticket.job_id,index).first();
 if(previous?.state==='ready') {
   if(previous.digest===expectedDigest&&previous.bytes===expected)return response({ok:true,part:index,reused:true},200,headers);
   return fail('part_conflict','Chunk already stored with different content',409);
 }
 const ts=now();
 if(!previous){
   const claim=await env.DB.prepare("INSERT OR IGNORE INTO upload_chunks (job_id,part,bytes,digest,state,updated_at) VALUES (?,?,?,?, 'writing',?)")
     .bind(ticket.job_id,index,expected,expectedDigest,ts).run();
   if(!claim.meta.changes)return fail('part_busy','Upload is already running',409);
 }else{
   const claim=await env.DB.prepare("UPDATE upload_chunks SET state='writing',digest=?,bytes=?,updated_at=? WHERE job_id=? AND part=? AND state!='ready' AND (state='failed' OR updated_at<?)")
     .bind(expectedDigest,expected,ts,ticket.job_id,index,ts-120).run();
   if(!claim.meta.changes)return fail('part_busy','Upload is already running; retry shortly',409);
 }
 try{
   await env.FILES.put(key,data,{expirationTtl:JOB_TTL});
   const update=await env.DB.prepare("UPDATE upload_chunks SET state='ready',updated_at=? WHERE job_id=? AND part=? AND state='writing' AND digest=?")
     .bind(now(),ticket.job_id,index,expectedDigest).run();
   if(!update.meta.changes)throw new Error('Upload lease lost');
   return response({ok:true,part:index,total:count},201,headers);
 }catch(e){
   console.warn('Chunk write failure',ticket.job_id,index,String(e));
   await env.DB.prepare("UPDATE upload_chunks SET state='failed',updated_at=? WHERE job_id=? AND part=? AND state='writing' AND digest=?")
     .bind(now(),ticket.job_id,index,expectedDigest).run().catch(()=>{});
   return fail('chunk_store','Chunk could not be stored, retry the same chunk',503);
 }
}
async function chunkProgress(request,env) {
 const auth=await uploadedToken(request,env);
 if(auth.error)return errorWithHeaders('unauthorized',auth.error,403,validUploadOrigin(request.headers.get('Origin')||'')?directUploadCors(request.headers.get('Origin')):{});
 const {ticket,headers}=auth;
 const rows=await env.DB.prepare("SELECT part,bytes FROM upload_chunks WHERE job_id=? AND state='ready' ORDER BY part")
  .bind(ticket.job_id).all();
 return response({job_id:ticket.job_id,total:chunkCount(ticket.file_bytes),
   uploaded:(rows.results||[]).map(x=>x.part),uploaded_bytes:(rows.results||[]).reduce((s,x)=>s+x.bytes,0)},200,headers);
}
async function finalizeChunks(request,env) {
 const auth=await uploadedToken(request,env);
 if(auth.error)return errorWithHeaders('unauthorized',auth.error,403,validUploadOrigin(request.headers.get('Origin')||'')?directUploadCors(request.headers.get('Origin')):{});
 const {ticket,hash,headers}=auth;
 const fail=(code,message,status)=>errorWithHeaders(code,message,status,headers);
 const n=chunkCount(ticket.file_bytes);
 const parts=await env.DB.prepare("SELECT part,bytes FROM upload_chunks WHERE job_id=? AND state='ready' ORDER BY part").bind(ticket.job_id).all();
 if(parts.results.length!==n||parts.results.some((x,i)=>x.part!==i||x.bytes!==partLength(ticket.file_bytes,i)))
   return fail('incomplete_upload','Upload is missing one or more chunks',409);
 // Only one finalizer is allowed; a second request cannot reserve the same quota.
 const consumed=await env.DB.prepare("UPDATE upload_tickets SET state='consumed' WHERE token_hash=? AND state='ready' AND expires_at>?")
   .bind(hash,now()).run();
 if(!consumed.meta.changes)return fail('ticket_used','Already finalized',409);
 const day=new Date().toISOString().slice(0,10),ts=now();
 const quota=await env.DB.prepare(`UPDATE clients SET usage_day=?,used_jobs=CASE WHEN usage_day=? THEN used_jobs+1 ELSE 1 END
   WHERE id=? AND active=1 AND (usage_day<>? OR used_jobs<max_jobs_per_day)`)
  .bind(day,day,ticket.client_id,day).run();
 if(!quota.meta.changes)return fail('quota_exceeded','Conversion quota is exhausted',429);
 const id=ticket.job_id;
 try{
   const saved=await env.DB.prepare(`INSERT INTO jobs
     (id,client_id,idempotency_key,state,preset,languages,book_title,author,input_key,original_bytes,created_at,updated_at,expires_at)
     VALUES (?,?,NULL,'queued',?,?,?,?,?,?,?,?,?)`)
    .bind(id,ticket.client_id,ticket.preset,ticket.languages,ticket.book_title,ticket.author,'chunked/'+id,ticket.file_bytes,ts,ts,ts+JOB_TTL).run();
   if(!saved.meta.changes)throw new Error('Job insert failed');
   try{await env.JOBS_QUEUE.send({job_id:id});}
   catch(e){console.warn('Queue will reconcile',id,String(e));}
   return response(publicJob(await ownedJob(env,id,ticket.client_id)),202,headers);
 }catch(e){
   console.error('Chunk finalize failed',id,String(e));
   await env.DB.prepare("UPDATE clients SET used_jobs=MAX(0,used_jobs-1) WHERE id=?").bind(ticket.client_id).run().catch(()=>{});
   await env.DB.prepare("DELETE FROM jobs WHERE id=?").bind(id).run().catch(()=>{});
   await env.DB.prepare("UPDATE upload_tickets SET state='ready' WHERE token_hash=? AND state='consumed'").bind(hash).run().catch(()=>{});
   return fail('finalize_failed','Unable to register PDF for conversion',503);
 }
}

const LEASE = 10 * 60;
const MAX_ATTEMPTS = 3;
const MAX_OUTPUT = 22 * 1024 * 1024;
const now = () => Math.floor(Date.now() / 1000);

function response(obj,status=200,headers={}) {
  return new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
}
function error(code,message,status=400){return response({error:{code,message}},status);}
function sameSecret(actual,expected){
  // secrets should be long and random; avoid direct timing-sensitive comparisons
  if(!actual || !expected || actual.length!==expected.length) return false;
  let diff=0; for(let i=0;i<actual.length;i++)diff|=actual.charCodeAt(i)^expected.charCodeAt(i);
  return diff===0;
}
async function sha256(value){
  let d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const iso=t=>new Date(t*1000).toISOString();
function publicJob(job){
 return {job_id:job.id,status:job.state,progress_percent:job.progress,attempts:job.attempts,
         created_at:iso(job.created_at),updated_at:iso(job.updated_at),expires_at:iso(job.expires_at),
         links:{status:`/v1/jobs/${job.id}`,report:`/v1/jobs/${job.id}/report`,download:job.state==='completed'?`/v1/jobs/${job.id}/download`:null},
         ...(job.state==='failed'?{error:{code:'conversion_failed',message:job.last_error||'Conversion could not be completed'}}:{})};
}
function cors(req,env){
 const origin=req.headers.get('Origin');
 const allow=(env.ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
 return origin&&allow.includes(origin)?{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'Authorization, Content-Type, Idempotency-Key','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS'}:{};
}
async function client(req,env){
 const match=(req.headers.get('Authorization')||'').match(/^Bearer\s+(\S+)$/i);
 if(!match || match[1].length<20 || match[1].length>200)return null;
 const hash=await sha256(match[1]);
 return await env.DB.prepare('SELECT id,max_jobs_per_day FROM clients WHERE key_hash=? AND active=1').bind(hash).first();
}
async function ownedJob(env,id,clientId){
 return await env.DB.prepare('SELECT * FROM jobs WHERE id=? AND client_id=?').bind(id,clientId).first();
}
function internalAuth(req,env){
 const bearer=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 return sameSecret(bearer,env.WORKER_SHARED_SECRET);
}

const UPLOAD_TICKET_TTL = 5 * 60;
const UPLOAD_TICKET_PENDING = 5;
function directUploadCors(origin) {
  // No ambient cookies. Authorization is a short-lived, single-use token
  // whose exact origin is checked against D1 before upload.
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer'
  };
}
function errorWithHeaders(code, message, status, headers) {
  return response({error:{code,message}},status,headers);
}
function validPreset(value) {
  return ['balanced','high_fidelity','maximum_compression'].includes(value);
}
function validLanguages(value) {
  return ['eng','hin','eng+hin'].includes(value);
}
function validUploadOrigin(value) {
  try {
    const u = new URL(value);
    return u.origin === value && u.protocol === 'https:' && !u.username && !u.password;
  } catch { return false; }
}
async function issueUploadTicket(request,env,c,headerCors) {
  if((request.headers.get('Content-Type')||'').split(';')[0]!=='application/json')
    return errorWithHeaders('unsupported_media_type','Use application/json',415,headerCors);
  const length=Number(request.headers.get('Content-Length'));
  if(!Number.isSafeInteger(length) || length<2 || length>2048)
    return errorWithHeaders('invalid_request_size','Ticket request must be at most 2048 bytes',413,headerCors);
  let input;
  try { input=await request.json(); } catch {
    return errorWithHeaders('invalid_json','Invalid upload ticket JSON',400,headerCors);
  }
  const size=input?.file_bytes, origin=input?.origin;
  if(!Number.isSafeInteger(size)||size<5||size>MAX_CHUNKED_UPLOAD)
    return errorWithHeaders('invalid_size','PDF must be 100 MB or smaller',413,headerCors);
  if(!validUploadOrigin(origin))
    return errorWithHeaders('invalid_origin','An HTTPS browser origin is required',422,headerCors);
  const preset=input.preset||'balanced';
  const languages=input.ocr_languages||'eng+hin';
  if(!validPreset(preset)||!validLanguages(languages))
    return errorWithHeaders('invalid_options','Unsupported EPUB preset or OCR language',422,headerCors);
  const title=typeof input.title==='string'?input.title.trim().slice(0,160):'';
  const author=typeof input.author==='string'?input.author.trim().slice(0,160):'';
  const ts=now();
  if(size>MAX_UPLOAD){
    const pendingLarge=await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_tickets WHERE file_bytes>? AND state='ready' AND expires_at>?")
      .bind(MAX_UPLOAD,ts).first();
    if((pendingLarge?.n||0)>=MAX_CHUNKED_PENDING)
      return errorWithHeaders('large_uploads_busy','Two large uploads are already reserved; retry later',429,headerCors);
    const jobs=await env.DB.prepare("SELECT COALESCE(SUM(original_bytes),0) AS bytes FROM jobs WHERE expires_at>? AND state NOT IN ('expired','failed','cancelled')").bind(ts).first();
    const queued=await env.DB.prepare("SELECT COALESCE(SUM(file_bytes),0) AS bytes FROM upload_tickets WHERE file_bytes>? AND state='ready' AND expires_at>?").bind(MAX_UPLOAD,ts).first();
    if((jobs?.bytes||0)+(queued?.bytes||0)+size>MAX_ACTIVE_INPUT_BYTES)
      return errorWithHeaders('storage_busy','Free storage capacity is busy. Retry after other jobs expire',429,headerCors);
  }
  // Tickets without uploads are bounded and expire quickly. Quota charged only
  // after an actual accepted PDF upload.
  const pending=await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM upload_tickets WHERE client_id=? AND state='ready' AND expires_at>?"
  ).bind(c.id,ts).first();
  if((pending?.n||0)>=UPLOAD_TICKET_PENDING)
    return errorWithHeaders('too_many_tickets','Too many pending uploads; retry later',429,headerCors);
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const token='up_'+[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');
  const hash=await sha256(token),id=crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO upload_tickets
    (token_hash,job_id,client_id,origin,file_bytes,preset,languages,book_title,author,state,created_at,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,'ready',?,?)`
  ).bind(hash,id,c.id,origin,size,preset,languages,title,author,ts,ts+(size>MAX_UPLOAD?CHUNK_TICKET_TTL:UPLOAD_TICKET_TTL)).run();
  const large=size>MAX_UPLOAD;
  return response({
    job_id:id,upload_token:token,
    upload_mode:large?'chunked':'single',
    upload_url:new URL(large?'/v1/chunks':'/v1/direct-upload',request.url).href,
    ...(large?{chunk_bytes:CHUNK_BYTES,chunk_count:chunkCount(size),
      finalize_url:new URL('/v1/chunks/finalize',request.url).href}:{}),
    expires_at:iso(ts+(large?CHUNK_TICKET_TTL:UPLOAD_TICKET_TTL)),
    max_upload_bytes:MAX_CHUNKED_UPLOAD
  },201,{...headerCors,'Cache-Control':'no-store'});
}
async function directUpload(request,env) {
  const origin=request.headers.get('Origin')||'';
  const noCache={'Cache-Control':'no-store'};
  const headers=validUploadOrigin(origin)?directUploadCors(origin):noCache;
  const fail=(code,message,status)=>errorWithHeaders(code,message,status,headers);
  if(!validUploadOrigin(origin))return fail('invalid_origin','HTTPS upload origin required',403);
  const auth=(request.headers.get('Authorization')||'').match(/^Bearer\s+(up_[a-f0-9]{64})$/i);
  if(!auth)return fail('unauthorized','A single-use upload token is required',401);
  const tokenHash=await sha256(auth[1]);
  const ticket=await env.DB.prepare('SELECT * FROM upload_tickets WHERE token_hash=?').bind(tokenHash).first();
  if(!ticket||ticket.origin!==origin||ticket.state!=='ready'||ticket.expires_at<=now())
    return fail('expired_ticket','Upload token is invalid, expired or already used',403);
  const length=Number(request.headers.get('Content-Length'));
  if(!Number.isSafeInteger(length)||length!==ticket.file_bytes||length<5||length>MAX_UPLOAD)
    return fail('invalid_length','Upload length does not match the authorized file size',413);
  if((request.headers.get('Content-Type')||'').split(';')[0].toLowerCase()!=='application/pdf')
    return fail('invalid_media','Upload raw PDF bytes',415);
  // Consume the capability before reading the body; concurrent replays lose.
  const claimed=await env.DB.prepare(
    "UPDATE upload_tickets SET state='consumed' WHERE token_hash=? AND state='ready' AND expires_at>?"
  ).bind(tokenHash,now()).run();
  if(!claimed.meta.changes)return fail('ticket_used','Upload token has already been consumed',409);
  const day=new Date().toISOString().slice(0,10);
  const reserved=await env.DB.prepare(`UPDATE clients
    SET usage_day=?,used_jobs=CASE WHEN usage_day=? THEN used_jobs+1 ELSE 1 END
    WHERE id=? AND active=1 AND (usage_day<>? OR used_jobs<max_jobs_per_day)`
  ).bind(day,day,ticket.client_id,day).run();
  if(!reserved.meta.changes)return fail('quota_exceeded','Daily conversion quota reached',429);
  const id=ticket.job_id, inputKey=`input/${id}.pdf`,ts=now();
  try {
    const file=new Uint8Array(await request.arrayBuffer());
    if(file.byteLength!==length||new TextDecoder().decode(file.subarray(0,5))!=='%PDF-')
      return await directUploadRejected(env,ticket.client_id,id,inputKey,fail,'invalid_pdf','PDF signature or uploaded length is invalid',422);
    await env.FILES.put(inputKey,file,{expirationTtl:JOB_TTL});
    const saved=await env.DB.prepare(`INSERT INTO jobs
      (id,client_id,idempotency_key,state,preset,languages,book_title,author,input_key,original_bytes,created_at,updated_at,expires_at)
      VALUES (?,?,NULL,'queued',?,?,?,?,?,?,?,?,?)`
    ).bind(id,ticket.client_id,ticket.preset,ticket.languages,ticket.book_title,ticket.author,inputKey,length,ts,ts,ts+JOB_TTL).run();
    if(!saved.meta.changes)throw new Error('Failed to insert conversion job');
    try {await env.JOBS_QUEUE.send({job_id:id});}
    catch(e){console.error('Enqueue failed; reconciliation will retry',id,String(e));}
    return response(publicJob(await ownedJob(env,id,ticket.client_id)),202,
      {...headers,'Retry-After':'10'});
  } catch(e) {
    console.error('Direct upload failed',id,String(e));
    return await directUploadRejected(env,ticket.client_id,id,inputKey,fail,
      'upload_failed','Unable to store or queue PDF',503);
  }
}
async function directUploadRejected(env,clientId,id,inputKey,fail,code,message,status) {
  await env.FILES.delete(inputKey).catch(()=>{});
  await env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run().catch(()=>{});
  await env.DB.prepare('UPDATE clients SET used_jobs=MAX(0,used_jobs-1) WHERE id=?').bind(clientId).run().catch(()=>{});
  return fail(code,message,status);
}

async function route(request,env) {
 const url=new URL(request.url),path=url.pathname,method=request.method;
 const headerCors=cors(request,env);
 if(method==='OPTIONS'){
   if(path==='/v1/direct-upload'||path==='/v1/chunks'||path==='/v1/chunks/finalize'){
     const origin=request.headers.get('Origin')||'';
     return validUploadOrigin(origin)
       ? new Response(null,{status:204,headers:directUploadCors(origin)})
       : error('origin_not_allowed','HTTPS origin required',403);
   }
   if(!headerCors['Access-Control-Allow-Origin'])return error('origin_not_allowed','Origin is not allowed',403);
   return new Response(null,{status:204,headers:headerCors});
 }
 if(path==='/' && method==='GET')return new Response(HOME_HTML,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"}});
 if(path==='/health')return response({status:'ok',component:'edge',temporary_storage:'kv',metadata:'d1',compute:'external_render'},200,headerCors);
 if(path.startsWith('/internal/')){
   if(!internalAuth(request,env))return error('unauthorized','Unauthorized',401);
   if(path.startsWith('/internal/files/'))return await internalFileRoute(request,env,path,method);
   return await internalRoute(request,env,path,method);
 }
 if(path==='/v1/direct-upload' && method==='POST')return await directUpload(request,env);
 if(path==='/v1/chunks'&&method==='POST')return await postChunk(request,env,Number(url.searchParams.get('part')));
 if(path==='/v1/chunks'&&method==='GET')return await chunkProgress(request,env);
 if(path==='/v1/chunks/finalize'&&method==='POST')return await finalizeChunks(request,env);
 if(!path.startsWith('/v1/'))return error('not_found','Endpoint not found',404);
 const c=await client(request,env);
 if(!c)return error('unauthorized','Valid API key required',401);
 if(path==='/v1/upload-tickets' && method==='POST')return await issueUploadTicket(request,env,c,headerCors);
 if(path==='/v1/convert'&&method==='POST'){
   let size=Number(request.headers.get('Content-Length'));
   if(!Number.isSafeInteger(size)||size<=0)return error('length_required','Send a known Content-Length',411);
   if(size>MAX_UPLOAD)return error('file_too_large','Max upload is 18 MiB',413);
   const mime=(request.headers.get('Content-Type')||'').toLowerCase().split(';')[0];
   if(mime!=='application/pdf')return error('unsupported_media_type','Send raw PDF bytes, Content-Type: application/pdf',415);
   const preset=url.searchParams.get('preset')||'balanced';
   if(!['balanced','high_fidelity','maximum_compression'].includes(preset))return error('invalid_preset','Invalid preset',422);
   const languages=url.searchParams.get('ocr_languages')||'eng+hin';
   if(!/^[a-z]{3}(\+[a-z]{3}){0,3}$/.test(languages))return error('invalid_language','Invalid OCR languages',422);
   const title=(url.searchParams.get('title')||'').slice(0,160);
   const author=(url.searchParams.get('author')||'').slice(0,160);
   const idempotency=request.headers.get('Idempotency-Key');
   if(idempotency && !/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotency))return error('invalid_idempotency_key','Use 8–128 safe characters',422);
   if(idempotency){
     const prior=await env.DB.prepare('SELECT * FROM jobs WHERE client_id=? AND idempotency_key=?').bind(c.id,idempotency).first();
     if(prior)return response(publicJob(prior),200,headerCors);
   }
   const day=new Date().toISOString().slice(0,10), ts=now();
   const changed=await env.DB.prepare(`UPDATE clients SET usage_day=?, used_jobs=CASE WHEN usage_day=? THEN used_jobs+1 ELSE 1 END WHERE id=? AND active=1 AND (usage_day<>? OR used_jobs<max_jobs_per_day)`).bind(day,day,c.id,day).run();
   if(!changed.meta.changes)return error('quota_exceeded','Daily job quota reached',429);
   const id=crypto.randomUUID(),inputKey=`input/${id}.pdf`;
   try {
     const file=new Uint8Array(await request.arrayBuffer());
     if(file.length!==size || file.length<5 || new TextDecoder().decode(file.subarray(0,5))!=='%PDF-')throw new Error('Invalid upload length or PDF signature');
     await env.FILES.put(inputKey,file,{expirationTtl:JOB_TTL});
     const ins=await env.DB.prepare(`INSERT OR IGNORE INTO jobs
      (id,client_id,idempotency_key,state,preset,languages,book_title,author,input_key,original_bytes,created_at,updated_at,expires_at)
      VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?,?)`)
       .bind(id,c.id,idempotency||null,preset,languages,title,author,inputKey,size,ts,ts,ts+JOB_TTL).run();
     if(!ins.meta.changes){
       await env.FILES.delete(inputKey);
       await env.DB.prepare('UPDATE clients SET used_jobs=MAX(0,used_jobs-1) WHERE id=?').bind(c.id).run();
       const prior=await env.DB.prepare('SELECT * FROM jobs WHERE client_id=? AND idempotency_key=?').bind(c.id,idempotency).first();
       return response(publicJob(prior),200,headerCors);
     }
     try{await env.JOBS_QUEUE.send({job_id:id});}catch(e){
       // Scheduled reconciliation will reenqueue within about five minutes.
       console.error('Enqueue failed; cron will recover',id,String(e));
     }
     const job=await ownedJob(env,id,c.id);
     return response(publicJob(job),202,{...headerCors,'Location':`/v1/jobs/${id}`,'Retry-After':'10'});
   }catch(e){
     await env.FILES.delete(inputKey).catch(()=>{});
     await env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run().catch(()=>{});
     await env.DB.prepare('UPDATE clients SET used_jobs=MAX(0,used_jobs-1) WHERE id=?').bind(c.id).run().catch(()=>{});
     console.error('Upload failed',String(e));
     return error('upload_failed','Failed to store PDF',503);
   }
 }
 const m=path.match(/^\/v1\/jobs\/([a-f0-9-]{36})(?:\/(download|report))?$/);
 if(!m)return error('not_found','Endpoint not found',404);
 const job=await ownedJob(env,m[1],c.id);
 if(!job)return error('not_found','Job not found',404);
 if(job.expires_at<=now())return error('expired','Job has expired',410);
 if(method==='DELETE'&&!m[2]){
   if(['completed','failed','cancelled'].includes(job.state))return error('invalid_state','Cannot cancel this job',409);
   await env.DB.prepare("UPDATE jobs SET state='cancelled',lease_token=NULL,updated_at=? WHERE id=? AND client_id=? AND state IN ('queued','running')").bind(now(),job.id,c.id).run();
   return response(publicJob(await ownedJob(env,job.id,c.id)),200,headerCors);
 }
 if(method!=='GET')return error('method_not_allowed','Method not allowed',405);
 if(!m[2])return response(publicJob(job),200,headerCors);
 if(m[2]==='report'){
   if(job.state!=='completed')return error('not_ready','Conversion not completed',409);
   return response(JSON.parse(job.report_json||'{}'),200,headerCors);
 }
 if(job.state!=='completed')return error('not_ready','EPUB not yet available',409);
 const result=await env.FILES.get(job.output_key,'stream');
 if(!result)return response({error:{code:'not_yet_visible',message:'KV propagation in progress; retry shortly'}},503,{...headerCors,'Retry-After':'30'});
 return new Response(result,{headers:{...headerCors,'Content-Type':'application/epub+zip',
   'Content-Length':String(job.output_bytes),'Content-Disposition':`attachment; filename="${job.id}.epub"`,
   'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}

async function internalFileRoute(request,env,path,method){
 const input=path.match(/^\/internal\/files\/input\/([a-f0-9-]{36})$/);
 if(input && method==='GET'){
   const job=await env.DB.prepare('SELECT input_key,original_bytes,expires_at,state FROM jobs WHERE id=?').bind(input[1]).first();
   if(!job || job.expires_at<=now() || ['failed','cancelled','expired'].includes(job.state))return error('not_found','Job unavailable',404);
   if(job.input_key.startsWith('chunked/'))return error('chunked_input','Use chunk endpoints for segmented source',422);
   const body=await env.FILES.get(job.input_key,'stream');
   if(!body)return error('temporarily_unavailable','KV input may still be propagating',503);
   return new Response(body,{headers:{'Content-Type':'application/pdf','Content-Length':String(job.original_bytes),'Cache-Control':'no-store'}});
 }
 const chunk=path.match(/^\/internal\/files\/chunk\/([a-f0-9-]{36})\/(\\d{1,2})$/);
 if(chunk&&method==='GET'){
   const id=chunk[1],index=Number(chunk[2]);
   const job=await env.DB.prepare('SELECT input_key,original_bytes,expires_at,state FROM jobs WHERE id=?').bind(id).first();
   if(!job||job.expires_at<=now()||['failed','cancelled','expired'].includes(job.state)||job.input_key!=='chunked/'+id)
     return error('not_found','Chunked source is unavailable',404);
   const n=chunkCount(job.original_bytes);
   if(index<0||index>=n)return error('part','Invalid chunk number',422);
   const record=await env.DB.prepare("SELECT bytes,digest FROM upload_chunks WHERE job_id=? AND part=? AND state='ready'").bind(id,index).first();
   if(!record||record.bytes!==partLength(job.original_bytes,index))return error('missing_chunk','Uploaded chunk not recorded',503);
   const stream=await env.FILES.get(uploadPartKey(id,index),'stream');
   if(!stream)return error('temporarily_unavailable','Chunk still propagating',503);
   return new Response(stream,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(record.bytes),
      'X-Chunk-SHA256':record.digest,'Cache-Control':'no-store'}});
 }
 const output=path.match(/^\/internal\/files\/output\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/);
 if(output && method==='PUT'){
   const [_,id,lease]=output;
   const j=await env.DB.prepare("SELECT lease_token,expires_at,state FROM jobs WHERE id=?").bind(id).first();
   if(!j || j.state!=='running' || j.lease_token!==lease || j.expires_at<=now())return error('lease_lost','Worker lease no longer valid',409);
   const size=Number(request.headers.get('Content-Length'));
   if(!Number.isSafeInteger(size)||size<100||size>MAX_OUTPUT)return error('file_size','EPUB must be <=22 MiB with Content-Length',413);
   const data=new Uint8Array(await request.arrayBuffer());
   if(data.byteLength!==size || data[0]!==0x50||data[1]!==0x4b)return error('invalid_epub','Output must be a ZIP/EPUB file',422);
   const key=`output/${id}/${lease}.epub`;
   await env.FILES.put(key,data,{expirationTtl:JOB_TTL});
   const update=await env.DB.prepare("UPDATE jobs SET output_bytes=?,output_key=?,updated_at=? WHERE id=? AND state='running' AND lease_token=?").bind(size,key,now(),id,lease).run();
   if(!update.meta.changes){await env.FILES.delete(key).catch(()=>{});return error('lease_lost','Lease was lost while saving',409);}
   return response({ok:true,bytes:size});
 }
 return error('not_found','Unknown internal file endpoint',404);
}

async function internalRoute(request,env,path,method){
 const m=path.match(/^\/internal\/jobs\/([a-f0-9-]{36})\/(claim|heartbeat|complete|fail)$/);
 if(!m||method!=='POST')return error('not_found','Unknown internal endpoint',404);
 let payload={};try{payload=await request.json();}catch{return error('invalid_json','Malformed payload');}
 const [_,id,op]=m;
 const ts=now();
 if(op==='claim'){
   const token=crypto.randomUUID();
   const changed=await env.DB.prepare(`UPDATE jobs SET state='running',lease_token=?,lease_until=?,
     attempts=attempts+1,progress=MIN(progress,95),updated_at=?
     WHERE id=? AND expires_at>? AND attempts<? AND (state='queued' OR (state='running' AND lease_until<?))`)
     .bind(token,ts+LEASE,ts,id,ts,MAX_ATTEMPTS,ts).run();
   if(!changed.meta.changes)return error('claim_denied','Already claimed, finished, or invalid',409);
   const j=await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first();
   return response({job_id:id,lease_token:token,input_key:j.input_key,
     ...(j.input_key.startsWith('chunked/')?{input_chunks:chunkCount(j.original_bytes),chunk_bytes:CHUNK_BYTES}:{}),
     output_key:`output/${id}/${token}.epub`,original_bytes:j.original_bytes,
     options:{preset:j.preset,ocr_languages:j.languages,title:j.book_title||null,author:j.author||null}});
 }
 if(typeof payload.lease_token!=='string')return error('lease_required','Missing lease token');
 if(op==='heartbeat'){
   const progress=Math.max(0,Math.min(95,Math.floor(Number(payload.progress)||0)));
   const r=await env.DB.prepare(`UPDATE jobs SET progress=MAX(progress,?),lease_until=?,updated_at=?
    WHERE id=? AND lease_token=? AND state='running' AND expires_at>?`)
      .bind(progress,ts+LEASE,ts,id,payload.lease_token,ts).run();
   return r.meta.changes?response({ok:true}):error('lease_lost','Lease lost or job cancelled',409);
 }
 if(op==='complete'){
   const key=`output/${id}/${payload.lease_token}.epub`;
   const saved=await env.DB.prepare('SELECT output_bytes,output_key FROM jobs WHERE id=? AND lease_token=? AND state=\'running\'').bind(id,payload.lease_token).first();
   if(!saved || saved.output_key!==key || !(saved.output_bytes>0 && saved.output_bytes<=MAX_OUTPUT))return error('invalid_output','Missing or oversize result',422);
   const object={size:saved.output_bytes};
   const report=payload.report;
   if(!report||!Array.isArray(report.warnings)||typeof report.pages!=='number')return error('invalid_report','Malformed report',422);
   report.epub_bytes=object.size;
   const j=await env.DB.prepare('SELECT original_bytes FROM jobs WHERE id=? AND lease_token=?').bind(id,payload.lease_token).first();
   if(!j)return error('lease_lost','Lease lost',409);
   report.original_bytes=j.original_bytes;
   report.reduction_percent=+((1-object.size/j.original_bytes)*100).toFixed(2);
   const r=await env.DB.prepare(`UPDATE jobs SET state='completed',output_key=?,output_bytes=?,report_json=?,
     progress=100,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND expires_at>?`)
     .bind(key,object.size,JSON.stringify(report).slice(0,20000),ts,id,payload.lease_token,ts).run();
   return r.meta.changes?response({ok:true}):error('lease_lost','Lease lost',409);
 }
 if(op==='fail'){
   const reason=String(payload.error||'Conversion failed').slice(0,250);
   const job=await env.DB.prepare('SELECT attempts FROM jobs WHERE id=?').bind(id).first();
   const retry=payload.retryable===true && job && job.attempts<MAX_ATTEMPTS;
   const state=retry?'queued':'failed';
   const r=await env.DB.prepare(`UPDATE jobs SET state=?,last_error=?,lease_token=NULL,lease_until=NULL,updated_at=?
       WHERE id=? AND state='running' AND lease_token=?`)
     .bind(state,reason,ts,id,payload.lease_token).run();
   if(!r.meta.changes)return error('lease_lost','Lease lost',409);
   if(retry)await env.JOBS_QUEUE.send({job_id:id}).catch(()=>{});
   return response({ok:true,state});
 }
 return error('not_found','Unknown operation',404);
}

export default {
 async fetch(request,env){
   let result;
   try{result=await route(request,env);}
   catch(e){console.error('Edge error',String(e));result=error('internal_error','Internal service error',500);}
   for(const [k,v] of Object.entries(cors(request,env))) result.headers.set(k,v);
   return result;
 },
 async queue(batch,env){
   for(const msg of batch.messages){
     const id=msg.body?.job_id;
     if(!/^[a-f0-9-]{36}$/.test(id||'')){msg.ack();continue;}
     try{
       // Render may be cold for ~60+ seconds. Do not acknowledge unless accepted.
       const r=await fetch(env.RENDER_URL.replace(/\/$/,'')+'/internal/kick',{
         method:'POST',headers:{Authorization:`Bearer ${env.WORKER_SHARED_SECRET}`,'Content-Type':'application/json'},
         body:JSON.stringify({job_id:id}),signal:AbortSignal.timeout(115000)
       });
       if(r.ok){
         const body=await r.json().catch(()=>null);
         if(body?.accepted===true && body?.job_id===id)msg.ack();
         else msg.retry({delaySeconds:90}); // A Render cold-start holding page is not acceptance.
       }
       else if(r.status===429||r.status>=500)msg.retry({delaySeconds:90});
       else { console.warn('Dispatch response',id,r.status); msg.ack(); }
     }catch(e){console.warn('Dispatch unavailable',id,String(e));msg.retry({delaySeconds:90});}
   }
 },
 async scheduled(event,env){
   const ts=now();
   // Fail jobs that exhausted attempts before recovery.
   await env.DB.prepare("UPDATE jobs SET state='failed',last_error='Retry limit reached',updated_at=? WHERE state IN ('running','queued') AND (lease_until<? OR lease_until IS NULL) AND attempts>=?")
     .bind(ts,ts,MAX_ATTEMPTS).run();
   const ready=await env.DB.prepare(`SELECT id FROM jobs WHERE expires_at>? AND attempts<?
     AND (state='queued' OR (state='running' AND lease_until<?)) ORDER BY created_at ASC LIMIT 10`)
     .bind(ts,MAX_ATTEMPTS,ts).all();
   for(const j of ready.results){try{await env.JOBS_QUEUE.send({job_id:j.id});}catch(e){console.warn('Requeue failed',j.id);}}
   // Physical cleanup; KV also has independent 24-hour TTL expiry.
   const expired=await env.DB.prepare("SELECT id,input_key,output_key FROM jobs WHERE expires_at<? AND state!='expired' LIMIT 12").bind(ts).all();
   for(const j of expired.results){
      try{
        if(j.input_key.startsWith('chunked/')){
          const uploaded=await env.DB.prepare('SELECT part FROM upload_chunks WHERE job_id=?').bind(j.id).all();
          for(const p of uploaded.results)await env.FILES.delete(uploadPartKey(j.id,p.part));
          await env.DB.prepare('DELETE FROM upload_chunks WHERE job_id=?').bind(j.id).run();
          await env.DB.prepare('DELETE FROM upload_tickets WHERE job_id=?').bind(j.id).run();
        }else await env.FILES.delete(j.input_key);
        if(j.output_key)await env.FILES.delete(j.output_key);
        await env.DB.prepare("UPDATE jobs SET state='expired',report_json=NULL,updated_at=? WHERE id=?").bind(ts,j.id).run();
      }catch(e){console.warn('Cleanup failed',j.id);}
   }
   // Abandoned, never-finalized uploads have no job; remove all their KV parts.
   const stale=await env.DB.prepare("SELECT job_id FROM upload_tickets WHERE state='ready' AND expires_at<? LIMIT 8").bind(ts).all();
   for(const t of stale.results){
     const parts=await env.DB.prepare('SELECT part FROM upload_chunks WHERE job_id=?').bind(t.job_id).all();
     for(const p of parts.results)await env.FILES.delete(uploadPartKey(t.job_id,p.part)).catch(()=>{});
     await env.DB.prepare('DELETE FROM upload_chunks WHERE job_id=?').bind(t.job_id).run();
     await env.DB.prepare('DELETE FROM upload_tickets WHERE job_id=?').bind(t.job_id).run();
   }
   // Retain expired metadata briefly for troubleshooting, then purge it.
   await env.DB.prepare("DELETE FROM jobs WHERE state='expired' AND expires_at<?").bind(ts-7*24*60*60).run();
 }
};

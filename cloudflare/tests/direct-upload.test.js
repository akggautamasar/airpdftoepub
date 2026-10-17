import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';

const origin='https://airtools.example';
const endpoint='https://pdfepub-edge.example';
const pdfBytes=(n)=>{const data=new Uint8Array(n);data.set(new TextEncoder().encode('%PDF-1.7'));return data;};

function mockEnvironment() {
  const clients={id:'airtools-site-v1',max_jobs_per_day:12,used_jobs:0,usage_day:''};
  const tickets=new Map(), jobs=new Map(), queued=[],files=new Map();
  const env={
    ALLOWED_ORIGINS:'',
    DB: {prepare(sql) {
      return {bind(...args){
        return {
          async first() {
            if(sql.startsWith('SELECT id,max_jobs_per_day FROM clients'))return clients;
            if(sql.includes('COUNT(*) AS n FROM upload_tickets'))
              return {n:[...tickets.values()].filter(t=>t.client_id===args[0]&&t.state==='ready'&&t.expires_at>args[1]).length};
            if(sql.includes('SELECT * FROM upload_tickets'))return tickets.get(args[0])||null;
            if(sql.includes('SELECT * FROM jobs WHERE id=? AND client_id=?'))return jobs.get(args[0])||null;
            throw Error('Unexpected first: '+sql);
          },
          async run() {
            if(sql.includes('INSERT INTO upload_tickets')) {
              const [token_hash,job_id,client_id,orig,size,preset,languages,book_title,author,created,expires]=args;
              tickets.set(token_hash,{token_hash,job_id,client_id,origin:orig,file_bytes:size,preset,languages,book_title,author,state:'ready',created_at:created,expires_at:expires});
              return {meta:{changes:1}};
            }
            if(sql.includes("UPDATE upload_tickets SET state='consumed'")) {
              const t=tickets.get(args[0]);
              if(!t||t.state!=='ready'||t.expires_at<=args[1])return {meta:{changes:0}};
              t.state='consumed';return {meta:{changes:1}};
            }
            if(sql.startsWith('UPDATE clients') && sql.includes('usage_day')) {
              if(clients.usage_day===args[3]&&clients.used_jobs>=clients.max_jobs_per_day)return {meta:{changes:0}};
              clients.used_jobs=clients.usage_day===args[1]?clients.used_jobs+1:1;
              clients.usage_day=args[0];
              return {meta:{changes:1}};
            }
            if(sql.includes('INSERT INTO jobs')) {
              const [id,client_id,preset,languages,title,author,key,bytes,created,updated,expires]=args;
              jobs.set(id,{id,client_id,preset,languages,book_title:title,author,input_key:key,original_bytes:bytes,
                state:'queued',progress:0,attempts:0,created_at:created,updated_at:updated,expires_at:expires});
              return {meta:{changes:1}};
            }
            if(sql.includes('UPDATE clients SET used_jobs=')){clients.used_jobs=Math.max(0,clients.used_jobs-1);return {meta:{changes:1}};}
            if(sql.includes('DELETE FROM jobs')){jobs.delete(args[0]);return {meta:{changes:1}};}
            throw Error('Unexpected run: '+sql);
          },
        };
      }};
    }},
    FILES:{async put(k,bytes){files.set(k,bytes);},async delete(k){files.delete(k);}},
    JOBS_QUEUE:{async send(message){queued.push(message);}},
  };
  return {env,tickets,jobs,queued,files,clients};
}

test('18 MiB upload uses one-time token without exposing permanent credentials', async()=>{
  const db=mockEnvironment();
  const options={origin,file_bytes:18*1024*1024,preset:'balanced',ocr_languages:'eng+hin',title:'Textbook'};
  const body=JSON.stringify(options);
  const req=new Request(endpoint+'/v1/upload-tickets',{
    method:'POST',headers:{Authorization:'Bearer '+'X'.repeat(32),'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))},
    body,
  });
  const r=await worker.fetch(req,db.env);
  assert.equal(r.status,201);
  const ticket=await r.clone().json().catch(()=>null);
  assert.match(ticket.upload_token,/^up_[a-f0-9]{64}$/);
  assert.equal(ticket.max_upload_bytes,18*1024*1024);
  assert.ok(!JSON.stringify(ticket).includes('X'.repeat(32)));
  const pre=await worker.fetch(new Request(ticket.upload_url,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Headers':'authorization,content-type'}}),db.env);
  assert.equal(pre.status,204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'),origin);
  const data=pdfBytes(18*1024*1024);
  const uploadHeaders={Authorization:'Bearer '+ticket.upload_token,Origin:origin,'Content-Type':'application/pdf','Content-Length':String(data.byteLength)};
  const invalidOrigin=await worker.fetch(new Request(ticket.upload_url,{method:'POST',headers:{...uploadHeaders,Origin:'https://other.example'},body:data}),db.env);
  assert.equal(invalidOrigin.status,403);
  assert.equal(db.queued.length,0);
  const accepted=await worker.fetch(new Request(ticket.upload_url,{method:'POST',headers:uploadHeaders,body:data}),db.env);
  assert.equal(accepted.status,202);
  const job=await accepted.clone().json().catch(()=>null);
  assert.equal(job.job_id,ticket.job_id);
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'),origin);
  assert.equal(db.queued.length,1);
  assert.equal(db.files.get('input/'+ticket.job_id+'.pdf').byteLength,18*1024*1024);
  const replay=await worker.fetch(new Request(ticket.upload_url,{method:'POST',headers:uploadHeaders,body:pdfBytes(1024)}),db.env);
  assert.notEqual(replay.status,202);
});

test('reject missing or invalid capabilities and oversized requests',async()=>{
  const {env}=mockEnvironment();
  const pre=await worker.fetch(new Request(endpoint+'/v1/direct-upload',{method:'OPTIONS',headers:{Origin:'http://insecure.example'}}),env);
  assert.equal(pre.status,403);
  const post=await worker.fetch(new Request(endpoint+'/v1/direct-upload',{method:'POST',headers:{Origin:origin,'Content-Type':'application/pdf'},body:pdfBytes(100)}),env);
  assert.equal(post.status,401);
  const body=JSON.stringify({origin,file_bytes:18*1024*1024+1,preset:'balanced',ocr_languages:'eng'});
  const oversized=await worker.fetch(new Request(endpoint+'/v1/upload-tickets',{method:'POST',headers:{
    Authorization:'Bearer '+'X'.repeat(32),'Content-Type':'application/json','Content-Length':String(body.length)},body}),env);
  assert.equal(oversized.status,413);
});

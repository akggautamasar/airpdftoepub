"""Generate an API key and a safe D1 insertion SQL statement.

python scripts/new_client.py --client airtools --name AirTools --daily 20
Paste SQL into wrangler d1 execute; keep the API key in your application's env.
"""
import argparse,hashlib,secrets,re
p=argparse.ArgumentParser()
p.add_argument('--client',required=True)
p.add_argument('--name',required=True)
p.add_argument('--daily',type=int,default=20)
a=p.parse_args()
if not re.fullmatch(r'[A-Za-z0-9_-]{3,50}',a.client):p.error('Client ID must be 3–50 safe characters')
if a.daily<1 or a.daily>1000:p.error('Daily quota must be 1..1000')
key='pe_'+secrets.token_urlsafe(32)
digest=hashlib.sha256(key.encode()).hexdigest()
name=a.name.replace("'","''")
print('SAVE THIS API KEY AS A SECRET — NEVER COMMIT IT:')
print(key)
print('\nRun from cloudflare/:')
print(f'''npx wrangler d1 execute pdfepub-db --remote --command="INSERT INTO clients (id,name,key_hash,max_jobs_per_day) VALUES ('{a.client}','{name}','{digest}',{a.daily});"''')

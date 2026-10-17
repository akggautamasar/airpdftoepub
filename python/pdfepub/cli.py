import argparse, json, sys
from .converter import convert_pdf, ConversionError

def main():
    p=argparse.ArgumentParser(description='Convert PDF to reflowable EPUB3')
    p.add_argument('pdf');p.add_argument('epub')
    p.add_argument('--options',default='{}',help='JSON options')
    p.add_argument('--progress',action='store_true',help='Emit one JSON line per page')
    a=p.parse_args()
    try:
        o=json.loads(a.options)
        def cb(done,total):
            if a.progress:
                print(json.dumps({'event':'progress','page':done,'total':total}),flush=True)
        report=convert_pdf(a.pdf,a.epub,o,cb)
        print(json.dumps({'event':'complete','report':report},ensure_ascii=False),flush=True)
    except (ConversionError,ValueError) as e:
        print(json.dumps({'event':'failed','error':str(e)}),flush=True)
        sys.exit(2)
if __name__=='__main__':main()

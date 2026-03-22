#!/usr/bin/env python3
"""Simple dev server with live-reload injection."""
import http.server, os, json, sys
from pathlib import Path

PORT = 3000
ROOT = '/Users/coletaylor/Desktop/All/personal-website'

INJECT = b'<script>(function(){var t=null;setInterval(function(){fetch("/__t__").then(r=>r.json()).then(d=>{if(t===null){t=d.t;return;}if(d.t!==t){t=d.t;location.reload();}}).catch(()=>{});},600);})();</script>'

def mtime():
    best = 0
    for ext in ('*.html','*.css','*.js'):
        for f in Path(ROOT).glob(ext):
            try: best = max(best, f.stat().st_mtime)
            except: pass
    return best

class H(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        p = self.path.split('?')[0]
        if p == '/__t__':
            body = json.dumps({'t': mtime()}).encode()
            self.send_response(200)
            self.send_header('Content-Type','application/json')
            self.send_header('Content-Length', len(body))
            self.send_header('Cache-Control','no-cache')
            self.end_headers()
            if not head: self.wfile.write(body)
            return

        # Map path to file
        if p == '/' or p == '':
            p = '/index.html'
        filepath = ROOT + p
        try:
            with open(filepath, 'rb') as f:
                body = f.read()
        except:
            self.send_error(404)
            return

        # Inject live-reload into HTML
        ctype = 'text/html'
        if p.endswith('.css'): ctype = 'text/css'
        elif p.endswith('.js'): ctype = 'application/javascript'
        elif p.endswith('.json'): ctype = 'application/json'
        elif p.endswith('.png'): ctype = 'image/png'

        if ctype == 'text/html':
            body = body.replace(b'</body>', INJECT + b'</body>')

        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', len(body))
        self.send_header('Cache-Control','no-cache')
        self.end_headers()
        if not head: self.wfile.write(body)

    def log_message(self, *a): pass

os.chdir(ROOT)
print(f'Server: http://localhost:{PORT}', flush=True)
http.server.HTTPServer(('', PORT), H).serve_forever()

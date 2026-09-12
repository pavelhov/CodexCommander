import http.server,pathlib,json,sys,time
root=pathlib.Path(sys.argv[1]);config=json.loads((root/'fixture.json').read_text())
class Handler(http.server.SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(root/'feed'),**kwargs)
 def do_GET(self):
  if self.path.startswith('/provider'):
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"data":[]}');return
  if self.path=='/update.zip' and (root/'fail-download').exists():self.send_error(503);return
  super().do_GET()
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length','0')))
  (root/'active-request').touch()
  deadline=time.time()+120
  while time.time()<deadline and not (root/'active-release').exists():time.sleep(.1)
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
  try:self.wfile.write(b'{"id":"fixture","object":"response","output":[],"status":"completed"}')
  except BrokenPipeError:pass
 def copyfile(self,source,outputfile):
  while block:=source.read(65536):
   outputfile.write(block)
   if (root/'slow-download').exists():time.sleep(0.15)
http.server.ThreadingHTTPServer(('127.0.0.1',config['httpport']),Handler).serve_forever()

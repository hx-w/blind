#!/usr/bin/env python3
"""Plugin lifecycle, OSS-only resolution, client-only auth and durable scenes."""
import json, os, socket, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
ROOT=Path(__file__).resolve().parents[1]
BIN=ROOT/(sys.argv[1] if len(sys.argv)>1 else 'target/debug')/'blind'
PLY=(ROOT/'tests/fixtures/tetra.ply').read_bytes()
requests=[]
class Storage(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  requests.append(self.path)
  if 'missing' in self.path:self.send_error(404);return
  assert self.headers.get('Authorization','').startswith('AWS4-HMAC-SHA256 ')
  data=b'attachment-data' if self.path.endswith('.zip') else PLY
  self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def http(url,token=None,data=None):
 req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token} if token else {},data=json.dumps(data).encode() if data is not None else None)
 if data is not None:req.add_header('Content-Type','application/json')
 with urllib.request.urlopen(req,timeout=120) as r:return r.status,r.read()
with tempfile.TemporaryDirectory(prefix='blind-plugin-test-') as tmp:
 tmp=Path(tmp);serverdir=tmp/'server';clientdir=tmp/'client';package=tmp/'package';package.mkdir()
 env={**os.environ,'BLIND_CONFIG_DIR':str(serverdir),'BLIND_CLIENT_DIR':str(clientdir)}
 def cli(*args,input=None,ok=True,environment=None):
  r=subprocess.run([str(BIN),*args],env=environment or env,input=input,text=True,capture_output=True,timeout=150)
  if ok:assert r.returncode==0,(args,r.stderr)
  else:assert r.returncode!=0,(args,r.stdout)
  return r
 status=json.loads(cli('status','--json').stdout);assert status['local_server']['state']=='unconfigured';assert not serverdir.exists()
 cli('init');config=json.loads((serverdir/'config.json').read_text());p=port();config['listen']=f'127.0.0.1:{p}';(serverdir/'config.json').write_text(json.dumps(config))
 storage=ThreadingHTTPServer(('127.0.0.1',0),Storage);threading.Thread(target=storage.serve_forever,daemon=True).start()
 cli('oss','set','test',input=f'http://127.0.0.1:{storage.server_port}\ntest-region\naccess\nsecret\n')
 manifest={'id':'demo','name':'Demo','version':'1.0.0','schemes':['demo'],'protocol_versions':[1],'entrypoint':[sys.executable,'resolver.py'],'files':['resolver.py'],'config_schema':{'type':'object','additionalProperties':False,'required':['oss_alias','bucket','token'],'properties':{'oss_alias':{'type':'string'},'bucket':{'type':'string'},'token':{'type':'string','writeOnly':True}}}}
 (package/'blind-plugin.json').write_text(json.dumps(manifest))
 (package/'resolver.py').write_text('''import json,sys
r=json.loads(sys.stdin.readline());p=r['params'];assert p['config']['token']=='PRIVATE';assert p['protocol_version']==1
uri=p['input'];assert uri in ['https://example.test/a?x=1','bad','future','partial','all-missing','failed-order','missing-order','attachment-missing','grouped','collision','many']
result={'schema_version':1,'requires':['layout.panels','attachments'],'title':'Plugin scene','resources':[{'id':'a','uri':'oss://test/bucket/a.ply','label':'First'},{'id':'b','uri':'oss://test/bucket/b.ply','label':'Second'}],'panels':[{'id':'one','label':'One','members':['a']},{'id':'two','label':'Two','members':['a','b']}],'attachments':[{'id':'zip','uri':'oss://test/bucket/log.zip','label':'Log'}],'new_optional_field':'ignored'}
if uri=='grouped':
 result['requires'].append('layout.panel-groups');result['panels']=[{'id':'m1','label':'16','group':'Stage one','members':['a','b']},{'id':'m2','label':'46','group':'Stage one','members':['a','b']},{'id':'c1','label':'16','group':'Stage two','members':['a','b']}]
if uri=='collision':
 result['requires'].append('components.v1');result['components']=[{'id':'mesh-0','uri':'oss://test/bucket/log.zip','component':'text','label':'Collision log'}]
if uri=='many':
 result['resources'] += [{'id':f'r{i}','uri':'oss://test/bucket/a.ply'} for i in range(255)]
 result['panels']=[]
if uri=='bad':result['resources'][0]['uri']='oss://other/bucket/a.ply'
if uri=='future':result['requires'].append('future.required')
if uri=='partial':result['resources'][1]['uri']='oss://test/bucket/missing.ply'
if uri=='all-missing':
 for item in result['resources']:item['uri']='oss://test/bucket/missing.ply'
if uri=='failed-order':result['warnings']=[{'code':'ORDER_FAILED','message':'Order failed; showing available artifacts'}]
if uri=='attachment-missing':result['attachments'][0]['uri']='oss://test/bucket/missing.zip'
if uri=='missing-order':
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32000,'message':'SECRET upstream details','data':{'code':'ORDER_NOT_FOUND'}}}));sys.exit(0)
print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}))
''')
 cli('plugin','install',str(package));cli('plugin','configure','demo','--set','oss_alias=test','--set','bucket=bucket','--secret-stdin','token',input='PRIVATE\n')
 assert 'PRIVATE' not in cli('plugin','config','demo').stdout
 cli('plugin','configure','demo','--set','token=LEAK',ok=False)
 cli('plugin','configure','demo','--set','oss_alias=missing',ok=False)
 log=open(tmp/'server.log','w');proc=subprocess.Popen([str(BIN),'serve'],env=env,stdout=log,stderr=log)
 origin=f'http://127.0.0.1:{p}'
 try:
  for _ in range(100):
   try:http(origin+'/api/v1/health');break
   except (OSError,urllib.error.URLError):time.sleep(.1)
  invitation=cli('invite','--host',origin).stdout.strip()
  # Separate config root: this Client must not start or require a local Server.
  remote={**env,'BLIND_CONFIG_DIR':str(tmp/'remote-server'),'BLIND_CLIENT_DIR':str(tmp/'remote-client')}
  cli('join','--stdin','--client-only',input=invitation,environment=remote)
  assert not (tmp/'remote-server').exists()
  status=json.loads(cli('status','--json',environment=remote).stdout)
  assert status['local_server']['state']=='unconfigured' and status['connection']['state']=='connected',status
  assert status['target']['kind']=='remote'
  assert json.loads(cli('plugin','list',environment=remote).stdout)['plugins'][0]['id']=='demo'
  try:http(origin+'/api/v1/client/plugins');raise AssertionError('anonymous discovery')
  except urllib.error.HTTPError as e:assert e.code==401
  for uri in ['absent://x','demo://bad','demo://future']:
   cli('share',uri,environment=remote,ok=False)
  shared=json.loads(cli('share','demo://https://example.test/a?x=1','--format','json',environment=remote).stdout)
  collection={'kind':'collection','schema_version':1,'title':'Plugin comparison','scenes':[
   {'id':'first','title':'First','uri':'demo://grouped'},
   {'id':'second','title':'Second','uri':'demo://collision'}]}
  combined=json.loads(cli('share','--config','-','--format','json',input=json.dumps(collection),environment=remote).stdout)
  combined_code=combined['viewer_url'].rsplit('/',1)[1]
  assert len(json.loads(http(origin+'/api/v1/scenes/'+combined_code)[1])['scenes'])==2
  collection['scenes'][0]['uri']='demo://many'
  many_error=cli('share','--config','-',input=json.dumps(collection),environment=remote,ok=False).stderr
  assert 'exceeds 256 resources' in many_error,many_error.replace('PRIVATE','[redacted]')
  code=shared['viewer_url'].rsplit('/',1)[1]
  scene=json.loads(http(origin+'/api/v1/scenes/'+code)[1])
  assert len(scene['meshes'])==3 and scene['meshes'][0]['translation']!=scene['meshes'][1]['translation']
  assert scene['meshes'][1]['translation']==scene['meshes'][2]['translation']
  assert 'oss://' not in json.dumps(scene) and 'PRIVATE' not in json.dumps(scene)
  assert http(origin+'/'+scene['attachments'][0]['url'])[1]==b'attachment-data'
  raw=http(origin+'/'+scene['meshes'][0]['source_url'])[1];assert raw
  assert http(origin+'/'+scene['meshes'][0]['source_url']+'/lod')[0]==200
  png=http(shared['image_url'])[1];assert png.startswith(b'\x89PNG')
  grouped=json.loads(cli('share','demo://grouped','--format','json',environment=remote).stdout)
  gscene=json.loads(http(origin+'/api/v1/scenes/'+grouped['viewer_url'].rsplit('/',1)[1])[1])
  assert [c['group'] for c in gscene['entities']]==['Stage one']*4+['Stage two']*2
  assert len(gscene['meshes'])==6
  positions=[m['translation'] for m in gscene['meshes']]
  assert positions[0]==positions[1] and positions[2]==positions[3] and positions[4]==positions[5]
  assert len({tuple(positions[i]) for i in [0,2,4]})==3
  collision=json.loads(cli('share','demo://collision','--format','json',environment=remote).stdout)
  ccode=collision['viewer_url'].rsplit('/',1)[1]
  cscene=json.loads(http(origin+'/api/v1/scenes/'+ccode)[1])
  assert len({c['id'] for c in cscene['entities']})==len(cscene['entities'])
  update={'state':cscene['state'],'meshes':[{k:m[k] for k in ['color','opacity','visible','quality']} for m in cscene['meshes']], 'entities':[{k:c.get(k) for k in ['id','position','size','visible','opacity']} for c in cscene['entities']]}
  assert http(origin+'/api/v1/scenes/'+ccode+'/share',data=update)[0]==200
  partial=json.loads(cli('share','demo://partial','--format','json',environment=remote).stdout);assert partial['status']=='partial'
  pscene=json.loads(http(origin+'/api/v1/scenes/'+partial['viewer_url'].rsplit('/',1)[1])[1])
  assert any(w['code']=='PANEL_INCOMPLETE' for w in pscene['warnings'])
  assert any('Two' in m.get('label',{}).get('text','') for m in pscene['meshes'])
  missing=cli('share','demo://missing-order',environment=remote,ok=False)
  assert 'ORDER_NOT_FOUND' in missing.stderr and 'SECRET' not in missing.stderr
  empty=cli('share','demo://all-missing',environment=remote,ok=False)
  assert 'NO_READABLE_GEOMETRY' in empty.stderr
  failed=json.loads(cli('share','demo://failed-order','--format','json',environment=remote).stdout)
  assert failed['status']=='partial' and any(w['code']=='ORDER_FAILED' for w in failed['warnings'])
  attached=json.loads(cli('share','demo://attachment-missing','--format','json',environment=remote).stdout)
  ascene=json.loads(http(origin+'/api/v1/scenes/'+attached['viewer_url'].rsplit('/',1)[1])[1])
  assert attached['status']=='partial' and not ascene['attachments'][0].get('url')
  # Client-only identity can never read Server filesystem paths.
  c=json.loads((tmp/'remote-client'/'client.json').read_text())
  try:http(origin+'/api/v1/client/scenes',c['credential'],{'paths':[str(ROOT/'tests/fixtures/tetra.ply')]});raise AssertionError('filesystem escape')
  except urllib.error.HTTPError:pass
  cli('plugin','remove','demo')
  assert http(origin+'/'+scene['meshes'][0]['source_url'])[1]==raw
  assert http(shared['image_url'])[1].startswith(b'\x89PNG')
  cli('share','demo://https://example.test/a?x=1',environment=remote,ok=False)
  cli('leave',environment=remote)
  try:http(origin+'/api/v1/scenes/'+code);raise AssertionError('revoked share')
  except urllib.error.HTTPError as e:assert e.code==410
  print('PASS: install/config, client-only, routing, binding, compatibility, layout, attachments, Raw/LOD/PNG, partial, uninstall persistence and revocation')
 finally:
  proc.terminate();proc.wait(timeout=20);log.close();storage.shutdown()

#!/usr/bin/env python3
"""Real CLI/server component contract, using an isolated export browser and no external services."""
import io
import zipfile
from PIL import Image
import json
import os
from pathlib import Path
import socket
import sys
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / (sys.argv[1] if len(sys.argv) > 1 else 'target/debug') / 'blind'
with tempfile.TemporaryDirectory(prefix='blind-components-') as temp:
    tmp = Path(temp)
    env = {**os.environ, 'BLIND_CONFIG_DIR': str(tmp/'server'), 'BLIND_CLIENT_DIR': str(tmp/'client')}
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    def cli(*args, ok=True):
        result = subprocess.run([str(BIN), *map(str,args)], env=env, text=True, capture_output=True, timeout=90)
        assert (result.returncode == 0) == ok, result.stderr
        return result.stdout
    def api(path, body=None):
        request = urllib.request.Request(origin+path, data=None if body is None else json.dumps(body).encode(), headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers
    def share(*args):
        result = json.loads(cli('share', *args, '--format', 'json'))
        token = result['viewer_url'].rsplit('/',1)[1]
        status, payload, _ = api(f'/api/v1/scenes/{token}')
        assert status == 200, payload
        return token, json.loads(payload)
    cli('init', '--host', origin)
    log = (tmp/'server.log').open('w')
    process = subprocess.Popen([str(BIN),'serve','--listen',f'127.0.0.1:{port}'], env=env, stdout=log, stderr=log)
    try:
        for attempt in range(100):
            try:
                if api('/api/v1/health')[0] == 200: break
            except OSError: time.sleep(.1)
        else: raise AssertionError('server not ready')
        # A component-only plugin exercises the public package and renderer contract.
        package = tmp/'example'; package.mkdir()
        manifest = {'id':'example','name':'Example','version':'1.0.0','schemes':[], 'protocol_versions':[1],'entrypoint':[], 'files':['panel.html'], 'components':[{'name':'panel','entrypoint':'panel.html','api_version':1,'extensions':['trace.json'],'frame_origins':['https://example.org']}], 'config_schema':{'type':'object','properties':{},'required':[],'additionalProperties':False}}
        (package/'blind-plugin.json').write_text(json.dumps(manifest))
        html = """<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:#e000e0}</style><script>window.addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='blind:init'){document.body.textContent=new TextDecoder().decode(e.data.buffer);e.ports[0].postMessage({version:1,type:'ready'});}});</script>"""
        (package/'panel.html').write_text(html)
        cli('plugin','install',package)
        (tmp/'run.log').write_text('real text <script>must not execute</script>\n')
        (tmp/'trace.json').write_text('{"traceEvents":[{"name":"work","ph":"X","ts":0,"dur":20,"pid":1,"tid":1}]}')
        (tmp/'capture.json').write_text((tmp/'trace.json').read_text())
        (tmp/'page.html').write_text('<h1>Report</h1><script>document.title="isolated"</script>')
        mesh = ROOT/'tests/fixtures/tetra.ply'
        token, scene = share(mesh, tmp/'run.log', tmp/'trace.json', tmp/'page.html')
        assert [c['component'] for c in scene['components']] == ['mesh','text','example:panel','html']
        assert [c['source'] for c in scene['components']] == [{'kind':'mesh','index':0}]+[{'kind':'attachment','index':i} for i in range(3)]
        assert all('path' not in json.dumps(c) for c in scene['components'])
        assert len(scene['meshes']) == 1 and len(scene['attachments']) == 3
        for attachment in scene['attachments']:
            assert api('/'+attachment['url'])[0] == 200
        html_url = '/'+scene['attachments'][2]['url']+'?embed=1'
        status, payload, headers = api(html_url)
        assert status == 200 and headers['Content-Type'].startswith('text/html')
        assert 'sandbox allow-scripts;' in headers['Content-Security-Policy']
        assert 'allow-same-origin' not in headers['Content-Security-Policy']
        assert 'https:' not in headers['Content-Security-Policy']
        assert api('/'+scene['attachments'][0]['url']+'?embed=1')[0] == 400
        plain_token, plain = share(tmp/'capture.json')
        assert plain['components'][0]['component'] == 'json' and not plain['meshes']
        assert api(f'/i/{plain_token}.png')[0] == 200
        _, explicit = share(tmp/'capture.json', '--component','example:panel')
        assert explicit['components'][0]['component'] == 'example:panel'
        # Full PNG export must contain the sandboxed plugin, not only WebGL geometry.
        plugin_token, plugin_scene = share(tmp/'trace.json')
        renderer_url = f"/api/v1/scenes/{plugin_token}/renderers/{plugin_scene['components'][0]['id']}"
        status, pinned_html, headers = api(renderer_url)
        assert status == 200 and 'sandbox allow-scripts' in headers['Content-Security-Policy']
        assert 'https://example.org' in api(f'/s/{plugin_token}')[2]['Content-Security-Policy']
        assert 'https://example.org' not in api('/')[2]['Content-Security-Policy']
        status, png, _ = api(f'/i/{plugin_token}.png')
        assert status == 200, png
        image = Image.open(io.BytesIO(png)).convert('RGB')
        colored = sum(1 for r,g,b in zip(*(iter(image.tobytes()),)*3) if r > 150 and b > 150 and g < 70)
        assert colored > image.width*image.height*.03, 'plugin missing from exported PNG'
        (package/'panel.html').write_text(html.replace('#e000e0','#00aaff'))
        manifest['version'] = '1.0.1'; (package/'blind-plugin.json').write_text(json.dumps(manifest))
        cli('plugin','install',package)
        assert api(renderer_url)[1] == pinned_html, 'upgrade changed an existing scene'
        cli('plugin','remove','example')
        assert api(renderer_url)[1] == pinned_html, 'removal broke an existing scene'
        cli('share',tmp/'trace.json','--component','example:panel',ok=False)
        cli('plugin','install',package)
        with zipfile.ZipFile(tmp/'bundle.zip','w') as archive: archive.writestr('run.log','member content')
        (tmp/'member.json').write_text(json.dumps({'resources':[{'path':'bundle.zip','member':'run.log','component':'text'}]}))
        _, member_scene = share('--config',tmp/'member.json')
        assert api('/'+member_scene['attachments'][0]['url'])[1] == b'member content'
        (tmp/'member.json').write_text(json.dumps({'resources':[{'path':'bundle.zip','member':'../run.log','component':'text'}]}))
        cli('share','--config',tmp/'member.json',ok=False)
        cli('share',mesh,tmp/'run.log','--component','example:panel',ok=False)
        cli('share',mesh,'--component','2=mesh',ok=False)
        cli('share',mesh,'--component','points',ok=False)
        (tmp/'scene.json').write_text(json.dumps({'resources':[{'path':str(mesh),'group':'Geometry'},{'path':'capture.json','component':'example:panel','label':'Timeline','group':'Diagnostics','position':[10,20,30],'size':[120,70]},{'path':str(mesh),'label':'Second','group':'Geometry'}]}))
        token, scene = share('--config',tmp/'scene.json')
        assert [c['group'] for c in scene['components']] == ['Geometry','Diagnostics','Geometry']
        assert scene['components'][1]['label'] == 'Timeline'
        assert scene['meshes'][1]['label']['text'] == 'Second'
        assert scene['components'][2]['source']['index'] == 1
        update = {'meshes':[{key:m[key] for key in ['color','opacity','visible','quality']} for m in scene['meshes']], 'state':scene['state'], 'components':[{key:c[key] for key in ['id','position','size','visible','opacity']} for c in scene['components']]}
        update['meshes'][0]['label'] = {'text':'Renamed geometry'}
        update['components'][0].update(position=[40,50,60],visible=False,opacity=.3)
        update['components'][1].update(position=[-20,0,7],visible=False,state={'selection':'row-2'})
        status, body, _ = api(f'/api/v1/scenes/{token}/share',update)
        assert status == 200, body
        new_token = json.loads(body)['viewer_url'].rsplit('/',1)[1]
        _, new_body, _ = api(f'/api/v1/scenes/{new_token}')
        saved = json.loads(new_body)
        assert saved['meshes'][0]['translation'] == [40,50,60]
        assert saved['meshes'][0]['opacity'] == saved['components'][0]['opacity']
        assert saved['meshes'][0]['visible'] is False
        assert saved['components'][0]['label'] == 'Renamed geometry'
        assert saved['components'][1]['position'] == [-20,0,7]
        assert saved['components'][1]['visible'] is False
        assert saved['components'][1]['state'] == {'selection':'row-2'}
        update['components'][1]['id'] = update['components'][0]['id']
        assert api(f'/api/v1/scenes/{token}/share',update)[0] == 400
        update['components'][1]['id'] = scene['components'][1]['id']
        update['components'][1]['source'] = {'kind':'attachment','index':0}
        assert api(f'/api/v1/scenes/{token}/share',update)[0] == 422
        # A failed HTML source must reject PNG export, never render an error document as success.
        html_token, _ = share(tmp/'page.html')
        assert api(f'/i/{html_token}.png')[0] == 200
        (tmp/'page.html').write_text('changed after share')
        assert api(f'/i/{html_token}.png')[0] == 422
        # Geometry-only component groups use the same Viewer layout for PNGs.
        (tmp/'groups.json').write_text(json.dumps({'resources':[
            {'path':str(mesh),'group':'Left','label':'Left'},
            {'path':str(mesh),'group':'Right','label':'Right'}]}))
        group_token, _ = share('--config',tmp/'groups.json')
        status, png, _ = api(f'/i/{group_token}.png')
        assert status == 200, png
        assert Image.open(io.BytesIO(png)).size == (1200,900)
        # An attachment changed after creation must never be served under the old revision.
        (tmp/'capture.json').write_text('{"changed":true}')
        assert api('/'+scene['attachments'][0]['url'])[0] == 410
        # Scene metadata and geometry remain inspectable when a diagnostic resource changes.
        assert api(f'/api/v1/scenes/{token}')[0] == 200
        print('PASS: plugin isolation, pinned revisions, full PNG export, bounded ZIP members; automatic/explicit components, JSON-only scene, flat groups, safe HTML, mixed source indices, layout round-trip, immutable bindings and revision checks')
    finally:
        process.terminate()
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        log.close()

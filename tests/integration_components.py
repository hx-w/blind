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
    def cli(*args, ok=True, cwd=None, environment=None, diagnostics=False):
        result = subprocess.run([str(BIN), *map(str,args)], env=environment or env, cwd=cwd, text=True, capture_output=True, timeout=90)
        assert (result.returncode == 0) == ok, result.stderr
        return result if diagnostics else result.stdout
    def api(path, body=None, credential=None):
        headers = {'Content-Type':'application/json'}
        if credential: headers['Authorization'] = 'Bearer '+credential
        request = urllib.request.Request(origin+path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers
    def share(*args, **kwargs):
        result = json.loads(cli('share', *args, '--format', 'json', **kwargs))
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
        manifest = '''id = "example"
name = "Example"
version = "1.0.0"
authors = [{ name = "Blind integration tests" }]
schemes = []
entrypoint = []
files = ["panel.html"]
[[components]]
name = "panel"
entrypoint = "panel.html"
api_version = 1
extensions = ["trace.json", "traceblob"]
frame_origins = ["https://example.org"]
'''
        (package/'blind-plugin.toml').write_text(manifest)
        expected_trace = '{"traceEvents":[{"name":"work","ph":"X","ts":0,"dur":20,"pid":1,"tid":1}]}'
        html = """<!doctype html><style>html,body{margin:0;width:100%;height:100%}</style><script>const expected=""" + json.dumps(expected_trace) + """;window.addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='blind:init'){const source=new TextDecoder().decode(e.data.buffer);if(source!==expected)return;document.body.textContent=source;document.body.style.background='#e000e0';e.ports[0].postMessage({version:1,type:'ready'});}});</script>"""
        (package/'panel.html').write_text(html)
        cli('plugin','install',package)
        (tmp/'run.log').write_text('real text <script>must not execute</script>\n')
        (tmp/'trace.json').write_text(expected_trace)
        (tmp/'capture.json').write_text((tmp/'trace.json').read_text())
        (tmp/'page.html').write_text('<h1>Report</h1><script>document.title="isolated"</script>')
        mesh = ROOT/'tests/fixtures/tetra.ply'
        # Exercise the production source constructor beyond its former 64-mesh ceiling.
        capacity_manifest = tmp/'capacity.json'
        capacity_manifest.write_text(json.dumps({'resources': [{'path': str(mesh)} for _ in range(65)]}))
        _, capacity_scene = share('--config', capacity_manifest)
        assert len(capacity_scene['meshes']) == len(capacity_scene['entities']) == 65
        assert [entity['source'] for entity in capacity_scene['entities']] == [
            {'kind': 'mesh', 'index': index} for index in range(65)]
        assert len({entity['id'] for entity in capacity_scene['entities']}) == 65
        assert all(m['visible'] for m in capacity_scene['meshes'])
        assert all(c['visible'] for c in capacity_scene['entities'])
        markdown = ROOT/'tests/fixtures/review.md'
        # Fidelity is per geometry instance, not per source URI or a later style update.
        selected = cli('share', mesh, tmp/'run.log', '--quality', '1=raw', '--format', 'json', diagnostics=True)
        raw_share = json.loads(selected.stdout)
        raw_token = raw_share['viewer_url'].rsplit('/',1)[1]
        raw_scene = json.loads(api(f'/api/v1/scenes/{raw_token}')[1])
        assert raw_scene['meshes'][0]['quality'] == 'raw'
        assert not raw_share['warnings'] and not selected.stderr
        assert api('/'+raw_scene['meshes'][0]['source_url'])[1] == mesh.read_bytes()
        assert api(f'/i/{raw_token}.png')[0] == 200
        default_result = cli('share', mesh, '--format', 'json', diagnostics=True)
        default_share = json.loads(default_result.stdout)
        assert default_share['status'] == 'complete'
        assert [(w['code'], w['resource_id']) for w in default_share['warnings']] == [('LOD_SELECTED','resource-1')]
        assert 'resource-1' in default_result.stderr
        for args in [
            (mesh, '--quality', 'invalid'), (mesh, '--quality', '2=raw'),
            (mesh, '--quality', 'raw', '--quality', 'lod'),
            (tmp/'run.log', '--quality', 'raw'),
            (mesh, '--component', 'text', '--quality', 'lod'),
            (tmp/'trace.json', '--plugin', 'example', '--quality', 'raw'),
        ]:
            assert cli('share', *args, '--format', 'json', ok=False) == ''
        quality_path = tmp/'quality.json'
        repeated = [{'path':str(mesh),'quality':'raw','visible':False}, {'path':str(mesh),'quality':'lod'}]
        quality_path.write_text(json.dumps({'resources':repeated}))
        quality_token, quality_scene = share('--config', quality_path)
        assert [m['quality'] for m in quality_scene['meshes']] == ['raw','lod']
        assert quality_scene['meshes'][0]['revision'] == quality_scene['meshes'][1]['revision'] == raw_scene['meshes'][0]['revision']
        assert [w['resource_id'] for w in quality_scene['warnings']] == ['resource-2']
        assert [m['visible'] for m in quality_scene['meshes']] == [False, True]
        assert [c['visible'] for c in quality_scene['entities']] == [False, True]
        assert quality_scene['meshes'][0]['source_url'] != quality_scene['meshes'][1]['source_url']
        assert all(api('/'+m['source_url'])[1] == mesh.read_bytes() for m in quality_scene['meshes'])
        quality_update = {'meshes':[{key:m[key] for key in ['color','opacity','visible','quality']} for m in quality_scene['meshes']],
                          'state':quality_scene['state']}
        quality_update['meshes'][0]['quality'] = 'lod'
        quality_update['meshes'][1]['quality'] = 'raw'
        status, updated_body, _ = api(f'/api/v1/scenes/{quality_token}/share',quality_update)
        assert status == 200, updated_body
        updated_token = json.loads(updated_body)['viewer_url'].rsplit('/',1)[1]
        updated_quality = json.loads(api(f'/api/v1/scenes/{updated_token}')[1])
        assert [m['quality'] for m in updated_quality['meshes']] == ['lod','raw']
        assert [w['resource_id'] for w in updated_quality['warnings']] == ['resource-1']
        assert [w['resource_id'] for w in json.loads(api(f'/api/v1/scenes/{quality_token}')[1])['warnings']] == ['resource-2']
        quality_path.write_text(json.dumps({'kind':'collection','schema_version':1,'title':'Quality','scenes':[
            {'id':'exact','title':'Exact','resources':[repeated[0],{'path':str(tmp/'run.log'),'visible':False}]},
            {'id':'derived','title':'Derived','resources':[repeated[1]]}]}))
        collection_result = cli('share','--config',quality_path,'--format','json',diagnostics=True)
        collection_share = json.loads(collection_result.stdout)
        assert not collection_share['scenes'][0]['warnings']
        assert collection_share['scenes'][1]['warnings'][0]['code'] == 'LOD_SELECTED'
        assert '[derived]' in collection_result.stderr and '[exact]' not in collection_result.stderr
        collection_token = collection_share['viewer_url'].rsplit('/',1)[1]
        for child, expected in [('exact','raw'),('derived','lod')]:
            child_scene = json.loads(api(f'/api/v1/scenes/{collection_token}?scene={child}')[1])
            assert child_scene['meshes'][0]['quality'] == expected
            assert child_scene['meshes'][0]['visible'] == (child == 'derived')
            assert child_scene['entities'][0]['visible'] == (child == 'derived')
            if child == 'exact':
                assert child_scene['entities'][1]['visible'] is False
                assert api('/'+child_scene['attachments'][0]['url'])[1] == (tmp/'run.log').read_bytes()
        advanced = {'schema_version':1,'requires':['components.v1'],'resources':[
            {'id':'exact','uri':str(mesh),'quality':'raw','visible':False},
            {'id':'derived','uri':str(mesh),'quality':'lod'}],
            'components':[{'id':'another','label':'Exact component','uri':str(mesh),'quality':'raw','visible':False},
                          {'id':'notes','label':'Notes','uri':str(tmp/'run.log'),'visible':False}]}
        quality_path.write_text(json.dumps(advanced))
        _, advanced_scene = share('--config',quality_path)
        assert [m['quality'] for m in advanced_scene['meshes']] == ['raw','lod','raw']
        assert [m['visible'] for m in advanced_scene['meshes']] == [False, True, False]
        assert [c['visible'] for c in advanced_scene['entities']] == [False, True, False, False]
        assert len({m['revision'] for m in advanced_scene['meshes']}) == 1
        assert all(api('/'+m['source_url'])[1] == mesh.read_bytes() for m in advanced_scene['meshes'])
        assert api('/'+advanced_scene['attachments'][0]['url'])[1] == (tmp/'run.log').read_bytes()
        for invalid_config in [
            {'resources':[{'path':str(mesh),'quality':'invalid'}]},
            {'resources':[{'path':str(tmp/'run.log'),'quality':'lod'}]},
            {'schema_version':1,'resources':[{'id':'bad','uri':str(tmp/'run.log'),'quality':'raw'}]},
            {'schema_version':1,'requires':['attachments'],'resources':[{'id':'mesh','uri':str(mesh)}],
             'attachments':[{'id':'notes','uri':str(tmp/'run.log'),'quality':'lod'}]},
            {'schema_version':1,'requires':['attachments'],'resources':[{'id':'mesh','uri':str(mesh)}],
             'attachments':[{'id':'notes','uri':str(tmp/'run.log'),'visible':False}]},
            {'resources':[{'path':str(mesh),'visible':'false'}]},
            {'resources':[{'path':str(mesh),'visible':False,'typo':'ignored'}]},
            {'schema_version':1,'requires':['components.v1'],'resources':[],
             'components':[{'id':'notes','label':'Notes','uri':str(tmp/'run.log'),'visible':False,'typo':'ignored'}]},
        ]:
            quality_path.write_text(json.dumps(invalid_config))
            assert cli('share','--config',quality_path,'--format','json',ok=False) == ''
        assert len(advanced_scene['warnings']) == 1
        pat = json.loads((tmp/'server/config.json').read_text())['pat']
        for body in [
            {'paths':[str(tmp/'run.log')],'display':[{'quality':'raw'}]},
            {'paths':[str(mesh)],'display':[{'component':'text','quality':'lod'}]},
            {'manifest':{'schema_version':1,'requires':['components.v1'],'resources':[],
                         'components':[{'id':'bad','uri':str(tmp/'run.log'),'label':'Bad','quality':'raw'}]}},
            {'manifest':{'schema_version':1,'requires':['attachments'],
                         'resources':[{'id':'mesh','uri':str(mesh)}],
                         'attachments':[{'id':'notes','uri':str(tmp/'run.log'),'visible':True}]}},
            {'paths':[str(tmp/'run.log')],'display':[{'panel_height':0}]},
            {'paths':[str(mesh)],'display':[{'panel_height':320}]},
        ]:
            status, payload, _ = api('/api/v1/scenes',body,pat)
            assert status == 400, (body, status, payload)
        malformed = {'paths':[str(mesh)],'display':[{'visible':False,'typo':'ignored'}]}
        status, payload, _ = api('/api/v1/scenes',malformed,pat)
        assert status == 422, (malformed, status, payload)
        visibility_path = tmp/'visibility.json'
        hidden_mesh = tmp/'hidden.ply'; hidden_mesh.write_bytes(mesh.read_bytes())
        visibility_path.write_text(json.dumps({'resources':[
            {'path':str(hidden_mesh),'visible':False},
            {'path':str(tmp/'run.log'),'visible':False}]}))
        hidden_share = json.loads(cli('share','--config',visibility_path,'--format','json'))
        hidden_token = hidden_share['viewer_url'].rsplit('/',1)[1]
        hidden_scene = json.loads(api(f'/api/v1/scenes/{hidden_token}')[1])
        assert hidden_share['status'] == 'complete' and len(hidden_share['resources']) == 1
        assert hidden_share['resources'][0]['revision'] == hidden_scene['meshes'][0]['revision']
        assert not hidden_scene['meshes'][0]['visible']
        assert [c['visible'] for c in hidden_scene['entities']] == [False, False]
        assert api('/'+hidden_scene['attachments'][0]['url'])[1] == (tmp/'run.log').read_bytes()
        assert api('/'+hidden_scene['meshes'][0]['source_url'])[1] == hidden_mesh.read_bytes()
        hidden_mesh.write_bytes(hidden_mesh.read_bytes()+b'\n')
        assert api('/'+hidden_scene['meshes'][0]['source_url'])[0] == 410
        # Directory discovery runs on the source machine and yields one normal scene.
        directory = tmp/'directory'; directory.mkdir()
        (directory/'nested').mkdir(); (directory/'.hidden').mkdir()
        (directory/'a.ply').write_bytes(mesh.read_bytes())
        (directory/'b.md').write_bytes(markdown.read_bytes())
        (directory/'c.TRACEBLOB').write_text('plugin-only extension')
        (directory/'nested'/'d.log').write_text('nested log')
        (directory/'skip.bin').write_text('explicit override only')
        (directory/'.secret.json').write_text('{}')
        (directory/'.hidden'/'private.txt').write_text('hidden')
        (directory/'linked.log').symlink_to(tmp/'run.log')
        (directory/'cycle').symlink_to(directory, target_is_directory=True)
        directory_token, direct = share('./', '--plugin', 'example', cwd=directory)
        assert [c['component'] for c in direct['entities']] == ['mesh','markdown','example:panel']
        _, discovered_raw = share(directory, '--plugin', 'example', '--quality', '1=raw')
        assert discovered_raw['meshes'][0]['quality'] == 'raw'
        assert api(f'/s/{directory_token}')[0] == 200
        assert api('/'+direct['attachments'][1]['url'])[1] == b'plugin-only extension'
        _, recursive = share(directory, directory/'b.md', '--plugin', 'example', '--recursive', '--label', '4=Nested', '--component', '2=text')
        assert [c['component'] for c in recursive['entities']] == ['mesh','text','example:panel','text']
        assert recursive['entities'][3]['label'] == 'Nested'
        # Explicit activation can discover a renderer installed only on the Server.
        remote_env = {**env, 'BLIND_CONFIG_DIR': str(tmp/'client-without-plugins')}
        _, remote_directory = share(directory, '--plugin', 'example', environment=remote_env)
        assert [c['component'] for c in remote_directory['entities']] == ['mesh','markdown','example:panel']
        assert not (tmp/'client-without-plugins').exists()
        _, explicit_unknown = share(directory/'skip.bin', directory, '--plugin', 'example', '--component', '1=text')
        assert len(explicit_unknown['entities']) == 4 and explicit_unknown['entities'][0]['component'] == 'text'
        (directory/'z.txt').write_text('added later')
        assert len(json.loads(api(f'/api/v1/scenes/{directory_token}')[1])['entities']) == 3
        _, refreshed = share(directory, '--plugin', 'example')
        assert len(refreshed['entities']) == 4
        empty = tmp/'empty'; empty.mkdir()
        assert cli('share', empty, '--format', 'json', ok=False) == ''
        assert cli('share', directory, tmp/'missing', '--format', 'json', ok=False) == ''
        for i in range(257): (empty/f'{i}.txt').write_text('too many')
        assert cli('share', empty, '--format', 'json', ok=False) == ''
        md_token, md_scene = share(markdown)
        assert md_scene['entities'][0]['component'] == 'markdown' and not md_scene['meshes']
        assert api('/'+md_scene['attachments'][0]['url'])[1] == markdown.read_bytes()
        status, png, _ = api(f'/i/{md_token}.png')
        assert status == 200, png[:200]
        assert Image.open(io.BytesIO(png)).format == 'PNG'
        _, raw_markdown = share(markdown, '--component', 'text')
        assert raw_markdown['entities'][0]['component'] == 'text'
        _, explicit_markdown = share(tmp/'run.log', '--component', 'markdown')
        assert explicit_markdown['entities'][0]['component'] == 'markdown'
        token, scene = share(mesh, tmp/'run.log', tmp/'trace.json', tmp/'page.html', '--plugin', 'example')
        assert [c['component'] for c in scene['entities']] == ['mesh','text','example:panel','html']
        assert [c['source'] for c in scene['entities']] == [{'kind':'mesh','index':0}]+[{'kind':'attachment','index':i} for i in range(3)]
        assert all('path' not in json.dumps(c) for c in scene['entities'])
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
        assert plain['entities'][0]['component'] == 'json' and not plain['meshes']
        assert api(f'/i/{plain_token}.png')[0] == 200
        _, explicit = share(tmp/'capture.json', '--component','example:panel')
        assert explicit['entities'][0]['component'] == 'example:panel'
        # Full PNG export must contain the sandboxed plugin, not only WebGL geometry.
        (tmp/'plugin-pane.json').write_text(json.dumps({'resources':[
            {'path':str(tmp/'trace.json'),'component':'example:panel','placement':'panel','panel_height':320}]}))
        plugin_token, plugin_scene = share('--config',tmp/'plugin-pane.json')
        assert plugin_scene['entities'][0]['panel_height'] == 320
        renderer_url = f"/api/v1/scenes/{plugin_token}/renderers/{plugin_scene['entities'][0]['id']}"
        status, pinned_html, headers = api(renderer_url)
        assert status == 200 and 'sandbox allow-scripts' in headers['Content-Security-Policy']
        assert 'https://example.org' in api(f'/s/{plugin_token}')[2]['Content-Security-Policy']
        assert 'https://example.org' not in api('/')[2]['Content-Security-Policy']
        status, png, _ = api(f'/i/{plugin_token}.png')
        assert status == 200, png
        image = Image.open(io.BytesIO(png)).convert('RGB')
        colored = sum(1 for r,g,b in zip(*(iter(image.tobytes()),)*3) if r > 150 and b > 150 and g < 70)
        assert colored > image.width*image.height*.03, 'plugin missing from exported PNG'
        def plugin_height(image):
            rows = [y for y in range(image.height) if any(
                r > 150 and b > 150 and g < 70 for r,g,b in
                (image.getpixel((x,y)) for x in range(image.width)))]
            assert rows, 'plugin pixels missing from pane export'
            return max(rows) - min(rows) + 1
        initial_height = plugin_height(image)
        assert 240 <= initial_height < 300, 'PNG must honor configured outer pane height'
        pane_update = {'meshes':[], 'state':plugin_scene['state'], 'entities':[
            {key:plugin_scene['entities'][0][key] for key in
             ['id','placement','position','size','panel_height','visible','opacity']}]}
        pane_update['entities'][0]['panel_height'] = 640
        status, body, _ = api(f'/api/v1/scenes/{plugin_token}/share',pane_update)
        assert status == 200, body
        taller_token = json.loads(body)['viewer_url'].rsplit('/',1)[1]
        taller = json.loads(api(f'/api/v1/scenes/{taller_token}')[1])
        assert taller['entities'][0]['panel_height'] == 640
        assert taller['entities'][0]['source'] == plugin_scene['entities'][0]['source']
        assert taller['entities'][0]['renderer'] == plugin_scene['entities'][0]['renderer']
        status, png, _ = api(f'/i/{taller_token}.png')
        assert status == 200, png[:200]
        assert abs(plugin_height(Image.open(io.BytesIO(png)).convert('RGB')) - initial_height - 320) <= 2
        assert json.loads(api(f'/api/v1/scenes/{plugin_token}')[1])['entities'][0]['panel_height'] == 320
        pane_update['entities'][0]['panel_height'] = None
        status, body, _ = api(f'/api/v1/scenes/{taller_token}/share',pane_update)
        assert status == 200, body
        auto_token = json.loads(body)['viewer_url'].rsplit('/',1)[1]
        assert json.loads(api(f'/api/v1/scenes/{auto_token}')[1])['entities'][0].get('panel_height') is None
        (package/'panel.html').write_text(html.replace('#e000e0','#00aaff'))
        manifest = manifest.replace('version = "1.0.0"', 'version = "1.0.1"')
        (package/'blind-plugin.toml').write_text(manifest)
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
        cli('share', '--config', tmp/'scene.json', '--recursive', ok=False)
        assert [c['group'] for c in scene['entities']] == ['Geometry','Diagnostics','Geometry']
        assert scene['entities'][1]['label'] == 'Timeline'
        assert scene['meshes'][1]['label']['text'] == 'Second'
        assert scene['entities'][2]['source']['index'] == 1
        update = {'meshes':[{key:m[key] for key in ['color','opacity','visible','quality']} for m in scene['meshes']], 'state':scene['state'], 'entities':[{key:c[key] for key in ['id','position','size','visible','opacity']} for c in scene['entities']]}
        update['meshes'][0]['label'] = {'text':'Renamed geometry'}
        update['entities'][0].update(position=[40,50,60],visible=False,opacity=.3)
        update['entities'][1].update(position=[-20,0,7],visible=False,state={'selection':'row-2'})
        status, body, _ = api(f'/api/v1/scenes/{token}/share',update)
        assert status == 200, body
        new_token = json.loads(body)['viewer_url'].rsplit('/',1)[1]
        _, new_body, _ = api(f'/api/v1/scenes/{new_token}')
        saved = json.loads(new_body)
        assert saved['meshes'][0]['translation'] == [40,50,60]
        assert saved['meshes'][0]['opacity'] == saved['entities'][0]['opacity']
        assert saved['meshes'][0]['visible'] is False
        assert saved['entities'][0]['label'] == 'Renamed geometry'
        assert saved['entities'][1]['position'] == [-20,0,7]
        assert saved['entities'][1]['visible'] is False
        assert saved['entities'][1]['state'] == {'selection':'row-2'}
        update['entities'][1]['id'] = update['entities'][0]['id']
        assert api(f'/api/v1/scenes/{token}/share',update)[0] == 400
        update['entities'][1]['id'] = scene['entities'][1]['id']
        update['entities'][1]['source'] = {'kind':'attachment','index':0}
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

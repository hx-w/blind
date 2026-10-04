#!/usr/bin/env python3
"""Unified local plugins: real clients, CAS deduplication, isolation and lifecycle."""
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / (sys.argv[1] if len(sys.argv) > 1 else 'target/debug') / 'blind'
REPORT = b'{"task":"actual-source","value":7}'
HTML = '''<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;background:#e000e0;color:#fff;font:24px sans-serif}</style></head><body><script>
addEventListener('message',e=>{if(e.source!==parent||e.data?.type!=='blind:init')return;
const p=e.ports[0];document.body.textContent='Plugin report: '+new TextDecoder().decode(e.data.buffer);
p.postMessage({version:1,type:'ready'});});
</script></body></html>'''


class Storage(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        assert self.headers.get('Authorization', '').startswith('AWS4-HMAC-SHA256 ')
        self.send_response(200)
        self.send_header('Content-Length', str(len(REPORT)))
        self.end_headers()
        self.wfile.write(REPORT)


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


with tempfile.TemporaryDirectory(prefix='blind-plugin-bundles-') as directory:
    tmp = Path(directory)
    server_env = {**os.environ, 'BLIND_CONFIG_DIR': str(tmp/'server'), 'BLIND_CLIENT_DIR': str(tmp/'owner')}
    clients = [{**server_env, 'BLIND_CONFIG_DIR': str(tmp/f'host-{i}'), 'BLIND_CLIENT_DIR': str(tmp/f'client-{i}')} for i in range(2)]
    origin = f'http://127.0.0.1:{free_port()}'

    def cli(*args, environment=server_env, input=None, ok=True, cwd=None):
        result = subprocess.run([str(BIN), *map(str, args)], env=environment, input=input, cwd=cwd,
                                text=True, capture_output=True, timeout=120)
        assert (result.returncode == 0) == ok, (args, result.stdout, result.stderr)
        return result.stdout if ok else result.stderr

    def api(path, body=None, credential=None, raw=None):
        headers = {'Content-Type': 'application/json'}
        if credential:
            headers['Authorization'] = 'Bearer '+credential
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        request = urllib.request.Request(origin+path, headers=headers, data=data)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    def share(environment, *args, input=None, cwd=None):
        result = json.loads(cli('share', *args, '--format', 'json', environment=environment, input=input, cwd=cwd))
        token = result['viewer_url'].rsplit('/', 1)[1]
        status, body, _ = api(f'/api/v1/scenes/{token}')
        assert status == 200, body
        return token, json.loads(body)

    def renderer_url(token, scene, suffix=''):
        return f"/api/v1/scenes/{token}/renderers/{scene['entities'][0]['id']}"+suffix

    package = tmp/'package'
    package.mkdir()
    manifest = f'''id = "sample"
name = "Sample diagnostics"
version = "1.0.0"
authors = [{{ name = "Blind integration tests", url = "https://example.org" }}]
license = "MIT"
repository = "https://example.org/source"
homepage = "https://example.org"
keywords = ["diagnostics"]
schemes = ["sample"]
entrypoint = [{json.dumps(sys.executable)}, "resolver.py"]
files = ["panel.html", "resolver.py"]
[[components]]
name = "panel"
entrypoint = "panel.html"
api_version = 1
extensions = ["report.json"]
[env.DEBUG_TOKEN]
required = true
secret = true
[env.API_ORIGIN]
default = "https://example.org"
'''
    (package/'blind-plugin.toml').write_text(manifest)
    (package/'.env').write_text('DEBUG_TOKEN=LOCAL_PLUGIN_SECRET\n')
    (package/'panel.html').write_text(HTML)
    resolver = '''import json,os,sys
r=json.loads(sys.stdin.readline())
assert r['params']['protocol_version']==2 and 'config' not in r['params']
assert os.environ['DEBUG_TOKEN']=='LOCAL_PLUGIN_SECRET'
assert os.environ['API_ORIGIN']=='https://example.org'
assert 'BLIND_CONFIG_DIR' not in os.environ and 'UNDECLARED_SECRET' not in os.environ
result={'schema_version':1,'requires':['components.v1'],'title':r['params']['input'],
'resources':[],'components':[{'id':'report','uri':'oss://test/bucket/report.json','label':'Diagnostics','component':'sample:panel'}]}
print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}))
'''
    (package/'resolver.py').write_text(resolver)
    storage = ThreadingHTTPServer(('127.0.0.1', 0), Storage)
    threading.Thread(target=storage.serve_forever, daemon=True).start()
    cli('init', '--host', origin)
    cli('oss', 'set', 'test', input=f'http://127.0.0.1:{storage.server_port}\nregion\naccess\nsecret\n')
    log = (tmp/'server.log').open('w')
    server = subprocess.Popen([str(BIN), 'serve', '--listen', origin.removeprefix('http://')],
                              env=server_env, stdout=log, stderr=log)
    try:
        for _ in range(100):
            try:
                if api('/api/v1/health')[0] == 200:
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise AssertionError('server not ready')
        # Authentication rejects even malformed uploads before parsing their bodies.
        assert api('/api/v1/client/scenes', raw=b'{')[0] == 401
        invitation = cli('invite', '--host', origin).strip()
        for environment in clients:
            cli('join', '--stdin', '--client-only', input=invitation, environment=environment)
            cli('plugin', 'install', package, environment=environment)
        assert json.loads(cli('plugin', 'list'))['plugins'] == [], 'client installation mutated Server catalog'

        # An explicit directory resolves and uploads browser-only code without an installation.
        direct_env = {**server_env, 'BLIND_CONFIG_DIR': str(tmp/'direct-host'),
                      'BLIND_CLIENT_DIR': str(tmp/'direct-client'), 'UNDECLARED_SECRET': 'HOST_SECRET'}
        cli('join', '--stdin', '--client-only', input=invitation, environment=direct_env)
        direct_token, direct_scene = share(direct_env, 'sample://direct', '--plugin', './package', cwd=tmp)
        direct_revision = direct_scene['entities'][0]['renderer']['revision']
        assert not (tmp/'direct-host').exists(), 'directory invocation installed private package state'
        direct_catalog = json.loads(cli('plugin', 'list', environment=direct_env))
        assert direct_catalog['plugins'] == [] and direct_catalog['server']['state'] == 'connected'
        assert 'LOCAL_PLUGIN_SECRET' not in json.dumps(direct_scene)
        config = {'kind': 'collection', 'schema_version': 1, 'title': 'Direct tasks', 'scenes': [
            {'id': 'a', 'title': 'A', 'uri': 'sample://direct-A'},
            {'id': 'b', 'title': 'B', 'uri': 'sample://direct-B'}]}
        _, direct_collection = share(direct_env, '--config', '-', '--plugin', package,
                                     input=json.dumps(config))
        assert [item['id'] for item in direct_collection['scenes']] == ['a', 'b']
        assert not (tmp/'direct-host').exists()
        nested = tmp/'nested'; nested.mkdir()
        _, relative = share(direct_env, 'sample://parent-directory', '--plugin', '../package', cwd=nested)
        assert relative['entities'][0]['renderer']['revision'] == direct_revision
        cli('share', 'sample://missing-directory', '--plugin', './sample', environment=direct_env, ok=False)
        # A captured absolute filename beginning with '-' remains a script, not an option.
        option_script = package/'-resolver.py'
        option_script.write_text(resolver)
        script_manifest = manifest.replace('files = ["panel.html", "resolver.py"]',
                                           'files = ["panel.html", "-resolver.py"]')
        script_manifest = script_manifest.replace(
            f'entrypoint = [{json.dumps(sys.executable)}, "resolver.py"]',
            f'entrypoint = [{json.dumps(sys.executable)}, {json.dumps(str(option_script))}]')
        (package/'blind-plugin.toml').write_text(script_manifest)
        _, option_scene = share(direct_env, 'sample://script-path', '--plugin', package)
        assert option_scene['entities'][0]['renderer']['revision'] == direct_revision
        (package/'blind-plugin.toml').write_text(manifest)
        # Host environment never supplies a missing declared value.
        (package/'.env').write_text('')
        inherited = {**direct_env, 'DEBUG_TOKEN': 'LOCAL_PLUGIN_SECRET'}
        failure = cli('share', 'sample://missing-env', '--plugin', package, environment=inherited, ok=False)
        assert 'LOCAL_PLUGIN_SECRET' not in failure
        (package/'.env').write_text('DEBUG_TOKEN=LOCAL_PLUGIN_SECRET\n')
        # Same-ID selections with different browser bytes fail before a scene upload.
        conflict = tmp/'conflict'; conflict.mkdir()
        (conflict/'blind-plugin.toml').write_text(manifest)
        (conflict/'.env').write_text((package/'.env').read_text())
        (conflict/'resolver.py').write_text(resolver)
        (conflict/'panel.html').write_text(HTML.replace('#e000e0', '#00aaff'))
        conflict_error = cli('share', 'sample://conflict', '--plugin', package, '--plugin', conflict,
                             environment=direct_env, ok=False)
        assert 'conflicting plugin content for sample' in conflict_error
        # A selected directory resolver wins over an installed resolver for its scheme.
        (conflict/'panel.html').write_text(HTML)
        (conflict/'.env').write_text('DEBUG_TOKEN=DIFFERENT_PRIVATE_VALUE\n')
        native_conflict = cli('share', 'sample://env-conflict', '--plugin', package,
                              '--plugin', conflict, environment=direct_env, ok=False)
        assert 'conflicting plugin resolution for sample' in native_conflict
        (conflict/'.env').write_text((package/'.env').read_text())
        (conflict/'resolver.py').write_text(resolver.replace("'title':r['params']['input']", "'title':'DIRECTORY_SELECTED'"))
        _, overridden = share(clients[0], 'sample://precedence', '--plugin', conflict)
        assert overridden['title'] == 'DIRECTORY_SELECTED'
        # The private environment file is not eligible as a declared package member.
        (conflict/'blind-plugin.toml').write_text(manifest.replace(
            'files = ["panel.html", "resolver.py"]', 'files = ["panel.html", "resolver.py", ".env"]'))
        cli('plugin', 'install', conflict, environment=direct_env, ok=False)
        cli('share', 'sample://private-member', '--plugin', conflict, environment=direct_env, ok=False)
        assert not (tmp/'direct-host'/'plugins'/'sample'/'current.json').exists()

        plain_token, plain = share(clients[0], 'oss://test/bucket/report.json')
        assert plain['entities'][0]['component'] == 'json' and plain['entities'][0].get('renderer') is None
        assert api(renderer_url(plain_token, plain))[0] == 404
        first_token, first = share(clients[0], 'sample://task-A')
        second_token, second = share(clients[1], 'sample://task-B')
        assert first['entities'][0]['component'] == second['entities'][0]['component'] == 'sample:panel'
        old_revision = first['entities'][0]['renderer']['revision']
        assert old_revision == second['entities'][0]['renderer']['revision']
        old_url = renderer_url(first_token, first)
        status, old_html, headers = api(old_url)
        assert status == 200 and old_html.decode() == HTML
        assert 'sandbox allow-scripts' in headers['Content-Security-Policy']
        assert 'allow-same-origin' not in headers['Content-Security-Policy']
        assert 'LOCAL_PLUGIN_SECRET' not in json.dumps(first)

        # Inspect real persistence, not a mocked upload count.
        database = tmp/'server'/'scenes.sqlite3'
        with sqlite3.connect(database) as connection:
            assert connection.execute('SELECT count(*) FROM renderer_bundles').fetchone()[0] == 1
            stored = connection.execute('SELECT bundle FROM renderer_bundles').fetchone()[0]
            assert 'LOCAL_PLUGIN_SECRET' not in stored and 'resolver.py' not in stored and '.env' not in stored

        # Native package differences do not duplicate an identical browser snapshot.
        (package/'resolver.py').write_text(resolver+'\n# Native build metadata differs.\n')
        cli('plugin', 'install', package, environment=clients[1])
        third_token, third = share(clients[1], 'sample://task-C')
        assert third['entities'][0]['renderer']['revision'] == old_revision
        with sqlite3.connect(database) as connection:
            assert connection.execute('SELECT count(*) FROM renderer_bundles').fetchone()[0] == 1

        # Removing a receipt mid-resolve must not discard the captured browser snapshot.
        started, release = tmp/'resolver-started', tmp/'resolver-release'
        waiting = resolver.replace("result={'schema_version'", f"""from pathlib import Path
import time
Path({str(started)!r}).touch()
while not Path({str(release)!r}).exists(): time.sleep(.02)
result={{'schema_version'""")
        (package/'resolver.py').write_text(waiting)
        cli('plugin', 'install', package, environment=clients[0])
        resolving = subprocess.Popen([str(BIN), 'share', 'sample://in-flight', '--format', 'json'],
                                     env=clients[0], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic()+15
            while not started.exists():
                assert time.monotonic() < deadline and resolving.poll() is None
                time.sleep(.02)
            cli('plugin', 'remove', 'sample', environment=clients[0])
            release.touch()
            output, error = resolving.communicate(timeout=30)
            assert resolving.returncode == 0, error
            flight_token = json.loads(output)['viewer_url'].rsplit('/', 1)[1]
            flight_scene = json.loads(api(f'/api/v1/scenes/{flight_token}')[1])
            assert flight_scene['entities'][0]['renderer']['revision'] == old_revision
            assert api(renderer_url(flight_token, flight_scene))[1] == old_html
        finally:
            release.touch()
            if resolving.poll() is None:
                resolving.kill()
                resolving.wait()
        (package/'resolver.py').write_text(resolver)
        cli('plugin', 'install', package, environment=clients[0])
        # Version is part of identity even when browser source bytes are unchanged.
        manifest = manifest.replace('version = "1.0.0"', 'version = "1.0.1"')
        (package/'blind-plugin.toml').write_text(manifest)
        cli('plugin', 'install', package, environment=clients[1])
        upgraded_token, upgraded = share(clients[1], 'sample://task-D', '--ttl', '0')
        new_revision = upgraded['entities'][0]['renderer']['revision']
        assert new_revision != old_revision
        assert api(old_url)[1] == old_html
        with sqlite3.connect(database) as connection:
            assert connection.execute('SELECT count(*) FROM renderer_bundles').fetchone()[0] == 2

        # Resharing keeps the exact implementation and stores component state.
        status, body, _ = api(f'/api/v1/scenes/{first_token}/share', {
            'meshes': [], 'state': first['state'],
            'entities': [{**{k: first['entities'][0].get(k) for k in ['id', 'position', 'size', 'visible', 'opacity']},
                          'state': {'selection': 'row-7'}}]})
        assert status == 200, body
        reshared_token = json.loads(body)['viewer_url'].rsplit('/', 1)[1]
        saved = json.loads(api(f'/api/v1/scenes/{reshared_token}')[1])
        assert saved['entities'][0]['state'] == {'selection': 'row-7'}
        assert saved['entities'][0]['renderer']['revision'] == old_revision

        # A local resolver can participate in a collection without server installation.
        collection = {'kind': 'collection', 'schema_version': 1, 'title': 'Two tasks', 'scenes': [
            {'id': 'a', 'title': 'A', 'uri': 'sample://collection-A'},
            {'id': 'b', 'title': 'B', 'uri': 'sample://collection-B'}]}
        collection_token, overview = share(clients[0], '--config', '-', input=json.dumps(collection))
        assert [part['id'] for part in overview['scenes']] == ['a', 'b']
        child = json.loads(api(f'/api/v1/scenes/{collection_token}?scene=a')[1])
        assert child['entities'][0]['renderer']['revision'] == old_revision
        assert api(renderer_url(collection_token, child, '?scene=a'))[1] == old_html

        status, png, _ = api(f'/i/{first_token}.png')
        assert status == 200, png[:300]
        image = Image.open(io.BytesIO(png)).convert('RGB')
        colored = sum(1 for r, g, b in zip(*(iter(image.tobytes()),)*3) if r > 150 and b > 150 and g < 70)
        assert colored > image.width*image.height*.03, 'client plugin missing from PNG'

        # Server rejects conflicting bundles before recording any scene or code.
        credential = json.loads((tmp/'client-0'/'client.json').read_text())['credential']
        bundle = json.loads(stored)
        other_version = {**bundle, 'version': '9.0.0'}
        status, _, _ = api('/api/v1/client/scenes', {
            'paths': ['oss://test/bucket/report.json'], 'display': [{'component': 'sample:panel'}],
            'renderers': [bundle, other_version]}, credential)
        assert status == 400
        malformed = {**bundle, 'documents': {'../outside.html': HTML}}
        assert api('/api/v1/client/scenes', {
            'paths': ['oss://test/bucket/report.json'], 'renderers': [malformed]}, credential)[0] == 400
        with sqlite3.connect(database) as connection:
            assert connection.execute('SELECT count(*) FROM renderer_bundles').fetchone()[0] == 2

        # Two active suffix handlers require an explicit selection, never load order.
        alternative = tmp/'alternative'
        alternative.mkdir()
        (alternative/'panel.html').write_text(HTML)
        (alternative/'blind-plugin.toml').write_text('''id = "alternative"
name = "Alternative"
version = "1.0.0"
authors = [{ name = "Blind integration tests" }]
files = ["panel.html"]
[[components]]
name = "panel"
entrypoint = "panel.html"
api_version = 1
extensions = ["report.json"]
''')
        cli('plugin', 'install', alternative, environment=clients[0])
        cli('share', 'oss://test/bucket/report.json', '--plugin', 'sample', '--plugin', 'alternative',
            environment=clients[0], ok=False)
        _, chosen = share(clients[0], 'oss://test/bucket/report.json', '--plugin', 'sample',
                          '--plugin', 'alternative', '--component', 'sample:panel')
        assert chosen['entities'][0]['renderer']['revision'] == old_revision

        cli('plugin', 'remove', 'sample', environment=clients[0])
        assert api(old_url)[1] == old_html, 'local uninstall broke an existing URL'
        assert api(f'/api/v1/scenes/{plain_token}')[0] == 200

        # Force expiry only in this isolated fixture, then exercise real maintenance.
        with sqlite3.connect(database) as connection:
            connection.execute('UPDATE scenes SET expires_at=? WHERE code!=?', (int(time.time())-1, upgraded_token))
        cli('doctor', '--clean-invalid')
        assert api(renderer_url(upgraded_token, upgraded))[1] == old_html
        with sqlite3.connect(database) as connection:
            rows = connection.execute('SELECT revision FROM renderer_bundles').fetchall()
            assert rows == [(new_revision,)], rows
        cli('leave', environment=clients[1])
        cli('doctor', '--clean-invalid')
        with sqlite3.connect(database) as connection:
            assert connection.execute('SELECT count(*) FROM renderer_bundles').fetchone()[0] == 0

        # The same package mechanism also resolves files on a registered local host.
        local_report = tmp/'local-report.json'
        local_report.write_bytes(REPORT)
        (package/'resolver.py').write_text("""import json,sys
r=json.loads(sys.stdin.readline())
result={'schema_version':1,'requires':['components.v1'],'resources':[],
'components':[{'id':'local','uri':r['params']['input'],'label':'Local report','component':'sample:panel'}]}
print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}))
""")
        cli('plugin', 'install', package)
        local_token, local_scene = share(server_env, 'sample://'+str(local_report))
        assert local_scene['entities'][0]['component'] == 'sample:panel'
        assert api('/'+local_scene['attachments'][0]['url'])[1] == REPORT
        assert api(renderer_url(local_token, local_scene))[1] == old_html
        partial = {'schema_version': 1, 'requires': ['components.v1', 'attachments'],
                   'resources': [], 'components': [
            {'id': 'report', 'uri': str(local_report), 'label': 'Local report', 'component': 'sample:panel'}],
            'attachments': [{'id': 'missing', 'uri': str(tmp/'absent.zip'), 'label': 'Missing archive'}]}
        partial_result = json.loads(cli('share', '--config', '-', '--format', 'json',
                                        input=json.dumps(partial)))
        assert partial_result['status'] == 'partial'
        partial_token = partial_result['viewer_url'].rsplit('/', 1)[1]
        partial_scene = json.loads(api(f'/api/v1/scenes/{partial_token}')[1])
        assert any(warning['code'] == 'ATTACHMENT_UNAVAILABLE' and warning['resource_id'] == 'missing'
                   for warning in partial_scene['warnings'])
        report_index = partial_scene['entities'][0]['source']['index']
        assert api('/'+partial_scene['attachments'][report_index]['url'])[1] == REPORT
        transient = resolver.replace("'oss://test/bucket/report.json'", "os.path.abspath('report.json')")
        transient = transient.replace("result={'schema_version'",
                                      f"open('report.json','w').write({REPORT.decode()!r})\nresult={{'schema_version'")
        (package/'resolver.py').write_text(transient)
        cli('share', 'sample://transient', '--plugin', package, ok=False)
        # Two 4 MiB documents are valid even though JSON framing exceeds 8 MiB.
        large_html = HTML + ' ' * (4 * 1024 * 1024 - len(HTML.encode()))
        large_bundle = {**bundle, 'id': 'large',
                        'components': [{**bundle['components'][0], 'name': name,
                                        'entrypoint': name+'.html', 'extensions': []}
                                       for name in ['first', 'second']],
                        'documents': {name+'.html': large_html for name in ['first', 'second']}}
        status, body, _ = api('/api/v1/client/scenes', {
            'paths': ['oss://test/bucket/report.json'], 'display': [{'component': 'large:first'}],
            'renderers': [large_bundle]}, credential)
        assert status == 200, body
        large_token = json.loads(body)['viewer_url'].rsplit('/', 1)[1]
        large_scene = json.loads(api(f'/api/v1/scenes/{large_token}')[1])
        assert api(renderer_url(large_token, large_scene))[1] == large_html.encode()
        # Browser uploads, including child uploads, share the bounded resolver admission pool.
        slot_dir = tmp/'slots'; slot_dir.mkdir()
        slot_release = tmp/'slots-release'
        slot_resolver = resolver.replace("result={'schema_version'", f"""from pathlib import Path
import time
(Path({str(slot_dir)!r})/str(os.getpid())).touch()
while not Path({str(slot_release)!r}).exists(): time.sleep(.02)
result={{'schema_version'""")
        (package/'resolver.py').write_text(slot_resolver)
        cli('plugin', 'install', package)
        admitted = []
        workers = [threading.Thread(target=lambda: admitted.append(api('/api/v1/client/scenes', {
            'paths': ['sample://admission']}, credential))) for _ in range(2)]
        for worker in workers:
            worker.start()
        try:
            deadline = time.monotonic()+15
            while len(list(slot_dir.iterdir())) != 2:
                assert time.monotonic() < deadline, admitted
                time.sleep(.02)
            upload = {'paths': ['oss://test/bucket/report.json'],
                      'display': [{'component': 'sample:panel'}], 'renderers': [bundle]}
            assert api('/api/v1/client/scenes', upload, credential)[0] == 429
            child_upload = {'collection': {'title': 'Admission', 'active_scene_id': 'a', 'scenes': [
                {'id': 'a', 'title': 'A', **upload}]}}
            assert api('/api/v1/client/scenes', child_upload, credential)[0] == 429
        finally:
            slot_release.touch()
            for worker in workers:
                worker.join(30)
        assert len(admitted) == 2 and all(result[0] == 200 for result in admitted), admitted
        cli('doctor', '--clear-all')
        with sqlite3.connect(database) as connection:
            assert connection.execute('SELECT count(*) FROM renderer_bundles').fetchone()[0] == 0
        print('PASS: unified local resolver/renderer, two-client CAS dedup, native independence, version pinning, URL isolation, collection, state, PNG, conflict rejection and last-reference GC')
    finally:
        server.terminate()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        log.close()
        storage.shutdown()

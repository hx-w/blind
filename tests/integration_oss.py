#!/usr/bin/env python3
"""Read-only S3 + real Blind CLI/HTTP contract test; no cloud credentials needed."""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = (ROOT / (sys.argv[1] if len(sys.argv) > 1 else 'target/debug') / 'blind').resolve()
PAYLOAD = (ROOT / 'tests/fixtures/tetra.ply').read_bytes()
KEY = 'folder/牙 +%.ply'
ACCOUNTS = {'key-a': 'secret-a', 'key-b': 'secret-b'}
state = {'mode': 'ok', 'payload': PAYLOAD, 'requests': []}
entered_read = threading.Event()
release_read = threading.Event()


class Storage(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        try:
            auth = self.headers['Authorization']
            assert auth.startswith('AWS4-HMAC-SHA256 ')
            fields = dict(x.split('=', 1) for x in auth.removeprefix('AWS4-HMAC-SHA256 ').split(', '))
            access, date, region, service, suffix = fields['Credential'].split('/')
            assert region == 'test-region' and service == 's3' and suffix == 'aws4_request'
            names = fields['SignedHeaders'].split(';')
            headers = ''.join(f'{name}:{" ".join(self.headers[name].split())}\n' for name in names)
            path = urllib.parse.urlsplit(self.path)
            canonical = '\n'.join(['GET', path.path, path.query, headers, fields['SignedHeaders'], self.headers['x-amz-content-sha256']])
            scope = '/'.join([date, region, service, suffix])
            signing = '\n'.join(['AWS4-HMAC-SHA256', self.headers['x-amz-date'], scope, hashlib.sha256(canonical.encode()).hexdigest()])
            key = ('AWS4' + ACCOUNTS[access]).encode()
            for part in [date, region, service, suffix]:
                key = hmac.new(key, part.encode(), hashlib.sha256).digest()
            assert hmac.compare_digest(fields['Signature'], hmac.new(key, signing.encode(), hashlib.sha256).hexdigest())
            bucket, key_path = urllib.parse.unquote(path.path).lstrip('/').split('/', 1)
            assert (access, bucket) in [('key-a', 'bucket-a'), ('key-b', 'bucket-b')]
            assert key_path == KEY
        except (AssertionError, KeyError, ValueError, AttributeError):
            self.send_error(403)
            return
        state['requests'].append((access, bucket, key_path))
        if state['mode'] == 'blocked':
            entered_read.set()
            assert release_read.wait(15), 'test read was not released'
        if state['mode'] in ['403', '404']:
            self.send_error(int(state['mode']))
            return
        if state['mode'] == 'redirect':
            self.send_response(302)
            self.send_header('Location', self.server.redirect_target)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('Content-Length', str(513 * 1024 * 1024 if state['mode'] == 'oversize' else len(state['payload'])))
        self.send_header('ETag', '"' + hashlib.md5(state['payload']).hexdigest() + '"')
        self.send_header('Last-Modified', 'Sat, 19 Sep 2026 00:00:00 GMT')
        self.end_headers()
        if state['mode'] != 'oversize':
            self.wfile.write(state['payload'])


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


with tempfile.TemporaryDirectory(prefix='blind-oss-test-') as temp:
    tmp = Path(temp).resolve()
    env = {**os.environ, 'BLIND_CONFIG_DIR': str(tmp/'server'), 'BLIND_CLIENT_DIR': str(tmp/'client')}
    origin = f'http://127.0.0.1:{free_port()}'
    storage = ThreadingHTTPServer(('127.0.0.1', 0), Storage)
    threading.Thread(target=storage.serve_forever, daemon=True).start()
    endpoint = f'http://127.0.0.1:{storage.server_port}'

    def run(*args, stdin=None, success=True):
        result = subprocess.run([str(BIN), *map(str, args)], input=stdin, text=True, capture_output=True, env=env, timeout=120)
        assert (result.returncode == 0) == success, result.stderr
        assert all(secret not in result.stdout + result.stderr for secret in ACCOUNTS.values())
        return result.stdout

    def api(path, token=None, body=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(origin+path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def set_alias(alias, access):
        run('oss', 'set', alias, stdin='\n'.join([endpoint, 'test-region', access, ACCOUNTS[access]])+'\n')

    def share(*paths, title='OSS test'):
        result = json.loads(run('share', *paths, '--title', title, '--format', 'json'))
        return result['viewer_url'].rsplit('/', 1)[1]

    run('init', '--host', origin)
    set_alias('prod', 'key-a')
    set_alias('archive', 'key-b')
    assert (tmp/'server/oss.json').stat().st_mode & 0o777 == 0o600
    listing = run('oss', 'list')
    assert 'prod' in listing and 'archive' in listing and 'key-a' not in listing
    pending = subprocess.Popen([str(BIN), 'oss', 'set', 'archive'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    assert pending.stderr.read(len('Endpoint: ')) == 'Endpoint: '
    run('oss', 'remove', 'prod')
    pending.communicate('\n'.join([endpoint, 'test-region', 'key-b', ACCOUNTS['key-b']])+'\n', timeout=15)
    assert pending.returncode == 0 and 'prod' not in run('oss', 'list')
    set_alias('prod', 'key-a')
    encoded = urllib.parse.quote(KEY)
    first = f'oss://prod/bucket-a/{encoded}'
    second = f'oss://archive/bucket-b/{encoded}'
    log = open(tmp/'server.log', 'w+')
    server = subprocess.Popen([str(BIN), 'serve', '--listen', origin.removeprefix('http://')], cwd=tmp, env=env, stdout=log, stderr=log)
    try:
        for _ in range(200):
            assert server.poll() is None, 'Blind exited'
            try:
                if api('/api/v1/health')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.1)
        else:
            raise AssertionError('Blind startup timed out')

        token = share(first, second, ROOT/'tests/fixtures/tetra.ply')
        mesh_url = f'/api/v1/scenes/{token}/meshes/0'
        status, data = api('/api/v1/scenes/'+token)
        assert status == 200
        scene = json.loads(data)
        assert len(scene['meshes']) == 3 and scene['meshes'][0]['name'] == '牙 +%.ply'
        assert all('path' not in m for m in scene['meshes'])
        assert api(mesh_url) == (200, PAYLOAD)
        assert api(mesh_url+'/lod')[0] == 200
        assert api(f'/api/v1/scenes/{token}/meshes/1') == (200, PAYLOAD)
        if json.loads(api('/api/v1/health')[1])['image_renderer']:
            status, png = api('/i/'+token+'.png')
            assert status == 200 and png.startswith(b'\x89PNG')
        assert set((x[0], x[1]) for x in state['requests']) == {('key-a', 'bucket-a'), ('key-b', 'bucket-b')}
        print('PASS: signed GET, separate credentials, encoded keys, mixed local/OSS, Raw/LOD/PNG')

        manifest = tmp/'scene.json'
        manifest.write_text(json.dumps({'resources': [{'path': first, 'label': 'Crown'}], 'title': 'Config test'}))
        result = json.loads(run('share', '--config', manifest, '--format', 'json'))
        assert result['resources'][0]['path'] == first
        pat = json.loads((tmp/'server/config.json').read_text())['pat']
        assert api('/api/v1/scenes', pat, {'paths': [first]})[0] == 200
        (tmp/'local.ply').write_bytes(PAYLOAD)
        assert api('/api/v1/scenes', pat, {'paths': ['local.ply', first]})[0] == 200
        state['mode'] = '403'
        assert api(mesh_url)[0] == 503
        audit = json.loads(api('/api/v1/control/doctor', pat)[1])
        assert audit['unavailable'] > 0
        state['mode'] = 'ok'
        assert api(mesh_url) == (200, PAYLOAD)
        state['mode'] = 'redirect'
        storage.redirect_target = endpoint+'/bucket-a/'+encoded
        before = len(state['requests'])
        assert api(mesh_url)[0] == 503 and len(state['requests']) == before+1
        state['mode'] = 'ok'
        # Rotation is read without a restart; invalid credentials remain recoverable.
        set_alias('prod', 'key-b')
        assert api(mesh_url)[0] == 503
        set_alias('prod', 'key-a')
        assert api(mesh_url)[0] == 200
        print('PASS: config/API creation, transient 403 and credential rotation recover without tombstoning')

        client = json.loads((tmp/'client/client.json').read_text())
        assert api('/api/v1/client/oss')[0] == 401
        catalog = json.loads(api('/api/v1/client/oss', client['credential'])[1])
        assert catalog['can_share'] and len(catalog['stores']) == 2
        assert all(set(x) == {'alias', 'endpoint', 'region'} for x in catalog['stores'])
        with sqlite3.connect(tmp/'server/sources.sqlite3') as db:
            record = json.loads(db.execute('SELECT record FROM sources WHERE id=?', (client['source']['id'],)).fetchone()[0])
            record['local'] = False
            db.execute('UPDATE sources SET record=? WHERE id=?', (json.dumps(record), record['id']))
        before = len(state['requests'])
        status, _ = api('/api/v1/client/scenes', client['credential'], {'paths': [first]})
        assert status == 401 and before == len(state['requests'])
        catalog = json.loads(api('/api/v1/client/oss', client['credential'])[1])
        assert not catalog['can_share'] and len(catalog['stores']) == 2
        client['source']['local'] = False
        (tmp/'client/client.json').write_text(json.dumps(client))
        assert 'prod' in run('oss', 'list')
        client['source']['local'] = True
        (tmp/'client/client.json').write_text(json.dumps(client))
        with sqlite3.connect(tmp/'server/sources.sqlite3') as db:
            record['local'] = True
            db.execute('UPDATE sources SET record=? WHERE id=?', (json.dumps(record), record['id']))
        print('PASS: remote Clients cannot use Server OSS credentials')

        blocked_token = share(first, title='revocation-during-read')
        state['mode'] = 'blocked'
        received = []
        reader = threading.Thread(target=lambda: received.append(api(f'/api/v1/scenes/{blocked_token}/meshes/0')[0]))
        reader.start()
        assert entered_read.wait(15)
        with sqlite3.connect(tmp/'server/sources.sqlite3') as db:
            record['active'] = False
            db.execute('UPDATE sources SET record=? WHERE id=?', (json.dumps(record), record['id']))
        release_read.set()
        reader.join(15)
        assert received == [410]
        with sqlite3.connect(tmp/'server/sources.sqlite3') as db:
            record['active'] = True
            db.execute('UPDATE sources SET record=? WHERE id=?', (json.dumps(record), record['id']))
        state['mode'] = 'ok'
        print('PASS: concurrent alias edits preserve removals; in-flight reads honor Client revocation')

        state['mode'] = 'oversize'
        assert api(mesh_url)[0] == 410
        state['mode'] = 'ok'
        token = share(first, title='content-change')
        assert api(f'/api/v1/scenes/{token}/meshes/0/lod')[0] == 200
        state['payload'] = PAYLOAD.replace(b'0 0 0', b'9 0 0', 1)
        assert state['payload'] != PAYLOAD and len(state['payload']) == len(PAYLOAD)
        assert api(f'/api/v1/scenes/{token}/meshes/0/lod')[0] == 410
        state['payload'] = PAYLOAD
        token = share(first, title='deletion')
        state['mode'] = '404'
        assert api(f'/api/v1/scenes/{token}/meshes/0')[0] == 410
        state['mode'] = 'ok'
        token = share(first, title='alias-removal')
        run('oss', 'remove', 'prod')
        assert api(f'/api/v1/scenes/{token}/meshes/0')[0] == 410
        assert 'archive' in run('oss', 'list')
        print('PASS: oversized replacement, same-size mutation, 404 and alias removal invalidate shares')
    finally:
        release_read.set()
        server.terminate()
        server.wait(timeout=20)
        storage.shutdown()
        log.close()

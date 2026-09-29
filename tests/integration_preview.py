#!/usr/bin/env python3
"""Read link previews like a crawler: real HTTP, no JavaScript or authentication."""
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / (sys.argv[1] if len(sys.argv) > 1 else 'target/debug') / 'blind'


class Head(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.meta = {}
        self.assets = []
        self.title = ''
        self.in_title = False
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('src'):
            self.assets.append(attrs['src'])
        if tag == 'link' and attrs.get('rel') in ['stylesheet', 'modulepreload']:
            self.assets.append(attrs['href'])
        if tag == 'meta':
            key = attrs.get('property', attrs.get('name'))
            if key:
                assert key not in self.meta, f'duplicate metadata: {key}'
                self.meta[key] = attrs.get('content')
        if tag == 'title':
            self.in_title = True

    def handle_endtag(self, tag):
        if tag == 'title': self.in_title = False

    def handle_data(self, data):
        if self.in_title: self.title += data


for base in ['', '/blind']:
    with tempfile.TemporaryDirectory(prefix='blind-preview-') as directory:
        tmp = Path(directory)
        env = {**os.environ, 'BLIND_CONFIG_DIR': str(tmp/'server'), 'BLIND_CLIENT_DIR': str(tmp/'client')}
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'

        def cli(*args):
            result = subprocess.run([str(BIN), *map(str, args)], env=env, capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stderr
            return result.stdout

        def get(path, headers=None):
            address = path if path.startswith('http://') else origin + base + path
            request = urllib.request.Request(address, headers=headers or {})
            try:
                with urllib.request.urlopen(request, timeout=90) as response:
                    return response.status, response.read(), response.headers
            except urllib.error.HTTPError as error:
                return error.code, error.read(), error.headers

        cli('init', '--host', origin)
        config_path = tmp/'server/config.json'
        config = json.loads(config_path.read_text())
        config['base_path'] = base
        config_path.write_text(json.dumps(config))
        with (tmp/'server.log').open('w') as log:
            server = subprocess.Popen([str(BIN), 'serve', '--listen', f'127.0.0.1:{port}'], env=env, stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        if get('/api/v1/health')[0] == 200: break
                    except OSError: pass
                    time.sleep(.1)
                else: raise AssertionError('server not ready')
                status, body, _ = get('/')
                home = Head(body.decode())
                assert status == 200 and home.meta.get('description'), 'home lacks a crawler description'
                assert home.meta['og:title'] == home.title == 'Blind'
                mesh = tmp/'private-source.ply'
                mesh.write_bytes((ROOT/'tests/fixtures/tetra.ply').read_bytes())
                title = '对比 "A&B" <测试>\n第二行说明 </title><script>alert(1)</script>'
                share = json.loads(cli('share', mesh, '--title', title, '--format', 'json'))
                token = share['viewer_url'].rsplit('/', 1)[1]
                viewer = f'{origin}{base}/s/{token}'
                status, body, headers = get(f'/s/{token}?owner=not-public&render=1', {
                    'User-Agent': 'LinkPreviewTest/1.0', 'Origin': 'https://untrusted.invalid',
                    'X-Forwarded-Host': 'untrusted.invalid', 'X-Forwarded-Proto': 'https'})
                head = Head(body.decode())
                assert status == 200 and 'no-store' in headers['Cache-Control']
                assert "default-src 'self'" in headers['Content-Security-Policy']
                assert head.title == head.meta['og:title'] == '对比 "A&B" <测试> · Blind'
                assert head.meta['og:description'] == head.meta['description']
                assert '第二行说明' in head.meta['description'] and '1 个资源' in head.meta['description']
                assert not any(text in head.meta['description'] for text in ['410', '正在读取', '场景已失效'])
                assert head.meta['og:url'] == viewer
                assert head.meta['og:image'] == share['image_url']
                assert head.meta['twitter:image'] == share['image_url']
                assert head.meta['twitter:card'] == 'summary_large_image'
                assert '<测试>' not in body.decode() and '&lt;测试&gt;' in body.decode()
                assert '<script>alert(1)</script>' not in body.decode()
                assert '&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;' in body.decode()
                assert all(secret not in json.dumps(head.meta) for secret in [str(mesh), config['pat'], share['owner_url'].split('#owner=')[1], 'not-public', 'untrusted.invalid'])
                assert head.assets, 'viewer has no built assets'
                for asset in head.assets:
                    address = urllib.parse.urljoin(origin + base + '/', asset)
                    assert urllib.parse.urlsplit(address).path.startswith(base + '/assets/'), f'asset escapes the viewer mount: {asset}'
                    assert get(address)[0] == 200, f'viewer asset is unreachable: {address}'
                image_status, image, image_headers = get(head.meta['og:image'])
                assert image_status == 200 and image.startswith(b'\x89PNG') and image_headers['Content-Type'] == 'image/png', (image_status, image[:300])
                long_share = json.loads(cli('share', mesh, '--title', '长' * 300, '--format', 'json'))
                long_code = long_share['viewer_url'].rsplit('/', 1)[1]
                long_head = Head(get(f'/s/{long_code}')[1].decode())
                assert long_head.title == '长' * 100 + '… · Blind'
                assert long_head.meta['description'].endswith('长' * 160 + '…')
                collection = {'kind':'collection','schema_version':1,'title':'集合标题','scenes':[
                    {'id':'first','title':'第一场景','resources':[{'path':str(mesh)}]},
                    {'id':'second','title':'第二场景','resources':[{'path':str(mesh)}]}]}
                manifest = tmp/'collection.json'; manifest.write_text(json.dumps(collection))
                shared = json.loads(cli('share', '--config', manifest, '--format', 'json'))
                code = shared['viewer_url'].rsplit('/', 1)[1]
                whole = Head(get(f'/s/{code}')[1].decode())
                child = Head(get(f'/s/{code}?scene=second&embedded=1')[1].decode())
                assert whole.meta['og:title'] == '集合标题 · Blind' and '2 个场景' in whole.meta['description']
                assert whole.meta['og:image'] == shared['image_url']
                first = Head(get(f'/s/{code}?scene=first')[1].decode())
                assert first.meta['og:title'] == '第一场景 · Blind' and '1 个资源' in first.meta['description']
                assert '2 个场景' not in first.meta['description']
                assert child.meta['og:title'] == '第二场景 · Blind'
                assert child.meta['og:url'] == shared['scenes'][1]['viewer_url']
                assert child.meta['og:image'] == shared['scenes'][1]['image_url']
                assert get(f'/s/{code}?scene=missing')[0] == 404
                assert get('/s/not-a-valid-token')[0] == 404
                mesh.unlink()
                # Source validation marks a deleted file gone; subsequent HTML must not advertise it.
                assert get(f'/api/v1/scenes/{token}/meshes/0')[0] == 410
                status, gone, _ = get(f'/s/{token}')
                assert status == 410 and 'og:image' not in gone.decode()
                print(f'PASS: crawler metadata, escaping, private fields, image, collection, errors, base={base or "/"}')
            finally:
                server.terminate()
                server.wait(timeout=15)

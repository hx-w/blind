#!/usr/bin/env python3
"""Exercise collection sharing through the real CLI, server, and image route."""
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / (sys.argv[1] if len(sys.argv) > 1 else 'target/debug') / 'blind'

with tempfile.TemporaryDirectory(prefix='blind-collection-') as directory:
    temp = Path(directory)
    env = {**os.environ, 'BLIND_CONFIG_DIR': str(temp / 'server'), 'BLIND_CLIENT_DIR': str(temp / 'client')}
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'

    def cli(*args, input=None, ok=True):
        result = subprocess.run([str(BIN), *map(str, args)], env=env, input=input, text=True, capture_output=True, timeout=90)
        assert (result.returncode == 0) == ok, result.stderr
        return result.stdout if ok else result.stderr

    def api(path, body=None):
        request = urllib.request.Request(origin + path, data=json.dumps(body).encode() if body is not None else None,
                                         headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    cli('init', '--host', origin)
    log = (temp / 'server.log').open('w')
    server = subprocess.Popen([str(BIN), 'serve', '--listen', f'127.0.0.1:{port}'], env=env, stdout=log, stderr=log)
    try:
        for _ in range(100):
            try:
                if api('/api/v1/health')[0] == 200:
                    break
            except OSError:
                time.sleep(.1)
        else:
            raise AssertionError('server not ready')
        assert json.loads(api('/api/v1/health')[1])['scene_schema'] == 6

        fixture = ROOT / 'tests/fixtures/tetra.ply'
        second = temp / 'second.ply'
        second.write_bytes(fixture.read_bytes().replace(b'0.8', b'1.8'))
        config = {
            'kind': 'collection', 'schema_version': 1, 'title': 'Review pair', 'active_scene_id': 'design',
            'scenes': [
                {'id': 'design', 'title': 'Design', 'resources': [{'path': str(fixture), 'label': 'Crown'}]},
                {'id': 'scan', 'title': 'Scan', 'resources': [{'path': str(second), 'label': 'Reference'}]},
            ],
        }
        oversized = temp / 'oversized.json'
        with oversized.open('wb') as stream:
            stream.truncate(4 * 1024 * 1024 + 1)
        assert 'exceeds 4 MiB' in cli('share', '--config', oversized, ok=False)
        shared = json.loads(cli('share', '--config', '-', '--format', 'json', input=json.dumps(config)))
        assert shared['kind'] == 'collection' and len(shared['scenes']) == 2
        token = shared['viewer_url'].rsplit('/', 1)[1]
        assert shared['scenes'][1]['viewer_url'] == f'{origin}/s/{token}?scene=scan'
        assert shared['scenes'][1]['image_url'] == f'{origin}/i/{token}.png?scene=scan'
        overview = json.loads(api(f'/api/v1/scenes/{token}')[1])
        assert overview['title'] == 'Review pair' and overview['active_scene_id'] == 'design'
        assert [part['id'] for part in overview['scenes']] == ['design', 'scan']
        design = json.loads(api(f'/api/v1/scenes/{token}?scene=design')[1])
        scan = json.loads(api(f'/api/v1/scenes/{token}?scene=scan')[1])
        assert design['meshes'][0]['label']['text'] == 'Crown'
        assert scan['meshes'][0]['label']['text'] == 'Reference'
        assert design['meshes'][0]['source_url'].endswith('?scene=design')
        assert api(f'/api/v1/scenes/{token}/meshes/0?scene=scan')[1] == second.read_bytes()
        assert api(f'/api/v1/scenes/{token}?scene=missing')[0] == 404

        def update(part, color, shading):
            part['state']['shading'] = shading
            part['state']['focused_component_id'] = part['components'][0]['id']
            return {'state': part['state'], 'meshes': [{
                'color': color, 'opacity': 1, 'visible': True, 'quality': 'raw'
            }]}

        status, response, _ = api(f'/api/v1/scenes/{token}/share', {
            'active_scene_id': 'scan',
            'updates': {'design': update(design, '#ff0000', 'wire'), 'scan': update(scan, '#00ff00', 'smooth')},
        })
        assert status == 200, response
        new_token = json.loads(response)['viewer_url'].rsplit('/', 1)[1]
        new_overview = json.loads(api(f'/api/v1/scenes/{new_token}')[1])
        assert new_overview['active_scene_id'] == 'scan'
        new_design = json.loads(api(f'/api/v1/scenes/{new_token}?scene=design')[1])
        new_scan = json.loads(api(f'/api/v1/scenes/{new_token}?scene=scan')[1])
        assert (new_design['meshes'][0]['color'], new_design['state']['shading']) == ('#ff0000', 'wire')
        assert (new_scan['meshes'][0]['color'], new_scan['state']['shading']) == ('#00ff00', 'smooth')
        assert new_scan['state']['focused_component_id'] == scan['components'][0]['id']
        assert json.loads(api(f'/api/v1/scenes/{token}')[1])['active_scene_id'] == 'design'
        status, png, _ = api(f'/i/{new_token}.png?scene=scan')
        assert status == 200, png
        assert Image.open(io.BytesIO(png)).size == (1200, 900)
        status, composite, headers = api(f'/i/{new_token}.png')
        assert status == 200 and headers['Content-Type'] == 'image/png', composite
        image = Image.open(io.BytesIO(composite)).convert('RGB')
        assert image.size == (1944, 780)
        assert image.getpixel((976, 8)) == (103, 167, 224), 'active scene header is missing'
        assert image.crop((8, 52, 968, 772)).getcolors(maxcolors=10) is None, 'first scene image is blank'
        assert image.crop((976, 52, 1936, 772)).getcolors(maxcolors=10) is None, 'second scene image is blank'

        second.write_bytes(second.read_bytes() + b'\n')
        assert api(f'/api/v1/scenes/{new_token}/meshes/0?scene=scan')[0] == 410
        assert api(f'/api/v1/scenes/{new_token}/meshes/0?scene=design')[0] == 200
        assert api(f'/api/v1/scenes/{new_token}')[0] == 200
        assert cli('share', '--config', '-', '--stateless', input=json.dumps(config), ok=False).find('short link') >= 0
        cli('leave')
        assert api(f'/api/v1/scenes/{token}')[0] == 410
        assert api(f'/s/{new_token}')[0] == 410
        assert api(f'/i/{new_token}.png')[0] == 410
        assert api(f'/api/v1/scenes/{new_token}/share', {'active_scene_id': 'scan', 'updates': {}})[0] == 410
        print('PASS: bounded config, collection CLI stdin, independent resources/state, composite and child PNGs, immutable reshare, child failure isolation and revocation')
    finally:
        server.terminate()
        server.wait(timeout=15)
        log.close()

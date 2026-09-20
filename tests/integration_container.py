#!/usr/bin/env python3
"""Exercise the packaged Chromium under the supported Docker security profile."""
import io
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
image = sys.argv[1] if len(sys.argv) > 1 else 'blind-component-test'

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()

container = docker(
    'run', '--detach', '--rm', '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--security-opt', f'seccomp={ROOT / "deploy/seccomp-chromium.json"}',
    '--memory', '4g', '--cpus', '4',
    '--tmpfs', '/tmp:size=256m,mode=1777',
    '--tmpfs', '/config:size=32m,uid=1000,gid=1000,mode=700',
    '--publish', '127.0.0.1::7400', '--entrypoint', '/bin/sh', image, '-c',
    'blind init >/dev/null && printf "%s" "<!doctype html><body style=background:magenta>Container export</body>" >/tmp/report.html && exec blind serve',
)
try:
    port = docker('port', container, '7400/tcp').rsplit(':', 1)[1]
    origin = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try:
            with urllib.request.urlopen(origin + '/api/v1/health', timeout=2) as response:
                assert response.status == 200
                break
        except OSError:
            time.sleep(.2)
    else:
        raise AssertionError('container server did not start')
    shared = json.loads(docker('exec', container, 'blind', 'share', '/tmp/report.html', '--format', 'json'))
    token = shared['viewer_url'].rsplit('/', 1)[1]
    with urllib.request.urlopen(f'{origin}/i/{token}.png', timeout=90) as response:
        assert response.status == 200
        png = Image.open(io.BytesIO(response.read())).convert('RGB')
    pixels = sum(1 for r, g, b in zip(*(iter(png.tobytes()),) * 3) if r > 180 and b > 180 and g < 70)
    assert pixels > png.width * png.height * .03, 'HTML missing from Docker PNG'
    print('PASS: non-root Docker PNG export with Chromium sandbox, seccomp and resource limits')
except Exception:
    print(docker('logs', '--tail', '30', container), file=sys.stderr)
    raise
finally:
    docker('stop', '--time', '10', container)

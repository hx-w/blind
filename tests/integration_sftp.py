#!/usr/bin/env python3
"""Isolated HTTP + real OpenSSH regression test. Never edits system SSH configuration or user keys.
Run after cargo build: python3 tests/integration_sftp.py [target/debug]
"""
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = (ROOT / (sys.argv[1] if len(sys.argv) > 1 else 'target/debug')).resolve()


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def run(args, env=None, input=None):
    result = subprocess.run([str(a) for a in args], input=input, text=True, capture_output=True, env=env, timeout=180)
    if result.returncode:
        raise AssertionError(f'{args[0]} {args[1]} failed: {result.stderr}')
    return result.stdout


with tempfile.TemporaryDirectory(prefix='blind-sftp-test-') as tmp:
    tmp = Path(tmp).resolve()
    env = {**os.environ, 'BLIND_CONFIG_DIR': str(tmp/'server'), 'BLIND_CLIENT_DIR': str(tmp/'client')}
    web_port, ssh_port = port(), port()
    origin = f'http://127.0.0.1:{web_port}'
    run([BIN/'blind', 'init', '--host', origin], env)
    # Keep credentials in memory; never print them or a generated scene URL.
    server_config = json.loads((tmp/'server/config.json').read_text())
    processes = []
    logs = []

    def api(path, token=None, body=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(origin+path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
                return r.status, json.loads(data) if 'json' in r.headers.get('Content-Type', '') else data
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def start(args, name, environment=env):
        log = open(tmp/(name+'.log'), 'w+')
        logs.append(log)
        proc = subprocess.Popen([str(a) for a in args], env=environment, stdout=log, stderr=log)
        processes.append(proc)
        return proc

    try:
        server = start([BIN/'blind', 'serve', '--listen', f'127.0.0.1:{web_port}'], 'server')
        for _ in range(100):
            if server.poll() is not None:
                raise AssertionError('server exited during startup')
            try:
                if api('/api/v1/health')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.1)
        else:
            raise AssertionError('server startup timed out')

        mesh = tmp/'tetra.ply'
        shutil.copyfile(ROOT/'tests/fixtures/tetra.ply', mesh)
        output = json.loads(run([BIN/'blind', 'share', mesh, '--label', '1=Test mesh', '--format', 'json'], env))
        assert output['viewer_url'].startswith(origin+'/s/')
        assert output['image_url'].startswith(origin+'/i/')
        assert len(output['viewer_url'].rsplit('/', 1)[1]) == 6
        import re
        status, html = api('/')
        assets = re.findall(rb'(?:src|href)="(/assets/[^"]+)"', html)
        assert assets and all(api(a.decode())[0] == 200 for a in assets), 'viewer assets must be served at the root'
        stateless = json.loads(run([BIN/'blind', 'share', mesh, '--stateless', '--format', 'json'], env))
        assert stateless['viewer_url'].startswith(origin+'/v/')
        token = output['viewer_url'].rsplit('/', 1)[1]
        status, scene = api('/api/v1/scenes/'+token)
        assert status == 200 and scene['source']['user'] == pwd.getpwuid(os.getuid()).pw_name
        assert 'path' not in scene['meshes'][0]
        assert api('/api/v1/scenes/'+token+'/meshes/0/lod')[0] == 200
        assert api('/api/v1/scenes/'+token+'/meshes/0')[1] == mesh.read_bytes()
        if api('/api/v1/health')[1]['image_renderer']:
            status, png = api('/i/'+token+'.png')
            assert status == 200 and png.startswith(b'\x89PNG')
        print('PASS: same-host Client registration, unchanged URLs, source metadata, Raw/LOD/PNG')

        sshd = shutil.which('sshd') or '/usr/sbin/sshd'
        sftp_server = next(p for p in ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server'] if Path(p).is_file())
        run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', tmp/'host_key'])
        username = pwd.getpwuid(os.getuid()).pw_name
        authorized = tmp/'authorized_keys'
        authorized.touch(mode=0o600)
        ssh_config = tmp/'sshd_config'
        ssh_config.write_text(f'''Port {ssh_port}
ListenAddress 127.0.0.1
HostKey {tmp}/host_key
PidFile {tmp}/sshd.pid
AuthorizedKeysFile {authorized}
StrictModes no
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
AllowUsers {username}
Subsystem sftp {sftp_server}
LogLevel VERBOSE
''')
        ssh = start([sshd, '-D', '-e', '-f', ssh_config], 'sshd')
        time.sleep(.4)
        if ssh.poll() is not None:
            raise AssertionError('isolated sshd could not start: '+(tmp/'sshd.log').read_text())

        def register(name):
            invitation = run([BIN/'blind', 'invite', '--host', origin], env).strip()
            import base64
            envelope = json.loads(base64.urlsafe_b64decode(invitation[7:]+'='*(-len(invitation[7:])%4)))
            request = {'name': name, 'host':'127.0.0.1', 'port':ssh_port, 'user':username, 'host_key':(tmp/'host_key.pub').read_text().split()[1]}
            status, receipt = api('/api/v1/clients/join', envelope['token'], request)
            assert status == 200, receipt
            assert api('/api/v1/clients/join', envelope['token'], request)[0] != 200
            assert api('/api/v1/client/scenes', receipt['credential'], {'paths':[str(mesh)]})[0] == 401
            return receipt

        a, b = register('User A'), register('User B')
        assert a['credential'] != b['credential'] and a['source']['id'] != b['source']['id']
        probe = tmp/'probe'
        probe.write_text(a['challenge'])
        # An unrestricted SFTP key must fail activation even though reading works.
        authorized.write_text(a['public_key']+'\n')
        status, error = api('/api/v1/client/activate', a['credential'], {'challenge_path':str(probe)})
        assert status == 400 and 'writable' in error['error'], error
        authorized.write_text(''.join(f'restrict,command="{sftp_server} -R" {r["public_key"]}\n' for r in [a,b]))
        for receipt in [a,b]:
            probe.write_text(receipt['challenge'])
            status, result = api('/api/v1/client/activate', receipt['credential'], {'challenge_path':str(probe),'host':'127.0.0.1','port':ssh_port})
            assert status == 200, result
        print('PASS: one-use invitations, independent identities, writable-key rejection, verified read-only SFTP')

        status, output = api('/api/v1/client/scenes', a['credential'], {'paths':[str(mesh)], 'source_id':b['source']['id']})
        assert status == 200, output
        assert output['source']['id'] == a['source']['id']
        token = output['viewer_url'].rsplit('/', 1)[1]
        assert api('/api/v1/scenes/'+token+'/meshes/0/lod')[0] == 200
        assert api('/api/v1/scenes/'+token+'/meshes/0')[1] == mesh.read_bytes()
        if api('/api/v1/health')[1]['image_renderer']:
            assert api('/i/'+token+'.png')[0] == 200
        print('PASS: source ownership cannot be overridden; remote Raw/LOD/PNG use the actual SFTP source')

        # Closing the listener does not kill existing SSH children. Close them by disabling the
        # source endpoint in the private test registry to force an independently unreachable route.
        import sqlite3
        db = sqlite3.connect(tmp/'server/sources.sqlite3')
        record = json.loads(db.execute('SELECT record FROM sources WHERE id=?',(a['source']['id'],)).fetchone()[0])
        record['port'] = port()
        db.execute('UPDATE sources SET record=? WHERE id=?',(json.dumps(record),a['source']['id']));db.commit()
        # Restart releases pooled SSH sessions while preserving source/scene registrations.
        server.terminate();server.wait(timeout=15)
        server = start([BIN/'blind','serve'], 'server-restarted')
        for _ in range(100):
            try:
                if api('/api/v1/health')[0] == 200: break
            except OSError: pass
            time.sleep(.1)
        assert api('/api/v1/scenes/'+token+'/meshes/0/lod')[0] == 503
        status, report = api('/api/v1/control/doctor/clean-invalid',server_config['pat'],{})
        assert status == 200 and report['unavailable'] >= 1 and report['removed'] == 0, report
        record['port'] = ssh_port
        db.execute('UPDATE sources SET record=? WHERE id=?',(json.dumps(record),a['source']['id']));db.commit()
        assert api('/api/v1/scenes/'+token)[0] == 200
        assert api('/api/v1/client/revoke',a['credential'],{})[0] == 200
        assert api('/api/v1/scenes/'+token+'/meshes/0/lod')[0] == 410
        assert api('/api/v1/client',b['credential'])[0] == 200
        print('PASS: offline 503, doctor preserves unavailable scenes, restart recovery, per-source revocation')
        oversized = tmp/'oversized.ply'
        shutil.copyfile(mesh, oversized)
        status, changed = api('/api/v1/client/scenes', b['credential'], {'paths':[str(oversized)]})
        assert status == 200, changed
        changed_token = changed['viewer_url'].rsplit('/', 1)[1]
        with oversized.open('r+b') as f: f.truncate(512*1024*1024+1)
        assert api('/api/v1/scenes/'+changed_token)[0] == 410
        assert api('/api/v1/client/scenes', b['credential'], {'paths':[str(oversized)]})[0] == 422
        shutil.copyfile(mesh, oversized)
        assert api('/api/v1/scenes/'+changed_token)[0] == 410
        print('PASS: oversized replacement permanently invalidates its old URL')

        mesh.write_bytes(mesh.read_bytes().replace(b'ply',b'PLy',1))
        local_token = json.loads(run([BIN/'blind','share',mesh,'--format','json'],env))['viewer_url'].rsplit('/',1)[1]
        mesh.unlink()
        assert api('/api/v1/scenes/'+local_token)[0] == 410
        print('PASS: confirmed source deletion invalidates links')
        db.close()
    finally:
        for proc in reversed(processes):
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=15)
                except subprocess.TimeoutExpired: proc.kill();proc.wait()
        for log in logs: log.close()

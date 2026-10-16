#!/usr/bin/env python3
"""Redacted pre-publication scan. Reports locations and rule names, never values."""
import argparse
from pathlib import Path
import io
import json
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXCLUDED = {'.git', 'node_modules', '.next', '.vinext', '.wrangler', '.sites-runtime',
            'dist', 'outputs', 'output', '.profile', '.data', 'private-audit', '__pycache__'}
RESOURCE_KEYS = {'account_id', 'database_id', 'project_id'}
PLACEHOLDERS = {'', '00000000-0000-4000-8000-000000000000'}
RULES = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{40,})\b'),
    'provider-key': re.compile(r'\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{25,}|AKIA[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35})\b'),
    'signed-session': re.compile(r'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\b'),
    'personal-home-path': re.compile(r'/(?:Users|home)/[A-Za-z0-9_.-]+/|/var/' r'folders/'),
    'production-query-link': re.compile(r'(?:\?query=|query%3D)[0-9a-f-]{36}'),
    'personal-email': re.compile(r'(?<![:/])\b[A-Za-z0-9._%+-]+@(?!(?:[A-Za-z0-9.-]+\.)?(?:example(?:\.(?:com|org|net))?|test|invalid)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
}
findings = []
def report(path, rule, line=1, revision='working'):
    findings.append({'path': path, 'line': line, 'rule': rule, 'revision': revision})
def forbidden_path(path):
    p = Path(path)
    name = p.name.lower()
    return (any(part in {'.profile', '.data', '.wrangler', 'browser-profile'} for part in p.parts)
            or name in {'probe-result.json', 'cookies.json', 'storage-state.json', 'auth-state.json'}
            or name.endswith(('.sqlite', '.sqlite3', '.db', '.har', '.log', '.pem', '.p12', '.pfx'))
            or ((name.startswith('.env') or name.startswith('.dev.vars')) and not name.endswith('.example'))
            or name.endswith('.local.json'))
def resource_values(value):
    if isinstance(value, dict):
        for k, v in value.items():
            if k in RESOURCE_KEYS and v is not None and str(v) not in PLACEHOLDERS:
                yield k
            yield from resource_values(v)
    elif isinstance(value, list):
        for v in value:
            yield from resource_values(v)
def scan(path, data, revision='working', archive=False):
    if forbidden_path(path):
        report(path, 'private-runtime-file', revision=revision)
    if data.startswith(b'PK\x03\x04'):
        if not archive:
            report(path, 'tracked-binary-archive', revision=revision)
            return
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for item in z.infolist():
                    if item.file_size > 8_000_000 or item.compress_size and item.file_size / item.compress_size > 1000:
                        report(path, 'unexpected-archive-entry', revision=revision)
                    elif not item.is_dir():
                        scan(path+'!'+item.filename, z.read(item), revision)
        except zipfile.BadZipFile:
            report(path, 'invalid-archive', revision=revision)
        return
    if b'\0' in data[:8000]:
        return
    try:
        text = data.decode('utf8')
    except UnicodeDecodeError:
        return
    for name, pattern in RULES.items():
        for m in pattern.finditer(text):
            report(path, name, text.count('\n', 0, m.start())+1, revision)
    if path.endswith('.json'):
        try:
            for key in resource_values(json.loads(text)):
                report(path, 'configured-'+key, revision=revision)
        except json.JSONDecodeError:
            pass

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], stderr=subprocess.DEVNULL)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history', action='store_true')
    parser.add_argument('--artifacts', action='store_true')
    args = parser.parse_args()
    try:
        files = sorted(set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').decode().split('\0'))-{''})
    except subprocess.CalledProcessError:
        files = [str(p.relative_to(ROOT)) for p in ROOT.rglob('*') if p.is_file() and not set(p.relative_to(ROOT).parts)&EXCLUDED and not p.name.endswith('.local.json')]
    checked = 0
    for name in files:
        path = ROOT/name
        if path.is_symlink():
            report(name, 'tracked-symlink')
        elif path.is_file():
            scan(name, path.read_bytes())
            checked += 1
    if args.history:
        try:
            rows = git('rev-list', '--objects', '--all').decode().splitlines()
        except subprocess.CalledProcessError:
            rows = []
        for row in rows:
            sha, _, path = row.partition(' ')
            if path and git('cat-file', '-t', sha).strip() == b'blob':
                scan(path, git('cat-file', 'blob', sha), sha[:12])
    if args.artifacts:
        artifacts = [ROOT/'public/downloads/rail-helper.zip', *ROOT.glob('outputs/*浏览器扩展*.zip')]
        for path in artifacts:
            if path.is_file():
                scan(str(path.relative_to(ROOT)), path.read_bytes(), 'artifact', archive=True)
    for item in findings:
        print(json.dumps(item, ensure_ascii=False))
    print(json.dumps({'checkedFiles': checked, 'findings': len(findings), 'history': args.history, 'artifacts': args.artifacts}))
    return 1 if findings else 0

if __name__ == '__main__':
    sys.exit(main())

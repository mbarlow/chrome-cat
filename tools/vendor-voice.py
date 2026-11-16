#!/usr/bin/env python3
"""Fetch/verify the exact voice assets locked in vendor/voice/sources.json."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent / 'vendor' / 'voice'


def check(item):
    path = ROOT / item['path']
    expected = item['sha256']
    if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
        return
    if '--fetch' not in sys.argv:
        raise RuntimeError(f'{path}: missing or checksum mismatch; run make vendor-voice')
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.part')
    try:
        subprocess.run(['curl', '-fsSL', '--retry', '2', '--max-time', '180', item['url'], '-o', str(temp)], check=True)
        if hashlib.sha256(temp.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f'{path}: upstream checksum mismatch')
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


if __name__ == '__main__':
    entries = json.loads((ROOT / 'sources.json').read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(check, entries))
    print(f'vendor/voice: {len(entries)} files match pinned SHA256 hashes.')

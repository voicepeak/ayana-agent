"""Export the running backend's actual recent model requests without API credentials."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import httpx


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True, help='Local backend URL, e.g. http://127.0.0.1:8765')
    parser.add_argument('--token-env', default='AYANA_DEBUG_TOKEN', help='Environment variable containing the per-launch backend token')
    parser.add_argument('--output', type=Path, help='New JSON output file; existing files are never overwritten')
    args = parser.parse_args()
    url = urlparse(args.base_url)
    if url.scheme not in {'http', 'https'} or url.hostname not in {'127.0.0.1', 'localhost', '::1'} or url.username or url.password or url.query or url.fragment:
        parser.error('--base-url must be the local backend address')
    token = os.environ.get(args.token_env)
    if not token:
        parser.error(f'Set {args.token_env} to the per-launch backend token (not the model API key)')
    target = args.output or Path('.runtime/prompt-exports') / (datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.json')
    if target.exists():
        parser.error('Output file already exists; choose a new path')
    with httpx.Client(trust_env=False, timeout=15) as client:
        response = client.get(args.base_url.rstrip('/') + '/debug/prompts/export', headers={'Authorization': 'Bearer ' + token})
    if response.status_code != 200:
        parser.error(f'Local backend returned HTTP {response.status_code}')
    value = response.json()
    if value.get('format') != 'ayana.prompt-trace.v1':
        parser.error('Unexpected export format')
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
    print(str(target.resolve()))


if __name__ == '__main__':
    main()

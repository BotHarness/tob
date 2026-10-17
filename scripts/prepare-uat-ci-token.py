#!/usr/bin/env python3
"""Human-only hidden input; no network, no token output, no overwrite."""
import getpass
import os
from pathlib import Path
import re
import sys

if not sys.stdin.isatty():
    sys.exit('Run in your own interactive terminal; never pass the token as an argument.')
if len(sys.argv) != 1:
    sys.exit('Usage: python3 scripts/prepare-uat-ci-token.py')
base = Path.home() / '.config/tob/first-deploy/tob-staging'
for part in [base, *base.parents]:
    if part.is_symlink():
        sys.exit('Refusing a symlink in the preparation path.')
if not (base / 'deployment.env').is_file():
    sys.exit('Run the first-deployment preparation wizard first.')
if base.stat().st_uid != os.getuid() or base.stat().st_mode & 0o077:
    sys.exit('Preparation directory must be owned by you with mode 0700.')
path = base / 'ci-secrets.env'
if path.exists() or path.is_symlink():
    sys.exit('CI token file already exists; not replacing it. Ask the deployment agent to verify it.')
print('Create token: https://dash.cloudflare.com/profile/api-tokens')
print('Target account only: Workers Scripts Edit, D1 Edit, Account Settings Read.')
print('Do not paste the token into chat. This script only saves it locally; it does not deploy.')
try:
    token = getpass.getpass('Cloudflare UAT CI API token (hidden): ')
    if not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', token):
        sys.exit('Unexpected token format; nothing saved.')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as output:
        output.write('CLOUDFLARE_API_TOKEN=' + token + '\n')
    print('Saved private CI token file; no verification or deployment performed.')
except (KeyboardInterrupt, EOFError):
    sys.exit('\nCancelled.')

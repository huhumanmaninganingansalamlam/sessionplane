#!/usr/bin/env python3
"""Exact Core handover CLI. This process never owns a second Chrome or DB writer."""
import argparse
import hashlib
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import time

if not __debug__:
    raise SystemExit('Optimized Python disables safety assertions')

OPS_DIR = str(pathlib.Path(__file__).resolve().parent)
if OPS_DIR not in sys.path:
    sys.path.insert(0, OPS_DIR)

from sessionplane_handover import bundle, cli, preflight

def main():
    return cli.main()

if __name__ == '__main__':
    if sys.argv[1:2] == ['bundle']:
        bundle.bundle_main(sys.argv[2:])
    elif sys.argv[1:2] == ['locks']:
        parser = argparse.ArgumentParser(
            description='Read-only current lock metadata; no SQLite connection or core call')
        parser.add_argument('--database', required=True)
        args = parser.parse_args(sys.argv[2:])
        print(json.dumps(preflight.lock_report(args.database), indent=2))
    else:
        try:
            main()
        except preflight.LockActivityError as error:
            print(json.dumps({'error': str(error), 'lockEvidence': error.report}), file=sys.stderr)
            raise SystemExit(1)

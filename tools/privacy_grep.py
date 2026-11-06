#!/usr/bin/env python3
"""Privacy gate: grep every file git would commit (tracked + untracked, not
ignored) for owner names, Gmail and local paths. Exit 1 on any hit.

  python tools/privacy_grep.py [repo]

The patterns are built from pieces so this file does not match itself.
"""
import re
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
parts = ["man" + "riquez", "mar" + "ko", "ki" + "hara", "mman" + "riquez", r"gmail\." + "com",
         r"Users[\\/]", r"[A-Za-z]:[\\/]_F26", r"[A-Za-z]:\\\\_F26"]
rx = re.compile("|".join(parts), re.IGNORECASE)
files = subprocess.run(["git", "ls-files", "-co", "--exclude-standard"], cwd=root, capture_output=True,
                       text=True, encoding="utf-8", check=True).stdout.splitlines()
hits = 0
for f in files:
    p = root / f
    if not p.is_file():
        continue
    try:
        text = p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        text = p.read_bytes().decode("latin-1")
    for n, line in enumerate(text.splitlines(), 1):
        if rx.search(line):
            hits += 1
            if hits <= 40:
                print(f"{f}:{n}: {line.strip()[:140]}")
print(f"privacy grep: {len(files)} files, {hits} hits")
sys.exit(1 if hits else 0)

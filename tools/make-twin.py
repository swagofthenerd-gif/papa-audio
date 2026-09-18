#!/usr/bin/env python3
"""Build a throwaway Papa Audio profile for QA — WITHOUT his credentials.

    python3 tools/make-twin.py /tmp/claude-1000/twin-<name>            # everything stripped
    python3 tools/make-twin.py /tmp/claude-1000/twin-<name> --keep-slskd  # Soulseek read-only QA; DRY_RUN required

On 2026-09-18 a twin built by hand-copying ~/.config/papa-audio carried the
real RealDebrid token; a QA click sent 12 addMagnet calls to his account (all
rejected — by luck). A twin must never be able to spend, delete or post as him.

What this does:
  * copies only the small JSON stores (never caches, artwork, backups, logs)
  * strips every secret the app itself redacts (src/redact.js is the single
    source of truth — a hand-written key list would drift) and DELETES those
    keys rather than leaving a placeholder, so debrid/slskd/yt read as
    "not configured"
  * writes fixture video-keep/cache indexes pointing INSIDE the twin dir, so
    On Device is testable and a Delete there can only touch fixture files
  * verifies: no original secret value survives anywhere under the twin dir
Launch it with:  PAPA_USER_DATA=<dir> PAPA_DRY_RUN=1 npx electron . --remote-debugging-port=<port>
"""
import json, os, re, shutil, subprocess, sys

SRC = os.path.expanduser('~/.config/papa-audio')
KEEP = ['config.json', 'playback-state.json', 'session-state.json', 'window-state.json',
        'library-cache.json', 'video-store.json', 'play-counts.json', 'playlists.json',
        'liked-tracks.json', 'saved-queues.json', 'recently-played.json', 'play-history.json']
MAX_BYTES = 8 * 1024 * 1024   # /tmp is tmpfs: refuse to copy anything large

def main(dst, keep_slskd=False):
    if not dst.startswith('/tmp/'):
        sys.exit('refusing: twin dir must be under /tmp so it can never be mistaken for his profile')
    os.makedirs(dst, exist_ok=True)
    node = subprocess.run(['node', '-e', '''
      const R = require("./src/redact.js");
      const raw = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const red = R.redactObject(raw);
      const MARK = R.MARK;
      // Everything the redactor marks is DELETED from the twin. But only values
      // whose PATH names a credential are treated as "must be absent everywhere":
      // the redactor also marks agentProfile.insights[].key — five-letter insight
      // labels — and one of those is a word that appears in his album folders.
      // The path test keeps an 8-character slskd password in scope and drops the
      // labels. A redacted OBJECT (apiKeys) contributes every leaf string inside it.
      const CRED_PATH = /password|passwd|token|cookie|api[-_]?keys?|secret|credential/i;
      const secretValues = [];
      // A string that IS the named secret counts at any length >= 4 (an 8-char
      // slskd password is still a password). A string that merely sits inside a
      // redacted bag (apiKeys holds provider and mode names beside the keys)
      // counts only when it is key-shaped: a real API key is never 5 characters,
      // and a 5-character provider name was matching a word in his assistant's
      // conversation summary.
      const leaves = (v, out, direct) => {
        if (typeof v === "string") { if (v.length >= (direct ? 4 : 16)) out.push(v); }
        else if (v && typeof v === "object") for (const x of Object.values(v)) leaves(x, out, false);
      };
      const KEEP_SLSKD = process.argv[2] === "1";
      const strip = (o, r, path) => {
        if (!o || typeof o !== "object") return;
        for (const k of Object.keys(o)) {
          const rv = r ? r[k] : undefined;
          const here = path + "." + k;
          if (rv === MARK) {
            if (KEEP_SLSKD && /^[.](slskdApiCreds|slskConfig)[.]/.test(here)) continue;   // --keep-slskd, see below
            if (CRED_PATH.test(here)) leaves(o[k], secretValues, typeof o[k] === "string");
            delete o[k]; continue;
          }
          if (typeof o[k] === "object") strip(o[k], rv, here);
        }
      };
      strip(raw, red, "");
      process.stdout.write(JSON.stringify({ config: raw, secretValues }));
    ''', os.path.join(SRC, 'config.json'), '1' if keep_slskd else '0'], capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if node.returncode != 0:
        sys.exit('redaction failed: ' + node.stderr[:400])
    out = json.loads(node.stdout)
    config, secrets = out['config'], out['secretValues']
    with open(os.path.join(dst, 'config.json'), 'w', encoding='utf-8') as f:
        json.dump(config, f)
    copied = ['config.json']
    for name in KEEP[1:]:
        p = os.path.join(SRC, name)
        if os.path.isfile(p) and os.path.getsize(p) <= MAX_BYTES:
            shutil.copy2(p, os.path.join(dst, name)); copied.append(name)
    # Fixture cache: real-shaped entries whose paths live INSIDE the twin.
    fx = os.path.join(dst, 'fixture-cache'); os.makedirs(fx, exist_ok=True)
    keep, cache = [], []
    for i, title in enumerate(['Fixture Show — E01', 'Fixture Show — E02', 'Fixture Film']):
        path = os.path.join(fx, f'fixture-{i + 1}.mkv')
        with open(path, 'wb') as f: f.write(b'\0' * 4096)
        keep.append({'id': f'fix-{i + 1}', 'title': title, 'path': path, 'sizeBytes': 4096, 'keptAt': 1700000000000 + i,
                     'show': 'Fixture Show' if i < 2 else None, 'season': 1 if i < 2 else None,
                     'episode': i + 1 if i < 2 else None, 'fileName': os.path.basename(path)})
        cache.append({'key': f'fixture:{i + 1}', 'path': path, 'title': title, 'sizeBytes': 4096, 'lastUsedAt': 1700000000000})
    with open(os.path.join(dst, 'video-keep-index.json'), 'w') as f: json.dump(keep, f)
    with open(os.path.join(dst, 'video-cache-index.json'), 'w') as f: json.dump(cache, f)
    # Verification: no original secret VALUE anywhere under the twin.
    leaks = []
    for root, _, files in os.walk(dst):
        for fn in files:
            if not fn.endswith('.json'): continue
            with open(os.path.join(root, fn), encoding='utf-8', errors='ignore') as f: txt = f.read()
            for sv in secrets:
                if sv in txt: leaks.append(fn)
    if leaks:
        shutil.rmtree(dst); sys.exit(f'LEAK: a secret value survived in {sorted(set(leaks))} — twin destroyed')
    size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(dst) for f in fs)
    kept = 'slskd password KEPT' if keep_slskd else 'all credentials stripped'
    print(f'twin at {dst}: {len(copied)} stores copied, {len(secrets)} secret values stripped and verified absent ({kept}), '
          f'{len(keep)} fixture cache entries, {size / 1048576:.1f} MB')
    if keep_slskd:
        # slskd is his REAL Soulseek account. Its creds are kept ONLY so read-only
        # browse/search can be tested; downloads, cancels and config changes must
        # be refused in main by PAPA_DRY_RUN=1. The marker makes the choice auditable.
        with open(os.path.join(dst, 'TWIN-HAS-SLSKD-CREDS'), 'w') as f: f.write('launch ONLY with PAPA_DRY_RUN=1\n')
        print('WARNING: slskd credentials kept (--keep-slskd). Launch ONLY with PAPA_DRY_RUN=1, never press download/cancel.')
    print(f'launch: PAPA_USER_DATA={dst} PAPA_DRY_RUN=1 npx electron . --remote-debugging-port=<port>')

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 1: sys.exit(__doc__)
    main(args[0], keep_slskd='--keep-slskd' in sys.argv)

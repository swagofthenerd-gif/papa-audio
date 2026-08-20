#!/usr/bin/env python3
"""Push EQ values to a running PipeWire filter chain, with no restart.

Every filter control in the chain is a live PipeWire parameter, so a gain
change is a set-param away — instantly audible, no dropout. Regenerating the
config and restarting PipeWire (the old path) costs 15-20 seconds of silence
for what should be immediate.

Limitation, deliberately surfaced rather than hidden: the generator omits
zero-gain bands, so a band moving away from zero has no node to set. This
exits 2 in that case and the caller must rebuild. Everything else — existing
bands, subwoofer level, crossover — applies live.

Usage:
    papa-eq-apply.py <preset>       push that preset's stored values
    papa-eq-apply.py <preset> --check   report what would apply, change nothing
"""
import json, os, subprocess, sys

HOME = os.path.expanduser('~')
MANIFEST = os.path.join(HOME, '.config/papa-eq/controls.json')
STORE = os.path.join(HOME, '.config/papa-eq/presets.json')


def graph(sink):
    """(node id, set of live control names) for a sink. One dump, not two."""
    try:
        dump = json.loads(subprocess.run(['pw-dump'], capture_output=True,
                                         text=True, timeout=15).stdout)
    except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError):
        return None, set()
    for o in dump:
        if o.get('info', {}).get('props', {}).get('node.name') != sink:
            continue
        names = set()
        for p in o.get('info', {}).get('params', {}).get('Props', []):
            pr = p.get('params')
            if not pr:
                continue
            for i in range(0, len(pr) - 1, 2):
                if isinstance(pr[i], str) and ':' in pr[i]:
                    names.add(pr[i])
        return o.get('id'), names
    return None, set()


def apply(values, nid):
    """Push every value in one set-param so the change lands atomically."""
    if not values:
        return True
    parts = ' '.join(f'"{k}" {float(v)}' for k, v in values.items())
    r = subprocess.run(['pw-cli', 'set-param', str(nid), 'Props',
                        '{ params = [ %s ] }' % parts],
                       capture_output=True, text=True, timeout=10)
    return r.returncode == 0


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip()); return 1
    key = sys.argv[1]
    check = '--check' in sys.argv

    if not os.path.exists(MANIFEST):
        print(f'no manifest at {MANIFEST} — run build-pipewire-presets.js', file=sys.stderr)
        return 1
    try:
        with open(MANIFEST) as fh:
            man = json.load(fh)
    except (OSError, json.JSONDecodeError):
        print(f'{MANIFEST} is unreadable — re-run build-pipewire-presets.js', file=sys.stderr)
        return 1
    if key not in man.get('presets', {}):
        print(f'unknown preset {key}; have: {", ".join(man.get("presets", {}))}', file=sys.stderr)
        return 1
    entry = man['presets'][key]
    sink = entry['sink']

    nid, have = graph(sink)
    if nid is None:
        print(f'{sink} is not loaded — is the EQ switched off? '
              'Try: papa-eq-toggle on', file=sys.stderr)
        return 1

    wanted = dict(entry.get('gains', {})); wanted.update(entry.get('mixer', {}))
    missing = [k for k in wanted if k not in have]
    settable = {k: v for k, v in wanted.items() if k in have}

    if check:
        print(f'{sink}: {len(settable)} settable, {len(missing)} missing')
        for m in missing[:10]:
            print('  missing:', m)
        return 2 if missing else 0

    if not settable:
        print(f'{sink}: nothing to apply — no matching controls in the graph', file=sys.stderr)
        return 2
    ok = apply(settable, nid)
    print(f'{sink}: applied {len(settable)} controls live' + (' (no restart)' if ok else ' — FAILED'))
    if missing:
        print(f'  {len(missing)} control(s) do not exist in the graph; a rebuild is needed for those')
        return 2
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())

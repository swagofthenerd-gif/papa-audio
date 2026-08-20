#!/usr/bin/env python3
"""Structural audit of the generated Papa EQ PipeWire config.

Checks invariants that are cheap to get wrong and silent when they are:
crossover topology, which EQ bands reach which output, mixer wiring, gain
staging, and dangling port references. Run after any change to
build-pipewire-presets.js or the preset store.

Exits non-zero if any invariant fails.
"""
import json, os, re, math, cmath, sys
CONF = os.path.expanduser('~/.config/pipewire/pipewire.conf.d/60-papa-eq-51.conf')
STORE = os.path.expanduser('~/.config/papa-eq/presets.json')

def _biquad_peaking_db(f0, gain, Q, f, fs=48000.0):
    A = 10 ** (gain / 40.0); w = 2*math.pi*f0/fs
    al = math.sin(w)/(2*Q); c = math.cos(w); a0 = 1 + al/A
    b0,b1,b2 = (1+al*A)/a0, (-2*c)/a0, (1-al*A)/a0
    a1,a2 = (-2*c)/a0, (1-al/A)/a0
    wz = -2*math.pi*f/fs
    cr,ci = math.cos(wz), math.sin(wz)
    c2r,c2i = math.cos(2*wz), math.sin(2*wz)
    nr = b0 + b1*cr + b2*c2r; ni = b1*ci + b2*c2i
    dr = 1 + a1*cr + a2*c2r;  di = a1*ci + a2*c2i
    return 10*math.log10((nr*nr+ni*ni)/(dr*dr+di*di))


def _response_peak(filters):
    """Peak of the SUMMED response, swept on a fine log grid."""
    if not filters: return 0.0
    best = 0.0
    for i in range(481):
        f = 20 * (10 ** ((i/480.0) * math.log10(1000.0)))
        db = sum(_biquad_peaking_db(fl[0], fl[1], fl[2], f) for fl in filters)
        if db > best: best = db
    return best


def _path_filters(p, which, S, BANDS, X):
    BM = S.get('bassManagement', True)
    try:
        corr = json.load(open(os.path.expanduser('~/.cache/speakercal.json'))).get('corrections', [])
    except Exception:
        corr = []
    out = []
    for band, g in zip(BANDS, p['gains']):
        if not g: continue
        if (not BM) or (band < X if which == 'sub' else band >= X):
            out.append((band, g, 1.0))
    for c in corr:
        if (not BM) or (c['freq'] < X if which == 'sub' else c['freq'] >= X):
            out.append((c['freq'], c['gain'], c['q']))
    return out

def die(msg, hint=''):
    print(msg, file=sys.stderr)
    if hint: print(hint, file=sys.stderr)
    sys.exit(1)

try:
    with open(CONF) as fh:
        conf = fh.read()
except OSError:
    die(f'No generated config at {CONF}',
        'Run: node ~/flac-player/tools/build-pipewire-presets.js')
try:
    with open(STORE) as fh:
        store = json.load(fh)
except OSError:
    die(f'No preset store at {STORE}',
        'Restore it from ~/flac-player/tools/presets.default.json')
except json.JSONDecodeError as e:
    die(f'{STORE} is not valid JSON: {e}',
        'Restore it from ~/flac-player/tools/presets.default.json')
S = store['settings']; BANDS = store['bands']; X = S['crossover']
chunks = conf.split('{ name = libpipewire-module-filter-chain')
BLOCKS = {}
for c in chunks[1:]:
    m = re.search(r'node\.name\s+= "papa_eq_([a-z0-9-]+)"\n', c)
    if m: BLOCKS[m.group(1)] = c
fail = []

# Every preset must produce exactly one sink.
names = re.findall(r'node\.name\s+= "papa_eq_([a-z0-9-]+)"', conf)
sinks = [n for n in names if not n.endswith('_out')]
keys = [p['key'] for p in store['presets']]
if sorted(set(sinks)) != sorted(set(keys)):
    fail.append(f"sink/preset mismatch: conf={sorted(set(sinks))} store={sorted(set(keys))}")

for p in store['presets']:
    k = p['key']
    b = BLOCKS.get(k)
    if not b:
        fail.append(f"{k}: module block not found"); continue

    # 1. Crossover topology. With bass management ON this must be LR4: two
    #    cascaded sections per side per satellite. With it OFF there is a
    #    single high-pass and no low-pass branch.
    for ch in ['FL','FR','FC','RL','RR']:
        tags = ['hp1','hp2','lp1','lp2'] if S.get('bassManagement', True) else ['hp']
        for tag in tags:
            if f'name = {k}_{tag}_{ch} ' not in b:
                fail.append(f"{k}/{ch}: missing {tag}")
    # 2. Sub must NOT carry filters above the crossover.
    if S.get('bassManagement', True):
        for band in BANDS:
            if band >= X and (f'name = {k}_v{band}_LFE ' in b or f'name = {k}_c{band}_LFE ' in b):
                fail.append(f"{k}: sub carries out-of-band filter at {band} Hz (xover {X})")
    # 3. Satellites must NOT carry filters below the crossover — but only when
    #    bass management is on. With it off they run full range and SHOULD
    #    carry every band, so this check produced a false failure there.
    #    Checks all five satellites, not just FC (the earlier version would
    #    have missed a fault confined to FL/FR/RL/RR).
    if S.get('bassManagement', True):
        for band in BANDS:
            if band >= X: continue
            for ch in ('FL','FR','FC','RL','RR'):
                if f'name = {k}_v{band}_{ch} ' in b:
                    fail.append(f"{k}: satellite {ch} carries below-crossover filter at {band} Hz")
    # 4. Mixer must have exactly 6 inputs (5 satellites + LFE) — but only
    #    when bass management is on; with it off there is deliberately no
    #    mixer, and demanding one produced a false failure.
    BM = S.get('bassManagement', True)
    mx = re.search(r'name = %s_submix_LFE label = mixer control = \{ ([^}]*) \}' % k, b)
    if BM and not mx: fail.append(f"{k}: no sub mixer")
    if mx:
        g = re.findall(r'"Gain (\d+)" = ([0-9.]+)', mx.group(1))
        if len(g) != 6: fail.append(f"{k}: mixer has {len(g)} gains, expected 6")
        links = len(re.findall(r'input = "%s_submix_LFE:In \d+"' % k, b))
        if links != 6: fail.append(f"{k}: {links} links into mixer, expected 6")
    # 5. Mixer gains must be UNITY (or subMixGain), never a per-path trim.
    #    A Linkwitz-Riley pair only sums flat when both halves are
    #    complementary; attenuating just the sub branch makes that branch gain
    #    the bass level outright. This is the invariant that was violated for
    #    most of this system's life, so it is checked explicitly.
    smg = S.get('subMixGain', 1.0)
    if mx:
        gd = dict(g)
        for i in range(1, 6):
            if abs(float(gd[str(i)]) - smg) > 0.002:
                fail.append(f"{k}: satellite mixer gain {gd[str(i)]} != {smg} "
                            f"(a per-path trim breaks crossover complementarity)")
        if abs(float(gd['6']) - 1.0) > 0.002:
            fail.append(f"{k}: LFE mixer gain {gd['6']} != 1.0")
    # 6. Sink attenuation covers the LARGER path peak plus summing headroom,
    #    applied before the split so both branches scale together.
    # Same true-response maths as the generator: overlapping Q=1 peaking
    # filters SUM, so the largest single band gain understates the real peak
    # and leaves the output above full scale — digital clipping, audible at
    # every volume setting.
    peak = max(_response_peak(_path_filters(p, 'sat', S, BANDS, X)),
               _response_peak(_path_filters(p, 'sub', S, BANDS, X)))
    head = S.get('subHeadroom', 0)
    want = round(10 ** (-(math.ceil(peak*10)/10 + head)/20), 4) if (peak > 0 or head > 0) else 1.0
    vol = re.search(r'volume = ([0-9.]+)', b)
    # The generator omits the line entirely at unity, so absent means 1.0.
    got = float(vol.group(1)) if vol else 1.0
    if abs(got-want) > 0.001:
        fail.append(f"{k}: volume {got} != expected {want} "
                    f"(true peak +{peak:.2f}, headroom {head} dB)")
    # 7. Every input/output port must exist as a node.
    io = re.search(r'inputs\s+= \[([^\]]*)\].*?outputs = \[([^\]]*)\]', b, re.S)
    if io:
        for port in re.findall(r'"([^"]+)"', io.group(1)+io.group(2)):
            node = port.split(':')[0]
            if f'name = {node} ' not in b:
                fail.append(f"{k}: port {port} references missing node")
    else:
        fail.append(f"{k}: no inputs/outputs arrays")

# Live checks: the config is only half the story if the graph disagrees.
import subprocess
try:
    live = subprocess.run(['pactl','list','sinks','short'], capture_output=True, text=True, timeout=5).stdout
    live_sinks = {l.split('\t')[1] for l in live.strip().split('\n') if '\t' in l}
    for k in keys:
        if f'papa_eq_{k}' not in live_sinks:
            fail.append(f"{k}: sink declared in config but not loaded")
    links = subprocess.run(['pw-link','-l'], capture_output=True, text=True, timeout=5).stdout
    for k in keys:
        n = links.count(f'papa_eq_{k}_out:output_')
        # `if n and n < 6` silently passed the WORST case: zero links, which is
        # exactly what a failed relink produces.
        if n < 6:
            fail.append(f"{k}: {n}/6 outputs linked to hardware")
except Exception as e:
    print(f"  (live checks skipped: {e})")

QUIET = '--quiet' in sys.argv
if not QUIET:
    print(f"checked {len(store['presets'])} presets")
# --- Consequence checks -------------------------------------------------
# The checks above verify the config matches the settings. They cannot catch a
# setting that is itself wrong, which is exactly how a 10 dB bass deficit went
# unnoticed: subMixGain validated against itself. These evaluate the acoustic
# RESULT instead.
warn = []
smg = S.get('subMixGain', 1.0)
if S.get('bassManagement', True) and smg < 0.95:
    import math as _m
    deficit = -20 * _m.log10(smg)
    warn.append(
        f"subMixGain={smg} attenuates ONLY the low-pass branch. Below the "
        f"crossover the subwoofer is the sole source, so this is a broadband "
        f"bass deficit of {deficit:.1f} dB, not a level trim. If the sub is "
        f"too loud, turn the subwoofer's own volume down instead.")
hp = S.get('subHighPass')
if hp and hp > 45:
    warn.append(f"subHighPass={hp} Hz is well above a typical ported 8-inch "
                f"driver's usable floor; check it against the speaker's rating.")
xo = S.get('crossover', 80)
if xo > 100:
    warn.append(f"crossover={xo} Hz asks the subwoofer for output above where "
                f"most compact subs roll off; check the speaker's rating.")
if warn and not QUIET:
    print(f"\n{len(warn)} WARNING(S):")
    for w in warn: print("  !", w)

if fail:
    print(f"\n{len(fail)} PROBLEM(S):")
    for f in fail: print("  -", f)
    sys.exit(1)
if not QUIET:
    print("\nAll structural invariants hold." if not warn
          else "\nStructural invariants hold, but see warnings above.")

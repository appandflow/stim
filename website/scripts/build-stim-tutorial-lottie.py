"""Writes the Stim Desktop tutorial illustrations to website/static/img/branding.

`stim-tutorial-{light,dark}.json` is one timeline per scheme. Each tutorial step id is a marker spanning that step's
loop, which starts and ends on the step's rest pose. A `<from>><to>` marker spans an authored transition from one rest
pose to the next. A `<step>.still` marker, with no duration, is the frame to show under Reduce Motion.
`stim-step-done-{light,dark}.json` is the badge played when a step completes.

Lottie's Core Animation engine renders every feature used here; check that it still picks it (no fallback warning)
after adding a shape or property type.
"""
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BRANDING = ROOT / 'website' / 'static' / 'img' / 'branding'
CHANGE_EFFECT = 'a'
W, H, FPS = 288, 168, 30
S = 0.58
SW = 2.0
LSW = SW / S
DASH = 5
LDASH = DASH / S
HOME = [144, 94]
LEFT, RIGHT = [90, 94], [202, 94]
LOOP, TRANS = 90, 24
RX, RY, RIM_Y, BASE_Y = 65.5, 36, -65, 65

EASE = ({'x': [0.55], 'y': [1]}, {'x': [0.45], 'y': [0]})
OUTE = ({'x': [0.2], 'y': [1]}, {'x': [0.4], 'y': [0]})
SMOOTH = ({'x': [0.58], 'y': [1]}, {'x': [0.42], 'y': [0]})
UNTRACE = ({'x': [0.6], 'y': [1]}, {'x': [0.8], 'y': [0]})
POP = ({'x': [0.3], 'y': [1.5]}, {'x': [0.5], 'y': [0]})
LIN = ({'x': [1], 'y': [1]}, {'x': [0], 'y': [0]})

PALETTES = {
    'light': {'stroke': '#5521FF', 'jar': '#FFFFFF', 'side': '#DDD3FF', 'top': '#5521FF', 'muted': '#BDB2E6',
              'accent': '#5521FF', 'screen': '#1B1530', 'ok': '#0F6C31', 'okfg': '#FFFFFF', 'bolt': '#FFB020'},
    'dark': {'stroke': '#FFFFFF', 'jar': '#5521FF', 'side': '#210092', 'top': '#FFFFFF', 'muted': '#6B55C4',
             'accent': '#B39CFF', 'screen': '#0C0A11', 'ok': '#4ADE80', 'okfg': '#0E0C13', 'bolt': '#FFC24D'},
}

OFF = 0


def r2(v):
    v = round(v, 2)
    return int(v) if v == int(v) else v


def rgb(hexc):
    h = hexc.lstrip('#')
    return [round(int(h[i:i + 2], 16) / 255, 4) for i in (0, 2, 4)] + [1]


def st(v):
    return {'a': 0, 'k': v}


def kf(keys, ease=EASE):
    out = []
    for n, key in enumerate(keys):
        t, v = key[0], key[1]
        e = key[2] if len(key) > 2 else ease
        k = {'t': t + OFF, 's': v if isinstance(v, list) else [v]}
        if n < len(keys) - 1:
            if e == 'hold':
                k['h'] = 1
            else:
                k['i'], k['o'] = e
        out.append(k)
    return {'a': 1, 'k': out}


def val(v):
    return v if isinstance(v, dict) else st(v)


def color(c):
    if isinstance(c, dict):
        return c
    return st(rgb(c))


def ckf(keys, ease=EASE):
    return kf([(k[0], rgb(k[1]), *k[2:]) for k in keys], ease)


def el(cx, cy, w, h):
    return {'ty': 'el', 'p': st([r2(cx), r2(cy)]), 's': st([r2(w), r2(h)]), 'd': 1}


def rc(cx, cy, w, h, r):
    return {'ty': 'rc', 'p': st([r2(cx), r2(cy)]), 's': st([r2(w), r2(h)]), 'r': st(r), 'd': 1}


def sh(points, closed=True, ins=None, outs=None):
    zero = [[0, 0] for _ in points]
    return {'ty': 'sh', 'ks': st({'c': closed, 'v': [[r2(x), r2(y)] for x, y in points], 'i': ins or zero,
                                  'o': outs or zero})}


def fl(c, o=100):
    return {'ty': 'fl', 'c': color(c), 'o': val(o), 'r': 1}


def stk(c, w, gap=None, o=100, dash=None):
    s = {'ty': 'st', 'c': color(c), 'o': val(o), 'w': st(w), 'lc': 2, 'lj': 2, 'ml': 4}
    if gap is not None:
        d = dash or (DASH if w == SW else LDASH)
        if isinstance(gap, list):
            s['d'] = [{'n': 'd', 'v': kf([(k[0], 2 * d - k[1], *k[2:]) for k in gap])}, {'n': 'g', 'v': kf(gap)},
                      {'n': 'o', 'v': st(0)}]
        else:
            s['d'] = [{'n': 'd', 'v': st(d)}, {'n': 'g', 'v': st(gap)}, {'n': 'o', 'v': st(0)}]
    return s


def tm(end, start=None):
    return {'ty': 'tm', 's': val(start if start is not None else 0), 'e': val(end), 'o': st(0), 'm': 1}


def gr(items, p=(0, 0), a=(0, 0), s=100, r=0, o=100):
    t = {'ty': 'tr', 'p': val(list(p)) if not isinstance(p, dict) else p, 'a': st(list(a)),
         's': s if isinstance(s, dict) else st([s, s]), 'r': val(r), 'o': val(o)}
    return {'ty': 'gr', 'it': items + [t]}


class Timeline:
    def __init__(self):
        self.layers = []
        self.markers = []
        self.t = 0

    def add(self, nm, shapes=None, ip=None, op=None, parent=None, o=100, p=(0, 0), s=100, r=0, a=(0, 0),
            null=False):
        ind = len(self.layers) + 1
        layer = {'ddd': 0, 'ind': ind, 'ty': 3 if null else 4, 'nm': nm, 'sr': 1,
                 'ks': {'o': val(o), 'r': val(r), 'p': p if isinstance(p, dict) else st(list(p)), 'a': st(list(a)),
                        's': s if isinstance(s, dict) else st([s, s, 100])},
                 'ao': 0, 'ip': self.ip if ip is None else ip, 'op': self.op if op is None else op, 'st': 0, 'bm': 0}
        if not null:
            layer['shapes'] = shapes
        if parent is not None:
            layer['parent'] = parent
        self.layers.append(layer)
        return ind

    def segment(self, name, length, still=None):
        global OFF
        OFF = self.t
        self.ip, self.op = self.t, self.t + length - 0.5
        self.markers.append({'tm': self.t, 'cm': name, 'dr': length})
        if still is not None:
            self.markers.append({'tm': self.t + still, 'cm': f'{name}.still', 'dr': 0})
        self.t += length


GAP = 4


def jar_right(cx, scale=1):
    return cx + (RX * S * scale) + SW / 2


def box_edges(cx, w):
    return cx - w / 2 - SW / 2, cx + w / 2 + SW / 2


def hlink(x0, x1, y):
    return sh([[x0 + GAP, y], [x1 - GAP, y]], closed=False)


def rig(tl, nm, p, s=100, r=0):
    if isinstance(s, dict):
        for key in s['k']:
            key['s'] = [key['s'][0] * S, key['s'][1] * S, 100]
    else:
        s = st([s * S, s * S, 100])
    return tl.add(nm, null=True, p=p, s=s, r=r)


def jar(tl, pal, parent, nm='jar', trim=None, gap=None, fill_op=100, o=100):
    k = 0.5522847498
    def body(closed):
        return sh([[-RX, RIM_Y], [-RX, BASE_Y], [0, BASE_Y + RY], [RX, BASE_Y], [RX, RIM_Y]], closed=closed,
                  ins=[[0, 0], [0, 0], [-k * RX, 0], [0, k * RY], [0, 0]],
                  outs=[[0, 0], [0, k * RY], [k * RX, 0], [0, 0], [0, 0]])
    extra = [tm(trim)] if trim else []
    tl.add(f'{nm}-rim', [gr([el(0, RIM_Y, 2 * RX, 2 * RY)] + extra + [stk(pal['stroke'], LSW, gap),
                                                                      fl(pal['jar'], fill_op)])], parent=parent, o=o)
    tl.add(f'{nm}-base', [gr([el(0, BASE_Y, 2 * RX, 2 * RY)] + extra + [stk(pal['stroke'], LSW, gap)])],
           parent=parent, o=o)
    tl.add(f'{nm}-body', [gr([body(False)] + extra + [stk(pal['stroke'], LSW, gap)]),
                          gr([body(True), fl(pal['jar'], fill_op)])], parent=parent, o=o)


def lid(tl, pal, parent, p=(0, 0), o=100, trim=None, gap=None, fill_op=100):
    def band(closed):
        return sh([[-RX - 3, RIM_Y - 12], [-RX - 3, RIM_Y], [0, RIM_Y + RY + 2], [RX + 3, RIM_Y],
                   [RX + 3, RIM_Y - 12]], closed=closed,
                  ins=[[0, 0], [0, 0], [-0.55 * (RX + 3), 0], [0, 0.55 * (RY + 2)], [0, 0]],
                  outs=[[0, 0], [0, 0.55 * (RY + 2)], [0.55 * (RX + 3), 0], [0, 0], [0, 0]])
    extra = [tm(trim)] if trim else []
    tl.add('lid', [gr([el(0, RIM_Y - 12, 2 * RX + 6, 2 * RY + 4)] + extra + [stk(pal['stroke'], LSW, gap),
                                                                         fl(pal['jar'], fill_op)]),
                   gr([band(False)] + extra + [stk(pal['stroke'], LSW, gap)]),
                   gr([band(True), fl(pal['side'], fill_op)])],
           parent=parent, p=p, o=o)


def phone(tl, pal, parent, nm='phone', header='#000000', screen_op=0, o=100, trim=None, gap=None, fill_op=100,
          p=(0, 0), s=100):
    outline = [rc(0, 0, 52, 96, 13)]
    extra = [tm(trim)] if trim else []
    detail = [gr([rc(0, -40, 18, 6, 3), fl(pal['top'])]),
              gr([rc(0, 4, 42, 70, 7), fl(pal['screen'], screen_op)]),
              gr([rc(0, -21, 38, 12, 4), fl(header)]),
              gr([rc(-4, -2, 30, 5, 2.5), rc(-8, 8, 22, 5, 2.5), fl(pal['muted'])])]
    tl.add(f'{nm}-detail', [gr(detail, o=fill_op)], parent=parent, o=o, p=p, s=s)
    tl.add(f'{nm}-body', [gr(outline + extra + [stk(pal['stroke'], LSW, gap), fl(pal['side'], fill_op)])],
           parent=parent, o=o, p=p, s=s)


def check_badge(tl, pal, parent, pos, scale):
    tl.add('check', [gr([sh([[-10, 0], [-3, 8], [11, -8]], closed=False), stk(pal['okfg'], LSW)]),
                     gr([el(0, 0, 44, 44), stk(pal['stroke'], LSW), fl(pal['ok'])])],
           parent=parent, p=pos, s=scale)


def bolt_shape(pal):
    return [gr([sh([[4, -22], [-12, 3], [-1, 3], [-5, 22], [12, -4], [1, -4], [6, -22]]), stk(pal['stroke'], SW),
                fl(pal['bolt'])])]


def sparkle(tl, pal, parent, t0, center=(0, RIM_Y), rx=RX, ry=RY, sw=LSW, gap=10, length=16):
    lines = []
    for deg in (-150, -112, -68, -30):
        a = math.radians(deg)
        x0, y0 = center[0] + (rx + gap) * math.cos(a), center[1] + (ry + gap) * math.sin(a)
        x1, y1 = center[0] + (rx + gap + length) * math.cos(a), center[1] + (ry + gap + length) * math.sin(a)
        lines.append(sh([[x0, y0], [x1, y1]], closed=False))
    trim_s = kf([(t0 + 4, 0), (t0 + 14, 100)], OUTE)
    trim_e = kf([(t0, 0), (t0 + 8, 100)], OUTE)
    tl.add('sparkle', [gr(lines + [tm(trim_e, trim_s), stk(pal['stroke'], sw)])], parent=parent,
           o=kf([(t0 - 1, 0, 'hold'), (t0, 100), (t0 + 14, 100)]))


def burst(tl, pal, center, t0, radius=26, length=9, parent=None, sw=SW):
    lines = []
    for n in range(8):
        a = math.pi * 2 * n / 8 - math.pi / 2
        x0, y0 = center[0] + radius * math.cos(a), center[1] + radius * math.sin(a)
        x1, y1 = center[0] + (radius + length) * math.cos(a), center[1] + (radius + length) * math.sin(a)
        lines.append(sh([[x0, y0], [x1, y1]], closed=False))
    trim_s = kf([(t0 + 4, 0), (t0 + 14, 100)], OUTE)
    trim_e = kf([(t0, 0), (t0 + 8, 100)], OUTE)
    tl.add('burst', [gr(lines + [tm(trim_e, trim_s), stk(pal['stroke'], sw)])], parent=parent,
           o=kf([(t0 - 1, 0, 'hold'), (t0, 100), (t0 + 14, 100)]))


def repo_card(pal, o=100):
    return branch_glyph(pal) + [gr([rc(0, 0, 48, 48, 12), stk(pal['stroke'], SW), fl(pal['side'])])]


def branch_glyph(pal, sw=SW):
    nodes = [el(-7, -11, 8, 8), el(-7, 11, 8, 8), el(7, -6, 8, 8)]
    trunk = sh([[-7, -7], [-7, 7]], closed=False)
    branch = sh([[7, -2], [-7, 6]], closed=False, ins=[[0, 0], [8, 0]], outs=[[0, 7], [0, 0]])
    return [gr(nodes + [stk(pal['stroke'], sw), fl(pal['jar'])]), gr([trunk, branch, stk(pal['stroke'], sw)])]


def package(pal):
    return [gr([rc(0, 0, 16, 16, 4), sh([[-8, -2], [8, -2]], closed=False), stk(pal['stroke'], SW),
                fl(pal['top'])])]


def change_arrives(tl, pal, j):
    tl.add('plus', [gr([sh([[-4, 0], [4, 0]], closed=False), sh([[0, -4], [0, 4]], closed=False),
                        stk(pal['okfg'], 2)]),
                    gr([el(0, 0, 16, 16), stk(pal['stroke'], SW), fl(pal['ok'])])],
           p=kf([(40, [130, 84]), (48, [112, 70], OUTE)]),
           s=kf([(40, [0, 0, 100]), (48, [100, 100, 100], POP), (74, [100, 100, 100]), (82, [0, 0, 100])]))
    tl.add('plus-ring', [gr([el(0, 0, 16, 16), stk(pal['stroke'], 1.5)],
                            s=kf([(46, [100, 100]), (58, [220, 220])], OUTE))],
           p=st([112, 70]), o=kf([(45, 0, 'hold'), (46, 80), (58, 0)]))
    brush = [gr([sh([[0, -2], [0, -20]], closed=False), stk(pal['stroke'], 3)]),
             gr([rc(0, 3, 10, 10, 3), stk(pal['stroke'], SW), fl(pal['accent'])])]
    tl.add('brush', [gr(brush, r=-35)],
           p=kf([(10, [112, 52]), (26, [128, 78]), (42, [162, 78]), (54, [184, 52])]),
           o=kf([(10, 0), (18, 100), (44, 100), (54, 0)]))
    tl.add('wipe', [gr([rc(0, -21, 38, 12, 4), fl(pal['accent'])], p=(-19, -21), a=(-19, -21),
                       s=kf([(26, [0, 100]), (42, [100, 100])], SMOOTH))], parent=j,
           o=kf([(0, 100), (80, 100), (89, 0)]))


def agent_works(tl, pal, j):
    star = [[0, -9], [2.4, -2.4], [9, 0], [2.4, 2.4], [0, 9], [-2.4, 2.4], [-9, 0], [-2.4, -2.4]]
    tl.add('agent', [gr([sh(star), fl(pal['accent'])]), gr([el(0, 0, 30, 30), stk(pal['stroke'], SW), fl(pal['jar'])])],
           p=kf([(0, [214, 44]), (22, [214, 39]), (45, [214, 44]), (67, [214, 39]), (89, [214, 44])]),
           s=kf([(30, [100, 100, 100]), (34, [88, 88, 100]), (40, [100, 100, 100])]),
           o=kf([(0, 0), (6, 100), (82, 100), (89, 0)]))
    path = sh([[200, 52], [150, 92]], closed=False, ins=[[0, 0], [24, -26]], outs=[[-18, 0], [0, 0]])
    tl.add('reach', [gr([path, tm(kf([(10, 0), (32, 100)], OUTE), kf([(56, 0), (72, 100)], OUTE)),
                         stk(pal['stroke'], SW, gap=DASH)])])
    tl.add('tap', [gr([el(0, 0, 18, 18), stk(pal['stroke'], LSW), fl(pal['accent'], 35)], p=(10, -4),
                      s=kf([(32, [40, 40]), (46, [220, 220])], OUTE))], parent=j,
           o=kf([(31, 0, 'hold'), (32, 100), (46, 0)]))


def parallel_change_arrives(tl, pal, k):
    tl.add('plus', [gr([sh([[-4, 0], [4, 0]], closed=False), sh([[0, -4], [0, 4]], closed=False),
                        stk(pal['okfg'], 2)]),
                    gr([el(0, 0, 16, 16), stk(pal['stroke'], SW), fl(pal['ok'])])],
           p=kf([(14, [RIGHT[0] - 14, 84]), (22, [RIGHT[0] - 30, 62], OUTE)]),
           s=kf([(14, [0, 0, 100]), (22, [100, 100, 100], POP), (60, [100, 100, 100]), (68, [0, 0, 100])]))
    brush = [gr([sh([[0, -2], [0, -20]], closed=False), stk(pal['stroke'], 3)]),
             gr([rc(0, 3, 10, 10, 3), stk(pal['stroke'], SW), fl(pal['accent'])])]
    tl.add('brush', [gr(brush, r=-35)],
           p=kf([(0, [RIGHT[0] - 34, 64]), (6, [RIGHT[0] - 14, 92]), (20, [RIGHT[0] + 16, 92]),
                 (28, [RIGHT[0] + 36, 64])]),
           o=kf([(0, 0), (4, 100), (22, 100), (28, 0)]))
    tl.add('swatch', [gr([rc(0, 4, 42, 70, 7), fl(pal['screen'])], p=(-21, 4), a=(-21, 4),
                         s=kf([(6, [0, 100]), (20, [100, 100])], SMOOTH))], parent=k,
           o=kf([(0, 100), (30, 100), (32, 0)]))


def parallel_agent_works(tl, pal, k):
    star = [[0, -9], [2.4, -2.4], [9, 0], [2.4, 2.4], [0, 9], [-2.4, 2.4], [-9, 0], [-2.4, -2.4]]
    tl.add('agent', [gr([sh(star), fl(pal['accent'])]), gr([el(0, 0, 30, 30), stk(pal['stroke'], SW), fl(pal['jar'])])],
           p=kf([(0, [262, 34]), (22, [262, 29]), (45, [262, 34]), (67, [262, 29]), (89, [262, 34])]),
           s=kf([(16, [100, 100, 100]), (19, [88, 88, 100]), (24, [100, 100, 100])]),
           o=kf([(0, 0), (6, 100), (82, 100), (89, 0)]))
    path = sh([[250, 42], [RIGHT[0] + 4, 96]], closed=False, ins=[[0, 0], [20, -24]], outs=[[-14, 0], [0, 0]])
    tl.add('reach', [gr([path, tm(kf([(2, 0), (18, 100)], OUTE), kf([(32, 0), (46, 100)], OUTE)),
                         stk(pal['stroke'], SW, gap=DASH)])])
    tl.add('tap', [gr([el(0, 0, 18, 18), stk(pal['stroke'], LSW), fl(pal['accent'], 35)], p=(6, 4),
                      s=kf([(18, [40, 40]), (32, [220, 220])], OUTE))], parent=k,
           o=kf([(17, 0, 'hold'), (18, 100), (32, 0)]))


def build(pal):
    tl = Timeline()
    HEAD = pal['muted']

    tl.segment('begin', LOOP, still=80)
    j = rig(tl, 'jar', st(HOME + [0]))
    tl.add('pkg', package(pal), p=kf([(0, [52, 92], 'hold'), (8, [52, 92]), (24, [98, 30]), (38, [144, 34]),
                                      (50, [144, 92], ({'x': [0.3], 'y': [1]}, {'x': [0.5], 'y': [0]}))]),
           o=kf([(0, 0, 'hold'), (8, 100), (60, 100), (70, 0)]),
           s=kf([(48, [100, 100, 100]), (54, [130, 130, 100]), (62, [0, 0, 100])], POP))
    tl.add('repo', repo_card(pal), p=st([52, 92]))
    phone(tl, pal, j, nm='seed', header=HEAD, o=kf([(56, 0), (64, 100), (82, 100), (89, 0)]),
          s=kf([(56, [20, 20, 100]), (66, [100, 100, 100])], POP))
    sparkle(tl, pal, j, 62)
    jar(tl, pal, j, gap=[(0, 0), (6, LDASH), (60, LDASH), (66, 0)],
        fill_op=kf([(0, 100), (6, 25), (60, 25), (66, 100)]))

    tl.segment('begin>build', TRANS)
    j = rig(tl, 'jar', st(HOME + [0]))
    tl.add('repo', repo_card(pal), p=kf([(0, [52, 92]), (14, [20, 92])]), o=kf([(0, 100), (14, 0)]))
    phone(tl, pal, j, header=HEAD, o=kf([(0, 0), (12, 100)]), trim=kf([(0, 0), (14, 100)], OUTE),
          gap=[(10, LDASH), (20, 0)], fill_op=kf([(10, 0), (22, 100)]))
    jar(tl, pal, j)

    tl.segment('build', LOOP, still=74)
    j = rig(tl, 'jar', st(HOME + [0]), s=kf([(50, [100, 100, 100]), (54, [104, 104, 100]), (62, [100, 100, 100])]))
    check_badge(tl, pal, j, st([60, -76]), kf([(58, [0, 0, 100]), (68, [100, 100, 100]), (82, [100, 100, 100]),
                                              (88, [0, 0, 100])], POP))
    (change_arrives if CHANGE_EFFECT == 'a' else agent_works)(tl, pal, j)
    sparkle(tl, pal, j, 50)
    recolor = ckf([(38, HEAD), (46, pal['accent']), (80, pal['accent']), (89, HEAD)])
    phone(tl, pal, j, header=HEAD if CHANGE_EFFECT == 'a' else recolor)
    jar(tl, pal, j)

    tl.segment('build>parallel', TRANS)
    j = rig(tl, 'jar', kf([(0, HOME + [0]), (18, LEFT + [0])]))
    k = rig(tl, 'jar2', st(RIGHT + [0]))
    phone(tl, pal, j, header=HEAD)
    jar(tl, pal, j)
    jar(tl, pal, k, nm='jar2', trim=kf([(6, 0), (22, 100)], OUTE), gap=LDASH, fill_op=0)

    tl.segment('parallel', LOOP, still=50)
    j = rig(tl, 'jar', st(LEFT + [0]))
    k = rig(tl, 'jar2', st(RIGHT + [0]), s=kf([(30, [100, 100, 100]), (34, [104, 104, 100]),
                                               (42, [100, 100, 100])]))
    (parallel_change_arrives if CHANGE_EFFECT == 'a' else parallel_agent_works)(tl, pal, k)
    tl.add('bolt', bolt_shape(pal), p=kf([(20, [RIGHT[0] + 4, 2]), (30, [RIGHT[0] + 4, 30])], OUTE),
           o=kf([(20, 0), (24, 100), (32, 100), (38, 0)]))
    tl.add('bolt-badge', [gr(bolt_shape(pal), s=60)], p=st([RIGHT[0] + 30, 52]),
           s=kf([(36, [0, 0, 100]), (44, [100, 100, 100]), (78, [100, 100, 100]), (86, [0, 0, 100])], POP))
    sparkle(tl, pal, k, 34)
    phone(tl, pal, k, nm='phone2', header=HEAD, screen_op=100, o=kf([(30, 0, 'hold'), (31, 100), (80, 100),
                                                                       (88, 0)]),
          s=kf([(30, [60, 60, 100]), (38, [100, 100, 100]), (80, [100, 100, 100])], POP))
    jar(tl, pal, k, nm='jar2', gap=[(24, LDASH), (30, 0), (80, 0), (88, LDASH)],
        fill_op=kf([(0, 0), (24, 0), (30, 100), (80, 100), (88, 0)]))
    tl.add('progress', [gr([rc(0, 0, 44, 6, 3), stk(pal['stroke'], SW)]),
                        gr([sh([[-20, 0], [20, 0]], closed=False), tm(kf([(0, 0), (89, 100)], LIN)),
                            stk(pal['accent'], 3)])], p=st([LEFT[0], 160]))
    phone(tl, pal, j, header=ckf([(50, HEAD), (60, pal['accent']), (80, pal['accent']), (89, HEAD)]))
    jar(tl, pal, j)

    tl.segment('device', LOOP, still=40)
    j = rig(tl, 'jar', st(LEFT + [0]))
    for n, t in enumerate((30, 62)):
        spot = [[-10, 6], [8, 20]][n]
        tl.add(f'tap{n}', [gr([el(0, 0, 18, 18), stk(pal['stroke'], LSW), fl(pal['accent'], 35)], p=spot,
                              s=kf([(t, [40, 40]), (t + 12, [200, 200])], OUTE))], parent=j,
               o=kf([(t - 1, 0, 'hold'), (t, 100), (t + 12, 0)]))
        mx, my = 210 + spot[0] * 0.36, 100 + spot[1] * 0.36
        tl.add(f'vtap{n}', [gr([el(0, 0, 10, 10), stk(pal['stroke'], SW), fl(pal['accent'], 35)], p=(mx, my),
                               s=kf([(t, [40, 40]), (t + 12, [200, 200])], OUTE))],
               o=kf([(t - 1, 0, 'hold'), (t, 100), (t + 12, 0)]))
    cursor = [gr([sh([[0, 0], [0, 16], [4, 12], [7, 19], [10, 17], [7, 11], [12, 11]]), stk(pal['jar'], 1.5),
                  fl(pal['stroke'])])]
    tl.add('cursor', cursor, p=kf([(0, [262, 140]), (26, [206, 102]), (34, [206, 102]), (56, [213, 107]),
                                   (66, [213, 107]), (88, [262, 140])]),
           s=kf([(28, [100, 100, 100]), (30, [85, 85, 100]), (34, [100, 100, 100]), (60, [100, 100, 100]),
                 (62, [85, 85, 100]), (66, [100, 100, 100])]))
    mini = [gr([rc(210, 84, 14, 3, 1.5), fl(pal['accent'])]),
            gr([rc(210, 99, 20, 36, 5), stk(pal['stroke'], SW), fl(pal['side'])])]
    window = [gr([el(158, 60, 5, 5), el(166, 60, 5, 5), el(174, 60, 5, 5), fl(pal['muted'])]),
              gr([sh([[148, 68], [272, 68]], closed=False), stk(pal['stroke'], SW)]),
              gr([rc(210, 94, 124, 84, 10), stk(pal['stroke'], SW), fl(pal['jar'])])]
    tl.add('mini', mini)
    tl.add('window', window)
    tl.add('link', [gr([hlink(jar_right(LEFT[0]), box_edges(210, 124)[0], 94), stk(pal['stroke'], SW, gap=DASH)])])
    phone(tl, pal, j, header=pal['accent'])
    jar(tl, pal, j)

    tl.segment('agent', LOOP, still=60)
    j = rig(tl, 'jar', st(LEFT + [0]))
    xs = [178, 206, 230, 252]
    head_x = kf([(6, [166, 112]), (76, [262, 112], LIN)])
    tl.add('playhead', [gr([sh([[0, -16], [0, 8]], closed=False), stk(pal['stroke'], SW)]),
                        gr([el(0, -18, 8, 8), fl(pal['top'])])], p=head_x, o=kf([(0, 0), (6, 100), (80, 100),
                                                                                (88, 0)]))
    for n, x in enumerate(xs):
        t = 6 + (x - 166) / 96 * 70
        tl.add(f'dot{n}', [gr([el(0, 0, 9, 9), stk(pal['stroke'], SW), fl(pal['accent'])])], p=st([x, 112]),
               s=kf([(t - 1, [100, 100, 100]), (t + 3, [160, 160, 100]), (t + 9, [100, 100, 100])], POP))
        spot = [[-12, 10], [10, -6], [-6, 24], [8, 14]][n]
        tl.add(f'tap{n}', [gr([el(0, 0, 18, 18), stk(pal['stroke'], LSW), fl(pal['accent'], 35)], p=spot, a=(0, 0),
                              s=kf([(t, [40, 40]), (t + 12, [200, 200])], OUTE))], parent=j,
               o=kf([(t - 1, 0, 'hold'), (t, 100), (t + 12, 0)]))
    tl.add('track', [gr([sh([[166, 112], [262, 112]], closed=False), stk(pal['muted'], 3)]),
                     gr([sh([[154, 70], [154, 82], [164, 76]]), fl(pal['top'])]),
                     gr([rc(184, 72, 18, 12, 3), rc(208, 72, 18, 12, 3), rc(232, 72, 18, 12, 3), rc(256, 72, 18, 12,
                                                                                                   3),
                         stk(pal['stroke'], SW), fl(pal['side'])]),
                     gr([rc(210, 92, 128, 64, 10), stk(pal['stroke'], SW), fl(pal['jar'])])])
    phone(tl, pal, j, header=pal['accent'])
    jar(tl, pal, j)

    tl.segment('logs', LOOP, still=70)
    j = rig(tl, 'jar', st(LEFT + [0]))
    for n in range(5):
        t = 6 + n * 9
        y = 66 + n * 13
        mine = n == 2
        w = [70, 52, 80, 44, 64][n]
        tl.add(f'line{n}', [gr([sh([[168, y], [168 + w, y]], closed=False), tm(kf([(t, 0), (t + 8, 100)], OUTE)),
                                stk(pal['accent'] if mine else pal['muted'], 4)]),
                            gr([el(158, y, 6, 6), fl(pal['accent'] if mine else pal['muted'])])],
               o=kf([(t - 1, 0, 'hold'), (t, 100), (80, 100), (88, 0)]))
        if mine:
            tl.add('mark', [gr([rc(208, y, 112, 11, 5), fl(pal['side'])])],
                   o=kf([(t + 8, 0), (t + 14, 100), (80, 100), (88, 0)]))
    tl.add('card', [gr([rc(210, 94, 128, 84, 10), stk(pal['stroke'], SW), fl(pal['jar'])])])
    tl.add('flow', [gr([hlink(jar_right(LEFT[0]), box_edges(210, 128)[0], 94), stk(pal['stroke'], SW, gap=DASH)])])
    phone(tl, pal, j, header=pal['accent'])
    jar(tl, pal, j)

    tl.segment('phone', LOOP, still=60)
    tl.add('scan', [gr([sh([[-18, 0], [18, 0]], closed=False), stk(pal['accent'], 3)])],
           p=kf([(4, [206, 66]), (22, [206, 120]), (30, [206, 66])]), o=kf([(2, 0), (6, 100), (30, 100), (34, 0)]))
    tl.add('minijar', [gr([el(0, -9, 22, 10), stk(pal['stroke'], SW), fl(pal['jar'])]),
                       gr([sh([[-11, -9], [-11, 9], [11, 9], [11, -9]], closed=False), stk(pal['stroke'], SW)]),
                       gr([el(0, 9, 22, 10), stk(pal['stroke'], SW), fl(pal['jar'])])],
           p=st([206, 96]), s=kf([(40, [0, 0, 100]), (50, [100, 100, 100], POP), (80, [100, 100, 100]),
                                  (88, [0, 0, 100])]))
    tl.add('handset', [gr([rc(206, 54, 16, 5, 2.5), fl(pal['top'])]),
                       gr([rc(206, 94, 54, 96, 12), stk(pal['stroke'], SW), fl(pal['side'])])])
    link_gap = [(34, DASH), (42, 0), (80, 0), (88, DASH)]
    tl.add('link', [gr([hlink(box_edges(90, 52)[1], box_edges(206, 54)[0], 94), stk(pal['stroke'], SW, gap=link_gap)])])
    qr = [rc(80 + (n % 4) * 7, 80 + (n // 4) * 7, 5, 5, 1) for n in range(16) if n not in (5, 6, 9, 10, 3, 12)]
    tl.add('code', [gr([rc(73, 73, 12, 12, 2), rc(101, 73, 12, 12, 2), rc(73, 101, 12, 12, 2),
                        stk(pal['stroke'], SW), fl(pal['side'])]),
                    gr(qr + [fl(pal['stroke'])], p=(-4, 0)),
                    gr([rc(87, 87, 52, 52, 8), stk(pal['stroke'], SW), fl(pal['jar'])])], p=st([3, 7]))

    tl.segment('share', LOOP, still=64)
    j = rig(tl, 'jar', st(LEFT + [0]))
    cx, cy, cw, ch = 212, 94, 120, 88
    left = box_edges(cx, cw)[0]
    sparkle(tl, pal, None, 46, center=(cx, cy - ch / 2), rx=cw / 2 - 6, ry=8, sw=SW, gap=4, length=8)
    tl.add('glyph', [gr(branch_glyph(pal, sw=SW * 2), p=(left + 16, cy - ch / 2 + 14), s=50)],
           o=kf([(34, 0), (40, 100), (80, 100), (88, 0)]))
    for n, (title, x) in enumerate((('muted', cx - 26), ('accent', cx + 26))):
        t = 8 + n * 6
        mini = [gr([rc(0, -12, 14, 4, 2), fl(pal['muted'] if title == 'muted' else pal['accent'])]),
                gr([rc(0, 0, 22, 38, 5), stk(pal['stroke'], SW), fl(pal['side'])])]
        tl.add(f'mini{n}', mini,
               p=kf([(t, LEFT + [0]), (t + 12, [(LEFT[0] + x) / 2, 40]), (t + 22, [x, cy + 12], OUTE)]),
               s=kf([(t, [40, 40, 100]), (t + 22, [100, 100, 100])]),
               o=kf([(t - 1, 0, 'hold'), (t, 0), (t + 4, 100), (80, 100), (88, 0)]))
    tl.add('card', [gr([sh([[cx, cy - ch / 2 + 28], [cx, cy + ch / 2 - 8]], closed=False),
                        sh([[cx - cw / 2, cy - ch / 2 + 26], [cx + cw / 2, cy - ch / 2 + 26]], closed=False),
                        stk(pal['muted'], 1.5)]),
                    gr([rc(cx + 12, cy - ch / 2 + 14, 60, 4, 2), fl(pal['muted'])]),
                    gr([rc(cx, cy, cw, ch, 12), stk(pal['stroke'], SW), fl(pal['jar'])])])
    phone(tl, pal, j, header=pal['accent'])
    jar(tl, pal, j)

    tl.segment('finish', LOOP, still=60)
    j = rig(tl, 'jar', st(HOME + [0]), s=kf([(44, [100, 100, 100]), (47, [103, 97, 100]), (52, [100, 100, 100])]))
    sparkle(tl, pal, j, 50)
    lid(tl, pal, j, p=kf([(0, [0, 0]), (10, [0, -40]), (34, [0, -40]), (46, [0, 0], OUTE)]),
        o=kf([(0, 100), (8, 0), (34, 0), (40, 100)]))
    phone(tl, pal, j, header=pal['accent'], o=kf([(2, 0), (10, 100), (20, 100), (32, 0)]))
    jar(tl, pal, j)

    tl.segment('finish>delete', TRANS)
    j = rig(tl, 'jar', st(HOME + [0]), s=kf([(4, [100, 100, 100]), (12, [103, 97, 100]), (22, [100, 100, 100])]))
    lid(tl, pal, j)
    jar(tl, pal, j)

    tl.segment('delete', LOOP, still=40)
    j = rig(tl, 'jar', st(HOME + [0]))
    fill = kf([(2, 100, SMOOTH), (12, 0), (78, 0, SMOOTH), (86, 100)])
    gap = [(14, 0, SMOOTH), (24, LDASH), (72, LDASH, SMOOTH), (78, 0)]
    lid(tl, pal, j, fill_op=fill, gap=gap, trim=kf([(26, 100, UNTRACE), (40, 0), (60, 0, OUTE), (70, 100)]))
    jar(tl, pal, j, fill_op=fill, gap=gap, trim=kf([(30, 100, UNTRACE), (46, 0), (56, 0, OUTE), (72, 100)]))

    return {'v': '5.7.4', 'fr': FPS, 'ip': 0, 'op': tl.t, 'w': W, 'h': H, 'nm': 'Stim tutorial', 'ddd': 0,
            'assets': [], 'markers': tl.markers, 'layers': tl.layers}


def step_done(pal):
    global OFF
    OFF = 0
    tl = Timeline()
    tl.segment('done', 30)
    burst(tl, pal, [20, 20], 4, radius=13, length=5, sw=1.6)
    tl.add('tick', [gr([sh([[-5, 0], [-1.5, 4], [6, -4]], closed=False), tm(kf([(6, 0), (14, 100)], OUTE)),
                        stk(pal['okfg'], 2)])], p=st([20, 20]))
    tl.add('disc', [gr([el(0, 0, 20, 20), fl(pal['ok'])])], p=st([20, 20]),
           s=kf([(0, [0, 0, 100]), (8, [120, 120, 100], POP), (14, [100, 100, 100])]))
    return {'v': '5.7.4', 'fr': FPS, 'ip': 0, 'op': 30, 'w': 40, 'h': 40, 'nm': 'Stim step done', 'ddd': 0,
            'assets': [], 'markers': [], 'layers': tl.layers}


for theme, palette in PALETTES.items():
    (BRANDING / f'stim-tutorial-{theme}.json').write_text(json.dumps(build(palette), separators=(',', ':')))
    (BRANDING / f'stim-step-done-{theme}.json').write_text(json.dumps(step_done(palette), separators=(',', ':')))

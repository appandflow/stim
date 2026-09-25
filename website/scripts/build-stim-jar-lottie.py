import io
import json
import math
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import pathops
from lottie.exporters.svg import export_svg
from lottie.importers.core import import_lottie

ROOT = Path(__file__).resolve().parent.parent.parent
BRANDING = ROOT / 'website' / 'static' / 'img' / 'branding'
MOBILE_ANIMATIONS = ROOT / 'apps' / 'mobile' / 'assets' / 'animations'
CROP_X, CROP_Y, CROP_W, CROP_H = 426, 665, 278, 450
OX, OY = CROP_X, CROP_Y
FPS = 60
BOB = 3.2 * FPS
ORBIT = 2.4 * FPS
OP = round(9.6 * FPS)
K = 0.5522847498
IDENTITY = 'matrix(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)'


def r2(v):
    v = round(v, 2)
    return int(v) if v == int(v) else v


def rgb(hexc):
    h = hexc.upper().replace('WHITE', '#FFFFFF').lstrip('#')
    return [round(int(h[i:i + 2], 16) / 255, 4) for i in (0, 2, 4)]


def parse_d(d):
    toks = re.findall(r'[MLHVCZmlhvcz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?', d)
    i, cmd, subs, cur, pt, start = 0, None, [], None, (0, 0), (0, 0)
    while i < len(toks):
        t = toks[i]
        if re.match(r'[A-Za-z]', t):
            cmd = t
            i += 1
            if cmd in 'Zz':
                cur['closed'] = True
                pt = start
                continue
        rel = cmd.islower()
        c = cmd.upper()
        ox, oy = pt if rel else (0, 0)
        if c == 'M':
            pt = (float(toks[i]) + ox, float(toks[i + 1]) + oy); i += 2
            cur = {'start': pt, 'segs': [], 'closed': False}
            subs.append(cur)
            start = pt
            cmd = 'l' if rel else 'L'
        elif c == 'L':
            pt = (float(toks[i]) + ox, float(toks[i + 1]) + oy); i += 2
            cur['segs'].append(('L', pt))
        elif c == 'H':
            pt = (float(toks[i]) + ox, pt[1]); i += 1
            cur['segs'].append(('L', pt))
        elif c == 'V':
            pt = (pt[0], float(toks[i]) + (pt[1] if rel else 0)); i += 1
            cur['segs'].append(('L', pt))
        elif c == 'C':
            v = [float(x) for x in toks[i:i + 6]]; i += 6
            c1 = (v[0] + ox, v[1] + oy); c2 = (v[2] + ox, v[3] + oy); pt = (v[4] + ox, v[5] + oy)
            cur['segs'].append(('C', c1, c2, pt))
        else:
            raise ValueError(c)
    return subs


def sub_to_shape(sub):
    v, ii, oo = [sub['start']], [(0, 0)], [(0, 0)]
    for s in sub['segs']:
        if s[0] == 'L':
            v.append(s[1]); ii.append((0, 0)); oo.append((0, 0))
        else:
            _, c1, c2, p = s
            oo[-1] = (c1[0] - v[-1][0], c1[1] - v[-1][1])
            v.append(p); ii.append((c2[0] - p[0], c2[1] - p[1])); oo.append((0, 0))
    closed = sub['closed']
    if closed and len(v) > 1 and abs(v[-1][0] - v[0][0]) < 1e-3 and abs(v[-1][1] - v[0][1]) < 1e-3:
        ii[0] = ii[-1]
        v.pop(); ii.pop(); oo.pop()
    pts = lambda arr, off: [[r2(x - (OX if off else 0)), r2(y - (OY if off else 0))] for x, y in arr]
    return {'ty': 'sh', 'ks': {'a': 0, 'k': {'c': closed, 'v': pts(v, True), 'i': pts(ii, False), 'o': pts(oo, False)}}}


def shapes_of(subs):
    return [sub_to_shape(s) for s in subs]


def ellipse_sub(cx, cy, rx, ry, m=(1, 0, 0, 1, 0, 0)):
    a, b, c, d, e, f = m
    tp = lambda x, y: (a * x + c * y + e, b * x + d * y + f)
    pts = [(cx + rx, cy, (0, K * ry)), (cx, cy + ry, (-K * rx, 0)), (cx - rx, cy, (0, -K * ry)), (cx, cy - ry, (K * rx, 0))]
    sub = {'start': tp(*pts[0][:2]), 'segs': [], 'closed': True}
    for j in range(4):
        x0, y0, o0 = pts[j]
        x1, y1, o1 = pts[(j + 1) % 4]
        sub['segs'].append(('C', tp(x0 + o0[0], y0 + o0[1]), tp(x1 - o1[0], y1 - o1[1]), tp(x1, y1)))
    return sub


def to_pathops(subs):
    p = pathops.Path()
    for s in subs:
        p.moveTo(*s['start'])
        for seg in s['segs']:
            if seg[0] == 'L':
                p.lineTo(*seg[1])
            else:
                p.cubicTo(*seg[1], *seg[2], *seg[3])
        if s['closed']:
            p.close()
    return p


def from_pathops(p):
    subs, cur = [], None
    for verb, pts in p.segments:
        if verb == 'moveTo':
            cur = {'start': pts[0], 'segs': [], 'closed': False}; subs.append(cur)
        elif verb == 'lineTo':
            cur['segs'].append(('L', pts[0]))
        elif verb == 'curveTo':
            cur['segs'].append(('C', pts[0], pts[1], pts[2]))
        elif verb == 'qCurveTo':
            p0 = cur['segs'][-1][-1] if cur['segs'] else cur['start']
            q, e = pts
            cur['segs'].append(('C', (p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1])),
                                (e[0] + 2 / 3 * (q[0] - e[0]), e[1] + 2 / 3 * (q[1] - e[1])), e))
        elif verb in ('closePath', 'endPath'):
            cur['closed'] = verb == 'closePath'
        else:
            raise ValueError(verb)
    return subs


def static(v):
    return {'a': 0, 'k': v}


def fill(hexc):
    return {'ty': 'fl', 'c': static(rgb(hexc)), 'o': static(100), 'r': 1}


def stroke(hexc, w=1, lc=1):
    return {'ty': 'st', 'c': static(rgb(hexc)), 'o': static(100), 'w': static(w), 'lc': lc, 'lj': 1, 'ml': 4}


def tr(p=(0, 0), s=(100, 100), r=0, sk=0):
    t = {'ty': 'tr', 'p': static([r2(p[0]), r2(p[1])]), 'a': static([0, 0]),
         's': static([r2(s[0]), r2(s[1])]), 'r': static(r2(r)), 'o': static(100)}
    if sk:
        t['sk'] = static(r2(sk))
        t['sa'] = static(0)
    return t


def group(nm, items, t=None):
    return {'ty': 'gr', 'nm': nm, 'it': items + [t or tr()]}


def matrix_to_tr(m):
    a, b, c, d, e, f = m
    sx = math.hypot(a, b)
    th = math.atan2(b, a)
    xp = math.cos(th) * c + math.sin(th) * d
    yp = -math.sin(th) * c + math.cos(th) * d
    return tr((e - OX, f - OY), (sx * 100, yp * 100), math.degrees(th), -math.degrees(math.atan(xp / yp)))


def parse_matrix(s):
    if s.startswith('matrix'):
        return tuple(float(x) for x in re.findall(r'-?[\d.]+', s))
    if s.startswith('rotate'):
        ang, cx, cy = (float(x) for x in re.findall(r'-?[\d.]+', s))
        ca, sa = math.cos(math.radians(ang)), math.sin(math.radians(ang))
        return (ca, sa, -sa, ca, cx - ca * cx + sa * cy, cy - sa * cx - ca * cy)
    raise ValueError(s)


def layer(ind, nm, shapes, pos=None, parent=None):
    L = {'ddd': 0, 'ind': ind, 'ty': 4, 'nm': nm, 'sr': 1,
         'ks': {'o': static(100), 'r': static(0), 'p': pos or static([0, 0]), 'a': static([0, 0]), 's': static([100, 100])},
         'ao': 0, 'shapes': shapes, 'ip': 0, 'op': OP, 'st': 0, 'bm': 0}
    if parent is not None:
        L['parent'] = parent
    return L


EASE = ((0.42, 0), (0.58, 1))


def bez(p, u):
    a, b, c, d = p
    return tuple((1 - u) ** 3 * a[i] + 3 * (1 - u) ** 2 * u * b[i] + 3 * (1 - u) * u * u * c[i] + u ** 3 * d[i] for i in (0, 1))


def split(p, u):
    a, b, c, d = p
    L = lambda x, y: (x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u)
    ab, bc, cd = L(a, b), L(b, c), L(c, d)
    abc, bcd = L(ab, bc), L(bc, cd)
    m = L(abc, bcd)
    return (a, ab, abc, m), (m, bcd, cd, d)


def u_at_x(p, x):
    lo, hi = 0.0, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if bez(p, mid)[0] < x else (lo, mid)
    return (lo + hi) / 2


def clipped_ease(x0, x1):
    p = ((0, 0), EASE[0], EASE[1], (1, 1))
    if x0 > 0:
        p = split(p, u_at_x(p, x0))[1]
    if x1 < 1:
        p = split(p, u_at_x(p, x1))[0]
    (ax, ay), b, c, (dx, dy) = p
    n = lambda q: (round((q[0] - ax) / (dx - ax), 4), round((q[1] - ay) / (dy - ay), 4))
    return ay, dy, n(b), n(c)


def bob_pos(amp, phase_frames):
    half = BOB / 2
    vals = lambda k: -amp if k % 2 else 0
    kfs, t = [], 0.0
    while t < OP - 1e-6:
        k = int((t + phase_frames) // half)
        seg0 = k * half - phase_frames
        t1 = min(seg0 + half, OP)
        ay, dy, o, i = clipped_ease((t - seg0) / half, (t1 - seg0) / half)
        v0, v1 = vals(k), vals(k + 1)
        kfs.append({'t': r2(t), 's': [0, r2(v0 + (v1 - v0) * ay)],
                    'o': {'x': o[0], 'y': o[1]}, 'i': {'x': i[0], 'y': i[1]}})
        end_v = r2(v0 + (v1 - v0) * dy)
        t = t1
    kfs.append({'t': r2(t), 's': [0, end_v]})
    return {'a': 1, 'k': kfs}


def sawtooth(period, end_value):
    eps = 0.01
    lin = {'o': {'x': [0], 'y': [0]}, 'i': {'x': [1], 'y': [1]}}
    kfs, t = [], 0
    while t < OP - 1e-6:
        kfs.append({'t': r2(t), 's': [0], **lin})
        te = t + period - eps
        kfs.append({'t': round(te, 2), 's': [round(end_value * (period - eps) / period, 3)], 'h': 1})
        t += period
    kfs.append({'t': r2(t), 's': [0]})
    return {'a': 1, 'k': kfs}


def build(svg_path, electron_hex):
    root = ET.parse(svg_path).getroot()
    by = {el.get('id'): el for el in root.iter() if el.get('id')}

    def path_group(el):
        items = shapes_of(parse_d(el.get('d')))
        if el.get('stroke'):
            items.append(stroke(el.get('stroke')))
        if el.get('fill') and el.get('fill') != 'none':
            items.append(fill(el.get('fill')))
        return group(el.get('id') or 'path', items)

    def union_group(gid):
        mask_path = None
        out = []
        for ch in by[gid]:
            tag = ch.tag.split('}')[1]
            if tag == 'mask':
                mask_path = parse_d(ch[0].get('d'))
            elif tag == 'path':
                subs = parse_d(ch.get('d'))
                if ch.get('mask'):
                    clipped = pathops.op(to_pathops(subs), to_pathops(mask_path), pathops.PathOp.INTERSECTION)
                    subs = from_pathops(clipped)
                out.append(group('outline' if ch.get('mask') or len(out) else 'body', shapes_of(subs) + [fill(ch.get('fill'))]))
        return group(gid, list(reversed(out)))

    def ellipse_group(el, fill_hex=None, stroke_hex=None, width=1, lc=1, extra=None):
        m = el.get('transform')
        ecx, ecy, rx, ry = (float(el.get(k)) for k in ('cx', 'cy', 'rx', 'ry'))
        if m and m.startswith('matrix'):
            sub = ellipse_sub(ecx + OX, ecy + OY, rx, ry)
            t = matrix_to_tr(parse_matrix(m))
        else:
            sub = ellipse_sub(ecx, ecy, rx, ry, parse_matrix(m) if m else (1, 0, 0, 1, 0, 0))
            t = None
        items = shapes_of([sub]) + (extra or [])
        if stroke_hex:
            items.append(stroke(stroke_hex, width, lc))
        if fill_hex:
            items.append(fill(fill_hex))
        return group(el.get('id') or 'ellipse', items, t)

    jar_items = [union_group('Union'), union_group('Union_2')]
    mouth = ET.Element('ellipse', {'id': 'mouth', 'cx': '565', 'cy': '780', 'rx': '126', 'ry': '69'})
    jar_items.append(ellipse_group(mouth, fill_hex=by['Ellipse 9796'].get('fill'), stroke_hex=by['Ellipse 9797'].get('stroke')))
    jar_items.append(path_group(by['Ellipse 9796']))

    def tab(u, rect):
        return [path_group(by[rect]), group(u, [path_group(e) for e in reversed(list(by[u]))])]

    label = [path_group(e) for e in reversed(list(by['Stim_2']))]
    orbit_ids = ['Ellipse 9799', 'Ellipse 9800', 'Ellipse 9801']
    orbits = [ellipse_group(by[i], stroke_hex=by[i].get('stroke')) for i in orbit_ids]
    orbits.append(ellipse_group(by['Ellipse 9802'], fill_hex=by['Ellipse 9802'].get('fill')))
    lid_items = [path_group(by['Ellipse 9797']), union_group('Union_6'), path_group(by['Ellipse 9798']),
                 group('orbits', list(reversed(orbits)))]

    IND = {'jar': 1, 'tab1': 2, 'tab2': 3, 'tab3': 4, 'label': 5, 'lid': 6}
    layers = [layer(IND['jar'], 'jar', list(reversed(jar_items)))]
    for n, (u, rct), ph in (('tab1', ('Union_3', 'Rectangle 34651015'), 0), ('tab2', ('Union_4', 'Rectangle 34650997'), 66),
                            ('tab3', ('Union_5', 'Rectangle 34650998'), 132)):
        layers.append(layer(IND[n], n, tab(u, rct), pos=bob_pos(7, ph)))
    layers.append(layer(IND['label'], 'label', label, parent=IND['tab3']))
    layers.append(layer(IND['lid'], 'lid', list(reversed(lid_items)), pos=bob_pos(4, 0)))
    for j, oid in enumerate(orbit_ids):
        trim = {'ty': 'tm', 's': static(0), 'e': static(0.1), 'o': sawtooth(ORBIT, 360), 'm': 1}
        eg = ellipse_group(by[oid], stroke_hex=electron_hex, width=4, lc=2, extra=[trim])
        eg['nm'] = f'electron{j + 1}'
        layers.append(layer(7 + j, f'electron{j + 1}', [eg], parent=IND['lid']))

    return {'v': '5.7.4', 'fr': FPS, 'ip': 0, 'op': OP, 'w': CROP_W, 'h': CROP_H, 'nm': 'Stim jar', 'ddd': 0,
            'assets': [], 'layers': list(reversed(layers))}


def background(svg_path):
    src = svg_path.read_text()
    start = src.index('<g id="Group 54"')
    depth = 0
    for m in re.finditer(r'<g\b|</g>', src[start:]):
        depth += 1 if m.group() == '<g' else -1
        if depth == 0:
            end = start + m.end()
            break
    head = src[:src.index('>', src.index('<svg')) + 1]
    return f'{head}\n{src[start:end]}\n</svg>\n'


def first_frame(json_path):
    buf = io.StringIO()
    export_svg(import_lottie(str(json_path)), buf, frame=0)
    root = ET.fromstring(buf.getvalue())
    for el in list(root.iter()):
        el.text = el.tail = None
        for child in list(el):
            if not child.tag.startswith('{http://www.w3.org/2000/svg}') or child.tag.endswith('}defs'):
                el.remove(child)
        for key in list(el.attrib):
            if key.startswith('{') or key in ('id', 'version') or el.get(key) in ('', IDENTITY):
                del el.attrib[key]
        if 'd' in el.attrib:
            el.set('d', re.sub(r'-?\d+\.\d{3,}', lambda m: f'{float(m.group()):.2f}', el.get('d')))
    ET.register_namespace('', 'http://www.w3.org/2000/svg')
    return ET.tostring(root, encoding='unicode') + '\n'


for theme, svg, electron in (('light', 'hero.svg', '#FFFFFF'), ('dark', 'hero-dark.svg', '#5521FF')):
    anim = build(BRANDING / svg, electron)
    json_path = BRANDING / f'stim-jar-{theme}.json'
    json_path.write_text(json.dumps(anim, separators=(',', ':')))
    (MOBILE_ANIMATIONS / json_path.name).write_text(json_path.read_text())
    (BRANDING / f'stim-jar-{theme}.svg').write_text(first_frame(json_path))
    suffix = '' if theme == 'light' else '-dark'
    (BRANDING / f'hero-bg{suffix}.svg').write_text(background(BRANDING / svg))

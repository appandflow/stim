import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BRANDING = ROOT / 'website' / 'static' / 'img' / 'branding'
MOBILE_ANIMATIONS = ROOT / 'apps' / 'mobile' / 'assets' / 'animations'
OX, OY = 339, 1391
W, H = 140, 210
FPS = 30
OP = 90
SW = 2.5
DASH = 5
CX, CY = 70, 105
EASE_OUT = ({'x': [0.2], 'y': [1]}, {'x': [0.4], 'y': [0]})
EASE = ({'x': [0.55], 'y': [1]}, {'x': [0.45], 'y': [0]})
DROP = ({'x': [0.3], 'y': [1.4]}, {'x': [0.5], 'y': [0]})

PALETTES = {
    'light': {'stroke': '#5521FF', 'jar': '#FFFFFF', 'side': '#DDD3FF', 'top': '#5521FF'},
    'dark': {'stroke': '#FFFFFF', 'jar': '#5521FF', 'side': '#210092', 'top': '#FFFFFF'},
}

DASH_IN = (4, 20)
RISE = (20, 40)
DROP_IN = (40, 48)
SCREEN_IN = (46, 58)
PULSE = (58, 62, 68)
FADE = (70, 80)
DASH_OUT = (80, 88)


def r2(v):
    v = round(v, 2)
    return int(v) if v == int(v) else v


def rgb(hexc):
    h = hexc.lstrip('#')
    return [round(int(h[i:i + 2], 16) / 255, 4) for i in (0, 2, 4)] + [1]


def static(v):
    return {'a': 0, 'k': v}


def animated(frames, ease=EASE):
    keys = []
    for n, (t, v) in enumerate(frames):
        key = {'t': t, 's': v if isinstance(v, list) else [v]}
        if n < len(frames) - 1:
            key['i'], key['o'] = ease
        keys.append(key)
    return {'a': 1, 'k': keys}


def svg_pt(x, y):
    return [r2(x - OX), r2(y - OY)]


def path(points, closed=True):
    zero = [[0, 0] for _ in points]
    return {'ty': 'sh', 'ks': static({'c': closed, 'v': points, 'i': zero, 'o': zero})}


def ellipse(cx, cy, w, h):
    return {'ty': 'el', 'p': static([r2(cx), r2(cy)]), 's': static([r2(w), r2(h)]), 'd': 1}


def rect(cx, cy, w, h, r):
    return {'ty': 'rc', 'p': static([r2(cx), r2(cy)]), 's': static([r2(w), r2(h)]), 'r': static(r), 'd': 1}


def fill(hexc):
    return {'ty': 'fl', 'c': static(rgb(hexc)), 'o': static(100), 'r': 1}


def stroke(hexc, dashed=False):
    st = {'ty': 'st', 'c': static(rgb(hexc)), 'o': static(100), 'w': static(SW), 'lc': 2, 'lj': 2, 'ml': 4}
    if dashed:
        st['d'] = [{'n': 'd', 'v': static(DASH)}, {'n': 'g', 'v': static(DASH)}, {'n': 'o', 'v': static(0)}]
    return st


def trim(start, end):
    return {'ty': 'tm', 's': static(0), 'e': animated([(start, 0), (end, 100)], EASE_OUT), 'o': static(0), 'm': 1}


def group(items, rotation=0, anchor=(0, 0)):
    t = {'ty': 'tr', 'p': static(list(anchor)), 'a': static(list(anchor)), 's': static([100, 100]),
         'r': static(rotation), 'o': static(100)}
    return {'ty': 'gr', 'it': items + [t]}


def layer(ind, nm, shapes, opacity=None, position=None, parent=None, mask=None):
    L = {'ddd': 0, 'ind': ind, 'ty': 4, 'nm': nm, 'sr': 1,
         'ks': {'o': opacity or static(100), 'r': static(0), 'p': position or static([0, 0]), 'a': static([0, 0]),
                's': static([100, 100])},
         'ao': 0, 'shapes': shapes, 'ip': 0, 'op': OP, 'st': 0, 'bm': 0}
    if parent is not None:
        L['parent'] = parent
    if mask is not None:
        L['hasMask'] = True
        L['masksProperties'] = [mask]
    return L


def rising_mask(left, right, top, bottom):
    def box(y):
        return {'c': True, 'v': [[left, y], [right, y], [right, bottom], [left, bottom]],
                'i': [[0, 0]] * 4, 'o': [[0, 0]] * 4}
    return {'inv': False, 'mode': 'a', 'o': static(100), 'x': static(0),
            'pt': animated([(RISE[0], [box(bottom)]), (RISE[1], [box(top)])])}


def fade_out(span):
    return animated([(span[0], 100), (span[1], 0)])


def cube(p):
    left = [svg_pt(362, 1467.92), svg_pt(408.758, 1492.08), svg_pt(408.758, 1547.21), svg_pt(362, 1523.04)]
    right = [svg_pt(455.516, 1467.92), svg_pt(408.758, 1492.08), svg_pt(408.758, 1547.21), svg_pt(455.516, 1523.04)]
    top = [svg_pt(456, 1467.91), svg_pt(408.756, 1491.53), svg_pt(362.227, 1467.91), svg_pt(408.756, 1445)]
    outline = [
        path([left[0], left[3], left[2], left[1]], closed=False),
        path([right[0], right[3], right[2]], closed=False),
        path(top),
    ]
    faces = [group([path(left), stroke(p['stroke']), fill(p['side'])]),
             group([path(right), stroke(p['stroke']), fill(p['side'])])]
    detail = [path(top), stroke(p['stroke']), fill(p['top'])]
    return outline, faces, detail, (20, 120, 74, 158)


def phone(p, radius, camera):
    w, h = 52, 96
    body = rect(CX, CY, w, h, radius)
    return [body], [body, stroke(p['stroke']), fill(p['side'])], camera, (CX - w / 2 - 4, CX + w / 2 + 4, CY - h / 2 - 4,
                                                                       CY + h / 2 + 4)


def ios(p):
    return phone(p, 13, [rect(CX, CY - 40, 18, 6, 3), fill(p['top'])])


def android(p):
    return phone(p, 7, [ellipse(CX, CY - 40, 7, 7), fill(p['top'])])


def macos(p):
    w, h = 92, 66
    top = CY - h / 2
    body = rect(CX, CY, w, h, 7)
    bar = path([[CX - w / 2, top + 14], [CX + w / 2, top + 14]], closed=False)
    dots = [ellipse(CX - w / 2 + 9 + 8 * i, top + 7, 5, 5) for i in range(3)]
    return [body], [bar, body, stroke(p['stroke']), fill(p['side'])], dots + [fill(p['top'])], (
        CX - w / 2 - 4, CX + w / 2 + 4, top - 4, CY + h / 2 + 4)


def web(p):
    d = 80
    disc = ellipse(CX, CY, d, d)
    lines = [ellipse(CX, CY, 34, d), path([[CX - d / 2, CY], [CX + d / 2, CY]], closed=False),
             path([[CX - 34, CY - 20], [CX + 34, CY - 20]], closed=False),
             path([[CX - 34, CY + 20], [CX + 34, CY + 20]], closed=False), stroke(p['stroke'])]
    return [disc], [disc, stroke(p['stroke']), fill(p['side'])], lines, (CX - d / 2 - 4, CX + d / 2 + 4, CY - d / 2 - 4,
                                                                       CY + d / 2 + 4)


def atom(p):
    sy = CY + 4
    orbits = [group([ellipse(CX, sy, 30, 11), trim(*SCREEN_IN), stroke(p['stroke'])], rotation=angle, anchor=(CX, sy))
              for angle in (0, 60, 120)]
    nucleus = group([ellipse(CX, sy, 5, 5), fill(p['top'])])
    return orbits + [nucleus]


def app_grid(p):
    sy = CY + 4
    tiles = [rect(CX + dx, sy + dy, 10, 10, 3) for dx in (-7, 7) for dy in (-7, 7)]
    return [group(tiles + [trim(*SCREEN_IN), stroke(p['stroke'])])]


ITEMS = {'cube': cube, 'ios': ios, 'android': android, 'macos': macos, 'web': web}
SCREENS = {'rn': atom, 'native': app_grid}


def build(p):
    layers = []

    def add(**kwargs):
        layers.append(layer(len(layers) + 2, **kwargs))

    pulse = {'ddd': 0, 'ind': 1, 'ty': 3, 'nm': 'pulse', 'sr': 1, 'ao': 0, 'ip': 0, 'op': OP, 'st': 0, 'bm': 0,
             'ks': {'o': static(100), 'r': static(0), 'p': static([CX, CY]), 'a': static([CX, CY]),
                    's': animated([(PULSE[0], [100, 100]), (PULSE[1], [104, 104]), (PULSE[2], [100, 100])])}}
    layers.append(pulse)
    for name, draw in SCREENS.items():
        add(nm=f'screen-{name}', shapes=draw(p), parent=1,
            opacity=animated([(SCREEN_IN[0], 0), (SCREEN_IN[0] + 4, 100), (FADE[0], 100), (FADE[1], 0)]))
    for name, draw in ITEMS.items():
        outline, faces, detail, (left, right, top, bottom) = draw(p)
        add(nm=f'item-{name}-detail', shapes=[group(detail)], parent=1,
            opacity=animated([(DROP_IN[0], 0), (DROP_IN[0] + 3, 100), (FADE[0], 100), (FADE[1], 0)]),
            position=animated([(DROP_IN[0], [0, -14]), (DROP_IN[1], [0, 0])], DROP))
        add(nm=f'item-{name}-fill', shapes=[group(faces)], parent=1, opacity=fade_out(FADE),
            mask=rising_mask(r2(left), r2(right), r2(top), r2(bottom)))
        add(nm=f'item-{name}-outline', shapes=[group(outline + [trim(*DASH_IN), stroke(p['stroke'], dashed=True)])],
            parent=1, opacity=fade_out(DASH_OUT))

    rim_top = svg_pt(409, 1430.5)
    rim_bottom = svg_pt(409, 1560.5)
    rx, ry = 65.5, 36
    k = 0.5522847498
    x0, x1, yb = rim_top[0] - rx, rim_top[0] + rx, rim_bottom[1]
    body = {'ty': 'sh', 'ks': static({
        'c': True,
        'v': [[x0, rim_top[1]], [x0, yb], [rim_top[0], yb + ry], [x1, yb], [x1, rim_top[1]]],
        'i': [[0, 0], [0, 0], [-k * rx, 0], [0, k * ry], [0, 0]],
        'o': [[0, 0], [0, k * ry], [k * rx, 0], [0, 0], [0, 0]],
    })}
    add(nm='jar-rim', shapes=[group([ellipse(*rim_top, 2 * rx, 2 * ry), stroke(p['stroke']), fill(p['jar'])])])
    add(nm='jar-base', shapes=[group([ellipse(*rim_bottom, 2 * rx, 2 * ry), stroke(p['stroke'])])])
    add(nm='jar-body', shapes=[group([body, stroke(p['stroke']), fill(p['jar'])])])
    return {'v': '5.7.4', 'fr': FPS, 'ip': 0, 'op': OP, 'w': W, 'h': H, 'nm': 'Stim build', 'ddd': 0, 'assets': [],
            'layers': layers}


for theme, palette in PALETTES.items():
    text = json.dumps(build(palette), separators=(',', ':'))
    (MOBILE_ANIMATIONS / f'stim-build-{theme}.json').write_text(text)
    (BRANDING / f'stim-build-{theme}.json').write_text(text)

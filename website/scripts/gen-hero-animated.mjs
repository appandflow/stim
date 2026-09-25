import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const NS = 'http://www.w3.org/2000/svg';
const STYLE = `
[data-part] { transform-box: fill-box; transform-origin: center; }
[data-part="tab1"] { animation: stim-bob 3.2s ease-in-out infinite; }
[data-part="tab2"] { animation: stim-bob 3.2s ease-in-out -1.1s infinite; }
[data-part="tab3"], [data-part="label"] { animation: stim-bob 3.2s ease-in-out -2.2s infinite; }
[data-part="lid"] { animation: stim-hover 3.2s ease-in-out infinite; }
[data-part="hatch"] { animation: stim-hatch 6s linear infinite; }
.stim-electron { fill: none; stroke-linecap: round; stroke-width: 4; animation: stim-orbit 2.4s linear infinite; }
.stim-electron:nth-of-type(2) { animation-duration: 3s; animation-direction: reverse; }
.stim-electron:nth-of-type(3) { animation-duration: 3.6s; }
@keyframes stim-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
@keyframes stim-hover { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes stim-hatch { to { transform: translate(4.824px, 4.824px); } }
@keyframes stim-orbit { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -100; } }
@media (prefers-reduced-motion: reduce) {
  [data-part], .stim-electron { animation: none; }
  .stim-electron { display: none; }
}
`;

function animate(src, out, electronColor) {
  const dom = new JSDOM(readFileSync(src, 'utf8'), { contentType: 'image/svg+xml' });
  const doc = dom.window.document;
  const svg = doc.documentElement;
  const byId = (id) => doc.getElementById(id);
  const wrap = (name, ids) => {
    const els = ids.map(byId).filter(Boolean);
    if (els.length !== ids.length) throw new Error(`missing part for ${name}`);
    const g = doc.createElementNS(NS, 'g');
    g.setAttribute('data-part', name);
    els[0].before(g);
    for (const el of els) g.appendChild(el);
    return g;
  };
  wrap('hatch', ['Group 51']);
  wrap('tab1', ['Union_3', 'Rectangle 34651015']);
  wrap('tab2', ['Union_4', 'Rectangle 34650997']);
  wrap('tab3', ['Union_5', 'Rectangle 34650998']);
  wrap('label', ['Stim_2']);
  const orbits = wrap('orbits', ['Ellipse 9799', 'Ellipse 9800', 'Ellipse 9801', 'Ellipse 9802']);
  const lid = wrap('lid', ['Ellipse 9797', 'Union_6', 'Ellipse 9798']);
  lid.appendChild(orbits);
  for (const id of ['Ellipse 9799', 'Ellipse 9800', 'Ellipse 9801']) {
    const e = byId(id).cloneNode();
    e.removeAttribute('id');
    e.removeAttribute('fill');
    e.setAttribute('class', 'stim-electron');
    e.setAttribute('pathLength', '100');
    e.setAttribute('stroke', electronColor);
    e.setAttribute('stroke-dasharray', '0.1 99.9');
    orbits.appendChild(e);
  }
  const mouth = doc.createElementNS(NS, 'ellipse');
  for (const [k, v] of Object.entries({ cx: 565, cy: 780, rx: 126, ry: 69 })) mouth.setAttribute(k, String(v));
  mouth.setAttribute('fill', byId('Ellipse 9796').getAttribute('fill') || 'white');
  mouth.setAttribute('stroke', byId('Ellipse 9797').getAttribute('stroke') || '#5521FF');
  byId('Union_2').after(mouth);
  const style = doc.createElementNS(NS, 'style');
  style.textContent = STYLE;
  svg.insertBefore(style, svg.firstChild);
  writeFileSync(out, new dom.window.XMLSerializer().serializeToString(doc));
}

const dir = fileURLToPath(new URL('../static/img/branding', import.meta.url));
animate(`${dir}/hero.svg`, `${dir}/hero-animated.svg`, '#ffffff');
const darkNucleus =
  new JSDOM(readFileSync(`${dir}/hero-dark.svg`, 'utf8'), { contentType: 'image/svg+xml' }).window.document
    .getElementById('Ellipse 9798')
    .getAttribute('stroke') || '#0f0c1d';
animate(`${dir}/hero-dark.svg`, `${dir}/hero-dark-animated.svg`, darkNucleus);

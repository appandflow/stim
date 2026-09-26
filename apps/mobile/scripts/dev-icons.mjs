#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ICONS = [
  ['assets/images/icon.png', 'assets/images/icon-dev.png'],
  ['assets/images/icon-ios.png', 'assets/images/icon-ios-dev.png'],
];
const HUE_SHIFT = 130;

function badge(size) {
  const height = Math.round(size * 0.2);
  const top = Math.round(size * 0.64);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect x="0" y="${top}" width="${size}" height="${height}" fill="#15121D"/>
  <text x="50%" y="${top + height / 2}" dominant-baseline="central" text-anchor="middle"
    font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="${Math.round(height * 0.72)}"
    letter-spacing="${Math.round(height * 0.08)}" fill="#FFFFFF">DEV</text>
</svg>`);
}

const path = (file) => fileURLToPath(new URL(`../${file}`, import.meta.url));

for (const [source, target] of ICONS) {
  const { width, hasAlpha } = await sharp(path(source)).metadata();
  const icon = await sharp(path(source))
    .modulate({ hue: HUE_SHIFT, brightness: 1.6 })
    .composite([{ input: badge(width), blend: 'atop' }])
    .png()
    .toBuffer();
  await (hasAlpha ? sharp(icon) : sharp(icon).removeAlpha()).toFile(path(target));
  console.log(`${source} -> ${target}`);
}

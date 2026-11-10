#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ICONS = ['icon', 'icon-ios'];
const VARIANTS = [
  { suffix: 'dev', label: 'DEV', hue: 130, brightness: 1.6 },
  { suffix: 'next', label: 'NEXT', hue: 230, brightness: 1.3 },
];

function badge(size, label) {
  const height = Math.round(size * 0.2);
  const top = Math.round(size * 0.64);
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect x="0" y="${top}" width="${size}" height="${height}" fill="#15121D"/>
  <text x="50%" y="${top + height / 2}" dominant-baseline="central" text-anchor="middle"
    font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="${Math.round(height * 0.72)}"
    letter-spacing="${Math.round(height * 0.08)}" fill="#FFFFFF">${label}</text>
</svg>`);
}

const path = (file) => fileURLToPath(new URL(`../assets/images/${file}.png`, import.meta.url));

for (const { suffix, label, hue, brightness } of VARIANTS) {
  for (const name of ICONS) {
    const target = `${name}-${suffix}`;
    const { width, hasAlpha } = await sharp(path(name)).metadata();
    const icon = await sharp(path(name))
      .modulate({ hue, brightness })
      .composite([{ input: badge(width, label), blend: 'atop' }])
      .png()
      .toBuffer();
    await (hasAlpha ? sharp(icon) : sharp(icon).removeAlpha()).toFile(path(target));
    console.log(`${name} -> ${target}`);
  }
}

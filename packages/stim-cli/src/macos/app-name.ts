import { sanitizeDeviceLabel } from '../devices/ios.ts';
import { ownedDeviceLabel } from '../workspace/project.ts';

const DOT = String.fromCodePoint(0xb7);
const ELLIPSIS = String.fromCodePoint(0x2026);
const LABEL_MAX = 24;
const PRODUCT_MAX = 40;

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}${ELLIPSIS}`;
}

/** The visible app name for a run: `<product> <dot> <label>`, or just the product when the label is empty. */
export function macosAppName(product: string, label: string): string {
  const name = clip(product.replace(/[\p{Cc}/:\\]+/gu, ' ').trim(), PRODUCT_MAX) || 'App';
  const suffix = clip(sanitizeDeviceLabel(label), LABEL_MAX);
  return suffix ? `${name} ${DOT} ${suffix}` : name;
}

export function workspaceAppName(root: string, product: string): string {
  return macosAppName(product, ownedDeviceLabel(root));
}

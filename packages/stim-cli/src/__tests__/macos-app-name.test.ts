import { describe, expect, it } from 'vitest';
import { macosAppName } from '../macos/app-name.ts';

const dot = String.fromCodePoint(0xb7);
const dots = String.fromCodePoint(0x2026);

describe('macosAppName', () => {
  it('joins the product and the workspace label', () => {
    expect(macosAppName('StimDesktop', '2971-ax-frame')).toBe(`StimDesktop ${dot} 2971-ax-frame`);
  });

  it('truncates a long label with an ellipsis and keeps the product', () => {
    const name = macosAppName('StimDesktop', 'a-very-long-worktree-name-for-an-agent-run-desktop');
    expect(name).toBe(`StimDesktop ${dot} a-very-long-worktree-na${dots}`);
    expect([...name.split(` ${dot} `)[1]!]).toHaveLength(24);
  });

  it('keeps only characters that are safe in a bundle name', () => {
    expect(macosAppName('My/App:Dev', 'feat/x y\u00e9\n')).toBe(`My App Dev ${dot} feat-x-y`);
    expect(macosAppName('A\u0000B\u001f', 'ok')).toBe(`A B ${dot} ok`);
  });

  it('falls back to the product when the label has nothing usable', () => {
    expect(macosAppName('StimDesktop', '\u00e9\u00e8')).toBe('StimDesktop');
    expect(macosAppName('', 'x')).toBe(`App ${dot} x`);
  });

  it('bounds the product', () => {
    expect([...macosAppName('P'.repeat(80), 'x').split(` ${dot} `)[0]!]).toHaveLength(40);
  });
});

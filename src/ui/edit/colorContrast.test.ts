import { describe, expect, it } from 'vitest';
import { contrastRatio, ensureContrast, mixHex, parseHex, readableTextColor, relativeLuminance, toHex } from './colorContrast';

describe('colorContrast', () => {
  it('parses short and long hex', () => {
    expect(parseHex('#fff')).toEqual([1, 1, 1]);
    expect(parseHex('000000')).toEqual([0, 0, 0]);
    expect(parseHex('nonsense')).toEqual([0.5, 0.5, 0.5]);
    expect(toHex(parseHex('#3050f8'))).toBe('#3050f8');
  });

  it('computes WCAG luminance and contrast ratios', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 6);
    // Well-known reference value: #777777 on white ≈ 4.48:1.
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#123456', '#abcdef')).toBeCloseTo(contrastRatio('#abcdef', '#123456'), 10);
  });

  it('picks readable text for CPK element colors', () => {
    const dark = '#0b0f17';
    const light = '#ffffff';
    expect(readableTextColor('#ffffff', dark, light)).toBe(dark); // H
    expect(readableTextColor('#909090', dark, light)).toBe(dark); // C
    expect(readableTextColor('#3050f8', dark, light)).toBe(light); // N
    expect(readableTextColor('#ffff30', dark, light)).toBe(dark); // S
    expect(readableTextColor('#a62929', dark, light)).toBe(light); // Br
  });

  it('mixes colors linearly', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#102030', '#102030', 0.3)).toBe('#102030');
  });

  it('ensures a minimum contrast while keeping legible colors unchanged', () => {
    expect(ensureContrast('#ff0d0d', '#121826', 3)).toBe('#ff0d0d');
    const s = ensureContrast('#ffff30', '#ffffff', 3);
    expect(s).not.toBe('#ffff30');
    expect(contrastRatio(s, '#ffffff')).toBeGreaterThanOrEqual(3);
    const n = ensureContrast('#3050f8', '#121826', 3);
    expect(contrastRatio(n, '#121826')).toBeGreaterThanOrEqual(3);
  });
});

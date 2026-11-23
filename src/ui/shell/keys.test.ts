import { describe, expect, it } from 'vitest';
import { formatShortcut, splitShortcut } from './keys';

describe('splitShortcut', () => {
  it('splits alternatives and keys (non-Mac)', () => {
    expect(splitShortcut('Ctrl/Cmd+Shift+Z / Ctrl+Y')).toEqual([
      ['Ctrl', 'Shift', 'Z'],
      ['Ctrl', 'Y'],
    ]);
    expect(splitShortcut('Delete / Backspace')).toEqual([['Delete'], ['Backspace']]);
    expect(splitShortcut('?')).toEqual([['?']]);
    expect(splitShortcut('e')).toEqual([['E']]);
    expect(splitShortcut('1 / 2 / 3')).toEqual([['1'], ['2'], ['3']]);
  });
  it('maps modifiers to Mac symbols', () => {
    expect(splitShortcut('Ctrl/Cmd+Shift+Z', true)).toEqual([['⌘', '⇧', 'Z']]);
    expect(splitShortcut('Mod+O', true)).toEqual([['⌘', 'O']]);
    expect(splitShortcut('Alt+drag', true)).toEqual([['⌥', 'drag']]);
    expect(splitShortcut('Esc', true)).toEqual([['Esc']]);
  });
  it('understands the editor format (space-joined combos, · alternatives)', () => {
    expect(splitShortcut('⌘ Shift Z · Ctrl Y', true)).toEqual([
      ['⌘', '⇧', 'Z'],
      ['⌃', 'Y'],
    ]);
    expect(splitShortcut('Ctrl Shift Z · Ctrl Y')).toEqual([
      ['Ctrl', 'Shift', 'Z'],
      ['Ctrl', 'Y'],
    ]);
    expect(splitShortcut('Delete · Backspace')).toEqual([['Delete'], ['Backspace']]);
    expect(splitShortcut('1 · 2 · 3')).toEqual([['1'], ['2'], ['3']]);
    expect(splitShortcut('C N O P')).toEqual([['C'], ['N'], ['O'], ['P']]);
    expect(splitShortcut('Shift H')).toEqual([['Shift', 'H']]);
    expect(splitShortcut('Esc')).toEqual([['Esc']]);
  });
  it('supports the plus key', () => {
    expect(splitShortcut('Ctrl++')).toEqual([['Ctrl', '+']]);
    expect(splitShortcut('+')).toEqual([['+']]);
  });
});

describe('formatShortcut', () => {
  it('joins key caps per platform', () => {
    expect(formatShortcut('Ctrl/Cmd+Z')).toBe('Ctrl+Z');
    expect(formatShortcut('Ctrl/Cmd+Z', true)).toBe('⌘Z');
    expect(formatShortcut('Ctrl/Cmd+Shift+Z / Ctrl+Y', true)).toBe('⌘⇧Z / ⌃Y');
  });
});

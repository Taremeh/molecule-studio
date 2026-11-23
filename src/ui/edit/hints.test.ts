import { describe, expect, it } from 'vitest';
import { defaultHint, formatShortcut, measureProgressHint } from './hints';

describe('hints', () => {
  it('describes measurement progress', () => {
    expect(measureProgressHint('distance', 0)).toBe('Pick atom 1 of 2 for a distance');
    expect(measureProgressHint('angle', 1)).toBe('Pick atom 2 of 3 for an angle');
    expect(measureProgressHint('dihedral', 3)).toBe('Pick atom 4 of 4 for a dihedral');
    expect(measureProgressHint('dihedral', 9)).toBe('Pick atom 4 of 4 for a dihedral');
  });

  it('gives a default hint per mode and tool', () => {
    const base = { editElement: 'N', measureKind: 'angle' as const, pendingCount: 0 };
    expect(defaultHint({ ...base, mode: 'view', tool: 'select' })).toMatch(/^Drag to rotate · right-drag to pan · scroll to zoom/);
    expect(defaultHint({ ...base, mode: 'edit', tool: 'add-atom' })).toContain('place N');
    expect(defaultHint({ ...base, mode: 'edit', tool: 'element' })).toContain('into N');
    expect(defaultHint({ ...base, mode: 'edit', tool: 'fragment', fragmentName: 'Benzene' })).toContain('attach Benzene');
    expect(defaultHint({ ...base, mode: 'view', tool: 'measure', pendingCount: 1 })).toBe('Pick atom 2 of 3 for an angle · Esc to cancel');
  });

  it('formats shortcuts per platform', () => {
    expect(formatShortcut('Mod+Shift+C', true)).toBe('⌘⇧C');
    expect(formatShortcut('Mod+Shift+C', false)).toBe('Ctrl+Shift+C');
    expect(formatShortcut('Shift+H', true)).toBe('⇧H');
    expect(formatShortcut('V', false)).toBe('V');
  });
});

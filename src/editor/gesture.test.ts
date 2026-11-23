import { describe, expect, it } from 'vitest';
import { CLICK_MAX_MS, DRAG_THRESHOLD_PX, classifyRelease, exceedsDragThreshold, rectFromPoints } from './gesture';

describe('click vs drag', () => {
  const o = { x: 100, y: 100 };

  it('uses a 4 px radius', () => {
    expect(DRAG_THRESHOLD_PX).toBe(4);
    expect(exceedsDragThreshold(o, { x: 104, y: 100 })).toBe(false);
    expect(exceedsDragThreshold(o, { x: 102.8, y: 102.8 })).toBe(false); // 3.96 px diagonally
    expect(exceedsDragThreshold(o, { x: 103, y: 103 })).toBe(true); // 4.24 px
    expect(exceedsDragThreshold(o, { x: 95.9, y: 100 })).toBe(true);
  });

  it('classifies releases', () => {
    expect(classifyRelease(o, { x: 101, y: 101 }, 120, false)).toBe('click');
    expect(classifyRelease(o, { x: 110, y: 100 }, 120, false)).toBe('drag');
    expect(classifyRelease(o, { x: 110, y: 100 }, 120, true)).toBe('drag');
  });

  it('times out unconsumed long presses but not consumed ones', () => {
    expect(CLICK_MAX_MS).toBe(500);
    expect(classifyRelease(o, o, 500, false)).toBe('click');
    expect(classifyRelease(o, o, 501, false)).toBe('none');
    expect(classifyRelease(o, o, 2000, true)).toBe('click');
  });

  it('normalises rectangles', () => {
    expect(rectFromPoints({ x: 50, y: 10 }, { x: 20, y: 40 })).toEqual({ x0: 20, y0: 10, x1: 50, y1: 40 });
  });
});

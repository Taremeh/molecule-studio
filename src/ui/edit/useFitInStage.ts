/**
 * Keeps an absolutely positioned popover inside the 3D stage (which clips its children with
 * overflow: hidden):
 *  - exposes the width available to the right of the popover's left edge as the CSS variable
 *    `--fit-width` on the inner element (content box), so its CSS can shrink to fit;
 *  - shifts the popover vertically and caps its height (scrolling) when the stage is too short.
 * OWNER: edit-ui.
 */
import { useLayoutEffect, type RefObject } from 'react';

const MARGIN = 8;

export function useFitInStage(innerRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const inner = innerRef.current;
    const pop = inner?.closest<HTMLElement>('.popover');
    const stage = inner?.closest<HTMLElement>('.stage');
    if (!inner || !pop || !stage) return;
    const fit = () => {
      pop.style.transform = '';
      pop.style.maxHeight = '';
      pop.style.overflowY = '';
      const s = stage.getBoundingClientRect();
      // Horizontal: the popover's left edge does not depend on its width.
      const chrome = pop.offsetWidth - inner.offsetWidth; // popover padding + border
      const availW = s.right - MARGIN - pop.getBoundingClientRect().left - chrome;
      inner.style.setProperty('--fit-width', `${Math.max(0, Math.floor(availW))}px`);
      // Vertical: cap the height, then shift up/down to stay inside.
      const availH = s.height - 2 * MARGIN;
      if (pop.offsetHeight > availH) {
        pop.style.maxHeight = `${Math.max(120, availH)}px`;
        pop.style.overflowY = 'auto';
      }
      const r = pop.getBoundingClientRect();
      let dy = 0;
      if (r.bottom > s.bottom - MARGIN) dy = s.bottom - MARGIN - r.bottom;
      if (r.top + dy < s.top + MARGIN) dy = s.top + MARGIN - r.top;
      if (dy) pop.style.transform = `translateY(${Math.round(dy)}px)`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [innerRef]);
}

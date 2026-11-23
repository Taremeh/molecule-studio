/**
 * Tooltip near the cursor describing the hovered atom / bond.
 * OWNER: edit-ui agent. See ARCHITECTURE.md § UI.
 *
 * Fixed-positioned 14 px below-right of the pointer, flipped to the other side near the window
 * edges. Hidden while dragging (a transient edit or any pressed pointer button) and when nothing
 * is hovered.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { describeHover } from './edit/hoverInfo';
import { readableTextColor } from './edit/colorContrast';
import './HoverTooltip.css';

const OFFSET = 14;
const EDGE = 8;

/** True while any pointer button is held anywhere in the window (capture phase, so nothing can hide it). */
function usePointerPressed(): boolean {
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const down = () => setPressed(true);
    const up = () => setPressed(false);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
    };
  }, []);
  return pressed;
}

export default function HoverTooltip() {
  const hovered = useStore((s) => s.hovered);
  const molecule = useStore((s) => s.molecule);
  const mode = useStore((s) => s.mode);
  const dragging = useStore((s) => s.transientBase !== null);
  const pressed = usePointerPressed();
  const ref = useRef<HTMLDivElement>(null);

  // Content depends on WHAT is hovered, not on where the pointer is: key the memo on the target
  // (pointer moves only reposition the card).
  const target = hovered ? `${hovered.kind}:${hovered.atomId ?? ''}:${hovered.bondId ?? ''}` : '';
  const content = useMemo(() => describeHover(molecule, hovered, mode), [molecule, target, mode]);
  const visible = !!content && !!hovered && !dragging && !pressed;

  // Position before paint: offset from the pointer, flipped near the window edges.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !hovered || !visible) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = hovered.clientX + OFFSET;
    let y = hovered.clientY + OFFSET;
    if (x + w > window.innerWidth - EDGE) x = hovered.clientX - OFFSET - w;
    if (y + h > window.innerHeight - EDGE) y = hovered.clientY - OFFSET - h;
    el.style.transform = `translate(${Math.max(EDGE, Math.round(x))}px, ${Math.max(EDGE, Math.round(y))}px)`;
  });

  if (!visible || !content) return null;

  return (
    <div ref={ref} className={`htip glass kind-${content.kind}`} role="tooltip">
      <div className="htip-head">
        <span className="htip-badges">
          {content.badges.map((b, i) => (
            <span key={i} className="htip-badge" style={{ background: b.color, color: readableTextColor(b.color) }}>
              {b.symbol}
            </span>
          ))}
        </span>
        <span className="htip-title">{content.title}</span>
        {content.aside && <span className="htip-aside">{content.aside}</span>}
      </div>
      {content.lines.map((l, i) => (
        <div key={i} className={`htip-line tone-${l.tone}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

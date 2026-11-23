/**
 * Floating vertical editing toolbar (edit mode).
 * OWNER: edit-ui agent. See ARCHITECTURE.md § UI.
 *
 * Layout (top → bottom): tools · current element (opens the periodic table) · bond order ·
 * current fragment (opens the fragment picker) · actions (add/remove H, clean up, center).
 */
import type { ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Crosshair, Eraser, FlaskConical, Hexagon, MousePointer2, Move, CirclePlus, Ruler, Sparkles, Spline } from 'lucide-react';
import { useStore } from '../../state/store';
import type { BondOrder, ToolId } from '../../core/types';
import { getElement } from '../../core/elements';
import { getFragment } from '../../core/templates';
import { IconButton, Popover } from '../common';
import { cmdAddHydrogens, cmdCenter, cmdCleanGeometry, cmdRemoveHydrogens } from '../../app/actions';
import ElementPalette from './ElementPalette';
import FragmentPicker from './FragmentPicker';
import { BondOrderIcon, ChargeIcon, HydrogenIcon } from './icons';
import { formatShortcut, TOOL_SHORTCUTS } from './hints';
import { readableTextColor } from './colorContrast';
import { BOND_ORDER_NAMES } from './geometryModel';
import './EditToolbar.css';

interface ToolDef {
  id: ToolId;
  icon: ReactNode;
  title: (ctx: { element: string; fragment: string }) => string;
}

const TOOLS: ToolDef[] = [
  { id: 'select', icon: <MousePointer2 />, title: () => 'Select — click atoms, shift-drag to box-select' },
  { id: 'move', icon: <Move />, title: () => 'Move — drag an atom or the selection' },
  { id: 'add-atom', icon: <CirclePlus />, title: ({ element }) => `Add atom — place ${element} or grow it from an atom` },
  { id: 'add-bond', icon: <Spline />, title: () => 'Add bond — drag between two atoms; click a bond to cycle its order' },
  { id: 'delete', icon: <Eraser />, title: () => 'Delete — click an atom or bond' },
  { id: 'element', icon: <FlaskConical />, title: ({ element }) => `Change element — click an atom to make it ${element}` },
  { id: 'charge', icon: <ChargeIcon />, title: () => 'Formal charge — click for +1, shift-click for −1' },
  { id: 'fragment', icon: <Hexagon />, title: ({ fragment }) => `Attach fragment — ${fragment}` },
  { id: 'measure', icon: <Ruler />, title: () => 'Measure — distances, angles and dihedrals' },
];

const BOND_ORDERS: BondOrder[] = [1, 2, 3];

export default function EditToolbar() {
  const { tool, editElement, editBondOrder, editFragment, selCount, busy } = useStore(
    useShallow((s) => ({
      tool: s.tool,
      editElement: s.editElement,
      editBondOrder: s.editBondOrder,
      editFragment: s.editFragment,
      selCount: s.selection.size,
      busy: s.loading !== null,
    })),
  );
  const el = getElement(editElement);
  const fragment = getFragment(editFragment);
  const fragmentName = fragment?.name ?? 'fragment';
  const usesOrder = tool === 'add-atom' || tool === 'add-bond';
  const scope = selCount ? `the ${selCount} selected atom${selCount === 1 ? '' : 's'}` : 'all atoms';
  const setTool = (t: ToolId) => useStore.getState().setTool(t);

  return (
    <div className="etb glass" role="toolbar" aria-label="Editing tools" aria-orientation="vertical">
      <div className="etb-group etb-tools">
        {TOOLS.map((t) => (
          <IconButton
            key={t.id}
            icon={t.icon}
            title={t.title({ element: el.name, fragment: fragmentName })}
            shortcut={TOOL_SHORTCUTS[t.id]}
            active={tool === t.id}
            onClick={() => setTool(t.id)}
          />
        ))}
      </div>

      <div className="etb-sep" />

      <Popover
        placement="right"
        className="etb-popover"
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`etb-element ${open ? 'is-open' : ''}`}
            style={{ background: el.color, color: readableTextColor(el.color) }}
            onClick={toggle}
            aria-haspopup="dialog"
            aria-expanded={open}
            title={`Element: ${el.name} — open the periodic table (keys C N O H S P F, L = Cl, K = Br, I)`}
          >
            <span className="etb-element-sym">{el.number > 0 ? el.symbol : editElement}</span>
          </button>
        )}
      >
        {(close) => <ElementPalette onPicked={close} />}
      </Popover>

      <div className={`etb-group etb-bond ${usesOrder ? '' : 'is-idle'}`} role="radiogroup" aria-label="Bond order">
        {BOND_ORDERS.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={editBondOrder === o}
            className={`etb-bond-btn ${editBondOrder === o ? 'is-active' : ''}`}
            title={`${BOND_ORDER_NAMES[o][0].toUpperCase()}${BOND_ORDER_NAMES[o].slice(1)} bond for new bonds (${o})`}
            onClick={() => useStore.getState().setEditBondOrder(o)}
          >
            <BondOrderIcon order={o} size={16} />
          </button>
        ))}
      </div>

      <Popover
        placement="right"
        className="etb-popover"
        trigger={(open, toggle) => (
          <button
            type="button"
            className={`etb-fragment ${open ? 'is-open' : ''} ${tool === 'fragment' ? 'is-active' : ''}`}
            onClick={toggle}
            aria-haspopup="dialog"
            aria-expanded={open}
            title={`Fragment: ${fragmentName} — choose a template (${TOOL_SHORTCUTS.fragment} activates the fragment tool)`}
          >
            {fragment ? <span className="etb-fragment-label">{fragment.label}</span> : <Hexagon size={16} />}
          </button>
        )}
      >
        {(close) => <FragmentPicker onPicked={close} />}
      </Popover>

      <div className="etb-sep" />

      <div className="etb-group">
        <IconButton icon={<HydrogenIcon sign="+" />} title={`Add hydrogens to ${scope}`} shortcut="H" onClick={cmdAddHydrogens} />
        <IconButton icon={<HydrogenIcon sign="-" />} title={`Remove hydrogens from ${scope}`} shortcut={formatShortcut('Shift+H')} onClick={cmdRemoveHydrogens} />
        <IconButton
          icon={<Sparkles />}
          title={selCount ? 'Clean up geometry of the selected atoms (force-field minimisation)' : 'Clean up geometry (force-field minimisation)'}
          shortcut={formatShortcut('Mod+Shift+C')}
          disabled={busy}
          onClick={() => void cmdCleanGeometry()}
        />
        <IconButton icon={<Crosshair />} title="Center the molecule at the origin and frame it" onClick={cmdCenter} />
      </div>
    </div>
  );
}

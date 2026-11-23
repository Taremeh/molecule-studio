/**
 * Help / onboarding overlay (store.panels.help): mouse controls, shortcuts, selection language.
 * OWNER: shell agent. See ARCHITECTURE.md § UI.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, Hand, Keyboard, Mouse, MousePointerClick, Move, Pencil, Ruler, ScanSearch, Search, SquareDashedMousePointer, ZoomIn } from 'lucide-react';
import { useStore } from '../state/store';
import { SHORTCUTS } from '../editor/shortcuts';
import { selectionHelp } from '../core/selection';
import { EmptyHint, Kbd, Modal } from './common';
import { isMacPlatform, splitShortcut } from './shell/keys';
import { sendQueryToSelectionBar } from './shell/shellStore';
import './HelpOverlay.css';

const MAC = isMacPlatform();

export default function HelpOverlay() {
  const open = useStore((s) => s.panels.help);
  const onClose = useCallback(() => useStore.getState().setPanel('help', false), []);
  return (
    <Modal open={open} onClose={onClose} title="Help & shortcuts" width={900} className="help-modal">
      {open && <HelpContent onClose={onClose} />}
    </Modal>
  );
}

function HelpContent({ onClose }: { onClose: () => void }) {
  return (
    <div className="help">
      <div className="help-grid">
        <div className="help-col">
          <HelpSection icon={<Mouse size={15} />} title="Navigation">
            <NavRow icon={<Hand size={15} />} action="Rotate" gesture="Left-drag" />
            <NavRow icon={<Move size={15} />} action="Pan" gesture="Right-drag" />
            <NavRow icon={<ZoomIn size={15} />} action="Zoom" gesture="Scroll wheel / middle-drag" />
            <NavRow icon={<ScanSearch size={15} />} action="Focus" gesture="Double-click an atom" />
            <NavRow icon={<MousePointerClick size={15} />} action="Select" gesture="Click an atom · Shift-click to add" />
            <NavRow icon={<SquareDashedMousePointer size={15} />} action="Box select" gesture="Shift-drag on empty space" />
            <NavRow icon={<Ruler size={15} />} action="Measure" gesture="Press M, then click 2–4 atoms" />
          </HelpSection>
          <HelpSection icon={<Pencil size={15} />} title="Editing tips">
            <ul className="help-tips">
              <li>
                Press <Kbd>E</Kbd> to edit the current molecule, or choose <b>Open → New</b> to start from scratch.
              </li>
              <li>
                <b>Add atom</b>: click empty space to place an atom, click an atom to grow a new bond from it, or drag from an atom to place the new one.
              </li>
              <li>
                Element keys <Kbd>C</Kbd> <Kbd>N</Kbd> <Kbd>O</Kbd> <Kbd>P</Kbd> (<Kbd>L</Kbd> = Cl, <Kbd>K</Kbd> = Br) pick what you draw; <Kbd>1</Kbd> <Kbd>2</Kbd> <Kbd>3</Kbd> set the bond order.
              </li>
              <li>
                <b>Add bond</b>: drag from one atom to another; click a bond to cycle single → double → triple.
              </li>
              <li>Red halos mark atoms with too many bonds, amber stubs show open valences. Hydrogens are added automatically (see Settings).</li>
              <li>Select 2, 3 or 4 atoms to read and set a distance, angle or dihedral in the inspector on the right.</li>
              <li>
                <b>Clean geometry</b> relaxes the structure with a force field. Everything can be undone with{' '}
                <KeyCaps keys="Ctrl/Cmd+Z" />.
              </li>
            </ul>
          </HelpSection>
        </div>
        <div className="help-col">
          <HelpSection icon={<Keyboard size={15} />} title="Keyboard shortcuts">
            <ShortcutList />
          </HelpSection>
        </div>
      </div>
      <HelpSection icon={<BookOpen size={15} />} title="Selection language">
        <SelectionLanguage onTry={onClose} />
      </HelpSection>
      <div className="help-footer">
        Press <Kbd>?</Kbd> anytime to open this help.
      </div>
    </div>
  );
}

function HelpSection(props: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="help-section">
      <h3 className="help-section-title">
        {props.icon}
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function NavRow(props: { icon: ReactNode; action: string; gesture: string }) {
  return (
    <div className="help-nav-row">
      <span className="help-nav-icon">{props.icon}</span>
      <span className="help-nav-action">{props.action}</span>
      <span className="help-nav-gesture">{props.gesture}</span>
    </div>
  );
}

/** Key caps for a shortcut string, alternatives separated by a slash. */
function KeyCaps({ keys }: { keys: string }) {
  const alts = splitShortcut(keys, MAC);
  return (
    <span className="help-keys">
      {alts.map((caps, i) => (
        <span key={i} className="help-keys-alt">
          {i > 0 && <span className="help-keys-or">/</span>}
          {caps.map((c, j) => (
            <Kbd key={j}>{c}</Kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

const MODE_GROUPS: { mode: 'general' | 'view' | 'edit'; title: string }[] = [
  { mode: 'general', title: 'Everywhere' },
  { mode: 'view', title: 'View mode' },
  { mode: 'edit', title: 'Edit mode' },
];

function ShortcutList() {
  if (SHORTCUTS.length === 0) return <EmptyHint>No shortcuts registered.</EmptyHint>;
  return (
    <div className="help-shortcuts">
      {MODE_GROUPS.map((g) => {
        const items = SHORTCUTS.filter((s) => (s.mode ?? 'general') === g.mode);
        if (!items.length) return null;
        return (
          <div key={g.mode} className="help-shortcut-group">
            <div className="help-group-title">{g.title}</div>
            {items.map((s, i) => (
              <div key={i} className="help-shortcut-row">
                <span className="help-shortcut-desc">{s.description}</span>
                <KeyCaps keys={s.keys} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function SelectionLanguage({ onTry }: { onTry: () => void }) {
  const [filter, setFilter] = useState('');
  const hasMolecule = useStore((s) => s.molecule !== null && s.molecule.atoms.length > 0);
  const all = useMemo(() => selectionHelp(), []);
  const items = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return all;
    return all.filter((h) => `${h.keyword} ${h.description} ${h.example}`.toLowerCase().includes(f));
  }, [all, filter]);

  return (
    <div className="help-sel">
      <p className="help-sel-intro">
        Type queries in the <b>Select</b> box or a layer's selection field. Combine terms with <code>and</code>, <code>or</code>, <code>not</code> and
        parentheses, e.g. <code>protein and chain A and not hydrogen</code> or <code>within 5 of ligand</code>.
      </p>
      <div className="help-sel-search">
        <Search size={14} aria-hidden="true" />
        <input className="input" placeholder="Filter keywords…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter selection keywords" />
      </div>
      {all.length === 0 ? (
        <EmptyHint>Selection help is not available.</EmptyHint>
      ) : items.length === 0 ? (
        <EmptyHint>No keyword matches “{filter}”.</EmptyHint>
      ) : (
        <div className="help-sel-table" role="table" aria-label="Selection keywords">
          {items.map((h) => (
            <div key={h.keyword} className="help-sel-row" role="row">
              <code className="help-sel-keyword" role="cell">
                {h.keyword}
              </code>
              <span className="help-sel-desc" role="cell">
                {h.description}
              </span>
              <span className="help-sel-example" role="cell">
                {hasMolecule ? (
                  <button
                    type="button"
                    className="help-sel-try"
                    title="Put this example in the Select box"
                    onClick={() => {
                      sendQueryToSelectionBar(h.example);
                      onTry();
                    }}
                  >
                    <code>{h.example}</code>
                  </button>
                ) : (
                  <code>{h.example}</code>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

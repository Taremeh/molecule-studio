/**
 * Store commands shared by the edit-ui components (palette, fragment picker, toolbar).
 * OWNER: edit-ui.
 */
import { useStore } from '../../state/store';

/** Pick an element like the element hot keys do: switch to add-atom unless the tool uses an element. */
export function pickElement(symbol: string) {
  const s = useStore.getState();
  s.setEditElement(symbol);
  if (s.tool !== 'add-atom' && s.tool !== 'element') s.setTool('add-atom');
}

/** Pick a fragment template and activate the fragment tool. */
export function pickFragment(id: string) {
  const s = useStore.getState();
  s.setEditFragment(id);
  if (s.tool !== 'fragment') s.setTool('fragment');
}

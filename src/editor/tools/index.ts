/**
 * Tool registry: one module per tool.
 */
import type { AppMode, ToolId } from '../../core/types';
import { VIEW_TOOLS } from '../../core/types';
import { addAtomTool } from './addAtom';
import { addBondTool } from './addBond';
import { chargeTool } from './charge';
import { deleteTool } from './delete';
import { elementTool } from './element';
import { fragmentTool } from './fragment';
import { measureTool } from './measure';
import { moveTool } from './move';
import { selectTool } from './select';
import type { Tool } from './types';

export const TOOLS: Record<ToolId, Tool> = {
  select: selectTool,
  measure: measureTool,
  move: moveTool,
  'add-atom': addAtomTool,
  'add-bond': addBondTool,
  delete: deleteTool,
  element: elementTool,
  charge: chargeTool,
  fragment: fragmentTool,
};

/** Tool that handles input: edit tools never act in view mode (the store also prevents it). */
export function effectiveToolId(mode: AppMode, tool: ToolId): ToolId {
  return mode === 'view' && !VIEW_TOOLS.includes(tool) ? 'select' : tool;
}

export function toolFor(mode: AppMode, tool: ToolId): Tool {
  return TOOLS[effectiveToolId(mode, tool)];
}

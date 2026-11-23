# Molecule Studio — Architecture & Module Contracts

An interactive 3D molecular visualizer and editor that runs in the browser.
Stack: **Vite + TypeScript (strict) + React 19 + zustand 5 + three.js 0.187 + lucide-react icons**. Tests: **vitest** (`npx vitest run <path>`).

Commands: `npm run dev` (port 5173), `npx tsc --noEmit`, `npx vitest run`, `npm run build`.

## Ground rules for every module

1. **Own only your files.** Each module has an owner (see table). Do not edit files you do not own.
   If you need a change in someone else's file or in a shared contract, *do not make it* — work around it
   and describe the needed change in your final report.
2. **Keep exported names and signatures** of the stub you were given. You may add exports, internal
   helper files (inside your directory, with your prefix), and tests (`*.test.ts` next to the code).
3. **No new npm dependencies.** Everything needed is installed (three, react, zustand, lucide-react).
4. **Molecules are immutable** (see `src/core/types.ts`). Never mutate atoms/bonds/arrays of a molecule
   that came from the store. Derived data is cached in `WeakMap`s keyed by the molecule object.
5. **Atoms are referenced by `id`**, never by index across edits. Per-atom typed arrays (masks, colors)
   are indexed by atom *index* in `molecule.atoms`; convert with `getTopology(mol).idToIndex`.
6. **World space = molecule coordinates in Å.** No centering transform.
7. Typecheck your files: `npx tsc --noEmit 2>&1 | grep -E 'src/(your/dir)'` (other modules may be
   mid-implementation; only your errors matter). Pure-logic modules must have vitest tests.
8. Performance targets: load and display a 50k-atom protein in a few seconds; hover/picking stays
   interactive (≤ 4 ms per pick at 50k atoms); editing small molecules (≤ 500 atoms) is instant.
9. UX tone: modern, calm, discoverable. Every control has a tooltip (`title`). Prefer direct
   manipulation and immediate feedback over dialogs. Never `alert()`; use `store.toast()`.

## File ownership

| Area | Files | Owner |
|---|---|---|
| Types, topology, store, glue, layout, shared UI primitives, global CSS | `core/types.ts`, `core/molecule.ts`, `core/prepare.ts`, `state/store.ts`, `app/actions.ts`, `render/viewerApi.ts`, `App.tsx`, `main.tsx`, `ui/common.tsx`, `styles/global.css` | integration (do not edit) |
| File formats, fetchers, samples | `io/*` | **io** |
| Bonds, secondary structure, selection language | `core/bonding.ts`, `core/secondary.ts`, `core/selection.ts` | **structure** |
| Elements, chemistry checks, geometry, edit ops, hydrogens | `core/elements.ts`, `core/chemistry.ts`, `core/geometry.ts`, `core/edit.ts` | **chemistry** |
| Force field minimiser, fragment templates, SMILES | `core/minimize.ts`, `core/templates.ts`, `core/smiles.ts` | **forcefield** |
| Viewer, atom/bond reps, picking, overlays, labels, Viewport | `render/Viewer.ts`, `render/reps/atoms.ts`, `render/reps/lines.ts`, `render/overlays*.ts`, `render/picking*.ts`, `render/labels*.ts`, any other new `render/*` file except below, `ui/Viewport.tsx` (+ `ui/Viewport.css`) | **render-core** |
| Color schemes, cartoon, surface | `render/colors.ts`, `render/reps/cartoon.ts`, `render/reps/surface.ts` (+ `surface.worker.ts`, `render/reps/spline*.ts`) | **render-advanced** |
| Interaction controller, keyboard shortcuts | `editor/*` | **editor** |
| App shell UI | `ui/TopBar`, `LoadDialog`, `DropOverlay`, `LayersPanel`, `SelectionBar`, `InfoPanel`, `SettingsPanel`, `Toasts`, `LoadingOverlay`, `HelpOverlay`, `EmptyState` (`.tsx` + `.css`) | **shell-ui** |
| Editing & inspection UI | `ui/edit/*`, `ui/GeometryInspector`, `ui/MeasurementsPanel`, `ui/SequenceViewer`, `ui/HoverTooltip` (`.tsx` + `.css`) | **edit-ui** |

## Data flow

```
 io/formats.parseMolecule ─► core/prepare.prepareMolecule ─► store.loadMolecule
                                   (bonds, orders, SS)            │
 UI components ──(store actions, app/actions.ts)──────────────────┤
 editor/controller ◄── pointer events ── ui/Viewport ──► Viewer   │
        │  (core/edit.* pure ops → store.commit / transient)      │
        └──────────────► store ──subscribe──► render/Viewer (rebuilds reps / overlays, requestRender)
```

- The **store** (`state/store.ts`) is the single source of truth. Read it in React with selectors
  `useStore(s => s.x)` (use `useShallow` from `zustand/react/shallow` for object/array picks), and outside
  React with `useStore.getState()` / `useStore.subscribe`.
- **Edits**: compute a new molecule with `core/edit.ts` functions, then `commit(newMol, 'Label')`.
  Drags: `beginTransient()` → `updateTransient(mol)` per pointer move → `endTransient('Move atoms')`
  (or `cancelTransient()` on Escape). Undo/redo is snapshot-based.
- `moleculeVersion` changes on every molecule change; `structureVersion` only on topology/element/order
  changes; `documentId` on load/new (renderer resets camera).

## Renderer (render-core + render-advanced)

`Viewer` (implements `ViewerApi`) owns a `THREE.WebGLRenderer` (antialias, `setPixelRatio(min(devicePixelRatio, 2))`),
scene, camera (perspective FOV ≈ 35°, or orthographic per `view.projection`), **TrackballControls**
(free rotation like VMD; disable its keyboard keys: `controls.keys = []`-equivalent), lights (soft hemisphere/ambient +
a key directional light attached to the camera so lighting follows the view), optional fog (depth cue),
`ResizeObserver` on the container. Rendering is **on demand**: a continuous rAF loop updates the controls every
frame but renders only when something changed (`requestRender`, store changes, camera motion, animations).

Subscriptions (store → viewer):
- `molecule`, `reps`, `view.showHydrogens`, `view.quality`, `mode` → rebuild representations (per rep:
  `evaluateSelection(mol, rep.selection)` mask, AND with hydrogen filter if `!showHydrogens && mode==='view'`,
  `computeAtomColors(mol, rep.color, rep.uniformColor)`, then build by style). Fast path: if only
  coordinates changed (structureVersion unchanged), update instance matrices / positions in place for
  atom-based reps; cartoon & surface rebuild (surface debounced ~300 ms, async with AbortSignal).
- `documentId` → `resetView()` (fit whole molecule, rotate center = centroid).
- `selection` → selection halos (translucent `HIGHLIGHT_COLORS.selection` shell around selected atoms,
  ~1.25× display radius; cap 20k).
- `hovered` → hover halo on that atom/bond (`HIGHLIGHT_COLORS.hover`).
- `editOverlay` → ghost atoms (translucent spheres in element color, red tint if invalid), ghost bonds
  (`preview` = solid translucent cylinder; `suggest` = dashed line; green if valid / red if invalid),
  highlight halos for `highlightAtoms`/`highlightBonds` using `HIGHLIGHT_COLORS[color]`.
- `mode === 'edit' && view.showValence` → valence markers from `analyzeValence(mol)`: over-valent atoms get a
  pulsing/red halo; if `shouldShowUnderValence(mol)` under-valent atoms get small amber stubs along
  `openValenceDirections(mol, id)` (cap at 2000 atoms).
- `measurements` + `pendingMeasure` → dashed lines between measured atoms (angle: arc optional) with a
  text label showing the live value (`measureAtoms`): "1.54 Å", "109.5°". Pending picks get a target halo.
- `view.labelMode` → text labels for selected atoms (all atoms if < 60 atoms and none selected; cap 500).
  Recommended: one 2D canvas overlay redrawn after each render (project positions; cheap and crisp).
- `view.background`, `fog`, `projection`, `autoRotate` → apply.

Atom-based styles (render-core, `render/reps/atoms.ts`, `render/reps/lines.ts`):
- **ball-and-stick**: spheres r = 0.25·vdW·scale (H a bit smaller; min 0.18 Å), bonds = cylinders r = 0.12·scale,
  split at midpoint with each half in its atom's color. Double bonds = 2 thinner parallel cylinders offset in the
  plane of a neighbouring atom (offset ≈ 0.14 Å); triple = 3; aromatic = 1 full + 1 thinner dashed/short inner
  cylinder (or 2 cylinders). Use `InstancedMesh` (sphere detail by quality) with per-instance color.
- **spacefill**: spheres r = vdW·scale, no bonds.
- **licorice**: spheres and bonds with the same r = 0.2·scale (multiple bonds drawn as single).
- **lines**: `LineSegments` with vertex colors (split bonds), atoms without bonds drawn as small crosses or points.
- Opacity < 1 → transparent materials with `depthWrite=false`.

Advanced (render-advanced): `buildCartoon`, `buildSurface` (async; worker), `computeAtomColors`, `colorLegend`.

**Picking** (`pick`): analytic ray–sphere over displayed atoms of atom-based reps (with their display radii;
grid/BVH acceleration for big systems) and ray–cylinder for bonds (lines: ~4 px tolerance); for cartoon/surface,
raycast the mesh and map the hit via `userData.vertexAtomIndex` (fallback: nearest selected atom to the hit point).
Return the closest hit to the camera. `pickRect` projects displayed atom centers.

`screenshot`: render at `scale ×` resolution into an offscreen render target or a resized renderer, return PNG blob
(transparent background option). Include labels if feasible.

**Viewport.tsx**: mounts `Viewer`, calls `setViewer`, creates `createEditorController(viewer)`, attaches
pointer listeners on the container **in capture phase** (`pointerdown` → `controller.onPointerDown(ev)`; if
true → `ev.stopPropagation()`, `ev.preventDefault()`, `container.setPointerCapture(ev.pointerId)`), plus
`pointermove`/`pointerup`/`pointerleave`/`dblclick`, prevents the context menu. Cursor by tool (crosshair for
add-atom/add-bond/measure, `not-allowed`-ish red for delete hover, grab/grabbing for move). Renders
`editOverlay.selectionRect` as an absolutely positioned dashed rectangle.

## Editor (editor agent) — `editor/controller.ts`

The controller reads `useStore.getState()` at each event. Hover: on `pointermove` (throttled to one pick per
animation frame), `viewer.pick()` → `setHovered({kind, atomId|bondId, clientX, clientY})` and tool-specific
previews in `editOverlay` + a `hint` string. A *click* = pointerdown/up within 4 px and 500 ms; a *drag* moves
farther. In **view mode** pointerdown is never consumed (camera rotates on drag) except shift-drag on empty space
in select tool (box select).

Tools (all modes): `select` — click atom: select it (shift/ctrl/cmd: toggle in selection); click a bond: select
both atoms; click empty space: clear selection; double-click atom: select whole residue (macromolecule) or
connected fragment (small molecule) and focus it; shift-drag empty: box select (`selectionRect`, `pickRect`).
`measure` — click atoms to build `pendingMeasure`; when it reaches 2/3/4 atoms for `measureKind`, call
`addMeasurement` and clear pending. Hint: "Pick atom 2 of 3 for an angle".

Edit-mode tools (consume pointerdown when they act on an atom/bond; empty-space drags still rotate the camera,
except where noted):
- `move`: drag an atom → moves it (or the whole selection if the atom is selected; alt-drag: the whole
  connected fragment) on the camera-facing plane through the atom (`screenToWorldOnPlane`). Uses
  transient edits. With `view.relaxOnDrag`, run `createMinimizer(mol, {movable: neighbours within 2–3 bonds})` and a
  few steps per frame with the dragged atom pinned. While dragging, find non-bonded atoms within
  1.2 × (rcov sum) of the dragged atom → `ghostBonds` style 'suggest' (valid per `canAddBond`), and clash atoms
  (< 0.6 × vdW sum) → `highlightAtoms` 'invalid'. On release, if `view.snapBonds`, create the valid suggested
  bonds (single), toast "Formed C–O bond". Escape during drag → `cancelTransient`.
- `add-atom` (element = `editElement`):
  - click empty space → new atom at the plane through the view target (first atom of an empty molecule at the
    origin); with `autoHydrogens` fill its valence with H (`adjustHydrogens`).
  - click an atom A → if A is H and editElement ≠ H: replace H by the new element (set element, fix bond length
    via `setDistance` to `idealBondLength`), else add a new atom bonded to A at `suggestNewAtomPosition` (if A
    has an H, replace that H instead, like Avogadro). Then `adjustHydrogens` on affected atoms if `autoHydrogens`.
  - drag from atom A → ghost atom + preview bond follow the pointer (on A's camera plane); release on empty → new
    atom there bonded to A; release on atom B → bond A–B with `editBondOrder`.
  - Hover preview: ghost atom at the suggested position + preview bond; invalid (red, hint explains why) if
    `canAcceptBond(A)` fails.
- `add-bond`: drag atom A → atom B creates/sets bond with `editBondOrder` (preview bond follows the pointer,
  green/red target highlight from `canAddBond`); click A then click B also works (A shows 'target' highlight);
  click on a bond → `cycleBondOrder`. Invalid → toast with the reason, no change.
- `delete`: hover highlights atom/bond in 'delete' color; click → remove atom (and its hydrogens) / bond; with
  `autoHydrogens` fix valences of former neighbours. Click empty space: nothing. Shift-drag box → delete atoms in box.
- `element`: click atom → `setElement` to `editElement` (+ adjustHydrogens, bond length fix).
- `charge`: click atom → charge +1 (shift-click −1) (+ adjustHydrogens).
- `fragment`: click atom → `attachFragment(mol, editFragment, {anchorAtomId})`; click empty → place at the plane
  through the view target. Hover preview: highlight anchor 'target'.
- Every committed edit gets a clear undo label ("Add N", "Bond C–O (double)", "Delete 3 atoms"...).
- After edits, keep the selection meaningful (e.g. select newly added atom for add-atom so the inspector shows it? —
  no: keep selection unchanged except for deleted atoms).

### Shortcuts — `editor/shortcuts.ts`
`Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` / `Ctrl+Y` redo, `E` toggle view/edit mode, `Esc` cancel current action /
clear pending measure / clear selection, `Delete`/`Backspace` delete selected atoms (edit mode), `Ctrl/Cmd+A` select
all, `F` focus selection (or all), `R` reset view, `?` help overlay, `Ctrl/Cmd+O` open load dialog,
`Ctrl/Cmd+S` export (opens nothing — export PDB/SDF: SDF for small molecules), `M` measure tool, `S` select tool.
Edit mode only: `V` move, `A` add atom, `B` add bond, `D` delete, `1`/`2`/`3` bond order, element keys `C N O H S P F`
plus `L` (Cl) `K` (Br) `I` (I) set `editElement` (and switch to add-atom if the current tool doesn't use an element),
`G` fragment tool, `H` add hydrogens, `Shift+H` remove hydrogens, `Ctrl/Cmd+Shift+C` clean geometry.
Export `SHORTCUTS` for the help overlay.

## UI (shell-ui + edit-ui)

Layout is fixed in `App.tsx` (read it). Components read the store with selectors and call store actions or
`app/actions.ts`. Use primitives from `ui/common.tsx` and icons from `lucide-react`. Theme tokens are CSS
variables in `styles/global.css` (dark + light). Component CSS goes in `ui/<Component>.css` with a class prefix
(e.g. `.layers-…`, `.topbar-…`) and is imported by the component. Floating elements over the stage use the
`.glass` class.

shell-ui:
- **TopBar**: brand (logo mark + "Molecule Studio" + current molecule name, editable inline), Open (`setPanel('load')`),
  segmented View | Edit mode switch, undo/redo with labels in tooltips (`past.at(-1).label`), Export menu
  (PDB, SDF, XYZ, MOL2, PNG image ×1/×2/×4 transparent), camera menu (reset view, view along X/Y/Z, focus selection),
  panel toggles (left/right/sequence), theme toggle, settings (`togglePanel('settings')`), help (`?`).
- **LoadDialog**: modal (`panels.load`) with tabs: *Gallery* (cards from `SAMPLES` grouped by category, search),
  *Search* (PubChem name with autocomplete via `pubchemAutocomplete`, debounced; PDB id with example chips;
  AlphaFold UniProt id), *SMILES* (textarea + examples, `openSmiles`), *File* (drop zone + picker using
  `ACCEPTED_EXTENSIONS`; paste-text area with format select), *New* (start empty molecule → edit mode).
- **DropOverlay**: window drag & drop → `openFile`.
- **SelectionBar**: query input with live validation (`evaluateSelection` count / error), autocomplete
  (`selectionSuggestions`), quick chips (`quickSelections`), actions: Select (`setSelection(maskToIds)`), Focus,
  "New layer from query", Clear; shows "N atoms selected".
- **LayersPanel**: one card per `reps` entry: visibility eye, name, style select (icons), color scheme select +
  color picker when uniform, selection query (editable, validated, shows atom count), opacity + size sliders,
  duplicate / delete / move up-down. "Add layer" menu with presets (Cartoon, Ball & stick, Sticks of ligands,
  Surface, Spacefill, Lines, "Selected atoms as ball & stick" → `selection: 'id 1 2 3'` style query from the
  current selection) and a small color legend (`colorLegend`) for the active scheme.
- **InfoPanel**: molecule summary (`moleculeSummary`: formula, mass, atoms, bonds, residues, chains, charge,
  source/format/externalId with link to RCSB/PubChem), and selection details: single atom (element name, atom
  name, residue, chain, serial, coordinates, B-factor, occupancy, charge, bonded neighbours, valence status);
  several atoms (count, formula of selection, centroid, residues spanned).
- **SettingsPanel**: drawer/popover with all `ViewSettings` (background swatches + custom color, projection,
  auto-rotate, fog, quality, labels, show hydrogens, and an "Editing" group: valence feedback, auto hydrogens,
  relax on drag, snap bonds).
- **Toasts**, **LoadingOverlay** (spinner + `loading` message), **HelpOverlay** (mouse controls, `SHORTCUTS`,
  `selectionHelp()`, tips on editing), **EmptyState** (hero: drop a file, quick-start cards: a few `SAMPLES`,
  search PubChem/PDB box, "Build a molecule" → `newMolecule()`).

edit-ui:
- **EditToolbar** (floating vertical `.glass` toolbar at the left edge of the stage, edit mode): tool buttons
  (Select, Move, Add atom, Add bond, Delete, Element, Charge, Fragment, Measure) with shortcuts in tooltips;
  current element button (shows symbol colored by element) opening **ElementPalette** (quick row of
  `COMMON_ELEMENTS` + full periodic table grid via `tableRow/tableCol`, colored by category); bond order
  selector (single/double/triple icons) for add-bond/add-atom; **FragmentPicker** popover (grid of `FRAGMENTS`
  by category) for the fragment tool; action buttons: Add H, Remove H, Clean geometry, Center.
- **EditStatusBar** (floating bottom-center `.glass`): current `hint` (or a default hint per tool/mode), in edit
  mode a valence summary ("2 atoms exceed their valence" — click selects them), undo label.
- **GeometryInspector** (right sidebar; shown when 2–4 atoms are selected or always with an empty hint):
  2 atoms → distance; 3 → angle (2nd selected = vertex; selection order = insertion order of the Set);
  4 → dihedral. Shows the live value; in edit mode a slider + `NumberField` change it live using
  `setDistance`/`setAngle`/`setDihedral` via transient edits (begin on slider pointerdown, end on commit),
  disabled with reason when not possible (`canSetDihedral`, ring bonds); "Pin as measurement" button.
  Also shows ideal bond length for bonded pairs and deviation.
- **MeasurementsPanel**: list of `measurements` with live values, hover → highlight, click → focus, delete,
  clear all, and a measure-kind segmented control that activates the measure tool.
- **SequenceViewer**: bottom strip; per chain a row of one-letter residue codes (protein/nucleic) with residue
  numbers every 10, colored by secondary structure background; hover → `setHovered` on the CA; click → select the
  residue's atoms (shift: extend range, ctrl/cmd: toggle); double-click → focus. Highlight residues that contain
  selected atoms. Horizontal scroll; handles thousands of residues (virtualize or cheap DOM).
- **HoverTooltip**: small `.glass` card near the cursor (offset 14 px, flips at edges) for `hovered`: atom → element,
  name, residue & chain, B-factor; in edit mode add valence status; bond → "C–O · double · 1.23 Å". Hidden while dragging.

## Testing expectations
- io: round-trip tests (parse → write → parse) for each format; real-world snippets (PDB with HELIX/SHEET,
  altLocs, multiple models; SDF with charges; mmCIF atom_site loop with quoted values; MOL2).
- structure: bonds for small molecules (ethanol, benzene), no H–H bonds, altLoc handling, selection grammar
  (each keyword, precedence, errors), secondary structure on an ideal helix.
- chemistry/forcefield: valence statuses incl. charges and aromatic, formula/mass (caffeine C8H10N4O2 = 194.19),
  edit ops keep ids stable, setDistance/Angle/Dihedral hit the target values, addHydrogens on methane-from-C,
  minimiser reduces energy and restores ideal bond lengths, SMILES parsing (benzene, caffeine, charged, rings,
  branches) and 3D embedding quality (bond lengths within 0.1 Å of ideal, aromatic rings planar).


## Implementation notes (added after integration)

- `idealBondLength` uses experimental X–H lengths and a table of polar heteroatom bonds (P–O, S–O, Si–O, …) besides
  scaled covalent radii; it is the single source of rest lengths for the minimiser and the geometry inspector.
  Delocalised terminal groups (carboxylate C–O 1.255 Å, nitro N–O 1.22 Å) use resonance lengths through
  `idealBondLengthInMolecule(mol, a, b)`, which the force field, the inspector, the hover tooltip and the editor's
  bond-length fixer all call.
- `setDistance` / `setAngle` / `setDihedral` move the smaller rigid side of the bond, so editing a side chain never drags
  the rest of a protein along (`smallerSide(mol, a, b)` in core/edit.ts shows which side moves).
- `ValenceInfo.bondOrderSum` is the effective valence used for the check (aromatic bonds rounded per atom).
- `prepareMolecule` assigns bond orders whenever the file has none: geometry-based for ligands and small molecules,
  residue templates for standard amino acids and nucleotides. 2D input is embedded in 3D before perception.
- Loading a protein or nucleic acid while editing switches to View mode; the layer added for editing leaves waters out.
- Reset view and Focus (without a selection) frame the atoms drawn by visible layers, not hidden waters.

### Caching by structure

- `getTopology`, `analyzeValence`, `moleculeSummary`, ring data, the selection index, coordinate-free selection results and
  the sequence model are cached per **structure** (`structureKey` / `createStructureCache` in core/molecule.ts), not per
  molecule object. Molecules that differ only in coordinates (every drag frame, minimiser output, geometry edits) share
  them, which keeps edit-mode drags on 100k-atom structures at a few ms per frame.
- A structure is every non-coordinate atom field plus the bonds (ids, endpoints, orders); a compile-time check fails if
  `Atom` or `Bond` gains a field missing from `ATOM_STRUCTURE_FIELDS` / `BOND_STRUCTURE_FIELDS`.
- Cached values are shared: never mutate them. A `createStructureCache` compute function must not read x/y/z or
  molecule-level fields (`name`, `meta`), which the key does not cover. Coordinate-dependent selections (`within`,
  `exwithin`, x/y/z comparisons) are cached per molecule object only.

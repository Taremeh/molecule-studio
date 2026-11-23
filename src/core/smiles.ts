/**
 * SMILES support: parse SMILES into a molecular graph and generate reasonable 3D coordinates.
 * OWNER: minimiser/SMILES agent. CONTRACT: keep exported names & signatures.
 *
 * Supported SMILES subset (OpenSMILES): organic subset atoms (B C N O P S F Cl Br I, aromatic
 * b c n o p s), bracket atoms with isotope/element/chirality(ignored for geometry ok)/H-count/charge/class
 * e.g. [NH4+], [O-], [Fe+2], [13CH3], [nH]; bonds - = # $ : / \ and '.' disconnection;
 * branches (); ring closures 1-9 and %nn, including bond orders on ring closures.
 * Aromatic bonds → order 1.5 in the output. Implicit hydrogens are made explicit.
 *
 * Notes on the implementation
 * - Implicit hydrogens follow OpenSMILES: organic-subset atoms take the lowest normal valence that
 *   fits their bonds; aromatic atoms additionally reserve one π bond when they need one, and a
 *   Kekulé structure (perfect matching of those atoms, blossom algorithm) must exist. A lowercase
 *   'n' that must carry the H (pyrrole written as c1ccnc1) is protonated automatically.
 * - Aromatic bonds between two π-contributing atoms become 1.5; bonds to atoms that do not take
 *   part in the ring's π bonding (pyrrole-type [nH], c(=O)) become single, keeping valences exact.
 * - Tetrahedral (@/@@) and double-bond (/ \) stereo are honoured by the 3D embedding.
 * - '$' (quadruple) is stored as a triple bond (the data model has no quadruple order).
 */
import type { Atom, Bond, BondOrder, Molecule } from './types';
import { ELEMENT_SYMBOLS, allowedValences } from './ff-chem';
import { edgeKey, ringEdgeSet } from './ff-rings';
import { maximumMatching } from './smiles-kekule';
import { embedMolecule, type StereoSpec } from './smiles-embed';

export interface SmilesParseResult {
  /** Graph only — all coordinates are 0. Explicit hydrogens included. */
  mol: Molecule;
}

/** Parse result with the stereo information needed by the 3D embedder. */
export interface SmilesParseDetailed extends SmilesParseResult {
  stereo: StereoSpec;
  /** Text after the SMILES (separated by whitespace), often a name. */
  title?: string;
}

const ELEMENTS = new Set(ELEMENT_SYMBOLS);
const AROMATIC_BRACKET = new Set(['b', 'c', 'n', 'o', 'p', 's', 'se', 'as', 'te']);
/** OpenSMILES default valences of the organic subset. */
const ORGANIC_VALENCES: Record<string, number[]> = {
  B: [3], C: [4], N: [3, 5], O: [2], P: [3, 5], S: [2, 4, 6], F: [1], Cl: [1], Br: [1], I: [1], '*': [0],
};

interface PAtom {
  element: string;
  aromatic: boolean;
  bracket: boolean;
  /** Explicit (bracket) or computed implicit hydrogen count. */
  hCount: number;
  charge: number;
  chiral: 0 | 1 | -1; // +1 '@@', -1 '@'
  pos: number;
  /** Neighbour atom indices in SMILES order; -2 marks the bracket hydrogen, -1 an unfilled ring slot. */
  order: number[];
  needsPi: boolean;
}

interface PBond {
  a: number;
  b: number;
  sym: string;
  pos: number;
  /** Atom written before the bond symbol (for / and \ semantics); -1 for ring closures. */
  from: number;
}

class SmilesError extends Error {}

function fail(pos: number, msg: string): never {
  throw new SmilesError(`Invalid SMILES at position ${pos + 1}: ${msg}`);
}

function bondOrderOfSymbol(sym: string): number {
  return sym === '=' ? 2 : sym === '#' ? 3 : sym === '$' ? 4 : 1;
}

/** Parse SMILES. Throws Error with a helpful message (position + reason) on invalid input. */
export function parseSmiles(smiles: string, name?: string): SmilesParseResult {
  const r = parseSmilesDetailed(smiles, name);
  return { mol: r.mol };
}

/** Like parseSmiles, plus stereo information (atom indices refer to the returned molecule). */
export function parseSmilesDetailed(input: string, name?: string): SmilesParseDetailed {
  const text = input.replace(/^\s+/, '');
  const wsAt = text.search(/\s/);
  const s = wsAt >= 0 ? text.slice(0, wsAt) : text;
  const title = wsAt >= 0 ? text.slice(wsAt).trim() || undefined : undefined;
  if (!s) throw new SmilesError('Invalid SMILES: the string is empty');

  const atoms: PAtom[] = [];
  const bonds: PBond[] = [];
  const bondSet = new Set<string>();
  const branchStack: { atom: number; pos: number; size: number }[] = [];
  const rings = new Map<number, { atom: number; sym: string; pos: number; slot: number }>();
  let prev = -1;
  let pending: { sym: string; pos: number } | null = null;
  let dotAt = -1;
  let i = 0;

  const addBond = (a: number, b: number, sym: string, pos: number, from: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (bondSet.has(key)) fail(pos, `duplicate bond between atoms ${a + 1} and ${b + 1}`);
    bondSet.add(key);
    bonds.push({ a, b, sym, pos, from });
  };

  const newAtom = (atom: PAtom) => {
    const idx = atoms.length;
    atoms.push(atom);
    if (prev >= 0) {
      addBond(prev, idx, pending ? pending.sym : '', pending ? pending.pos : atom.pos, prev);
      atoms[prev].order.push(idx);
      atom.order.unshift(prev);
    } else if (pending) {
      fail(pending.pos, `bond '${pending.sym}' has no atom before it`);
    }
    pending = null;
    prev = idx;
    dotAt = -1;
    if (branchStack.length) branchStack[branchStack.length - 1].size++;
  };

  while (i < s.length) {
    const ch = s[i];
    const start = i;
    if (ch === '[') {
      const close = s.indexOf(']', i);
      if (close < 0) fail(i, "unterminated bracket atom (missing ']')");
      const body = s.slice(i + 1, close);
      newAtom(parseBracket(body, i));
      i = close + 1;
    } else if (/[A-Za-z*]/.test(ch)) {
      let sym = '';
      let aromatic = false;
      const two = s.slice(i, i + 2);
      if (two === 'Cl' || two === 'Br') {
        sym = two;
        i += 2;
      } else if ('BCNOPSFI*'.includes(ch)) {
        sym = ch;
        i++;
      } else if ('bcnops'.includes(ch)) {
        sym = ch.toUpperCase();
        aromatic = true;
        i++;
      } else {
        // Elements outside the organic subset must be bracketed: suggest it (e.g. Na → [Na]).
        const two2 = ch + (s[i + 1] ?? '');
        const back = (s[i - 1] ?? '') + ch;
        const sym = /^[A-Z][a-z]$/.test(two2) && ELEMENTS.has(two2) ? two2
          : /^[A-Z][a-z]$/.test(back) && ELEMENTS.has(back) ? back
          : ELEMENTS.has(ch) ? ch : '';
        fail(i, `unexpected character '${ch}'${sym ? ` (elements outside B C N O P S F Cl Br I go in brackets, e.g. [${sym}])` : ''}`);
      }
      newAtom({ element: sym, aromatic, bracket: false, hCount: 0, charge: 0, chiral: 0, pos: start, order: [], needsPi: false });
    } else if ('-=#$:/\\'.includes(ch)) {
      if (prev < 0) fail(i, `bond '${ch}' has no atom before it`);
      if (pending) fail(i, `two bond symbols in a row ('${pending.sym}${ch}')`);
      pending = { sym: ch, pos: i };
      i++;
    } else if (ch === '(') {
      if (prev < 0) fail(i, "branch '(' must follow an atom");
      if (pending) fail(pending.pos, "a bond symbol must go inside the branch, e.g. C(=O)");
      branchStack.push({ atom: prev, pos: i, size: 0 });
      i++;
    } else if (ch === ')') {
      const br = branchStack.pop();
      if (!br) fail(i, "unmatched ')'");
      if (pending) fail(pending.pos, `bond '${pending.sym}' at the end of a branch`);
      if (br.size === 0) fail(br.pos, 'empty branch ()');
      prev = br.atom;
      i++;
    } else if (ch === '.') {
      if (pending) fail(pending.pos, `bond '${pending.sym}' before '.'`);
      if (prev < 0) fail(i, "'.' must follow an atom");
      prev = -1;
      dotAt = i;
      i++;
    } else if (/[0-9%]/.test(ch)) {
      let num: number;
      if (ch === '%') {
        if (s[i + 1] === '(') {
          const close = s.indexOf(')', i);
          if (close < 0 || !/^\d+$/.test(s.slice(i + 2, close))) fail(i, "ring bond '%(' needs digits and ')'");
          num = parseInt(s.slice(i + 2, close), 10);
          i = close + 1;
        } else {
          if (!/^\d\d$/.test(s.slice(i + 1, i + 3))) fail(i, "ring bond '%' must be followed by two digits, e.g. %10");
          num = parseInt(s.slice(i + 1, i + 3), 10);
          i += 3;
        }
      } else {
        num = ch.charCodeAt(0) - 48;
        i++;
      }
      if (prev < 0) fail(start, `ring bond ${num} has no atom before it`);
      const open = rings.get(num);
      const sym = pending ? pending.sym : '';
      if (open) {
        if (open.atom === prev) fail(start, `ring bond ${num} closes on the same atom`);
        let bsym = open.sym || sym;
        if (open.sym && sym && open.sym !== sym) {
          const dir = (x: string) => x === '/' || x === '\\';
          if (dir(open.sym) && dir(sym)) bsym = '-';
          else fail(start, `ring bond ${num} has conflicting bond symbols '${open.sym}' and '${sym}'`);
        }
        // Directional marks on ring closures are not used for stereo (treated as single bonds).
        if (bsym === '/' || bsym === '\\') bsym = '-';
        addBond(open.atom, prev, bsym, open.pos, -1);
        atoms[open.atom].order[open.slot] = prev;
        atoms[prev].order.push(open.atom);
        rings.delete(num);
      } else {
        atoms[prev].order.push(-1);
        rings.set(num, { atom: prev, sym, pos: start, slot: atoms[prev].order.length - 1 });
      }
      pending = null;
    } else {
      fail(i, `unexpected character '${ch}'`);
    }
  }
  // (TS cannot see that the closures above reassign `pending`, hence the explicit type)
  const dangling = pending as { sym: string; pos: number } | null;
  if (dangling) fail(dangling.pos, `bond '${dangling.sym}' at the end of the SMILES`);
  if (branchStack.length) fail(branchStack[branchStack.length - 1].pos, "unclosed branch '('");
  if (dotAt >= 0) fail(dotAt, "'.' must be followed by another fragment");
  if (rings.size) {
    const [num, r] = [...rings.entries()][0];
    fail(r.pos, `ring bond ${num} is never closed`);
  }
  if (!atoms.length) throw new SmilesError('Invalid SMILES: no atoms');

  assignHydrogens(atoms, bonds);
  return buildResult(atoms, bonds, name ?? title ?? s, title);
}

function parseBracket(body: string, at: number): PAtom {
  // [isotope? symbol chiral? hcount? charge? class?]
  const m = /^(\d+)?(\*|[A-Z][a-z]?|se|as|te|[bcnops])(@(?:@|TH[12]|AL[12]|SP[123]|TB\d{1,2}|OH\d{1,2})?)?(H\d*)?([+-](?:\d+|[+-]*))?(:\d+)?$/.exec(body);
  if (!m) {
    if (!body) fail(at, 'empty bracket atom []');
    fail(at, `cannot read bracket atom [${body}]`);
  }
  let sym = m[2];
  let aromatic = false;
  if (AROMATIC_BRACKET.has(sym)) {
    aromatic = true;
    sym = sym[0].toUpperCase() + sym.slice(1);
  } else if (sym !== '*' && !ELEMENTS.has(sym)) {
    // e.g. [Cn] is valid but [Xy] is not; a two-letter match might also be element + something else
    fail(at, `unknown element '${sym}' in [${body}]`);
  }
  let chiral: 0 | 1 | -1 = 0;
  const c = m[3];
  if (c === '@' || c === '@TH1') chiral = -1;
  else if (c === '@@' || c === '@TH2') chiral = 1;
  const hCount = m[4] ? (m[4].length > 1 ? parseInt(m[4].slice(1), 10) : 1) : 0;
  let charge = 0;
  const q = m[5];
  if (q) {
    const sign = q[0] === '+' ? 1 : -1;
    const rest = q.slice(1);
    if (!rest) charge = sign;
    else if (/^\d+$/.test(rest)) charge = sign * parseInt(rest, 10);
    else if ([...rest].every((x) => x === q[0])) charge = sign * (rest.length + 1);
    else fail(at, `cannot read charge '${q}' in [${body}]`);
  }
  return { element: sym === '*' ? '*' : sym, aromatic, bracket: true, hCount, charge, chiral, pos: at, order: hCount > 0 ? [-2] : [], needsPi: false };
}

/** Implicit hydrogens (organic subset) and π-bond requirements of aromatic atoms (Kekulé check). */
function assignHydrogens(atoms: PAtom[], bonds: PBond[]): void {
  const n = atoms.length;
  const nbrs: number[][] = atoms.map(() => []);
  const sum = new Float64Array(n);
  const hasMultiple = new Uint8Array(n);
  for (const b of bonds) {
    nbrs[b.a].push(b.b);
    nbrs[b.b].push(b.a);
    const o = bondOrderOfSymbol(b.sym);
    sum[b.a] += o;
    sum[b.b] += o;
    if (o >= 2) {
      hasMultiple[b.a] = 1;
      hasMultiple[b.b] = 1;
    }
  }
  for (let i = 0; i < n; i++) {
    const a = atoms[i];
    if (a.bracket) {
      if (a.aromatic && !hasMultiple[i]) {
        const v = allowedValences(a.element, a.charge)[0];
        a.needsPi = v !== undefined && sum[i] + a.hCount + 1 <= v;
      }
      continue;
    }
    const valences = ORGANIC_VALENCES[a.element] ?? [];
    if (a.aromatic) {
      const v = valences[0] ?? 0;
      if (!hasMultiple[i] && sum[i] + 1 <= v) {
        a.needsPi = true;
        a.hCount = v - sum[i] - 1;
      } else a.hCount = Math.max(0, v - sum[i]);
    } else {
      const v = valences.find((x) => x >= sum[i]);
      a.hCount = v === undefined ? 0 : v - sum[i];
    }
  }

  // Kekulé structure: perfect matching on π-needing aromatic atoms over aromatic ring bonds.
  const ringEdges = ringEdgeSet(nbrs);
  const isAromaticBond = (b: PBond) =>
    atoms[b.a].aromatic && atoms[b.b].aromatic && (b.sym === ':' || b.sym === '') && ringEdges.has(edgeKey(b.a, b.b, n));
  const solve = () => {
    const adj: number[][] = atoms.map(() => []);
    for (const b of bonds) {
      if (!isAromaticBond(b) || !atoms[b.a].needsPi || !atoms[b.b].needsPi) continue;
      adj[b.a].push(b.b);
      adj[b.b].push(b.a);
    }
    const match = maximumMatching(n, adj);
    const unmatched: number[] = [];
    for (let i = 0; i < n; i++) if (atoms[i].needsPi && match[i] === -1) unmatched.push(i);
    return unmatched;
  };
  let unmatched = solve();
  if (unmatched.length) {
    // Pyrrole-type nitrogens written without their H (c1ccnc1): try protonating candidates.
    const candidates = atoms
      .map((a, idx) => idx)
      .filter((idx) => {
        const a = atoms[idx];
        return a.aromatic && !a.bracket && a.element === 'N' && a.needsPi && sum[idx] === 2;
      });
    for (const c of candidates) {
      if (!unmatched.length) break;
      atoms[c].needsPi = false;
      atoms[c].hCount = 1;
      const next = solve();
      if (next.length < unmatched.length) unmatched = next;
      else {
        atoms[c].needsPi = true;
        atoms[c].hCount = 0;
      }
    }
  }
  if (unmatched.length) {
    const a = atoms[unmatched[0]];
    const sym = a.element.toLowerCase();
    fail(a.pos, `cannot assign a Kekulé structure to the aromatic system containing '${sym}' (check aromatic atoms; pyrrole-type nitrogens are written [nH])`);
  }
}

function buildResult(atoms: PAtom[], bonds: PBond[], name: string, title?: string): SmilesParseDetailed {
  const n = atoms.length;
  const nbrs: number[][] = atoms.map(() => []);
  for (const b of bonds) {
    nbrs[b.a].push(b.b);
    nbrs[b.b].push(b.a);
  }
  const ringEdges = ringEdgeSet(nbrs);
  const outAtoms: Atom[] = [];
  const outBonds: Bond[] = [];
  const counters = new Map<string, number>();
  const nameFor = (el: string) => {
    const c = (counters.get(el) ?? 0) + 1;
    counters.set(el, c);
    return `${el}${c}`;
  };
  for (let i = 0; i < n; i++) {
    const a = atoms[i];
    const el = a.element === '*' ? 'X' : a.element;
    const atom: Atom = { id: i + 1, element: el, x: 0, y: 0, z: 0, name: nameFor(el) };
    if (a.charge) atom.charge = a.charge;
    outAtoms.push(atom);
  }
  for (const b of bonds) {
    let order: BondOrder;
    const o = bondOrderOfSymbol(b.sym);
    if (o >= 2) order = (o >= 3 ? 3 : 2) as BondOrder;
    else if (
      (b.sym === ':' || b.sym === '') &&
      atoms[b.a].aromatic &&
      atoms[b.b].aromatic &&
      atoms[b.a].needsPi &&
      atoms[b.b].needsPi &&
      ringEdges.has(edgeKey(b.a, b.b, n))
    )
      order = 1.5;
    else order = 1;
    outBonds.push({ id: outBonds.length + 1, a: b.a + 1, b: b.b + 1, order });
  }
  // Explicit hydrogens, appended after the heavy atoms (first H of each atom remembered for stereo).
  const firstH = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let h = 0; h < atoms[i].hCount; h++) {
      const idx = outAtoms.length;
      if (h === 0) firstH[i] = idx;
      outAtoms.push({ id: idx + 1, element: 'H', x: 0, y: 0, z: 0, name: nameFor('H') });
      outBonds.push({ id: outBonds.length + 1, a: i + 1, b: idx + 1, order: 1 });
    }
  }

  // ---- stereo ----
  const stereo: StereoSpec = { centres: [], doubleBonds: [] };
  for (let i = 0; i < n; i++) {
    const a = atoms[i];
    if (!a.chiral) continue;
    const order = a.order.map((x) => (x === -2 ? firstH[i] : x));
    // implicit H of an organic-subset atom cannot carry chirality; brackets list it explicitly
    if (order.length !== 4 || order.some((x) => x < 0)) continue;
    stereo.centres.push({ atom: i, nbrs: order, sign: a.chiral });
  }
  // Directional bonds: side(v relative to u) for each bond written u→v ('/' = up).
  const side = new Map<string, number>(); // `${atom},${neighbour}` → +1 up / −1 down
  for (const b of bonds) {
    if (b.sym !== '/' && b.sym !== '\\') continue;
    const dir = b.sym === '/' ? 1 : -1;
    const u = b.from;
    const v = u === b.a ? b.b : b.a;
    side.set(`${u},${v}`, dir); // v is "up" from u for '/'
    side.set(`${v},${u}`, -dir); // u is "down" from v
  }
  if (side.size) {
    for (const b of bonds) {
      if (bondOrderOfSymbol(b.sym) !== 2) continue;
      const pick = (atom: number, other: number) => {
        for (const x of nbrs[atom]) if (x !== other && side.has(`${atom},${x}`)) return x;
        return -1;
      };
      const x = pick(b.a, b.b);
      const y = pick(b.b, b.a);
      if (x < 0 || y < 0) continue;
      const sx = side.get(`${b.a},${x}`)!;
      const sy = side.get(`${b.b},${y}`)!;
      stereo.doubleBonds.push({ a: b.a, b: b.b, x, y, cis: sx === sy });
    }
  }

  const mol: Molecule = {
    name,
    atoms: outAtoms,
    bonds: outBonds,
    nextAtomId: outAtoms.length + 1,
    nextBondId: outBonds.length + 1,
    meta: { source: 'smiles', title: title ?? name, hasBondOrders: true },
  };
  return { mol, stereo, title };
}

/**
 * Parse + embed in 3D + minimize. The result has sensible bond lengths/angles, planar aromatic rings,
 * and no clashes. meta.source = 'smiles'. Throws on invalid SMILES.
 */
export function moleculeFromSmiles(smiles: string, name?: string): Molecule {
  const parsed = parseSmilesDetailed(smiles, name);
  const mol = embedMolecule(parsed.mol, parsed.stereo);
  return { ...mol, name: parsed.mol.name, meta: { ...parsed.mol.meta, source: 'smiles', hasBondOrders: true } };
}

/** Generate 3D coordinates for a molecule graph whose coordinates are missing/flat/2D. Returns a new molecule. */
export function embed3D(mol: Molecule): Molecule {
  if (mol.atoms.length === 0) return mol;
  return embedMolecule(mol, undefined, { useInputDoubleBondStereo: true });
}

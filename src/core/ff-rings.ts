/**
 * Graph utilities on index-based adjacency lists: ring (non-bridge) edges, bounded local ring
 * searches (for force-field typing of small rings) and a smallest set of smallest rings (SSSR)
 * for 3D embedding. OWNER: forcefield agent.
 *
 * Self-contained on purpose (the force field must not depend on modules developed concurrently).
 */

export type Adjacency = readonly (readonly number[])[];

/** Canonical key for the undirected edge i–j in a graph of n vertices. */
export function edgeKey(i: number, j: number, n: number): number {
  return i < j ? i * n + j : j * n + i;
}

/**
 * Edges that lie on at least one cycle (i.e. are not bridges), as a set of edgeKey values.
 * Iterative Tarjan bridge finding, O(V + E); safe for long chains (no recursion).
 */
export function ringEdgeSet(nbrs: Adjacency, mask?: Uint8Array): Set<number> {
  const n = nbrs.length;
  // With a mask, only the induced subgraph of the masked vertices is analysed.
  const inside = (v: number) => !mask || mask[v] === 1;
  const disc = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const stackV = new Int32Array(n);
  const stackP = new Int32Array(n);
  const stackI = new Int32Array(n);
  const skipped = new Uint8Array(n);
  const bridges = new Set<number>();
  let time = 0;
  for (let root = 0; root < n; root++) {
    if (disc[root] !== -1 || !inside(root)) continue;
    let sp = 0;
    stackV[0] = root;
    stackP[0] = -1;
    stackI[0] = 0;
    skipped[0] = 0;
    disc[root] = low[root] = time++;
    while (sp >= 0) {
      const v = stackV[sp];
      const list = nbrs[v];
      if (stackI[sp] < list.length) {
        const w = list[stackI[sp]++];
        if (!inside(w)) continue;
        // Skip the tree edge back to the parent exactly once (parallel bonds would form a ring).
        if (w === stackP[sp] && !skipped[sp]) {
          skipped[sp] = 1;
          continue;
        }
        if (disc[w] === -1) {
          disc[w] = low[w] = time++;
          sp++;
          stackV[sp] = w;
          stackP[sp] = v;
          stackI[sp] = 0;
          skipped[sp] = 0;
        } else if (disc[w] < low[v]) {
          low[v] = disc[w];
        }
      } else {
        const p = stackP[sp];
        sp--;
        if (p >= 0) {
          if (low[v] < low[p]) low[p] = low[v];
          if (low[v] > disc[p]) bridges.add(edgeKey(p, v, n));
        }
      }
    }
  }
  const ring = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (!inside(i)) continue;
    for (const j of nbrs[i]) {
      if (j <= i || !inside(j)) continue;
      const k = edgeKey(i, j, n);
      if (!bridges.has(k)) ring.add(k);
    }
  }
  return ring;
}

/**
 * Shortest path (vertex list src … dst) with at most `maxLen` edges that does not visit
 * `avoidVertex` and does not use the direct edge src–dst when `avoidDirect` is set.
 * Optional `allowed` restricts the visited vertices. Uses a Map so it stays cheap on large graphs.
 */
export function shortestPath(
  nbrs: Adjacency,
  src: number,
  dst: number,
  maxLen: number,
  avoidVertex = -1,
  avoidDirect = false,
  allowed?: (v: number) => boolean,
): number[] | null {
  if (src === dst) return [src];
  const prev = new Map<number, number>();
  prev.set(src, -1);
  let frontier = [src];
  for (let depth = 0; depth < maxLen && frontier.length; depth++) {
    const next: number[] = [];
    for (const v of frontier) {
      for (const w of nbrs[v]) {
        if (w === avoidVertex || prev.has(w)) continue;
        if (avoidDirect && v === src && w === dst) continue;
        if (w !== dst && allowed && !allowed(w)) continue;
        prev.set(w, v);
        if (w === dst) {
          const path = [dst];
          let c = v;
          while (c !== -1) {
            path.push(c);
            c = prev.get(c)!;
          }
          return path.reverse();
        }
        next.push(w);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Size of the smallest ring (≤ maxSize) containing both bonds a–j and j–c, or 0 if none.
 * (a and c bonded → 3-ring, common neighbour → 4-ring, …)
 */
export function smallestRingThroughAngle(
  nbrs: Adjacency,
  ringEdges: Set<number>,
  a: number,
  j: number,
  c: number,
  maxSize: number,
): number {
  const n = nbrs.length;
  if (!ringEdges.has(edgeKey(a, j, n)) || !ringEdges.has(edgeKey(j, c, n))) return 0;
  const p = shortestPath(nbrs, a, c, maxSize - 2, j);
  return p ? p.length + 1 : 0;
}

/** Size of the smallest ring (≤ maxSize) containing bond i–j, or 0. */
export function smallestRingThroughBond(nbrs: Adjacency, ringEdges: Set<number>, i: number, j: number, maxSize: number): number {
  if (!ringEdges.has(edgeKey(i, j, nbrs.length))) return 0;
  const p = shortestPath(nbrs, i, j, maxSize - 1, -1, true);
  return p ? p.length : 0;
}

/**
 * Smallest set of smallest rings. Candidates are the shortest cycle through every ring edge
 * (plus Horton candidates if those do not span the cycle space, e.g. for some cages); a minimum
 * cycle basis is then selected greedily by size with Gaussian elimination over GF(2).
 * Each ring is returned as an ordered list of vertex indices.
 */
export function findSSSR(nbrs: Adjacency): number[][] {
  const n = nbrs.length;
  const ringEdges = ringEdgeSet(nbrs);
  if (ringEdges.size === 0) return [];

  // Index ring edges and split them into connected ring systems.
  const edgeIndex = new Map<number, number>();
  const edges: [number, number][] = [];
  for (const k of ringEdges) {
    edgeIndex.set(k, edges.length);
    edges.push([Math.floor(k / n), k % n]);
  }
  const ringNbrs: number[][] = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) {
    ringNbrs[u].push(v);
    ringNbrs[v].push(u);
  }
  const comp = new Int32Array(n).fill(-1);
  let nComp = 0;
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1 || ringNbrs[s].length === 0) continue;
    const stack = [s];
    comp[s] = nComp;
    while (stack.length) {
      const v = stack.pop()!;
      for (const w of ringNbrs[v]) if (comp[w] === -1) {
        comp[w] = nComp;
        stack.push(w);
      }
    }
    nComp++;
  }

  const rings: number[][] = [];
  for (let c = 0; c < nComp; c++) {
    const sysEdges: number[] = [];
    const sysVerts: number[] = [];
    for (let e = 0; e < edges.length; e++) if (comp[edges[e][0]] === c) sysEdges.push(e);
    for (let v = 0; v < n; v++) if (comp[v] === c) sysVerts.push(v);
    const mu = sysEdges.length - sysVerts.length + 1;
    if (mu <= 0) continue;
    const words = Math.ceil(edges.length / 32);
    const basis: { vec: Uint32Array; pivot: number }[] = [];
    const chosen: number[][] = [];
    const seen = new Set<string>();

    const toVec = (cycle: number[]): Uint32Array | null => {
      const vec = new Uint32Array(words);
      for (let i = 0; i < cycle.length; i++) {
        const e = edgeIndex.get(edgeKey(cycle[i], cycle[(i + 1) % cycle.length], n));
        if (e === undefined) return null;
        vec[e >>> 5] ^= 1 << (e & 31);
      }
      return vec;
    };
    const tryAdd = (cycle: number[]) => {
      if (chosen.length >= mu) return;
      const key = cycle.slice().sort((x, y) => x - y).join(',');
      if (seen.has(key)) return;
      seen.add(key);
      const vec = toVec(cycle);
      if (!vec) return;
      for (const b of basis) if ((vec[b.pivot >>> 5] >>> (b.pivot & 31)) & 1) for (let w = 0; w < words; w++) vec[w] ^= b.vec[w];
      let pivot = -1;
      for (let w = 0; w < words && pivot < 0; w++) if (vec[w]) pivot = w * 32 + (31 - Math.clz32(vec[w] & -vec[w]));
      if (pivot < 0) return;
      // Keep the basis reduced on the new pivot so later reductions stay a single pass.
      for (const b of basis) if ((b.vec[pivot >>> 5] >>> (pivot & 31)) & 1) for (let w = 0; w < words; w++) b.vec[w] ^= vec[w];
      basis.push({ vec, pivot });
      chosen.push(cycle);
    };

    // Shortest cycle through each ring edge.
    const candidates: number[][] = [];
    for (const e of sysEdges) {
      const [u, v] = edges[e];
      const p = shortestPath(ringNbrs, u, v, sysVerts.length, -1, true);
      if (p) candidates.push(p);
    }
    candidates.sort((a, b) => a.length - b.length);
    for (const cyc of candidates) tryAdd(cyc);

    if (chosen.length < mu) {
      // Horton candidates: path(x,u) + (u,v) + path(v,x) for every vertex x and edge (u,v).
      const horton: number[][] = [];
      for (const x of sysVerts) {
        const prev = new Map<number, number>([[x, -1]]);
        const queue = [x];
        for (let qi = 0; qi < queue.length; qi++) {
          const v = queue[qi];
          for (const w of ringNbrs[v]) if (!prev.has(w)) {
            prev.set(w, v);
            queue.push(w);
          }
        }
        const pathTo = (t: number) => {
          const p: number[] = [];
          for (let cur = t; cur !== -1; cur = prev.get(cur)!) p.push(cur);
          return p.reverse();
        };
        for (const e of sysEdges) {
          const [u, v] = edges[e];
          if (prev.get(u) === v || prev.get(v) === u) continue;
          const pu = pathTo(u);
          const pv = pathTo(v);
          const set = new Set(pu);
          let disjoint = true;
          for (let i = 1; i < pv.length; i++) if (set.has(pv[i])) disjoint = false;
          if (!disjoint) continue;
          horton.push([...pu, ...pv.slice(1).reverse()]);
        }
      }
      horton.sort((a, b) => a.length - b.length);
      for (const cyc of horton) tryAdd(cyc);
    }
    rings.push(...chosen);
  }
  return rings;
}

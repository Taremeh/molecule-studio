/**
 * Maximum matching in a general graph (Edmonds' blossom algorithm, O(V³)). Used to find a Kekulé
 * structure for aromatic SMILES: every aromatic atom that needs a π bond must be matched with
 * exactly one aromatic neighbour (fused 5-rings make the graph non-bipartite, hence blossoms).
 * OWNER: forcefield agent.
 */

/** Returns match[v] = partner of v, or -1 when v is unmatched. */
export function maximumMatching(n: number, adj: readonly (readonly number[])[]): Int32Array {
  const match = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n);
  const base = new Int32Array(n);
  const used = new Uint8Array(n);
  const blossom = new Uint8Array(n);
  const queue = new Int32Array(n);

  const lca = (a0: number, b0: number): number => {
    const seen = new Uint8Array(n);
    let a = a0;
    for (;;) {
      a = base[a];
      seen[a] = 1;
      if (match[a] === -1) break;
      a = parent[match[a]];
    }
    let b = b0;
    for (;;) {
      b = base[b];
      if (seen[b]) return b;
      b = parent[match[b]];
    }
  };

  const markPath = (v0: number, b: number, child0: number) => {
    let v = v0;
    let child = child0;
    while (base[v] !== b) {
      blossom[base[v]] = 1;
      blossom[base[match[v]]] = 1;
      parent[v] = child;
      child = match[v];
      v = parent[match[v]];
    }
  };

  /** BFS for an augmenting path from root; returns its free end vertex or -1. */
  const findPath = (root: number): number => {
    used.fill(0);
    parent.fill(-1);
    for (let i = 0; i < n; i++) base[i] = i;
    used[root] = 1;
    let qh = 0;
    let qt = 0;
    queue[qt++] = root;
    while (qh < qt) {
      const v = queue[qh++];
      for (const to of adj[v]) {
        if (base[v] === base[to] || match[v] === to) continue;
        if (to === root || (match[to] !== -1 && parent[match[to]] !== -1)) {
          // Odd cycle: contract the blossom onto its base.
          const cur = lca(v, to);
          blossom.fill(0);
          markPath(v, cur, to);
          markPath(to, cur, v);
          for (let i = 0; i < n; i++) {
            if (blossom[base[i]]) {
              base[i] = cur;
              if (!used[i]) {
                used[i] = 1;
                queue[qt++] = i;
              }
            }
          }
        } else if (parent[to] === -1) {
          parent[to] = v;
          if (match[to] === -1) return to;
          used[match[to]] = 1;
          queue[qt++] = match[to];
        }
      }
    }
    return -1;
  };

  // Greedy start, then augment from every free vertex.
  for (let v = 0; v < n; v++) {
    if (match[v] !== -1) continue;
    for (const to of adj[v]) {
      if (match[to] === -1) {
        match[v] = to;
        match[to] = v;
        break;
      }
    }
  }
  for (let v = 0; v < n; v++) {
    if (match[v] !== -1) continue;
    let u = findPath(v);
    while (u !== -1) {
      const pv = parent[u];
      const ppv = match[pv];
      match[u] = pv;
      match[pv] = u;
      u = ppv;
    }
  }
  return match;
}

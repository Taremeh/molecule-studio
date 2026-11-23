/* Demo overlays, injected into the app page while recording (demo/record.mjs):
 * a visible cursor with click ripples, a step label over the 3D view, and title / end cards in
 * which real molecules (water, methane, ammonia, CO₂, ethanol, acetic acid, benzene, caffeine)
 * drift and turn in 3D behind the title.
 * Exposes window.__demo = { step(text|null, n), card(id|null), cursor(visible) }. */
(() => {
  if (window.__demo) return;

  // ---- molecules (Å, centred), from the app's own samples and PubChem's caffeine -------------
  const MOLS = {
    water: { a: [['O', 0, -0.39, 0], ['H', 0.76, 0.2, 0], ['H', -0.76, 0.2, 0]], b: [[0, 1], [0, 2]] },
    methane: { a: [['C', 0, 0, 0], ['H', 0.63, 0.63, 0.63], ['H', 0.63, -0.63, -0.63], ['H', -0.63, 0.63, -0.63], ['H', -0.63, -0.63, 0.63]], b: [[0, 1], [0, 2], [0, 3], [0, 4]] },
    ammonia: { a: [['N', 0, 0, 0.29], ['H', 0, 0.94, -0.1], ['H', -0.81, -0.47, -0.1], ['H', 0.81, -0.47, -0.1]], b: [[0, 1], [0, 2], [0, 3]] },
    co2: { a: [['C', 0, 0, 0], ['O', 1.16, 0, 0], ['O', -1.16, 0, 0]], b: [[0, 1], [0, 2]] },
    ethanol: { a: [['C', -1, -0.18, 0], ['C', 0.51, -0.18, 0], ['O', 0.95, 1.18, 0], ['H', 1.92, 1.19, 0], ['H', -1.38, -1.21, 0], ['H', -1.38, 0.33, -0.89], ['H', -1.38, 0.33, 0.89], ['H', 0.89, -0.72, 0.88], ['H', 0.89, -0.72, -0.88]], b: [[0, 1], [1, 2], [2, 3], [0, 4], [0, 5], [0, 6], [1, 7], [1, 8]] },
    acetic: { a: [['C', -0.95, 0.19, 0], ['C', 0.57, 0.19, 0], ['O', 1.29, 1.16, 0], ['O', 1.04, -1.09, 0], ['H', 2.01, -1.02, 0], ['H', -1.32, 1.22, 0], ['H', -1.32, -0.32, -0.89], ['H', -1.32, -0.32, 0.89]], b: [[0, 1], [1, 2], [1, 3], [3, 4], [0, 5], [0, 6], [0, 7]] },
    benzene: { a: [['C', 1.4, 0, 0], ['C', 0.7, 1.21, 0], ['C', -0.7, 1.21, 0], ['C', -1.4, 0, 0], ['C', -0.7, -1.21, 0], ['C', 0.7, -1.21, 0], ['H', 2.48, 0, 0], ['H', 1.24, 2.15, 0], ['H', -1.24, 2.15, 0], ['H', -2.48, 0, 0], ['H', -1.24, -2.15, 0], ['H', 1.24, -2.15, 0]], b: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [0, 5], [0, 6], [1, 7], [2, 8], [3, 9], [4, 10], [5, 11]] },
    caffeine: { a: [['O', 0.41, 2.53, 0], ['O', -3.19, -0.49, 0], ['N', -1.03, -1.36, 0], ['N', 2.15, 0.1, 0], ['N', -1.41, 1.04, 0], ['N', 1.35, -1.98, 0], ['C', 0.79, 0.22, 0], ['C', 0.33, -1.07, 0], ['C', -0.03, 1.38, 0], ['C', -1.97, -0.29, 0], ['C', 2.44, -1.24, 0], ['C', -1.49, -2.74, 0], ['C', 3.13, 1.16, 0], ['C', -2.36, 2.14, 0], ['H', 3.45, -1.62, 0], ['H', -1.11, -3.24, -0.89], ['H', -2.58, -2.8, 0], ['H', -1.11, -3.24, 0.9], ['H', 4.14, 0.74, 0], ['H', 2.98, 1.77, -0.9], ['H', 2.98, 1.77, 0.9], ['H', -1.87, 3.12, 0], ['H', -3, 2.06, 0.89], ['H', -3, 2.06, -0.89]], b: [[0, 8], [1, 9], [2, 7], [2, 9], [2, 11], [3, 6], [3, 10], [3, 12], [4, 8], [4, 9], [4, 13], [5, 7], [5, 10], [6, 7], [6, 8], [10, 14], [11, 15], [11, 16], [11, 17], [12, 18], [12, 19], [12, 20], [13, 21], [13, 22], [13, 23]] },
  };
  const COLOR = { H: ['#ffffff', '#9aa3b2'], C: ['#b8bec9', '#4b5260'], N: ['#8fa6ff', '#2338b8'], O: ['#ff8a8a', '#b80d0d'] };
  const RAD = { H: 0.24, C: 0.36, N: 0.35, O: 0.34 };

  // a seeded random, so every take has the same scene
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  function makeScene(names) {
    return names.map((name, i) => {
      const depth = 0.35 + 0.65 * ((i * 0.618) % 1); // spread over depth layers
      const axis = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
      const al = Math.hypot(...axis);
      return {
        mol: MOLS[name],
        fx: rnd(), fy: rnd(), // place as a fraction of the screen
        depth,
        axis: axis.map((v) => v / al),
        angle: rnd() * 6.28,
        spin: (0.18 + rnd() * 0.3) * (rnd() < 0.5 ? -1 : 1),
        vx: (rnd() - 0.5) * 14, vy: -6 - rnd() * 12, // a slow drift upwards
      };
    });
  }

  function rotate([x, y, z], [ux, uy, uz], a) {
    const c = Math.cos(a), s = Math.sin(a), d = ux * x + uy * y + uz * z;
    return [
      x * c + (uy * z - uz * y) * s + ux * d * (1 - c),
      y * c + (uz * x - ux * z) * s + uy * d * (1 - c),
      z * c + (ux * y - uy * x) * s + uz * d * (1 - c),
    ];
  }

  function drawScene(ctx, scene, w, h, t) {
    ctx.clearRect(0, 0, w, h);
    const order = scene.slice().sort((p, q) => p.depth - q.depth); // far ones first
    for (const m of order) {
      const scale = (22 + 46 * m.depth) * (h / 810); // px per Å
      const span = 1.3;
      let x = ((m.fx * w + m.vx * t) % (w * span) + w * span) % (w * span) - w * (span - 1) / 2;
      let y = ((m.fy * h + m.vy * t * m.depth) % (h * span) + h * span) % (h * span) - h * (span - 1) / 2;
      const ang = m.angle + m.spin * t;
      const pts = m.mol.a.map(([el, ax, ay, az]) => {
        const [rx, ry, rz] = rotate([ax, ay, az], m.axis, ang);
        return { el, x: x + rx * scale, y: y - ry * scale, z: rz };
      });
      ctx.save();
      // molecules fade out as they drift behind the title in the middle, so the text stays legible
      const ex = (x - w / 2) / (w * 0.3), ey = (y - h / 2) / (h * 0.26);
      const clear = Math.min(1, Math.max(0.08, (Math.hypot(ex, ey) - 0.55) / 0.55));
      ctx.globalAlpha = (0.22 + 0.6 * m.depth) * clear;
      ctx.filter = m.depth < 0.75 ? `blur(${((0.75 - m.depth) * 7).toFixed(1)}px)` : 'none';
      // bonds behind, then atoms back to front
      ctx.lineCap = 'round';
      for (const [i, j] of m.mol.b) {
        const a = pts[i], b = pts[j];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.lineWidth = 0.17 * scale;
        ctx.strokeStyle = COLOR[a.el][1];
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mx, my); ctx.stroke();
        ctx.strokeStyle = COLOR[b.el][1];
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      for (const p of pts.slice().sort((p, q) => p.z - q.z)) {
        const r = RAD[p.el] * scale * 1.25;
        const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.35, r * 0.1, p.x, p.y, r);
        g.addColorStop(0, COLOR[p.el][0]);
        g.addColorStop(1, COLOR[p.el][1]);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  const css = `
  #demo-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483646; pointer-events: none;
    transform: translate(-100px, -100px); transition: opacity .25s; filter: drop-shadow(0 2px 4px rgba(0,0,0,.45)); }
  #demo-cursor.down svg { transform: scale(.86); transform-origin: 3px 2px; }
  .demo-ripple { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; z-index: 2147483645;
    pointer-events: none; border: 2.5px solid rgba(96,165,250,.95); background: rgba(96,165,250,.18); animation: demo-rip .55s ease-out forwards; }
  @keyframes demo-rip { from { transform: scale(.25); opacity: 1 } to { transform: scale(1.25); opacity: 0 } }
  #demo-step { position: fixed; z-index: 2147483640; pointer-events: none; display: flex; align-items: center; gap: 10px;
    padding: 9px 16px 9px 10px; border-radius: 999px; font: 600 15px/1.2 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #f1f5f9; background: rgba(15,23,42,.78); border: 1px solid rgba(148,163,184,.28); backdrop-filter: blur(10px);
    box-shadow: 0 8px 24px rgba(0,0,0,.35); opacity: 0; transform: translateY(-8px); transition: opacity .35s, transform .35s; }
  #demo-step.on { opacity: 1; transform: none; }
  #demo-step b { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%;
    background: linear-gradient(135deg,#60a5fa,#a78bfa); color: #0b1020; font-size: 13px; }
  .demo-card { position: fixed; inset: 0; z-index: 2147483644; pointer-events: none; opacity: 0; transition: opacity .8s ease;
    background: radial-gradient(ellipse at 50% 45%, #17223b 0%, #0b0f17 72%); }
  .demo-card.on { opacity: 1; }
  .demo-card canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .demo-card .veil { position: absolute; inset: 0; background: radial-gradient(ellipse 42% 34% at 50% 50%, rgba(11,15,23,.9) 0%, rgba(11,15,23,.6) 55%, rgba(11,15,23,0) 100%); }
  .demo-card .inner { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
  .demo-card .logo { width: 92px; height: 92px; margin: 0 auto 22px; opacity: 0; }
  .demo-card h1 { margin: 0; font: 700 66px/1.05 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: -1.5px;
    background: linear-gradient(90deg,#e2e8f0,#93c5fd 55%,#c4b5fd); -webkit-background-clip: text; color: transparent; opacity: 0; }
  .demo-card p { margin: 16px 0 0; font: 500 23px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; color: #a5b4c8; opacity: 0; }
  .demo-card .tags { margin-top: 26px; display: flex; gap: 10px; justify-content: center; opacity: 0; }
  .demo-card .tags span { font: 600 14px/1 Inter, ui-sans-serif, system-ui, sans-serif; color: #cbd5e1; padding: 8px 14px;
    border-radius: 999px; border: 1px solid rgba(148,163,184,.3); background: rgba(30,41,59,.7); }
  .demo-card.play .logo { animation: demo-pop .9s cubic-bezier(.2,1.4,.4,1) .35s forwards; }
  .demo-card.play h1 { animation: demo-up .9s cubic-bezier(.2,.8,.2,1) .7s forwards; }
  .demo-card.play p { animation: demo-up .9s cubic-bezier(.2,.8,.2,1) 1.15s forwards; }
  .demo-card.play .tags { animation: demo-up .9s cubic-bezier(.2,.8,.2,1) 1.5s forwards; }
  @keyframes demo-pop { from { opacity: 0; transform: scale(.4) rotate(-25deg) } to { opacity: 1; transform: none } }
  @keyframes demo-up { from { opacity: 0; transform: translateY(18px) } to { opacity: 1; transform: none } }
  `;
  const logo = `<svg class="logo" viewBox="0 0 100 100"><defs>
    <radialGradient id="dg1" cx="35%" cy="30%"><stop offset="0" stop-color="#bfdbfe"/><stop offset="1" stop-color="#3b82f6"/></radialGradient>
    <radialGradient id="dg2" cx="35%" cy="30%"><stop offset="0" stop-color="#fecaca"/><stop offset="1" stop-color="#ef4444"/></radialGradient>
    <radialGradient id="dg3" cx="35%" cy="30%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cbd5e1"/></radialGradient></defs>
    <line x1="38" y1="58" x2="66" y2="30" stroke="#94a3b8" stroke-width="7" stroke-linecap="round"/>
    <line x1="38" y1="58" x2="70" y2="70" stroke="#94a3b8" stroke-width="7" stroke-linecap="round"/>
    <circle cx="38" cy="58" r="22" fill="url(#dg1)"/><circle cx="68" cy="28" r="14" fill="url(#dg2)"/><circle cx="72" cy="72" r="11" fill="url(#dg3)"/></svg>`;

  const install = () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const cur = document.createElement('div');
    cur.id = 'demo-cursor';
    cur.innerHTML = `<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L19 15 Z"
      fill="#fff" stroke="#0b0f17" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(cur);
    const step = document.createElement('div');
    step.id = 'demo-step';
    document.body.appendChild(step);

    const NAMES = ['caffeine', 'water', 'benzene', 'methane', 'ethanol', 'co2', 'ammonia', 'acetic', 'water', 'benzene', 'methane', 'co2', 'ethanol', 'water', 'ammonia', 'caffeine'];
    const mk = (id, html) => {
      const c = document.createElement('div');
      c.className = 'demo-card';
      c.id = 'demo-card-' + id;
      c.innerHTML = `<canvas></canvas><div class="veil"></div><div class="inner">${html}</div>`;
      document.body.appendChild(c);
      const canvas = c.querySelector('canvas');
      return { el: c, canvas, scene: makeScene(NAMES), t0: performance.now() };
    };
    const cards = {
      title: mk('title', `${logo}<h1>Molecule Studio</h1><p>Explore and build molecules in 3D, right in the browser</p>`),
      end: mk('end', `${logo}<h1>Molecule Studio</h1><p>Explore · Inspect · Build</p>
        <div class="tags"><span>PDB · mmCIF · SDF · MOL2 · XYZ</span><span>PubChem · AlphaFold · SMILES</span><span>Live chemical feedback</span></div>`),
    };
    const tick = () => {
      for (const card of Object.values(cards)) {
        if (!card.el.classList.contains('on') && getComputedStyle(card.el).opacity === '0') continue;
        const dpr = window.devicePixelRatio || 1;
        const w = card.canvas.clientWidth, h = card.canvas.clientHeight;
        if (card.canvas.width !== Math.round(w * dpr)) { card.canvas.width = Math.round(w * dpr); card.canvas.height = Math.round(h * dpr); }
        const ctx = card.canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawScene(ctx, card.scene, w, h, (performance.now() - card.t0) / 1000);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const move = (e) => { cur.style.transform = `translate(${e.clientX - 3}px, ${e.clientY - 2}px)`; };
    // Pointer events, not mouse events: the app cancels pointerdown on the canvas, which stops
    // the compatibility mouse events for the rest of a drag.
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerdown', (e) => {
      move(e);
      cur.classList.add('down');
      const r = document.createElement('div');
      r.className = 'demo-ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    }, true);
    window.addEventListener('pointerup', () => cur.classList.remove('down'), true);
    const placeStep = () => {
      const stage = document.querySelector('.stage');
      const r = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth };
      step.style.left = r.left + r.width / 2 + 'px';
      step.style.top = r.top + 16 + 'px';
      step.style.marginLeft = -step.offsetWidth / 2 + 'px';
    };
    window.__demo = {
      step(text, n) {
        if (!text) { step.classList.remove('on'); return; }
        step.innerHTML = `<b>${n}</b>${text}`;
        placeStep();
        requestAnimationFrame(() => { placeStep(); step.classList.add('on'); });
      },
      /** show a card (restarting its entrance and its molecules), or hide all with null */
      card(id) {
        for (const [k, c] of Object.entries(cards)) {
          const on = k === id;
          if (on && !c.el.classList.contains('play')) {
            c.t0 = performance.now();
            c.el.classList.add('play');
          }
          if (!on) setTimeout(() => !c.el.classList.contains('on') && c.el.classList.remove('play'), 900);
          c.el.classList.toggle('on', on);
        }
      },
      /** restart the title's entrance (called when the recording starts) */
      replayTitle() {
        const c = cards.title;
        c.el.classList.remove('play');
        void c.el.offsetWidth;
        c.t0 = performance.now();
        c.el.classList.add('play');
      },
      cursor(visible) { cur.style.opacity = visible ? '1' : '0'; },
    };
    cards.title.el.classList.add('on');
  };
  if (document.body) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
})();

#!/usr/bin/env node
/* Records the demo video's picture: drives the app in headless Chrome on the narration's clock
 * and captures every painted frame.
 *
 *   node demo/record.mjs --timeline <build>/timeline.json --out <build> [--url http://localhost:4173]
 *
 * The timeline comes from the narration step (tts.py + align.py): every action below is placed on
 * the start of a spoken word, so the picture follows the voice. Writes <out>/frames/*.jpg and
 * <out>/frames.txt (an ffmpeg concat list with each frame's duration). demo/overlay.js draws the
 * cursor, the step labels and the title / end cards inside the page.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const URL_ = opt('url', 'http://localhost:4173/');
const OUT = opt('out');
const TL = JSON.parse(readFileSync(opt('timeline'), 'utf8'));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1440, H = 810, DSF = 4 / 3; // 1920 × 1080 pixels
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- narration clock -------------------------------------------------------------------------
const norm = (w) => w.toLowerCase().replace(/[^a-z0-9-]/g, '');
const shot = (id) => TL.shots.find((s) => s.id === id);
/** start time of the n-th occurrence of `word` in shot `id` */
function word(id, w, n = 0) {
  const hits = shot(id).lines.flatMap((l) => l.words ?? []).filter((x) => norm(x[0]) === norm(w));
  if (!hits[n]) throw new Error(`word "${w}" not in shot ${id}`);
  return hits[n][1];
}

// ---- Chrome + CDP ----------------------------------------------------------------------------
const prof = mkdtempSync(join(tmpdir(), 'demo-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, '--remote-debugging-port=0',
  '--user-data-dir=' + prof, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => {
  let buf = '';
  chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
  chrome.on('exit', () => rej(new Error('Chrome exited: ' + buf.slice(-300))));
});
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let msgId = 0;
const pending = new Map();
const handlers = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  } else if (m.method) handlers.forEach((f) => f(m));
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const msg = { id: ++msgId, method, params };
  if (sessionId) msg.sessionId = sessionId;
  pending.set(msg.id, { res, rej });
  ws.send(JSON.stringify(msg));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable');
await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DSF, mobile: false });
await S('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(join(HERE, 'overlay.js'), 'utf8') });
handlers.push((m) => {
  if (m.method === 'Runtime.exceptionThrown') console.error('page error:', m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
});

async function js(expr) {
  const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) + '\n' + expr.slice(0, 200));
  return r.result.value;
}
async function waitFor(expr, timeout = 15000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (await js(`!!(${expr})`)) return;
    await sleep(50);
  }
  throw new Error('timed out waiting for ' + expr);
}
async function navigate() {
  const loaded = new Promise((r) => { const f = (m) => { if (m.method === 'Page.loadEventFired') { handlers.splice(handlers.indexOf(f), 1); r(); } }; handlers.push(f); });
  await S('Page.navigate', { url: URL_ });
  await loaded;
  await waitFor('window.__store && window.__demo && document.querySelector(".stage")');
  await js(PAGE_HELPERS);
}

// Page-side helpers: find controls by CSS, title prefix or exact text, and atoms on screen.
const PAGE_HELPERS = `window.__rec = {
  el(q, root = document) {
    const vis = (e) => e && e.getClientRects().length > 0;
    if (q.startsWith('title^=')) return [...root.querySelectorAll('[title]')].find((e) => vis(e) && e.getAttribute('title').startsWith(q.slice(7)));
    if (q.startsWith('text=')) return [...root.querySelectorAll('button,[role=tab],label,a')].find((e) => vis(e) && e.textContent.trim() === q.slice(5));
    return [...root.querySelectorAll(q)].find(vis);
  },
  box(q, rootSel) {
    const root = rootSel ? this.el(rootSel) : document;
    const e = root && this.el(q, root);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, r: r.right, t: r.top, b: r.bottom };
  },
  card(name) { return [...document.querySelectorAll('.layers-card')].find((c) => c.querySelector('.layers-name')?.value === name); },
  atom(id) {
    const a = window.__store.getState().molecule.atoms.find((a) => a.id === id);
    const p = window.__viewer().worldToScreen([a.x, a.y, a.z]);
    return { x: p.x, y: p.y };
  },
  pickable(id) {
    const p = this.atom(id);
    const k = window.__viewer().pick(p.x, p.y);
    return k && k.kind === 'atom' && k.atomId === id ? p : null;
  },
  /** A screen point that really picks this atom: its centre, or the nearest point around it that
   *  is not covered by a neighbour drawn in front (e.g. a hydrogen in front of its carbon). */
  pickPoint(id) {
    const p = this.atom(id), v = window.__viewer();
    for (const r of [0, 4, 7, 10, 13, 16, 20, 24]) {
      for (let k = 0; k < (r ? 16 : 1); k++) {
        const a = (k * Math.PI) / 8, x = p.x + r * Math.cos(a), y = p.y + r * Math.sin(a);
        const h = v.pick(x, y);
        if (h && h.kind === 'atom' && h.atomId === id) return { x, y };
      }
    }
    return p;
  },
};`;

// ---- input -----------------------------------------------------------------------------------
let cx = W * 0.62, cy = H * 0.55, buttons = 0;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const mouse = (type, extra = {}) => S('Input.dispatchMouseEvent', { type, x: cx, y: cy, buttons, ...extra });
/** Moves on the wall clock (not per step), so slow round trips to the page never stretch a move. */
async function move(x, y, dur = 0.45, arc = 0.12) {
  const x0 = cx, y0 = cy, t0 = performance.now(), D = dur * 1000;
  // a gentle arc, like a hand moving the mouse
  const nx = -(y - y0) * arc, ny = (x - x0) * arc;
  for (;;) {
    const u = Math.min(1, (performance.now() - t0) / D);
    const t = ease(u), b = Math.sin(Math.PI * t);
    cx = x0 + (x - x0) * t + nx * b;
    cy = y0 + (y - y0) * t + ny * b;
    await mouse('mouseMoved', buttons ? { button: 'left' } : {});
    if (u >= 1) break;
    await sleep(14);
  }
}
async function down() { buttons = 1; await mouse('mousePressed', { button: 'left', clickCount: 1 }); }
async function up() { buttons = 0; await mouse('mouseReleased', { button: 'left', clickCount: 1 }); }
async function click(p, dur = 0.4) {
  if (p) await move(p.x, p.y, dur);
  await down();
  await sleep(70);
  await up();
}
/** Types on the wall clock: when the page is slow to take a key, the next ones go in together. */
async function type(text, cps = 14) {
  const t0 = performance.now();
  let done = 0;
  while (done < text.length) {
    const due = Math.min(text.length, Math.floor(((performance.now() - t0) / 1000) * cps) + 1);
    if (due > done) {
      await S('Input.insertText', { text: text.slice(done, due) });
      done = due;
    } else await sleep(6);
  }
}
const KEYS = { Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'] };
async function key(k) {
  const [code, name, text] = KEYS[k] ?? [k.toUpperCase().charCodeAt(0), 'Key' + k.toUpperCase(), k];
  await S('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: KEYS[k] ? name : k, code: name, windowsVirtualKeyCode: code, text });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: KEYS[k] ? name : k, code: name, windowsVirtualKeyCode: code });
}
async function wheel(x, y, dy, count, dur) {
  await move(x, y, 0.25);
  for (let i = 0; i < count; i++) {
    await S('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: dy });
    await sleep((dur * 1000) / count);
  }
}
const box = (q, root) => js(`__rec.box(${JSON.stringify(q)}, ${JSON.stringify(root ?? null)})`);
async function need(q, root) {
  const b = await box(q, root);
  if (!b) throw new Error('control not found: ' + q);
  return b;
}
const blur = () => js('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
const stageBox = () => box('.stage');

// ---- warm-up: fetch the structures once so the recorded loads are quick -----------------------
await navigate();
await js(`Promise.all([
  fetch('https://files.rcsb.org/download/1HSG.pdb').then((r) => r.text()),
  fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/caffeine/SDF?record_type=3d').then((r) => r.text()),
]).then((t) => t.map((x) => x.length))`).catch(() => 0);
await navigate();
await sleep(800);

// ---- recording -------------------------------------------------------------------------------
const FR = join(OUT, 'frames');
rmSync(FR, { recursive: true, force: true });
mkdirSync(FR, { recursive: true });
const frames = [];
handlers.push((m) => {
  if (m.method !== 'Page.screencastFrame') return;
  const { data, metadata, sessionId: sid } = m.params;
  const file = join(FR, String(frames.length).padStart(6, '0') + '.jpg');
  writeFileSync(file, Buffer.from(data, 'base64'));
  frames.push({ file, ts: metadata.timestamp });
  S('Page.screencastFrameAck', { sessionId: sid }).catch(() => {});
});
await S('Page.startScreencast', { format: 'jpeg', quality: 93, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
await js('__demo.cursor(false)');
await sleep(400);
const T0 = Date.now() / 1000;
await js('__demo.replayTitle()');
const now = () => Date.now() / 1000 - T0;
async function at(t) { const d = t - now(); if (d > 0) await sleep(d * 1000); }
const log = (s) => console.log(`${now().toFixed(2).padStart(6)}  ${s}`);
const pt = (id) => js(`__rec.pickPoint(${id})`);
async function moveTo(id, dur, arc) { const p = await pt(id); await move(p.x, p.y, dur, arc); }

const st = await stageBox();
const mid = { x: (st.l + st.r) / 2, y: (st.t + st.b) / 2 };
await mouse('mouseMoved');

// INTRO: animated title over the start page ---------------------------------------------------
await at(word('intro', 'browser') + 1.0);
await js('__demo.card(null)');
log('title out');

// LOOK: a small molecule by name, turn, zoom, inspect -----------------------------------------
await at(shot('look').start - 0.5);
await js('__demo.cursor(true)');
await js(`__demo.step('Open a molecule by name', 1)`);
await click(await need('input.shell-field-input'), 0.7);
await at(word('look', 'Type') + 0.3);
await type('caffeine', 9);
await at(word('look', 'caffeine') + 0.25);
await key('Enter');
await blur();
log('search caffeine');
await waitFor(`window.__store.getState().molecule?.atoms.length === 24`);
log('caffeine loaded');
await move(mid.x + 40, mid.y + 170, 0.8);
await at(word('look', 'Drag') - 0.35);
await js(`__demo.step('Turn it, zoom in, click an atom', 2)`);
await move(mid.x - 150, mid.y + 90, 0.35);
await down();
await move(mid.x + 170, mid.y + 30, 1.3, 0.2);
await up();
await at(word('look', 'scroll') - 0.1);
await wheel(mid.x + 20, mid.y + 20, -90, 7, 1.1);
log('turned + zoomed');
const oxy = await js(`(() => {
  const m = window.__store.getState().molecule;
  return m.atoms.filter((a) => a.element === 'O').map((a) => a.id).find((id) => __rec.pickable(id)) ?? m.atoms[0].id;
})()`);
await at(word('look', 'Click') - 0.15);
await click(await pt(oxy), 0.6);
log('inspected');

// BUILD: add a carbon, drag a bond (green / red), tidy up --------------------------------------
await at(shot('build').start - 0.3);
await js(`__demo.step('Edit it, with live chemical feedback', 3)`);
await blur();
await key('Escape');
await js(`window.__viewer().resetView()`);
await click(await need('text=Edit'), 0.6);
await sleep(300);
await at(word('build', 'Click') - 0.75);
await click(await need('title^=Add atom'), 0.55);
await sleep(200);
// caffeine's C8 (the ring CH) and a saturated ring nitrogen next to it; the new atom goes just
// beyond C8, so both are within bonding reach and the red preview is about valence, not distance
const cf = await js(`(() => {
  const m = window.__store.getState().molecule;
  const nb = new Map(m.atoms.map((a) => [a.id, []]));
  for (const b of m.bonds) { nb.get(b.a).push(b.b); nb.get(b.b).push(b.a); }
  const el = new Map(m.atoms.map((a) => [a.id, a.element]));
  const c8 = m.atoms.find((a) => a.element === 'C' && nb.get(a.id).some((x) => el.get(x) === 'H') && nb.get(a.id).filter((x) => el.get(x) === 'N').length === 2);
  const ns = nb.get(c8.id).filter((x) => el.get(x) === 'N');
  const n7 = ns.find((x) => nb.get(x).length === 2) ?? ns[0];
  const h8 = nb.get(c8.id).find((x) => el.get(x) === 'H');
  const p8 = __rec.atom(c8.id), ph = __rec.atom(h8);
  const dx = ph.x - p8.x, dy = ph.y - p8.y, L = Math.hypot(dx, dy) || 1;
  const px = Math.max(60, L) / 1.09; // pixels per Å, roughly
  return { c8: c8.id, n7, place: { x: p8.x + (dx / L) * px * 2.4, y: p8.y + (dy / L) * px * 2.4 } };
})()`);
await at(word('build', 'add') - 0.35);
await click(cf.place, 0.7);
log('placed atom');
await sleep(250);
const newC = await js(`Math.max(...window.__store.getState().molecule.atoms.filter((a) => a.element === 'C').map((a) => a.id))`);
await move(mid.x + 230, mid.y + 120, 0.8); // out of the way while the hydrogens appear
await at(word('build', 'Drag') - 0.45);
await moveTo(newC, 0.55);
await down();
await moveTo(cf.c8, Math.max(0.6, word('build', 'green') - now() - 0.05), 0.15);
log('green');
await at(word('build', 'red') - 0.35);
await moveTo(cf.n7, 0.6, 0.15);
log('red');
await at(word('build', 'full') + 0.35);
await moveTo(cf.c8, 0.55, 0.1);
await at(word('build', 'Let') + 0.05);
await up();
log('bonded');
await at(word('build', 'one') - 0.55);
await click(await need('title^=Clean up geometry'), 0.6);
log('clean');

// PROTEIN: the big one, at the end ------------------------------------------------------------
await at(shot('protein').start - 0.25);
await js(`__demo.step('Big molecules too', 4)`);
await click(await need('title^=Open a structure'), 0.55);
await waitFor(`__rec.el('.modal')`);
await sleep(200);
await click(await need('text=Search online', '.modal'), 0.45);
await sleep(200);
await click(await need('title^=1HSG:', '.modal'), 0.5);
log('open 1HSG');
await waitFor(`window.__store.getState().molecule?.atoms.length > 1000`);
log('protein loaded');
await move(mid.x + 160, mid.y + 200, 0.7);
await at(word('protein', 'with') - 0.2);
await move(mid.x - 120, mid.y + 80, 0.4);
await down();
await move(mid.x + 90, mid.y + 40, 1.2, 0.15);
await up();
await at(word('protein', 'Show') - 0.9);
const chev = await js(`(() => { const c = __rec.card('Protein'); const b = c.querySelector('.layers-chevron').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
await click(chev, 0.5);
await sleep(250);
const surf = await js(`(() => { const e = [...__rec.card('Protein').querySelectorAll('.layers-style')].find((b) => b.title.startsWith('Surface')); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await move(surf.x, surf.y, 0.45);
await at(word('protein', 'surface') - 0.15);
await click(null);
log('surface');
const sel = await js(`(() => { const r = __rec.card('Protein').querySelector('select').getBoundingClientRect(); return { x: r.left + r.width * 0.45, y: r.top + r.height / 2 }; })()`);
await at(word('protein', 'color') - 0.1);
await move(sel.x, sel.y, 0.5);
await at(word('protein', 'water-loving') + 0.05);
// A native <select> popup is not drawn in a screencast: show the click, set the value directly.
await js(`(() => {
  window.dispatchEvent(new PointerEvent('pointerdown', { clientX: ${sel.x}, clientY: ${sel.y} }));
  window.dispatchEvent(new PointerEvent('pointerup', { clientX: ${sel.x}, clientY: ${sel.y} }));
  const s = __rec.card('Protein').querySelector('select');
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'hydrophobicity');
  s.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
log('hydrophobicity');
const rng = await js(`(() => { const r = __rec.card('Protein').querySelector('input[type=range]').getBoundingClientRect(); return { l: r.left, r: r.right, y: r.top + r.height / 2 }; })()`);
await at(word('protein', 'look') - 0.45);
await move(rng.r - 7, rng.y, 0.4);
await down();
await move(rng.l + (rng.r - rng.l) * 0.38, rng.y, 1.0, 0);
await up();
log('see-through');
await js(`window.__store.getState().setView({ autoRotate: true })`);
await move(st.r - 70, st.b - 70, 0.8);

// OUTRO --------------------------------------------------------------------------------------
await at(shot('outro').start);
await js(`__demo.step(null)`);
await at(word('outro', 'Molecule') - 0.3);
await js('__demo.cursor(false); __demo.card("end")');
log('end card');
await at(TL.duration);
await sleep(300);
await S('Page.stopScreencast');
await sleep(300);

// ---- frame list ------------------------------------------------------------------------------
const T1 = TL.duration;
const rel = frames.map((f) => ({ ...f, t: f.ts - T0 }));
const startIdx = Math.max(0, rel.findIndex((f) => f.t > 0) - 1);
const kept = rel.slice(startIdx).filter((f) => f.t < T1);
let list = '';
for (let i = 0; i < kept.length; i++) {
  const t = Math.max(0, kept[i].t);
  const t2 = i + 1 < kept.length ? Math.max(0, kept[i + 1].t) : T1;
  list += `file '${kept[i].file}'\nduration ${(t2 - t).toFixed(4)}\n`;
}
list += `file '${kept[kept.length - 1].file}'\n`;
writeFileSync(join(OUT, 'frames.txt'), list);
console.log(`${kept.length} frames over ${T1.toFixed(2)} s (${(kept.length / T1).toFixed(1)} fps average)`);
ws.close();
chrome.kill();
await sleep(500);
try { rmSync(prof, { recursive: true, force: true }); } catch {}
process.exit(0);

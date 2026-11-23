/**
 * Minimal DOM for rendering the UI components with react-dom/client in vitest's node environment
 * (no jsdom in this project). Supports what React 19 and the components need: element tree,
 * attributes, style, text, events with capture / target / bubble phases, focus and a window with
 * listeners. Test-only. OWNER: ui.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = { fn: (e: any) => void; capture: boolean; once: boolean };

class FakeEventTarget {
  _listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: any, opts?: boolean | { capture?: boolean; once?: boolean; passive?: boolean }) {
    if (!fn) return;
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const once = typeof opts === 'object' && !!opts?.once;
    const list = this._listeners.get(type) ?? [];
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture, once });
    this._listeners.set(type, list);
  }
  removeEventListener(type: string, fn: any, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }
  listenerCount(type: string) {
    return this._listeners.get(type)?.length ?? 0;
  }
  _parentForEvents(): FakeEventTarget | null {
    return null;
  }
  dispatchEvent(ev: any): boolean {
    ev.target = this;
    const path: FakeEventTarget[] = [];
    for (let n: FakeEventTarget | null = this; n; n = n._parentForEvents()) path.push(n);
    const invoke = (node: FakeEventTarget, phase: 'capture' | 'bubble' | 'target-capture' | 'target-bubble') => {
      const list = node._listeners.get(ev.type);
      if (!list) return;
      ev.currentTarget = node;
      ev.eventPhase = phase.startsWith('target') ? 2 : phase === 'capture' ? 1 : 3;
      for (const l of [...list]) {
        const wantCapture = phase === 'capture' || phase === 'target-capture';
        if (l.capture !== wantCapture) continue;
        if (l.once) node.removeEventListener(ev.type, l.fn, l.capture);
        l.fn.call(node, ev);
        if (ev._stopImmediate) return;
      }
    };
    for (let i = path.length - 1; i >= 1 && !ev._stop; i--) invoke(path[i], 'capture');
    if (!ev._stop) invoke(path[0], 'target-capture');
    if (!ev._stop) invoke(path[0], 'target-bubble');
    if (ev.bubbles) for (let i = 1; i < path.length && !ev._stop; i++) invoke(path[i], 'bubble');
    ev.currentTarget = null;
    return !ev.defaultPrevented;
  }
}

export function makeEvent(type: string, init: Record<string, any> = {}) {
  const ev: any = {
    type,
    bubbles: init.bubbles ?? !['mouseenter', 'mouseleave', 'pointerenter', 'pointerleave', 'focus', 'blur', 'load', 'scroll'].includes(type),
    cancelable: true,
    defaultPrevented: false,
    timeStamp: Date.now(),
    isTrusted: true,
    _stop: false,
    _stopImmediate: false,
    target: null,
    currentTarget: null,
    eventPhase: 0,
    button: 0,
    buttons: 0,
    pointerId: 1,
    isPrimary: true,
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    relatedTarget: null,
    ...init,
    stopPropagation() {
      this._stop = true;
    },
    stopImmediatePropagation() {
      this._stop = true;
      this._stopImmediate = true;
    },
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    },
    getModifierState() {
      return false;
    },
  };
  return ev;
}

class FakeNode extends FakeEventTarget {
  nodeType = 1;
  nodeName = '';
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  ownerDocument: any;
  constructor(doc: any) {
    super();
    this.ownerDocument = doc;
  }
  _parentForEvents(): FakeEventTarget | null {
    if (this.parentNode) return this.parentNode;
    if ((this as any).nodeType === 9) return (this as any).defaultView ?? null;
    return null;
  }
  get parentElement(): FakeNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
  get previousSibling(): FakeNode | null {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null;
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  appendChild(c: FakeNode) {
    if (c.nodeType === 11) {
      for (const k of [...c.childNodes]) this.appendChild(k);
      return c;
    }
    c.parentNode?.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  insertBefore(c: FakeNode, ref: FakeNode | null) {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c);
    const i = this.childNodes.indexOf(ref);
    c.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
    return c;
  }
  removeChild(c: FakeNode) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  contains(n: any): boolean {
    for (let x: FakeNode | null = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
}

class FakeText extends FakeNode {
  nodeType = 3;
  nodeName = '#text';
  data: string;
  constructor(doc: any, data: string) {
    super(doc);
    this.data = data;
  }
  get nodeValue() {
    return this.data;
  }
  set nodeValue(v: string) {
    this.data = v;
  }
  get textContent() {
    return this.data;
  }
  set textContent(v: string) {
    this.data = v;
  }
}

class FakeComment extends FakeText {
  nodeType = 8;
  nodeName = '#comment';
  get textContent() {
    return '';
  }
  set textContent(_v: string) {}
}

function makeStyle() {
  const props: Record<string, string> = {};
  return new Proxy(props as any, {
    get(t, k) {
      if (k === 'setProperty') return (n: string, v: string) => (t[n] = v);
      if (k === 'removeProperty') return (n: string) => delete t[n];
      if (k === 'getPropertyValue') return (n: string) => t[n] ?? '';
      if (k === 'cssText') return Object.entries(t).map(([a, b]) => `${a}: ${b}`).join('; ');
      return t[k as string] ?? '';
    },
    set(t, k, v) {
      t[k as string] = v;
      return true;
    },
  });
}

export class FakeElement extends FakeNode {
  tagName: string;
  localName: string;
  namespaceURI: string;
  attributes: Record<string, string> = {};
  style = makeStyle();
  dataset: Record<string, string> = {};
  value = '';
  checked = false;
  disabled = false;
  selectionStart = 0;
  selectionEnd = 0;
  scrollLeft = 0;
  scrollTop = 0;
  clientWidth = 800;
  clientHeight = 100;
  offsetWidth = 100;
  offsetHeight = 20;
  constructor(doc: any, tag: string, ns = 'http://www.w3.org/1999/xhtml') {
    super(doc);
    this.localName = tag;
    this.tagName = ns.endsWith('xhtml') ? tag.toUpperCase() : tag;
    this.nodeName = this.tagName;
    this.namespaceURI = ns;
  }
  get type() {
    return this.attributes.type ?? (this.localName === 'button' ? 'submit' : 'text');
  }
  set type(v: string) {
    this.attributes.type = v;
  }
  get className() {
    return this.attributes.class ?? '';
  }
  set className(v: string) {
    this.attributes.class = v;
  }
  get id() {
    return this.attributes.id ?? '';
  }
  get title() {
    return this.attributes.title ?? '';
  }
  setAttribute(n: string, v: any) {
    this.attributes[n] = String(v);
    if (n.startsWith('data-')) this.dataset[n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    if (n === 'disabled') this.disabled = true;
    if (n === 'value') this.value = String(v);
  }
  selected = false;
  defaultSelected = false;
  get options() {
    return this.querySelectorAll('option');
  }
  setAttributeNS(_ns: string, n: string, v: any) {
    this.setAttribute(n, v);
  }
  getAttribute(n: string) {
    return n in this.attributes ? this.attributes[n] : null;
  }
  hasAttribute(n: string) {
    return n in this.attributes;
  }
  removeAttribute(n: string) {
    delete this.attributes[n];
    if (n === 'disabled') this.disabled = false;
  }
  removeAttributeNS(_ns: string, n: string) {
    this.removeAttribute(n);
  }
  matches(sel: string): boolean {
    return sel.split(',').some((s) => matchSimple(this, s.trim()));
  }
  closest(sel: string): FakeElement | null {
    for (let n: FakeNode | null = this; n; n = n.parentNode) if (n instanceof FakeElement && n.matches(sel)) return n;
    return null;
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  focus() {
    const doc = this.ownerDocument;
    const prev = doc.activeElement;
    if (prev === this) return;
    doc.activeElement = this;
    if (prev && prev !== doc.body) {
      prev.dispatchEvent(makeEvent('focusout', { relatedTarget: this }));
    }
    this.dispatchEvent(makeEvent('focusin', { relatedTarget: prev }));
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    this.dispatchEvent(makeEvent('focusout', { relatedTarget: null }));
  }
  click() {
    this.dispatchEvent(makeEvent('click'));
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0 };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() {
    return false;
  }
  scrollTo() {}
  scrollIntoView() {}
  select() {}
  setSelectionRange() {}
  get innerHTML() {
    return '';
  }
  set innerHTML(_v: string) {
    this.textContent = '';
  }
}

function matchSimple(el: FakeElement, sel: string): boolean {
  // Supports: tag, .class, [attr], [attr="v"], tag.class, combos without descendant combinators.
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m: RegExpExecArray | null;
  let matchedAny = false;
  const classes = (el.attributes.class ?? '').split(/\s+/);
  while ((m = re.exec(sel))) {
    matchedAny = true;
    if (m[1] && el.localName !== m[1].toLowerCase()) return false;
    if (m[2] && !classes.includes(m[2])) return false;
    if (m[3]) {
      if (!(m[3] in el.attributes)) return false;
      if (m[4] !== undefined && el.attributes[m[3]] !== m[4]) return false;
    }
  }
  return matchedAny;
}

export function installFakeDom() {
  const win: any = new FakeEventTarget();
  const doc: any = new FakeNode(null as any);
  doc.ownerDocument = null;
  doc.nodeType = 9;
  doc.nodeName = '#document';
  doc.defaultView = win;
  // React feature-detects these with `'on<event>' in document`.
  for (const ev of ['input', 'change', 'pointerdown', 'pointerup', 'pointermove', 'keydown', 'keyup', 'click', 'mouseover', 'mouseout', 'focusin', 'focusout', 'scroll', 'wheel', 'select']) doc['on' + ev] = null;
  doc.createElement = (tag: string) => new FakeElement(doc, tag);
  doc.createElementNS = (ns: string, tag: string) => new FakeElement(doc, tag, ns);
  doc.createTextNode = (t: string) => new FakeText(doc, t);
  doc.createComment = (t: string) => new FakeComment(doc, t);
  doc.createDocumentFragment = () => {
    const f = new FakeNode(doc);
    f.nodeType = 11;
    return f;
  };
  const html = new FakeElement(doc, 'html');
  const body = new FakeElement(doc, 'body');
  doc.appendChild(html);
  html.appendChild(body);
  doc.documentElement = html;
  doc.body = body;
  doc.activeElement = body;
  doc.getElementById = (id: string) => html.querySelectorAll(`[id="${id}"]`)[0] ?? null;
  doc.querySelector = (s: string) => html.querySelector(s);
  doc.querySelectorAll = (s: string) => html.querySelectorAll(s);
  win.document = doc;
  win.HTMLIFrameElement = class HTMLIFrameElement {};
  win.HTMLElement = FakeElement;
  win.Element = FakeElement;
  win.Node = FakeNode;
  win.innerWidth = 1400;
  win.innerHeight = 900;
  win.event = undefined;
  win.getComputedStyle = () => makeStyle();
  const noSelection = { rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, removeAllRanges() {}, addRange() {} };
  win.getSelection = () => noSelection;
  doc.getSelection = () => noSelection;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
  win.cancelAnimationFrame = (h: number) => clearTimeout(h as any);
  win.navigator = { platform: 'Linux', userAgent: 'node' };
  const g = globalThis as any;
  g.window = win;
  g.document = doc;
  g.HTMLIFrameElement = win.HTMLIFrameElement;
  g.HTMLElement = FakeElement;
  g.Element = FakeElement;
  g.Node = FakeNode;
  g.requestAnimationFrame = win.requestAnimationFrame;
  g.cancelAnimationFrame = win.cancelAnimationFrame;
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // window.addEventListener must be reachable as a global too (components call addEventListener on window).
  return { window: win, document: doc, body };
}

/** All elements under root matching a predicate. */
export function findAll(root: FakeNode, pred: (e: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => {
    for (const c of n.childNodes) {
      if (c instanceof FakeElement) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

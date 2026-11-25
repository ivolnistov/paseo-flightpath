// A small Chrome DevTools Protocol page driver for the E2E harness: Node's built-in WebSocket and
// fetch, no dependency. One Page per browser tab; real input events (mouse, touch, keys) only; the page
// is read through Runtime.evaluate.
import { writeFileSync } from "node:fs";
import { pageSocketOk, visibleFraction } from "./guards.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Page {
  constructor(ws, id, port) {
    this.ws = ws;
    this.id = id;
    this.port = port;
    this.seq = 0;
    this.waiters = new Map();
    /** Console messages and exceptions the page reported. */
    this.log = [];
    /** Protocol event names a journey asks to record in `events`; none by default. */
    this.capture = null;
    this.events = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && this.waiters.has(msg.id)) {
        this.waiters.get(msg.id)(msg);
        this.waiters.delete(msg.id);
      } else if (this.capture?.has(msg.method)) {
        // Opt-in protocol events a journey asked for (for example WebSocket frames), with arrival time.
        this.events.push({ at: Date.now(), method: msg.method, params: msg.params });
      } else if (msg.method === "Runtime.consoleAPICalled" || msg.method === "Runtime.exceptionThrown") {
        this.log.push(msg);
      } else if (msg.method === "Page.javascriptDialogOpening") {
        // A dialog would block the page; it is recorded as a problem and dismissed.
        this.log.push({ method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: `dialog: ${msg.params?.type} ${msg.params?.message}` } } });
        void this.send("Page.handleJavaScriptDialog", { accept: false });
      }
    };
  }

  /** Opens a new tab at `url` in the browser listening on `port` (127.0.0.1). */
  static async open(port, url, size = { width: 1220, height: 847 }) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURI(url)}`, { method: "PUT", signal: AbortSignal.timeout(10_000) });
    const target = await res.json();
    // Exactly this page's socket on the run's own endpoint port (not merely some loopback URL).
    if (!pageSocketOk(target, port)) throw new Error(`DevTools offered an unexpected page socket ${JSON.stringify(target?.webSocketDebuggerUrl)}`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("page socket did not open within 10000 ms")), 10_000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });
    const page = new Page(ws, target.id, port);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    // A tab that is not in front is throttled or frozen by Chrome (frames stop, evaluation waits).
    await page.front();
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.size(size.width, size.height, false);
    return page;
  }

  /** One protocol call; a page that does not answer within `timeout` fails the step instead of hanging the run. */
  send(method, params = {}, timeout = 30_000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`${method}: no answer from the page within ${timeout} ms`));
      }, timeout);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        // A protocol error is a failed call, never a result.
        if (msg.error) reject(new Error(`${method}: protocol error ${msg.error.code ?? ""} ${msg.error.message ?? JSON.stringify(msg.error)}`.trim()));
        else resolve(msg.result ?? {});
      });
    });
  }

  async ev(expr) {
    const out = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(`page evaluate failed: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
    return out.result?.value;
  }

  /** Errors and warnings the page logged (console.error/warn, uncaught exceptions). */
  problems() {
    return this.log
      .filter((m) => m.method === "Runtime.exceptionThrown" || ["error", "warning", "assert"].includes(m.params?.type))
      .map((m) => String(m.params?.args?.[0]?.value ?? m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? "").slice(0, 300));
  }

  async front() {
    await this.send("Page.bringToFront");
    // The lifecycle nudge is refused while a navigation replaces the page ("Not attached to an
    // active page"); only that refusal is tolerated, and it is recorded. Any other error fails.
    try {
      await this.send("Page.setWebLifecycleState", { state: "active" });
    } catch (e) {
      if (!/protocol error -32000 Not attached to an active page/.test(e instanceof Error ? e.message : "")) throw e;
      this.lifecycleSkipped = (this.lifecycleSkipped ?? 0) + 1;
    }
  }

  async size(width, height, mobile) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    // maxTouchPoints must be 1–16 even when disabling (a protocol error otherwise).
    await this.send("Emulation.setTouchEmulationEnabled", mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await sleep(800);
  }

  /** Visible interactive elements: role, label, text, states and rectangle. */
  controls() {
    return this.ev(`(() => {
      const els = [...document.querySelectorAll('[role="button"],button,[role="menuitem"],[role="menuitemradio"],[role="radio"],[role="link"],a,input,textarea')];
      return els.map((e) => {
        const r = e.getBoundingClientRect();
        return { role: e.getAttribute('role') || e.tagName.toLowerCase(), label: e.getAttribute('aria-label') || '', text: (e.innerText || e.value || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
          disabled: e.getAttribute('aria-disabled') === 'true' || e.disabled === true, pressed: e.getAttribute('aria-pressed'), current: e.getAttribute('aria-current'),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
      }).filter((c) => c.visible);
    })()`);
  }

  /**
   * Whether the one element labelled to match `re` is genuinely visible: the share of it left after
   * clipping by the viewport and every clipping ancestor (scroll views included), and whether a hit
   * test at the centre of that visible part lands on it (not on something covering it).
   */
  async visibility(re) {
    return this.ev(`(() => {
      const visibleFraction = ${visibleFraction.toString()};
      const re = new RegExp(${JSON.stringify(re.source)});
      const els = [...document.querySelectorAll('[aria-label]')].filter((e) => re.test(e.getAttribute('aria-label')));
      if (els.length !== 1) return { found: els.length, fraction: 0, hit: false };
      const el = els[0];
      const box = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
      const clips = [];
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') clips.push(box(a.getBoundingClientRect()));
      }
      const rect = box(el.getBoundingClientRect());
      const v = visibleFraction(rect, clips, { w: innerWidth, h: innerHeight });
      const at = v.centre ? document.elementFromPoint(v.centre.x, v.centre.y) : null;
      return { found: 1, fraction: Math.round(v.fraction * 1000) / 1000, hit: !!at && (el === at || el.contains(at)), rect };
    })()`);
  }

  text() {
    return this.ev("document.body.innerText");
  }

  /** Waits until `fn()` returns a truthy value (polled), else throws naming `what`. */
  async waitFor(what, fn, timeout = 15_000, step = 250) {
    const end = Date.now() + timeout;
    let last;
    for (;;) {
      last = await fn();
      if (last) return last;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(step);
    }
  }

  waitText(re, timeout) {
    return this.waitFor(`text ${re}`, async () => re.test(await this.text()), timeout);
  }

  /** The one control whose label (or text) matches `re`; throws when none or several match. */
  async control(re, { index } = {}) {
    const all = (await this.controls()).filter((c) => re.test(c.label) || (c.label === "" && re.test(c.text)));
    if (index !== undefined) {
      if (!all[index]) throw new Error(`no control ${re} at ${index} (${all.length} found)`);
      return all[index];
    }
    if (all.length !== 1) throw new Error(`expected one control ${re}, found ${all.length}: ${all.map((c) => c.label || c.text).join(" | ")}`);
    return all[0];
  }

  /** Brings a control into view (the page's own scrolling, a driver step) and returns it fresh. */
  async reveal(re, opts) {
    const c = await this.settled(re, opts);
    if (c.y >= 0 && c.y + c.h <= (await this.ev("innerHeight"))) return c;
    await this.ev(`(() => { const re = new RegExp(${JSON.stringify(re.source)}); const e = [...document.querySelectorAll('[aria-label],button,[role="button"],input,textarea')].find((x) => re.test(x.getAttribute('aria-label') || '') || re.test((x.innerText || '').trim())); e && e.scrollIntoView({ block: 'center' }); return 1; })()`);
    await sleep(400);
    return this.settled(re, opts);
  }

  /** The control once its rectangle holds still (a sheet or menu sliding in moves its rows). */
  async settled(re, opts) {
    let c = await this.control(re, opts);
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const next = await this.control(re, opts);
      if (next.x === c.x && next.y === c.y && next.w === c.w && next.h === c.h) return next;
      c = next;
    }
    throw new Error(`control ${re} kept moving`);
  }

  /** A real mouse click at the centre of the control matching `re`. */
  async click(re, opts) {
    const c = await this.reveal(re, opts);
    const x = c.x + c.w / 2;
    const y = c.y + c.h / 2;
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(400);
    return c;
  }

  /** A real touch tap at the centre of the control matching `re`. */
  async tap(re, opts) {
    const c = await this.reveal(re, opts);
    const x = c.x + c.w / 2;
    const y = c.y + c.h / 2;
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(60);
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(500);
    return c;
  }

  /** Types into the focused field: selects its content first when `replace`, then inserts the text. */
  async type(text, { replace = false } = {}) {
    if (replace) {
      await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4 });
      await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    }
    await this.send("Input.insertText", { text });
    await sleep(300);
  }

  async key(key, code = key, keyCode = 0) {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
    await sleep(300);
  }

  async shot(file) {
    const out = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(out.data, "base64"));
    return file;
  }

  async reload() {
    await this.send("Page.reload", { ignoreCache: true });
    await sleep(1500);
  }

  async close() {
    try {
      await fetch(`http://127.0.0.1:${this.port}/json/close/${this.id}`, { signal: AbortSignal.timeout(3_000) });
    } catch {
      // the browser may already be gone
    }
    this.ws.close();
  }
}

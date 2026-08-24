/**
 * Browser tools — an agent-drivable browser, hosted by the app itself.
 *
 * The connector drove a separate Chrome over CDP. Electron already *is* a
 * browser, so a plain BrowserWindow avoids shipping/locating another one,
 * and the same code works on all three platforms.
 *
 * The interaction model is snapshot → act, not "guess a CSS selector":
 * `BrowserSnapshot` returns interactive elements with short refs (e1, e2…)
 * and `BrowserAct` operates on a ref. A model cannot invent a ref that was
 * not in the snapshot it just read, which is what makes this reliable
 * instead of a stream of misses.
 *
 * Safety: pages are untrusted, so the window is created with node
 * integration off and context isolation on, and it never gets a preload.
 */
import { BrowserWindow } from 'electron';

export interface SnapshotNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
}

export interface BrowserSession {
  window: BrowserWindow;
  /** ref → the selector we recorded when the snapshot was taken */
  refs: Map<string, string>;
}

const MAX_TEXT = 40_000;

/** Injected into the page. Assigns a stable data attribute per element so a
 *  ref survives until the next snapshot, and reports what a person would see. */
const SNAPSHOT_JS = `(() => {
  const out = [];
  let n = 0;
  const seen = new Set();
  const label = (el) => (
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.getAttribute('alt') ||
    (el.innerText || el.value || '').trim().slice(0, 120)
  );
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [role=textbox], [contenteditable=true], summary';
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el) || seen.has(el)) continue;
    seen.add(el);
    n += 1;
    const ref = 'e' + n;
    el.setAttribute('data-geny-ref', ref);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const node = { ref, role, name: label(el) };
    if (el.value !== undefined && el.type !== 'password') node.value = String(el.value).slice(0, 120);
    out.push(node);
    if (n >= 200) break;
  }
  return { url: location.href, title: document.title, nodes: out };
})()`;

const EXTRACT_JS = `(() => {
  const drop = ['script','style','noscript','svg','nav','footer','header','aside'];
  const clone = document.body.cloneNode(true);
  for (const tag of drop) for (const el of clone.querySelectorAll(tag)) el.remove();
  const text = (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, text: text.slice(0, ${MAX_TEXT}) };
})()`;

export class BrowserHost {
  private sessions = new Map<string, BrowserSession>();

  constructor(private readonly opts: { show: boolean } = { show: true }) {}

  private session(agentId: string): BrowserSession {
    const existing = this.sessions.get(agentId);
    if (existing && !existing.window.isDestroyed()) return existing;
    const window = new BrowserWindow({
      width: 1100,
      height: 800,
      show: this.opts.show,
      title: 'Geny — agent browser',
      webPreferences: {
        // the page is untrusted: no preload, no node, isolated
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
      },
    });
    const session: BrowserSession = { window, refs: new Map() };
    window.on('closed', () => this.sessions.delete(agentId));
    this.sessions.set(agentId, session);
    return session;
  }

  async navigate(agentId: string, url: string): Promise<{ url: string; title: string }> {
    const { window } = this.session(agentId);
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await window.loadURL(target);
    return { url: window.webContents.getURL(), title: window.getTitle() };
  }

  async snapshot(agentId: string): Promise<{ url: string; title: string; nodes: SnapshotNode[] }> {
    const session = this.session(agentId);
    const result = (await session.window.webContents.executeJavaScript(SNAPSHOT_JS, true)) as {
      url: string;
      title: string;
      nodes: SnapshotNode[];
    };
    session.refs = new Map(result.nodes.map((n) => [n.ref, `[data-geny-ref="${n.ref}"]`]));
    return result;
  }

  async act(
    agentId: string,
    input: { ref: string; action: 'click' | 'type' | 'select'; text?: string },
  ): Promise<{ ok: true; url: string }> {
    const session = this.session(agentId);
    const selector = session.refs.get(input.ref);
    if (!selector) {
      throw new Error(`unknown ref ${input.ref} — take a BrowserSnapshot first`);
    }
    const text = JSON.stringify(input.text ?? '');
    const js =
      input.action === 'click'
        ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'gone'; el.click(); return 'ok'; })()`
        : `(() => {
             const el = document.querySelector(${JSON.stringify(selector)});
             if (!el) return 'gone';
             const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
             if (setter) setter.call(el, ${text}); else el.textContent = ${text};
             el.dispatchEvent(new Event('input', { bubbles: true }));
             el.dispatchEvent(new Event('change', { bubbles: true }));
             return 'ok';
           })()`;
    const outcome = (await session.window.webContents.executeJavaScript(js, true)) as string;
    if (outcome === 'gone') throw new Error(`${input.ref} is no longer on the page`);
    // a click usually navigates or mutates; give the page a moment so the
    // next snapshot reflects the result rather than the previous state
    await new Promise((r) => setTimeout(r, 350));
    return { ok: true, url: session.window.webContents.getURL() };
  }

  async extract(agentId: string): Promise<{ url: string; title: string; text: string }> {
    const { window } = this.session(agentId);
    return (await window.webContents.executeJavaScript(EXTRACT_JS, true)) as {
      url: string;
      title: string;
      text: string;
    };
  }

  async back(agentId: string): Promise<{ url: string }> {
    const { window } = this.session(agentId);
    if (window.webContents.navigationHistory.canGoBack()) {
      window.webContents.navigationHistory.goBack();
      await new Promise((r) => setTimeout(r, 400));
    }
    return { url: window.webContents.getURL() };
  }

  close(agentId: string): { closed: boolean } {
    const session = this.sessions.get(agentId);
    if (!session || session.window.isDestroyed()) return { closed: false };
    session.window.destroy();
    this.sessions.delete(agentId);
    return { closed: true };
  }

  destroyAll(): void {
    for (const [, session] of this.sessions) {
      if (!session.window.isDestroyed()) session.window.destroy();
    }
    this.sessions.clear();
  }
}

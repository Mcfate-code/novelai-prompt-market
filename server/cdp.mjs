// cdp.mjs — CdpSessionManager：发现目标页、attach WebSocket、命令/事件分发、断线重连
const CDP_HTTP = "http://127.0.0.1:9222";

export class CdpSessionManager {
  constructor({ httpBase = CDP_HTTP } = {}) {
    this.httpBase = httpBase;
    this.sessions = new Map(); // wsUrl -> { ws, pending: Map, id: seq, handlers: Map }
  }

  async listPages() {
    const res = await fetch(`${this.httpBase}/json`);
    if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
    const targets = await res.json();
    return targets.filter((t) => t.type === "page");
  }

  async findPage(urlRegex) {
    const pages = await this.listPages();
    return pages.find((p) => urlRegex.test(p.url)) || null;
  }

  // attach 一个页面 target（通过 webSocketDebuggerUrl）
  async attach(page) {
    if (this.sessions.has(page.webSocketDebuggerUrl)) {
      return this.sessions.get(page.webSocketDebuggerUrl);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const session = { ws, page, pending: new Map(), seq: 0, handlers: new Map(), closed: false };
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = (e) => reject(new Error("CDP ws error"));
    });
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined) {
        const { resolve, reject } = session.pending.get(msg.id) || {};
        if (!resolve) return;
        session.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        const hs = session.handlers.get(msg.method);
        if (hs) for (const h of hs) h(msg.params);
      }
    };
    ws.onclose = () => { session.closed = true; this.sessions.delete(page.webSocketDebuggerUrl); };
    this.sessions.set(page.webSocketDebuggerUrl, session);
    await this.send(session, "Runtime.enable");
    await this.send(session, "Page.enable");
    return session;
  }

  send(session, method, params = {}) {
    if (session.closed) return Promise.reject(new Error("session closed"));
    const id = ++session.seq;
    return new Promise((resolve, reject) => {
      session.pending.set(id, { resolve, reject });
      session.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  // 在页面上下文执行 JS，返回值（returnByValue）
  async evaluate(session, expression) {
    const r = await this.send(session, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`page eval error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text || "unknown"}`);
    }
    return r.result?.value;
  }

  on(session, method, handler) {
    const hs = session.handlers.get(method) || [];
    hs.push(handler);
    session.handlers.set(method, hs);
  }

  isClosed(session) {
    return session.closed || session.ws.readyState !== WebSocket.OPEN;
  }

  // 等待目标页出现（页面加载/刷新后重新查找），返回 session
  async waitPage(urlRegex, { timeoutMs = 30000, intervalMs = 1000 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const page = await this.findPage(urlRegex);
        if (page) return await this.attach(page);
      } catch {}
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`等待页面超时: ${urlRegex}`);
  }
}


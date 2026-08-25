// sync.mjs — SyncEngine：面板 ↔ NovelAI 提示词双向实时同步
// 轮询监听 + 来源标记防循环；任务执行期间暂停 面板→NovelAI 方向，防止覆盖任务内容
const SYNC_INJECT = (key, selectors) => `(() => {
  if (window.__syncInstalled) return;
  window.__syncInstalled = true;
  window.__syncIncoming = false;
  window.__syncKey = ${JSON.stringify(key)};
  window.__syncSelectors = ${JSON.stringify(selectors)};
  const POLL_MS = 250;
  window.__syncRead = () => {
    for (const s of window.__syncSelectors) {
      const el = document.querySelector(s);
      if (el) return (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : (el.textContent || '');
    }
    return null;
  };
  window.__syncLast = window.__syncRead(); // 初始化为当前值，避免启动时空值推送对端
  window.__syncWrite = (v) => {
    for (const s of window.__syncSelectors) {
      const el = document.querySelector(s);
      if (el) {
        window.__syncIncoming = true;
        const proto = (el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : el.tagName === 'INPUT' ? HTMLInputElement : HTMLElement).prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, v); else el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => { window.__syncIncoming = false; }, 600);
        return true;
      }
    }
    return false;
  };
  setInterval(() => {
    const v = window.__syncRead();
    if (v === window.__syncLast) return;
    window.__syncLast = v;
    if (window.__syncIncoming) return;
    console.log('__SYNC__|' + window.__syncKey + '|' + v);
  }, POLL_MS);
})();`;

export class SyncEngine {
  constructor({ cdp, panelSession, novelSession, panelSelectors = ["#prompt-input"], novelSelectors, isJobRunning = () => false, onEvent }) {
    this.cdp = cdp;
    this.panelSession = panelSession;
    this.novelSession = novelSession;
    this.panelSelectors = panelSelectors;
    this.novelSelectors = novelSelectors;
    this.isJobRunning = isJobRunning;
    this.onEvent = onEvent;
    this.enabled = true;
    this._listeners = [];
  }

  async start() {
    await this._install(this.panelSession, "panel", this.panelSelectors);
    await this._install(this.novelSession, "novel", this.novelSelectors);
  }

  async _install(session, key, selectors) {
    await this.cdp.evaluate(session, SYNC_INJECT(key, selectors));
    const handler = (params) => this._onConsole(session, key, params);
    this.cdp.on(session, "Runtime.consoleAPICalled", handler);
    this._listeners.push({ session, key, handler });
  }

  _onConsole(session, key, params) {
    if (params.type !== "log") return;
    const text = params.args?.[0]?.value;
    if (typeof text !== "string" || !text.startsWith("__SYNC__|")) return;
    const first = text.indexOf("|");
    if (first < 0) return;
    const second = text.indexOf("|", first + 1);
    if (second < 0) return;
    const fromKey = text.slice(first + 1, second);
    const value = text.slice(second + 1);
    if (!fromKey) return;
    if (!this.enabled) return;
    // 来源标记：写入由本次同步引起的页面变化不再回流（页面端已用 __syncIncoming 挡），这里再兜一层
    if (fromKey === "panel") {
      // 面板 → NovelAI；任务运行中暂停此方向（任务内容由 JobManager 写入）
      if (this.isJobRunning()) return;
      this.cdp.evaluate(this.novelSession, `window.__syncWrite(${JSON.stringify(value)})`).catch(() => {});
      if (this.onEvent) this.onEvent({ type: "sync.changed", from: "panel", value: String(value).slice(0, 120) });
    } else if (fromKey === "novel") {
      // NovelAI → 面板，始终显示
      this.cdp.evaluate(this.panelSession, `window.__syncWrite(${JSON.stringify(value)})`).catch(() => {});
      if (this.onEvent) this.onEvent({ type: "sync.changed", from: "novel", value: String(value).slice(0, 120) });
    }
  }

  setEnabled(on) {
    this.enabled = on;
  }

  stop() {
    this.enabled = false;
    for (const { session, key, handler } of this._listeners) {
      const hs = session.handlers.get("Runtime.consoleAPICalled") || [];
      session.handlers.set("Runtime.consoleAPICalled", hs.filter((h) => h !== handler));
    }
    this._listeners = [];
  }
}

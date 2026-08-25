// adapter.mjs — NovelAiAdapter：把「写提示词 → 点生成 → 检测完成 → 抓图」封装为可替换适配层
// NovelAI DOM 变化时只改这里的选择器，不动内核。
const PAGE_HELPERS = `(() => {
  if (window.__na) return;
  window.__na = {
    find(selectors) {
      for (const s of selectors) { const el = document.querySelector(s); if (el) return el; }
      return null;
    },
    findAll(selectors) {
      for (const s of selectors) { const els = document.querySelectorAll(s); if (els.length) return Array.from(els); }
      return [];
    },
    read(el) {
      if (!el) return null;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value;
      return (el.innerText || el.textContent || '').replace(/\u200b/g, '').trim();
    },
    write(el, v) {
      if (!el) return false;
      if (el.isContentEditable || el.classList?.contains('ProseMirror')) {
        el.focus();
        el.replaceChildren();
        const p = document.createElement('p');
        if (v) p.textContent = v;
        else p.appendChild(document.createElement('br'));
        el.appendChild(p);
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: v }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                  : el.tagName === 'INPUT' ? HTMLInputElement.prototype
                  : HTMLElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    isDisabled(el) {
      if (!el) return true;
      return el.disabled || el.getAttribute('aria-disabled') === 'true' || (el.classList && el.classList.contains('disabled'));
    },
    click(el) { if (!el || el.disabled) return false; el.click(); return true; },
    imgInfo(img) {
      if (!img) return null;
      return { src: img.currentSrc || img.src, complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
    },
    bodyHasLoginHint() {
      const hasPassword = !!document.querySelector('input[type="password"]');
      const hasLogout = [...document.querySelectorAll('button,a')].some((e) => /log\s*out/i.test((e.textContent || '').trim()));
      if (hasLogout && !hasPassword) return false;
      const t = (document.body && document.body.innerText || '').slice(0, 2000);
      return hasPassword || (/log\s*in|sign\s*in/i.test(t) && !hasLogout);
    },
    async fetchAsDataUrl(src) {
      try {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error('fetch ' + resp.status);
        const blob = await resp.blob();
        if (blob.size > 25 * 1024 * 1024) throw new Error('img too large ' + blob.size);
        return await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(new Error('FileReader error'));
          fr.readAsDataURL(blob);
        });
      } catch (e) { throw new Error('capture fail: ' + e.message); }
    }
  };
})();`;

const DEFAULT_PROMPT = ["#prompt", 'textarea[id="prompt"]', "#prompt-input", 'textarea[class*="prompt"]', '[class*="prompt"] textarea', '.prompt-input-box-prompt .ProseMirror', '.image-gen-prompt-main .prompt-input-box-prompt .ProseMirror'];
const DEFAULT_NEG = ["#negative-prompt", 'textarea[id="negative-prompt"]', "#neg_prompt", '[class*="negative"] textarea', '.prompt-input-box-undesired-content .ProseMirror', '.image-gen-prompt-main .prompt-input-box-undesired-content .ProseMirror'];
const DEFAULT_GENERATE = ['button.image-gen-generate-button', 'button[class*="generate"]', '[class*="generate"] button', 'button[type="submit"]'];
const DEFAULT_RESULTS = ["#results img", '[class*="result"] img', '[class*="generated"] img', '[class*="image"] img'];
// 参数控件候选选择器（NovelAI 真机改版时在此适配）
const DEFAULT_MODEL_SELECTORS = ["#model-select", 'select[id*="model" i]', '[class*="model"] select', 'select[class*="model"]'];
const DEFAULT_RESOLUTION_SELECTORS = ["#resolution-select", 'select[id*="resolution" i]', '[class*="resolution"] select', 'select[class*="resolution"]'];
const DEFAULT_SEED_SELECTORS = ["#seed-input", 'input[id*="seed" i]', '[class*="seed"] input', 'input[class*="seed"]'];
const DEFAULT_STEPS_SELECTORS = ["#steps-input", 'input[id*="steps" i]', '[class*="steps"] input', 'input[class*="steps"]', 'input[type="number"]'];
const DEFAULT_GUIDANCE_SELECTORS = ["#guidance-input", 'input[id*="guidance" i]', '[class*="guidance"] input', 'input[class*="guidance"]', 'input[id*="scale" i]'];

export class NovelAiAdapter {
  constructor(cdp, session, opts = {}) {
    this.cdp = cdp;
    this.session = session;
    this.promptSelectors = opts.promptSelectors || DEFAULT_PROMPT;
    this.negSelectors = opts.negSelectors || DEFAULT_NEG;
    this.generateSelectors = opts.generateSelectors || DEFAULT_GENERATE;
    this.resultsSelectors = opts.resultsSelectors || DEFAULT_RESULTS;
    this.modelSelectors = opts.modelSelectors || DEFAULT_MODEL_SELECTORS;
    this.resolutionSelectors = opts.resolutionSelectors || DEFAULT_RESOLUTION_SELECTORS;
    this.seedSelectors = opts.seedSelectors || DEFAULT_SEED_SELECTORS;
    this.stepsSelectors = opts.stepsSelectors || DEFAULT_STEPS_SELECTORS;
    this.guidanceSelectors = opts.guidanceSelectors || DEFAULT_GUIDANCE_SELECTORS;
    this.injected = false;
  }

  async inject() {
    if (this.injected) return;
    await this.cdp.evaluate(this.session, PAGE_HELPERS);
    this.injected = true;
  }

  // 能力探测：输入框/生成按钮是否可用，页面是否疑似未登录
  async probe() {
    await this.inject();
    const r = await this.cdp.evaluate(this.session, `(() => {
      const input = window.__na.find(${JSON.stringify(this.promptSelectors)});
      let gen = window.__na.find(${JSON.stringify(this.generateSelectors)}) || null;
      if (!gen) gen = Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /generate\s*\d*\s*image/i.test((b.textContent || '').trim())) || null;
      return {
        inputFound: !!input,
        generateFound: !!gen,
        generateDisabled: window.__na.isDisabled(gen),
        loginHint: window.__na.bodyHasLoginHint(),
        url: location.href
      };
    })()`);
    r.ok = r.inputFound && r.generateFound && !r.generateDisabled && !r.loginHint;
    return r;
  }

  // 写提示词（React 兼容）+ 回读确认
  async writePrompt(prompt, negative = "") {
    await this.inject();
    const args = JSON.stringify({ prompt, negative, ps: this.promptSelectors, ns: this.negSelectors });
    const r = await this.cdp.evaluate(this.session, `(() => {
      const a = ${args};
      const pi = window.__na.find(a.ps), ni = window.__na.find(a.ns);
      const okP = window.__na.write(pi, a.prompt);
      const okN = window.__na.write(ni, a.negative);
      return { okP, okN, readP: window.__na.read(pi), readN: ni ? window.__na.read(ni) : '' };
    })()`);
    return r;
  }

  async readPrompt() {
    await this.inject();
    return this.cdp.evaluate(this.session, `(() => {
      const el = window.__na.find(${JSON.stringify(this.promptSelectors)});
      return window.__na.read(el);
    })()`);
  }

  // Read visible generation controls directly from the live NovelAI page.
  // This deliberately returns semantic DOM facts instead of hard-coded defaults so
  // the panel can follow NovelAI UI changes without silently lying to the user.
  async inspectState() {
    await this.inject();
    return this.cdp.evaluate(this.session, `(() => {
      const visible = (el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const clean = (v, n = 240) => String(v || '').replace(/\\s+/g, ' ').trim().slice(0, n);
      const controls = Array.from(document.querySelectorAll('input,select,button,[role="button"],[role="combobox"],[role="slider"],[aria-label]'))
        .filter(visible).slice(0, 320).map((el, index) => {
          let context = '';
          for (let p = el.parentElement, depth = 0; p && depth < 3; p = p.parentElement, depth++) {
            const t = clean(p.innerText || p.textContent, 300);
            if (t && t.length > context.length) context = t;
          }
          return {
            index, tag: el.tagName.toLowerCase(), type: el.type || '', role: el.getAttribute('role') || '',
            id: el.id || '', name: el.getAttribute('name') || '',
            value: el.value ?? '', checked: !!el.checked, text: clean(el.innerText || el.textContent),
            label: clean(el.getAttribute('aria-label')), valueText: clean(el.getAttribute('aria-valuetext')),
            valueNow: clean(el.getAttribute('aria-valuenow')), pressed: el.getAttribute('aria-pressed'),
            title: clean(el.getAttribute('title')), placeholder: clean(el.getAttribute('placeholder')),
            min: el.min ?? '', max: el.max ?? '', step: el.step ?? '',
            disabled: window.__na.isDisabled(el), context,
            className: clean(typeof el.className === 'string' ? el.className : '', 180),
            html: clean(el.outerHTML, 700),
          };
        });
      const promptEl = window.__na.find(${JSON.stringify(this.promptSelectors)});
      const negEl = window.__na.find(${JSON.stringify(this.negSelectors)});
      let generateEl = window.__na.find(${JSON.stringify(this.generateSelectors)});
      if (!generateEl) generateEl = Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /generate/i.test(clean(b.textContent))) || null;
      const bodyText = clean(document.body?.innerText, 20000);
      const money = bodyText.split(/\\n| {2,}/).filter((s) => /anlas|credit|积分|cost/i.test(s)).slice(0, 30);
      return {
        url: location.href,
        prompt: window.__na.read(promptEl) || '',
        negative_prompt: window.__na.read(negEl) || '',
        generate: generateEl ? {
          text: clean(generateEl.innerText || generateEl.textContent),
          label: clean(generateEl.getAttribute('aria-label')),
          title: clean(generateEl.getAttribute('title')),
          disabled: window.__na.isDisabled(generateEl),
        } : null,
        money,
        controls,
      };
    })()`);
  }

  async openSettings({ advanced = false } = {}) {
    await this.inject();
    const clicked = await this.cdp.evaluate(this.session, `(() => {
      if (document.querySelector('button[aria-label="close Settings"]')) return false;
      const el = document.querySelector('button[aria-label="Settings"]');
      if (!el || window.__na.isDisabled(el)) return false;
      el.click();
      return true;
    })()`);
    if (clicked) await new Promise((r) => setTimeout(r, 350));
    if (advanced) {
      const opened = await this.cdp.evaluate(this.session, `(() => {
        const el = Array.from(document.querySelectorAll('button')).find((b) => /advanced settings/i.test((b.textContent || '').trim()));
        if (!el || window.__na.isDisabled(el)) return false;
        el.click();
        return true;
      })()`);
      if (opened) await new Promise((r) => setTimeout(r, 350));
    }
    return clicked;
  }

  async readSelectOptions(labels) {
    await this.inject();
    const out = {};
    for (const label of labels) {
      const found = await this.cdp.evaluate(this.session, `(() => {
        const wanted = ${JSON.stringify(label)};
        const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
        const norm = (v) => clean(v).toLowerCase().replace(/[：:]/g, '');
        const candidates = Array.from(document.querySelectorAll('select,input,button,[role="combobox"],[role="button"]'))
          .filter((el) => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; });
        const el = candidates.find((x) => norm(x.getAttribute('aria-label')) === norm(wanted))
          || candidates.find((x) => norm(x.getAttribute('placeholder')) === norm(wanted))
          || candidates.find((x) => norm(x.getAttribute('title')) === norm(wanted))
          || candidates.find((x) => norm(x.innerText || x.textContent).includes(norm(wanted)))
          || candidates.find((x) => norm(x.parentElement?.innerText || '').startsWith(norm(wanted)));
        if (!el) return false;
        if (el.tagName === 'SELECT') { el.focus(); return true; }
        el.click(); el.focus();
        return true;
      })()`);
      if (!found) { out[label] = []; continue; }
      await new Promise((r) => setTimeout(r, 140));
      out[label] = await this.cdp.evaluate(this.session, `(() => {
        const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
        const values = Array.from(document.querySelectorAll('select option,[role="option"]'))
          .map((el) => clean(el.innerText || el.textContent || el.value)).filter(Boolean);
        const active = document.activeElement;
        if (active && active.tagName !== 'SELECT') active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        return [...new Set(values)];
      })()`);
      await new Promise((r) => setTimeout(r, 60));
    }
    return out;
  }

  async readGenerationState({ withOptions = true } = {}) {
    await this.openSettings();
    let live = await this.inspectState();
    const controls = live.controls || [];
    const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase().replace(/[：:]/g, '');
    const findControl = (label) => {
      const wanted = normalize(label);
      return controls.find((c) => normalize(c.label) === wanted)
        || controls.find((c) => [c.placeholder, c.title, c.text, c.context, c.id, c.name].some((v) => normalize(v).includes(wanted)));
    };
    const labeled = (label) => findControl(label);
    const contextValue = (label, prefix = '') => {
      const c = findControl(label);
      if (!c) return '';
      const raw = c.valueText || c.value || c.text || c.context || '';
      return String(raw).replace(new RegExp('^' + prefix + '\\s*:?\\s*', 'i'), '').trim();
    };
    const plainNumbers = controls.filter((c) => c.tag === 'input' && c.type === 'number' && !c.label && !c.placeholder);
    const genText = [live.generate?.text, live.generate?.label, live.generate?.title].filter(Boolean).join(' | ');
    const countMatch = genText.match(/(?:generate|生成)[^0-9]{0,12}(\d+)\s*(?:images?|张|图)/i);
    const costSources = [genText, ...(live.money || [])].filter(Boolean);
    const costText = costSources.join(' | ');
    const costMatch = costText.match(/(?:cost|消耗|费用|generate[^|]*?[-·:]?)?\s*(\d+(?:\.\d+)?)\s*(?:anlas|积分|credits?)/i);
    const mode = controls.find((c) => /currently using .* mode/i.test(c.label || ''))?.text || '';
    const parameters = {
      model: contextValue('Select the Model'),
      mode,
      width: Number(labeled('W')?.value) || null,
      height: Number(labeled('H')?.value) || null,
      resolution_category: contextValue('Select a Resolution Category'),
      number_images: countMatch ? Number(countMatch[1]) : 1,
      steps: plainNumbers[0]?.value === '' ? null : Number(plainNumbers[0]?.value),
      guidance: plainNumbers[1]?.value === '' ? null : Number(plainNumbers[1]?.value),
      seed: controls.find((c) => c.placeholder === 'Enter a seed')?.value || '',
      sampler: contextValue('Select a sampler'),
      quality_preset: contextValue('Quality Preset', 'Quality Tags'),
      uc_preset: contextValue('Undesired Content Preset', 'UC Preset'),
      transparent_bg: controls.find((c) => c.text === 'Transparent BG')?.pressed === 'true',
    };
    if (parameters.model && !/^NAI Diffusion /i.test(parameters.model)) parameters.model = `NAI Diffusion ${parameters.model}`;
    let options = {};
    if (withOptions) {
      const raw = await this.readSelectOptions([
        'Select the Model', 'Select a Resolution Category', 'Select a sampler',
        'Quality Preset', 'Undesired Content Preset',
      ]);
      options = {
        model: (raw['Select the Model'] || []).map((v) => v.replace(/\s+(?:Our|No longer).*$/i, '').trim()),
        resolution_category: raw['Select a Resolution Category'] || [],
        sampler: raw['Select a sampler'] || [],
        quality_preset: raw['Quality Preset'] || [],
        uc_preset: raw['Undesired Content Preset'] || [],
        number_images: [1, 2, 3, 4],
      };
      // Never replace a live value with an empty option list. The current value
      // is still useful when NovelAI renders a custom menu that we cannot open.
      for (const key of ['model', 'resolution_category', 'sampler', 'quality_preset', 'uc_preset']) {
        const current = parameters[key];
        if (current && !options[key].some((v) => String(v).toLowerCase() === String(current).toLowerCase())) options[key].unshift(current);
      }
      const modelMatch = options.model.find((v) => parameters.model && v.toLowerCase().includes(parameters.model.toLowerCase()));
      if (modelMatch) parameters.model = modelMatch;
      // React-select popovers can briefly change the DOM; refresh current facts.
      live = await this.inspectState();
    }
    return {
      url: live.url,
      prompt: live.prompt || '',
      negative_prompt: live.negative_prompt || '',
      parameters,
      options,
      cost: {
        anlas: costMatch ? Number(costMatch[1]) : null,
        costKnown: !!costMatch,
        costSource: costMatch ? (genText ? 'generate-control' : 'page-text') : 'unknown',
        rawCostText: costText.slice(0, 600),
        label: genText || costText || 'Cost unavailable',
      },
      generate_disabled: !!live.generate?.disabled,
      synced_at: new Date().toISOString(),
      _debug: live,
    };
  }

  async generateButtonState() {
    await this.inject();
    return this.cdp.evaluate(this.session, `(() => {
      let el = window.__na.find(${JSON.stringify(this.generateSelectors)});
      if (!el) {
        el = Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /generate\s*\d*\s*image/i.test((b.textContent || '').trim())) || null;
      }
      return el ? { found: true, disabled: window.__na.isDisabled(el), text: (el.textContent || '').trim().slice(0, 40) } : { found: false, disabled: true, text: '' };
    })()`);
  }

  async clickGenerate() {
    await this.inject();
    const before = await this.generateButtonState();
    const r = await this.cdp.evaluate(this.session, `(() => {
      let el = window.__na.find(${JSON.stringify(this.generateSelectors)});
      if (!el) {
        el = Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /generate\s*\d*\s*image/i.test((b.textContent || '').trim())) || null;
      }
      if (!el || window.__na.isDisabled(el)) return { clicked: false };
      el.click();
      return { clicked: true };
    })()`);
    return { ...r, before };
  }

  // 当生成进行中时点击对应按钮主动中断（支持 stop / cancel / abort 文案）。
  async stopGeneration() {
    await this.inject();
    return this.cdp.evaluate(this.session, `(() => {
      const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
      const isStopLike = (el) => {
        const t = clean(el && (el.innerText || el.textContent));
        return t === 'stop' || t === 'cancel' || t === 'abort' || t.includes('stop') || t.includes('cancel') || t.includes('abort') || t.includes('取消') || t.includes('停止');
      };
      const stopBtn = buttons.find((b) => isStopLike(b) && !b.disabled);
      if (stopBtn) { stopBtn.click(); return { clicked: true, target: 'stop' }; }
      // 某些皮肤里按钮仍显示 Generate while in progress，尝试点击非禁用的 Generate/Generating 控件。
      const genBtn = document.querySelector('button.active[data-state="running"], [role="button"][data-state="running"]')
        || buttons.find((b) => /generating|stop|cancel|abort/i.test(clean(b.innerText || b.textContent || '')));
      if (genBtn) { genBtn.click(); return { clicked: true, target: 'generate' }; }
      return { clicked: false, reason: '未发现可点击的取消按钮' };
    })()`);
  }

  // 生成中信号：按钮 disabled / 文本含 Generating（进行时）——注意 "Generate"（命令式）不算生成中
  async isGenerating() {
    const st = await this.generateButtonState();
    return st.found && (st.disabled || /generating|stop|abort|cancel/i.test(st.text));
  }

  // 结果区图片快照（生成前调用，用于区分新旧）
  async snapshotResults() {
    await this.inject();
    return this.cdp.evaluate(this.session, `(() => {
      const imgs = window.__na.findAll(${JSON.stringify(this.resultsSelectors)});
      return imgs.map(window.__na.imgInfo);
    })()`);
  }

  // 找出与 before 快照不同的新图（complete 且 naturalWidth>0）
  async findNewImage(beforeSnap) {
    const now = await this.snapshotResults();
    const before = beforeSnap || [];
    const beforeSrcs = new Set(before.map((i) => i.src));
    const cands = now.filter((i) => i && i.complete && i.naturalWidth > 0 && !beforeSrcs.has(i.src));
    return cands[cands.length - 1] || null;
  }

  // 抓图：页面 fetch(src) → dataURL（继承页面会话/权限）
  async captureImage(imgInfo) {
    if (!imgInfo || !imgInfo.src) throw new Error("no image to capture");
    const dataUrl = await this.cdp.evaluate(this.session, `window.__na.fetchAsDataUrl(${JSON.stringify(imgInfo.src)})`);
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!m) throw new Error("bad data url");
    return { mime: m[1], base64: m[2], src: imgInfo.src, width: imgInfo.naturalWidth, height: imgInfo.naturalHeight };
  }

  // 参数透传（Model / Resolution / Seed / Steps / Guidance）：select 按 value/text 匹配选项，input 原生 setter 写入
  // 返回 { ok, reason }；控件找不到或选项不匹配时降级（不阻断生成），由上层记录。
  async setParameter(name, value) {
    const map = { model: this.modelSelectors, resolution: this.resolutionSelectors, seed: this.seedSelectors,
      steps: this.stepsSelectors, guidance: this.guidanceSelectors };
    const semanticLabels = {
      model: 'Select the Model', resolution_category: 'Select a Resolution Category', sampler: 'Select a sampler',
      quality_preset: 'Quality Preset', uc_preset: 'Undesired Content Preset', width: 'W', height: 'H',
    };
    if (['model', 'resolution_category', 'sampler', 'quality_preset', 'uc_preset'].includes(name)) {
      await this.openSettings();
      const label = semanticLabels[name];
      const opened = await this.cdp.evaluate(this.session, `(() => {
        const wanted = ${JSON.stringify(label)}.toLowerCase();
        const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const els = Array.from(document.querySelectorAll('select,input,button,[role="combobox"],[role="button"]'));
        const el = els.find((x) => norm(x.getAttribute('aria-label')) === wanted)
          || els.find((x) => norm(x.getAttribute('placeholder')) === wanted)
          || els.find((x) => norm(x.getAttribute('title')) === wanted)
          || els.find((x) => norm(x.parentElement?.innerText || '').includes(wanted));
        if (!el) return false;
        if (el.tagName === 'SELECT') { el.focus(); return true; }
        el.click(); el.focus(); return true;
      })()`);
      if (!opened) return { ok: false, reason: '控件未找到' };
      await new Promise((r) => setTimeout(r, 120));
      const picked = await this.cdp.evaluate(this.session, `(() => {
        const wanted = ${JSON.stringify(String(value))}.trim().toLowerCase();
        const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const els = Array.from(document.querySelectorAll('select'));
        const native = els.find((s) => Array.from(s.options).some((o) => norm(o.textContent) === wanted || norm(o.value) === wanted || norm(o.textContent).startsWith(wanted)));
        if (native) {
          const option = Array.from(native.options).find((o) => norm(o.textContent) === wanted || norm(o.value) === wanted || norm(o.textContent).startsWith(wanted));
          native.value = option.value;
          native.dispatchEvent(new Event('input', { bubbles: true })); native.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        const opts = Array.from(document.querySelectorAll('[role="option"]'));
        const el = opts.find((o) => norm(o.innerText || o.textContent) === wanted)
          || opts.find((o) => norm(o.innerText || o.textContent).startsWith(wanted));
        if (!el) return false; el.click(); return true;
      })()`);
      if (!picked) return { ok: false, reason: '选项不存在: ' + value };
      await new Promise((r) => setTimeout(r, 120));
      const verify = await this.readGenerationState({ withOptions: false });
      const actual = verify.parameters?.[name] ?? verify.parameters?.resolution_category;
      const same = String(actual || '').trim().toLowerCase() === String(value).trim().toLowerCase()
        || String(actual || '').trim().toLowerCase().startsWith(String(value).trim().toLowerCase());
      return same ? { ok: true, wrote: value, actual } : { ok: false, reason: `写入后校验不一致，实际为 ${actual || '空'}` };
    }
    if (['width', 'height'].includes(name)) {
      await this.openSettings();
      const label = semanticLabels[name];
      return this.cdp.evaluate(this.session, `(() => {
        const el = document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)});
        if (!el) return { ok:false, reason:'控件未找到' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        return { ok:true, wrote:${JSON.stringify(String(value))} };
      })()`);
    }
    if (name === 'number_images') {
      await this.openSettings();
      return this.cdp.evaluate(this.session, `(() => {
        const wanted = ${JSON.stringify(String(value))};
        const el = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === wanted && /Number of Images/.test(b.parentElement?.parentElement?.innerText || ''));
        if (!el) return { ok:false, reason:'选项不存在: '+wanted }; el.click(); return { ok:true, wrote:wanted };
      })()`);
    }
    if (name === 'transparent_bg') {
      const wanted = !!value;
      return this.cdp.evaluate(this.session, `(() => {
        const el = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'Transparent BG');
        if (!el) return { ok:false, reason:'控件未找到' };
        const current = el.getAttribute('aria-pressed') === 'true'; if (current !== ${wanted}) el.click();
        return { ok:true, wrote:${wanted} };
      })()`);
    }
    if (['steps', 'guidance', 'seed'].includes(name)) {
      await this.openSettings();
      const n = name === 'steps' ? 0 : name === 'guidance' ? 1 : -1;
      return this.cdp.evaluate(this.session, `(() => {
        const el = ${n < 0 ? "document.querySelector('input[placeholder=\"Enter a seed\"]')" : `Array.from(document.querySelectorAll('input[type="number"]')).filter((x) => !x.getAttribute('aria-label') && !x.placeholder)[${n}]`};
        if (!el) return { ok:false, reason:'控件未找到' };
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
        return { ok:true, wrote:${JSON.stringify(String(value))} };
      })()`);
    }
    const sels = map[name];
    if (!sels) return { ok: false, reason: `未知参数 ${name}` };
    await this.inject();
    const args = JSON.stringify({ value: String(value), sels });
    const r = await this.cdp.evaluate(this.session, `(() => {
      const a = ${args};
      for (const s of a.sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        if (el.tagName === 'SELECT') {
          let matched = false;
          for (const opt of el.options) {
            if (opt.value === a.value || (opt.textContent || '').trim() === a.value || (opt.textContent || '').trim().startsWith(a.value)) {
              el.value = opt.value; matched = true; break;
            }
          }
          if (!matched) return { ok: false, reason: '选项不存在: ' + a.value };
        } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const proto = (el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement).prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) setter.set.call(el, a.value); else el.value = a.value;
        } else {
          el.textContent = a.value;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, wrote: a.value };
      }
      return { ok: false, reason: '控件未找到' };
    })()`);
    return r;
  }
}

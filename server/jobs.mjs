// jobs.mjs — JobManager：生图任务状态机（单并发），多信号完成检测
// ready → submitted → generating → captured → persisted → succeeded | failed | timeout | cancelled
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class JobManager {
  constructor({ cdp, adapter, store, onEvent }) {
    this.cdp = cdp;
    this.adapter = adapter;
    this.store = store;
    this.onEvent = onEvent; // (event) => void
    this.lock = false;
    this.current = null; // { jobId, cancelled }
    this.GENERATE_TIMEOUT = 120_000; // 生成等待
    this.CAPTURE_RETRY = 15_000; // 按钮恢复后等图
    this.POLL_MS = 500;
  }

  get busy() {
    return this.lock;
  }

  emit(type, data = {}) {
    if (this.onEvent) this.onEvent({ type, jobId: this.current?.jobId, ts: Date.now(), ...data });
  }

  // 主入口：单并发，返回任务结果
  async run({ prompt, negative_prompt = "", parameters_json = null, kind = "manual" }) {
    if (this.lock) throw new Error("已有任务在运行（单并发）");
    this.lock = true;
    const jobId = this.store.createJob({ kind, prompt, negative_prompt, parameters_json });
    this.current = { jobId, cancelled: false };
    this.emit("job.update", { state: "submitted", jobId });
    try {
      // 1) 能力探测
      const probe = await this.adapter.probe();
      if (!probe.ok) {
        const why = !probe.inputFound ? "未找到提示词输入框" : !probe.generateFound ? "未找到生成按钮" : probe.loginHint ? "页面疑似未登录" : "生成按钮不可用";
        throw Object.assign(new Error(why), { code: "PROBE_FAIL" });
      }
      this.emit("job.update", { state: "generating", jobId, progress: "写入提示词" });

      // 2) 写提示词 + 回读确认
      const w = await this.adapter.writePrompt(prompt, negative_prompt);
      const expectedPrompt = prompt.trim();
      const actualPrompt = (w.readP || "").trim();
      if (!w.okP || actualPrompt !== expectedPrompt) {
        throw Object.assign(new Error(`提示词写入回读不一致: 期望[${expectedPrompt.slice(0, 30)}] 实际[${actualPrompt.slice(0, 30)}]`), { code: "WRITE_FAIL" });
      }
      this.emit("job.update", { state: "generating", jobId, progress: "准备生成" });

      // 2.5) 透传参数（Model / Resolution / Seed / Steps / Guidance）——失败降级不阻断
      const pj = parameters_json ? (() => { try { return JSON.parse(parameters_json); } catch { return null; } })() : null;
      if (pj) {
        for (const key of ["model", "width", "height", "resolution_category", "number_images", "steps", "guidance", "seed", "sampler", "quality_preset", "uc_preset", "transparent_bg"]) {
          const v = pj[key];
          if (v === undefined || v === null || v === "") continue;
          const pr = await this.adapter.setParameter(key, v);
          if (!pr.ok) {
            this.emit("job.update", { state: "generating", jobId, progress: `参数 ${key} 未生效（${pr.reason}）` });
          }
        }
      }

      // 3) 生成前快照（区分新旧图）
      const before = await this.adapter.snapshotResults();

      // 4) 点击生成，确认进入生成中
      const click = await this.adapter.clickGenerate();
      if (!click.clicked) throw Object.assign(new Error("生成按钮点击失败（未找到或不可用）"), { code: "CLICK_FAIL" });
      // 等待按钮进入忙碌（最多 4s）；点击后可能瞬时，若 1s 内未 busy 且很快出现新图也算开始
      const busyAt = Date.now();
      let generating = await this.adapter.isGenerating();
      while (!generating && Date.now() - busyAt < 4000) {
        await sleep(300);
        generating = await this.adapter.isGenerating();
      }
      if (!generating) this.emit("job.update", { state: "generating", jobId, progress: "未检测到忙碌态，继续观察" });

      // 5) 完成检测（多信号轮询）
      const result = await this.waitForCompletion(before);
      this.emit("job.update", { state: "captured", jobId, progress: "抓取图片" });

      // 6) 抓图
      const img = await this.adapter.captureImage(result.img);
      const buffer = Buffer.from(img.base64, "base64");
      this.emit("job.update", { state: "persisted", jobId, progress: "保存入库" });

      // 7) 入库（去重由 store 处理）
      const saved = this.store.saveImage(buffer, {
        mime: img.mime, width: img.width, height: img.height,
        source: "novelai", job_id: jobId,
        prompt, negative_prompt, parameters_json,
      });
      this.store.finishJob(jobId, { status: "succeeded" });
      this.emit("asset.created", { assetId: saved.id, filePath: saved.file_path, duplicate: saved.duplicate, jobId });
      this.emit("job.update", { state: "succeeded", jobId, progress: "完成", assetId: saved.id, duplicate: saved.duplicate });
      return { jobId, assetId: saved.id, duplicate: saved.duplicate };
    } catch (e) {
      const code = e.code || "UNKNOWN";
      const status = e.code === "TIMEOUT" ? "timeout" : e.name === "CancelError" ? "cancelled" : "failed";
      this.store.finishJob(jobId, { status, error_code: code, error_message: e.message });
      this.emit("job.update", { state: status, jobId, error: e.message });
      throw e;
    } finally {
      this.lock = false;
      this.current = null;
    }
  }

  // 多信号完成检测：新图出现且 complete，按钮恢复后确认稳定
  async waitForCompletion(before) {
    const t0 = Date.now();
    let lastImg = null;
    let stableSince = 0;
    while (Date.now() - t0 < this.GENERATE_TIMEOUT) {
      this.assertNotCancelled();
      const generating = await this.adapter.isGenerating();
      const img = await this.adapter.findNewImage(before);
      if (process.env.JOB_DEBUG) console.log(`[job-debug] t=${Math.round((Date.now() - t0) / 1000)}s generating=${generating} img=${img ? img.src.slice(0, 40) : "none"} lastImg=${lastImg ? lastImg.src.slice(0, 20) : "none"} stableSince=${stableSince ? Date.now() - stableSince : 0}`);
      if (img) {
        if (lastImg && lastImg.src === img.src) {
          if (!stableSince) stableSince = Date.now();
          // 新图稳定（连续采样一致）且按钮已恢复 → 完成
          if (!generating && Date.now() - stableSince >= this.POLL_MS) {
            return { img, generating: false };
          }
        } else {
          lastImg = img;
          stableSince = 0;
        }
      } else if (lastImg && !generating) {
        // 图已找到但按钮已恢复：再给抓取窗口
        return { img: lastImg, generating: false };
      }
      await sleep(this.POLL_MS);
    }
    throw Object.assign(new Error("生成超时（120s 未检测到新图）"), { code: "TIMEOUT" });
  }

  assertNotCancelled() {
    if (this.current?.cancelled) {
      const e = new Error("任务已取消");
      e.name = "CancelError";
      throw e;
    }
  }

  cancel() {
    if (this.current) {
      this.current.cancelled = true;
      const stopper = this.adapter?.stopGeneration;
      if (typeof stopper === "function") {
        stopper.call(this.adapter).catch(() => {});
      }
    }
  }
}

/**
 * Prompt Compiler + Model Routing P0 回归测试
 * 运行方式: env -u NODE_OPTIONS node --test tests/test_prompt_compiler.mjs
 *
 * 覆盖：
 * - V5 Full / V5 Curated 的 selector/config/provider exact model ID
 * - 官方 Quality / UC 档位内容（用户提供的官方档位事实，2026-08 同步）：
 *   Standard/Light Quality 精确数组；light/heavy/furry_focus/human_focus UC 精确数组（heavy 不含 nsfw）
 * - 跨极性 exact-token 冲突检测为 warning-only（不删除任何 token，恢复 WebUI parity）
 * - 用户自己 pos/neg 同 token 冲突保留 + 报告
 * - 无冲突 baseline：统一官方档位内容应用于所有模型家族（V5 Curated 不伪造专属差异）
 * - unknown model / unknown tier 明确报错、不 fallback
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { splitTokens, joinTokens } from "../static/prompt-compiler.js";
import {
  compileGenerationPrompts,
  compileNegative,
  compilePrompt,
  getModelPresetFamily,
  getAutoPromptPreset,
  QUALITY_PRESETS,
  UC_PRESETS,
} from "../static/prompt-compiler.js";

test("compiler tokenizer preserves weighted comma token", () => {
  const tokens = splitTokens("1.5::rain, night::, bedroom");
  assert.deepEqual(tokens, ["1.5::rain, night::", "bedroom"]);
  assert.equal(joinTokens(tokens), "1.5::rain, night::, bedroom");
});
import { normalizeGenerationRequest } from "../server/generation-request.mjs";
import { NovelAIProvider } from "../server/novelai-provider.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODELS = {
  v5Full: "nai-diffusion-5-full",
  v5Curated: "nai-diffusion-5-curated",
  v45Full: "nai-diffusion-4-5-full",
  v4Full: "nai-diffusion-4-full",
};

// 官方档位内容（与 prompt-compiler.js 内常量一致；测试作为精确断言基准）
const OFFICIAL_QUALITY = {
  standard: ["very aesthetic", "masterpiece", "no text"],
  light: ["very aesthetic", "amazing quality", "no text"],
};
const OFFICIAL_UC = {
  light: ["lowres", "bad hands", "bad anatomy", "artistic error", "sepia", "white haze", "worst quality", "very displeasing", "jpeg artifacts", "0::ai-generated::"],
  heavy: ["lowres", "artistic error", "film grain", "scan artifacts", "worst quality", "bad quality", "jpeg artifacts", "very displeasing", "chromatic aberration", "dithering", "halftone", "screentone", "multiple views", "logo", "too many watermarks", "negative space", "blank page"],
  furry_focus: ["{worst quality}", "distracting watermark", "unfinished", "bad quality", "{widescreen}", "upscale", "{sequence}", "{{grandfathered content}}", "blurred foreground", "chromatic aberration", "sketch", "everyone", "[sketch background]", "simple", "[flat colors]", "ych (character)", "outline", "multiple scenes", "[[horror (theme)]]", "comic"],
  human_focus: ["lowres", "artistic error", "film grain", "scan artifacts", "worst quality", "bad quality", "jpeg artifacts", "very displeasing", "chromatic aberration", "dithering", "halftone", "screentone", "multiple views", "logo", "too many watermarks", "negative space", "blank page", "@_@", "mismatched pupils", "glowing eyes", "bad anatomy"],
};

function readSelectorOptions() {
  const html = readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
  const m = html.match(/<select id="nai-model"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(m, "nai-model selector not found in index.html");
  return [...m[1].matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]);
}

function readTierSelectorOptions(id) {
  const html = readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
  const m = html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  assert.ok(m, `${id} selector not found in index.html`);
  return [...m[1].matchAll(/<option value="([^"]+)"/g)].map((x) => x[1]);
}

const provider = new NovelAIProvider();

// ---- 1. Model selector / config / provider exact IDs ----

test("model selector exposes the 4 current legal txt2img model IDs", () => {
  const options = readSelectorOptions();
  for (const id of [MODELS.v5Full, MODELS.v5Curated, MODELS.v45Full, MODELS.v4Full]) {
    assert.ok(options.includes(id), `selector missing ${id}`);
  }
  // 普通 txt2img selector 不得包含 inpainting / V3 / Furry
  assert.ok(!options.some((id) => id.includes("-inpainting")), "inpainting must not be in txt2img selector");
  assert.ok(!options.some((id) => /v3|furry/i.test(id)), "V3/Furry must not be in selector");
});

test("tier selectors expose the official tier options (#nai-positive-tier / #nai-negative-tier)", () => {
  assert.deepEqual(readTierSelectorOptions("nai-positive-tier"), ["off", "standard", "light"]);
  assert.deepEqual(readTierSelectorOptions("nai-negative-tier"), ["off", "light", "heavy", "furry_focus", "human_focus"]);
});

for (const [name, id] of Object.entries(MODELS)) {
  test(`V5/V4 config + provider exact model ID: ${id}`, () => {
    const request = normalizeGenerationRequest({
      prompt: "nahida",
      settings: { model: id, width: 832, height: 1216, seed_mode: "random" },
    });
    assert.equal(request.settings.model, id, "normalizeGenerationRequest must keep exact ID");
    const payload = provider.buildPayload({ ...request, settings: { ...request.settings, seed: 1 } });
    assert.equal(payload.model, id, "provider payload.model must keep exact ID");
    // params_version: V5=4, V4.5/V4=3
    const isV5 = id.startsWith("nai-diffusion-5-");
    assert.equal(payload.parameters.params_version, isV5 ? 4 : 3);
  });
}

// ---- 2. Cross-polarity conflict detection: warning-only (WebUI parity) ----

test("user positive lowres + auto negative lowres -> both sides kept, warning only", () => {
  // 官方 heavy UC 含 lowres（不含 nsfw）
  const res = compileGenerationPrompts("nahida, lowres", "blurry", MODELS.v45Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.userPositive.some((t) => t.toLowerCase() === "lowres"), "user positive lowres preserved");
  assert.ok(res.autoNegative.some((t) => t.toLowerCase() === "lowres"), "auto negative lowres kept, NOT removed (warning-only)");
  assert.ok(res.crossPolarityWarnings.some((t) => t.toLowerCase() === "lowres"), "lowres reported in crossPolarityWarnings");
  assert.deepEqual(res.suppressedAuto.negative, [], "suppressedAuto is empty (deprecated, no deletion)");
  assert.ok(res.effectivePositive.includes("lowres"), "user positive lowres still in effective positive");
  assert.ok(res.effectiveNegative.split(",").some((t) => t.trim().toLowerCase() === "lowres"), "auto negative lowres still in effective negative");
});

test("user negative masterpiece + auto positive masterpiece -> both sides kept, warning only", () => {
  // V4.5 家族 auto positive 含 masterpiece（旧 quality tags）
  const res = compileGenerationPrompts("nahida", "masterpiece, blurry", MODELS.v45Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.userNegative.some((t) => t.toLowerCase() === "masterpiece"), "user negative masterpiece preserved");
  assert.ok(res.autoPositive.some((t) => t.toLowerCase() === "masterpiece"), "auto positive masterpiece kept, NOT removed (warning-only)");
  assert.ok(res.crossPolarityWarnings.some((t) => t.toLowerCase() === "masterpiece"), "masterpiece reported in crossPolarityWarnings");
  assert.deepEqual(res.suppressedAuto.positive, [], "suppressedAuto is empty (deprecated, no deletion)");
  assert.ok(res.effectivePositive.split(",").some((t) => t.trim().toLowerCase() === "masterpiece"), "auto positive masterpiece still in effective positive");
  assert.ok(res.effectiveNegative.includes("masterpiece"), "user negative masterpiece still in effective negative");
});

test("user positive chromatic aberration + auto UC chromatic aberration -> both kept, warning only", () => {
  // V5 Full auto negative（Heavy UC）含 chromatic aberration
  const res = compileGenerationPrompts("nahida, chromatic aberration", "blurry", MODELS.v5Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.userPositive.some((t) => t.toLowerCase() === "chromatic aberration"), "user positive chromatic aberration preserved");
  assert.ok(res.autoNegative.some((t) => t.toLowerCase() === "chromatic aberration"), "auto UC chromatic aberration kept, NOT removed");
  assert.ok(res.crossPolarityWarnings.some((t) => t.toLowerCase() === "chromatic aberration"), "chromatic aberration reported as warning");
  assert.ok(res.effectivePositive.includes("chromatic aberration"), "user positive chromatic aberration still in effective positive");
  assert.ok(res.effectiveNegative.split(",").some((t) => t.trim().toLowerCase() === "chromatic aberration"), "auto UC chromatic aberration still in effective negative");
});

test("user positive+negative same token lowres -> both kept, conflict reported", () => {
  const res = compileGenerationPrompts("nahida, lowres", "lowres, blurry", MODELS.v45Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.userPositive.some((t) => t.toLowerCase() === "lowres"), "user positive lowres kept");
  assert.ok(res.userNegative.some((t) => t.toLowerCase() === "lowres"), "user negative lowres kept");
  assert.ok(res.userCrossPolarityConflicts.some((t) => t.toLowerCase() === "lowres"), "lowres reported as user cross-polarity conflict");
  assert.ok(res.crossPolarityWarnings.some((t) => t.toLowerCase() === "lowres"), "lowres also reported in crossPolarityWarnings");
  assert.ok(res.effectivePositive.includes("lowres"));
  assert.ok(res.effectiveNegative.split(",").some((t) => t.trim().toLowerCase() === "lowres"), "user negative lowres still in effective negative");
});

// ---- 3. No-conflict baseline; uniform official tier content (heavy 不含 nsfw) ----

test("no-conflict nahida on V4.5 uses official quality/UC baseline", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v45Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.autoPositive.some((t) => t.toLowerCase() === "masterpiece"), "V4.5 keeps official standard quality tags");
  assert.ok(res.autoNegative.some((t) => t.toLowerCase() === "lowres"), "V4.5 keeps official heavy UC");
  assert.ok(!res.autoNegative.some((t) => t.toLowerCase() === "nsfw"), "official heavy UC must NOT contain nsfw");
  assert.deepEqual(res.userCrossPolarityConflicts, []);
});

test("no-conflict nahida on V5 Full injects official Standard Quality, no explicit-suppression", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { qualityTags: true, heavyUc: true });
  assert.deepEqual(res.autoPositive, OFFICIAL_QUALITY.standard, "V5 Full official standard quality tags");
  assert.ok(res.autoNegative.some((t) => t.toLowerCase() === "lowres"), "V5 Full keeps official heavy UC");
  assert.ok(!res.autoNegative.some((t) => t.toLowerCase() === "nsfw"), "official heavy UC must NOT contain nsfw");
  assert.equal(res.effectivePositive, "nahida, very aesthetic, masterpiece, no text", "V5 Full effective positive matches official standard");
  assert.ok(res.effectivePositive.includes("masterpiece"), "masterpiece must be present, not suppressed");
});

test("V5 Curated uses the same uniform official tier content (no fabricated Curated-specific preset)", () => {
  // 官方档位内容统一应用于所有模型家族；不伪造 Curated 专属差异。
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Curated, { positiveTier: "standard", negativeTier: "heavy" });
  assert.deepEqual(res.autoPositive, OFFICIAL_QUALITY.standard, "V5 Curated applies the same official standard quality (user-provided official facts)");
  assert.deepEqual(res.autoNegative, OFFICIAL_UC.heavy, "V5 Curated applies the same official heavy UC (no fabricated Curated-specific array)");
  assert.equal(res.effectivePositive, "nahida, very aesthetic, masterpiece, no text");
});

test("regression: V5 Full nahida + quality=standard -> nahida, very aesthetic, masterpiece, no text", () => {
  // model=nai-diffusion-5-full, raw positive=nahida, quality=standard
  const res = compileGenerationPrompts("nahida", "", MODELS.v5Full, { qualityTags: true, heavyUc: true });
  assert.equal(res.model, MODELS.v5Full);
  assert.equal(res.family, "v5");
  // 严格等于官网真实 Network 的 effective positive 顺序/内容
  assert.equal(res.effectivePositive, "nahida, very aesthetic, masterpiece, no text");
  // masterpiece 明确存在且未被 suppress/错误删除（warning-only 不删除 token）
  assert.ok(res.effectivePositive.includes("masterpiece"), "masterpiece must be present in effective positive");
  assert.deepEqual(res.suppressedAuto.positive, [], "masterpiece must not be suppressed (deprecated field empty)");
  assert.deepEqual(res.crossPolarityWarnings, [], "no cross-polarity warning for plain nahida");
  assert.deepEqual(res.userCrossPolarityConflicts, [], "no user cross-polarity conflict for plain nahida");
});

test("getModelPresetFamily distinguishes v5 vs v4_5_or_v4", () => {
  assert.equal(getModelPresetFamily(MODELS.v5Full), "v5");
  assert.equal(getModelPresetFamily(MODELS.v5Curated), "v5");
  assert.equal(getModelPresetFamily(MODELS.v45Full), "v4_5_or_v4");
  assert.equal(getModelPresetFamily(MODELS.v4Full), "v4_5_or_v4");
});

test("getAutoPromptPreset: uniform official content across all model families (no nsfw)", () => {
  for (const id of [MODELS.v5Full, MODELS.v5Curated, MODELS.v45Full, MODELS.v4Full]) {
    const preset = getAutoPromptPreset(id);
    assert.deepEqual(preset.positiveTags, OFFICIAL_QUALITY.standard, `${id} positive = official standard`);
    assert.deepEqual(preset.negativeTags, OFFICIAL_UC.heavy, `${id} negative = official heavy`);
    assert.ok(!preset.negativeTags.includes("nsfw"), `${id} heavy must NOT contain nsfw`);
  }
  // transparent background appended to auto positive
  const bg = getAutoPromptPreset(MODELS.v5Full, { transparentBackground: true });
  assert.deepEqual(bg.positiveTags, [...OFFICIAL_QUALITY.standard, "transparent background"]);
});

// ---- 3b. Tier mapping: positive/negative tier -> 官方 Quality/UC 数组 ----
// 前端档位选择器（#nai-positive-tier / #nai-negative-tier）在 app.js 的 naiCompileGeneration
// 映射为 compiler 的 positiveTier / negativeTier 档位值：
//   positive: off | standard | light
//   negative: off | light | heavy | furry_focus | human_focus
// 此处用纯函数验证该映射的编译结果（官方数组精确断言）。

test("positive off -> no auto positive injected", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "off", negativeTier: "heavy" });
  assert.deepEqual(res.autoPositive, [], "positive off must not inject auto positive");
  assert.equal(res.effectivePositive, "nahida");
});

test("V5 Full + positive standard + raw nahida -> strict official Standard Quality", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "standard", negativeTier: "heavy" });
  assert.deepEqual(res.autoPositive, OFFICIAL_QUALITY.standard, "standard positive exactly = very aesthetic, masterpiece, no text");
  assert.equal(res.effectivePositive, "nahida, very aesthetic, masterpiece, no text");
  assert.equal(res.effectivePositive, "nahida, " + OFFICIAL_QUALITY.standard.join(", "));
});

test("V5 Full + positive light -> official Light Quality exactly", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "light", negativeTier: "heavy" });
  assert.deepEqual(res.autoPositive, OFFICIAL_QUALITY.light, "light positive exactly = very aesthetic, amazing quality, no text");
  assert.equal(res.effectivePositive, "nahida, very aesthetic, amazing quality, no text");
});

test("QUALITY_PRESETS exposed by compiler match the user-provided official facts", () => {
  assert.deepEqual(QUALITY_PRESETS.standard, OFFICIAL_QUALITY.standard);
  assert.deepEqual(QUALITY_PRESETS.light, OFFICIAL_QUALITY.light);
});

test("negative off -> no client auto negative injected", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "standard", negativeTier: "off" });
  assert.deepEqual(res.autoNegative, [], "negative off must not inject client auto negative");
  assert.equal(res.effectiveNegative, "blurry");
});

test("negative heavy -> official Heavy UC exactly, no nsfw", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "standard", negativeTier: "heavy" });
  assert.deepEqual(res.autoNegative, OFFICIAL_UC.heavy, "heavy negative exactly = official heavy list");
  assert.ok(!res.autoNegative.includes("nsfw"), "official Heavy 明确不含 nsfw");
  assert.equal(res.effectiveNegative, OFFICIAL_UC.heavy.join(", ") + ", blurry", "UC 追加到负面开头");
});

test("negative light -> official Light UC exactly with 0::ai-generated::", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "standard", negativeTier: "light" });
  assert.deepEqual(res.autoNegative, OFFICIAL_UC.light, "light negative exactly = official light list");
  assert.ok(res.autoNegative.includes("0::ai-generated::"), "light UC contains 0::ai-generated::");
});

test("negative furry_focus -> official Furry Focus UC exactly", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "standard", negativeTier: "furry_focus" });
  assert.deepEqual(res.autoNegative, OFFICIAL_UC.furry_focus, "furry_focus negative exactly = official Furry Focus list");
});

test("negative human_focus -> official Human Focus UC exactly", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "standard", negativeTier: "human_focus" });
  assert.deepEqual(res.autoNegative, OFFICIAL_UC.human_focus, "human_focus negative exactly = official Human Focus list");
});

test("UC_PRESETS exposed by compiler match the user-provided official facts (no nsfw anywhere)", () => {
  assert.deepEqual(UC_PRESETS.light, OFFICIAL_UC.light);
  assert.deepEqual(UC_PRESETS.heavy, OFFICIAL_UC.heavy);
  assert.deepEqual(UC_PRESETS.furry_focus, OFFICIAL_UC.furry_focus);
  assert.deepEqual(UC_PRESETS.human_focus, OFFICIAL_UC.human_focus);
  for (const key of ["light", "heavy", "furry_focus", "human_focus"]) {
    assert.ok(!UC_PRESETS[key].includes("nsfw"), `${key} must not contain nsfw`);
  }
});

test("unknown positive tier / unknown negative tier -> clear error, no fallback", () => {
  assert.throws(
    () => compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "ultra", negativeTier: "heavy" }),
    /不支持的正面档位/,
  );
  assert.throws(
    () => compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "standard", negativeTier: "ultra" }),
    /不支持的负面档位/,
  );
});

test("negative light/heavy/furry_focus/human_focus -> client auto negative present (request layer preset is separate)", () => {
  for (const tier of ["light", "heavy", "furry_focus", "human_focus"]) {
    const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { positiveTier: "standard", negativeTier: tier });
    assert.ok(res.autoNegative.length > 0, `negative ${tier} keeps client auto UC`);
    assert.deepEqual(res.autoNegative, OFFICIAL_UC[tier], `negative ${tier} uses the exact official array`);
  }
});

// ---- 4. Legacy string wrappers still work (backward compat) ----

test("legacy compilePrompt/compileNegative wrappers return strings", () => {
  // 默认官方 Standard Quality / Heavy UC
  assert.equal(compilePrompt("nahida"), "nahida, very aesthetic, masterpiece, no text");
  assert.ok(compileNegative("blurry").includes("lowres"));
  assert.ok(!compileNegative("blurry").includes("nsfw"), "official heavy must not contain nsfw");
  assert.ok(compileNegative("blurry").endsWith(", blurry"));
  // 显式传 V4.5 模型仍得到官方 quality/UC
  assert.equal(compilePrompt("nahida", { model: MODELS.v45Full }), "nahida, very aesthetic, masterpiece, no text");
  assert.ok(compileNegative("blurry", { model: MODELS.v45Full }).includes("lowres"));
  // 显式传 V5 Curated：与 V5 Full 相同官方档位内容（统一官方档位事实）
  assert.equal(compilePrompt("nahida", { model: MODELS.v5Curated }), "nahida, very aesthetic, masterpiece, no text");
});

// ---- 5. Unknown model -> clear error, no fallback ----

test("unknown model is rejected, not silently fallback", () => {
  assert.throws(() => normalizeGenerationRequest({
    prompt: "nahida",
    settings: { model: "nai-diffusion-9-unknown", width: 832, height: 1216 },
  }), /不支持的模型/, "unknown model must throw");
  // V3 / Furry / inpainting 不在本轮允许范围，同样拒绝
  assert.throws(() => normalizeGenerationRequest({
    prompt: "x",
    settings: { model: "nai-diffusion-3-full", width: 832, height: 1216 },
  }), /不支持的模型/);
  assert.throws(() => normalizeGenerationRequest({
    prompt: "x",
    settings: { model: "nai-diffusion-5-full-inpainting", width: 832, height: 1216 },
  }), /不支持的模型/);
});

// ---- 6. Case-insensitive exact-token conflict detection (warning-only) ----

test("cross-polarity conflict detection is case-insensitive exact token", () => {
  const res = compileGenerationPrompts("nahida, LOWRES", "blurry", MODELS.v45Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.autoNegative.some((t) => t.toLowerCase() === "lowres"), "auto negative lowres kept (warning-only)");
  assert.ok(res.crossPolarityWarnings.some((t) => t.toLowerCase() === "lowres"), "LOWRES (uppercase) reported as warning");
  assert.deepEqual(res.suppressedAuto.negative, [], "suppressedAuto is empty (deprecated)");
});

// ---- 7. P0: Preview 与 Generate 共用结构化解析路径（多角色草稿） ----
// app.js 的 naiUpdateEffectivePreview / naiStructuredRequest 依赖浏览器全局，无法在 Node 中直接导入。
// 这里用纯函数 compileGenerationPrompts 模拟该路径的语义：
//   先 naiStructuredRequest(rawPrompt, rawNeg) -> { prompt: basePrompt, negative_prompt: globalUc }
//   再 naiCompileGeneration(compilePromptInput, compileNegativeInput)
// 证明：多角色草稿下，把 textarea 的结构化 displayPrompt 解析回 basePrompt 后再编译，
// 得到的 effectivePositive 是干净的 base prompt，而不是被当成普通 token 的 “Base: ...\nCharacter 1: ...” 字面量。

test("structured display prompt resolves to base prompt before compile (P0 preview/generate 同源)", () => {
  // 模拟 naiStructuredDraft：displayPrompt 为 textarea 里的结构化字符串，basePrompt 为实际要编译的正文
  const draft = {
    displayPrompt: "Base: 1girl, forest\nCharacter 1: nahida",
    displayNegative: "lowres",
    basePrompt: "1girl, forest, nahida",
    globalUc: "lowres",
    characters: [{ prompt: "nahida" }],
  };
  // 模拟 naiStructuredRequest(rawPrompt, rawNeg) —— 与 app.js 完全一致的判定逻辑
  const naiStructuredRequest = (prompt, negativePrompt) => {
    if (!draft) return null;
    if (prompt.trim() !== draft.displayPrompt || negativePrompt !== draft.displayNegative) return null;
    return { prompt: draft.basePrompt, negative_prompt: draft.globalUc, characters: draft.characters };
  };
  const rawPrompt = draft.displayPrompt;
  const rawNeg = draft.displayNegative;

  // 修复前：直接编译 displayPrompt —— 结构化字符串被当成普通正面 token，混入 effectivePositive
  const broken = compileGenerationPrompts(rawPrompt, rawNeg, MODELS.v5Full, { qualityTags: true, heavyUc: true });
  assert.ok(broken.effectivePositive.includes("Base:"), "bug: display prompt string leaks into effectivePositive");

  // 修复后：先解析回 basePrompt 再编译
  const structured = naiStructuredRequest(rawPrompt, rawNeg);
  const compilePromptInput = structured?.prompt ?? rawPrompt;
  const compileNegativeInput = structured?.negative_prompt ?? rawNeg;
  const fixed = compileGenerationPrompts(compilePromptInput, compileNegativeInput, MODELS.v5Full, { qualityTags: true, heavyUc: true });
  assert.equal(fixed.effectivePositive, "1girl, forest, nahida, very aesthetic, masterpiece, no text", "resolved base prompt compiles cleanly (official Standard Quality)");
  assert.ok(!fixed.effectivePositive.includes("Base:"), "no structured marker leaks after resolving to base prompt");

  // 非结构化路径行为不变：无 draft 匹配时退回原始输入
  const plain = naiStructuredRequest("some other prompt", "blurry");
  assert.equal(plain, null, "non-matching prompt returns null (falls back to raw)");
  assert.equal(compileGenerationPrompts("a", "b", MODELS.v5Full, { qualityTags: true, heavyUc: true }).effectivePositive, "a, very aesthetic, masterpiece, no text");
});

test("empty structured basePrompt stays empty in Preview/Generate, no fallback to displayPrompt", () => {
  // 购物车只有角色、无 base/free_text 时，basePrompt 为合法空字符串（""）。
  // naiFillFromCart 中 basePrompt = [r.base, r.free_text].filter(part => part?.trim()).join(", ") -> ""
  const draft = {
    displayPrompt: "Base: \nCharacter 1: nahida",
    displayNegative: "lowres",
    basePrompt: "",
    globalUc: "lowres",
    characters: [{ prompt: "nahida" }],
  };
  // 与 app.js 完全一致的 naiStructuredRequest 判定逻辑
  const naiStructuredRequest = (prompt, negativePrompt) => {
    if (!draft) return null;
    if (prompt.trim() !== draft.displayPrompt || negativePrompt !== draft.displayNegative) return null;
    return { prompt: draft.basePrompt, negative_prompt: draft.globalUc, characters: draft.characters };
  };
  const rawPrompt = draft.displayPrompt;
  const rawNeg = draft.displayNegative;
  const structured = naiStructuredRequest(rawPrompt, rawNeg);
  assert.ok(structured, "structured draft matches textarea");

  // Preview 路径：structured?.prompt ?? rawPrompt（空字符串不回退）
  const compilePromptInput = structured?.prompt ?? rawPrompt;
  assert.equal(compilePromptInput, "", "Preview keeps empty basePrompt, does NOT fall back to displayPrompt");

  // Generate 路径：structured?.prompt ?? prompt.trim()（修复前为 ||，空字符串被错误回退）
  const prompt = rawPrompt;
  const rawGenerationPrompt = structured?.prompt ?? prompt.trim();
  assert.equal(rawGenerationPrompt, "", "Generate keeps empty basePrompt, does NOT fall back to displayPrompt");
  assert.ok(!rawGenerationPrompt.includes("Base:"), "no 'Base:' leak");
  assert.ok(!rawGenerationPrompt.includes("Character:"), "no 'Character:' leak");

  // 空 basePrompt 编译结果同样干净（不含结构化标记），V5 Full 会追加官方 Standard Quality
  const fixed = compileGenerationPrompts(rawGenerationPrompt, structured?.negative_prompt ?? rawNeg, MODELS.v5Full, { qualityTags: true, heavyUc: true });
  assert.equal(fixed.effectivePositive, "very aesthetic, masterpiece, no text", "empty basePrompt compiles to only official Standard Quality");
  assert.ok(!fixed.effectivePositive.includes("Base:"));
  assert.ok(!fixed.effectivePositive.includes("Character:"));

  // 非结构化 fallback 行为不变：nullish 时仍退回原始输入（含 trim）
  const plain = naiStructuredRequest("other", "lowres");
  assert.equal(plain, null, "non-matching prompt returns null (falls back to raw)");
  assert.equal(null ?? "  nahida  ".trim(), "nahida", "non-structured fallback still trims raw input");
});

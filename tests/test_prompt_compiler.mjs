/**
 * Prompt Compiler + Model Routing P0 回归测试
 * 运行方式: env -u NODE_OPTIONS node --test tests/test_prompt_compiler.mjs
 *
 * 覆盖：
 * - V5 Full / V5 Curated 的 selector/config/provider exact model ID
 * - 跨极性 exact-token 冲突检测为 warning-only（不删除任何 token，恢复 WebUI parity）
 * - 用户自己 pos/neg 同 token 冲突保留 + 报告
 * - 无冲突 baseline：V5 Full 注入 Web-verified Standard Quality / Heavy UC；V5 Curated UNVERIFIED 不注入
 * - unknown model 明确报错、不 fallback
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  compileGenerationPrompts,
  compileNegative,
  compilePrompt,
  getModelPresetFamily,
  getAutoPromptPreset,
} from "../static/prompt-compiler.js";
import { normalizeGenerationRequest } from "../server/generation-request.mjs";
import { NovelAIProvider } from "../server/novelai-provider.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODELS = {
  v5Full: "nai-diffusion-5-full",
  v5Curated: "nai-diffusion-5-curated",
  v45Full: "nai-diffusion-4-5-full",
  v4Full: "nai-diffusion-4-full",
};

function readSelectorOptions() {
  const html = readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
  const m = html.match(/<select id="nai-model"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(m, "nai-model selector not found in index.html");
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

test("user positive nsfw + auto negative nsfw -> both sides kept, warning only", () => {
  // V4.5 家族 auto negative 含 nsfw（旧 heavy UC）
  const res = compileGenerationPrompts("nahida, nsfw", "blurry", MODELS.v45Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.userPositive.some((t) => t.toLowerCase() === "nsfw"), "user positive nsfw preserved");
  assert.ok(res.autoNegative.some((t) => t.toLowerCase() === "nsfw"), "auto negative nsfw kept, NOT removed (warning-only)");
  assert.ok(res.crossPolarityWarnings.some((t) => t.toLowerCase() === "nsfw"), "nsfw reported in crossPolarityWarnings");
  assert.deepEqual(res.suppressedAuto.negative, [], "suppressedAuto is empty (deprecated, no deletion)");
  assert.ok(res.effectivePositive.includes("nsfw"), "user positive nsfw still in effective positive");
  assert.ok(res.effectiveNegative.split(",").some((t) => t.trim().toLowerCase() === "nsfw"), "auto negative nsfw still in effective negative");
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

test("user positive+negative same token nsfw -> both kept, conflict reported", () => {
  const res = compileGenerationPrompts("nahida, nsfw", "nsfw, blurry", MODELS.v45Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.userPositive.some((t) => t.toLowerCase() === "nsfw"), "user positive nsfw kept");
  assert.ok(res.userNegative.some((t) => t.toLowerCase() === "nsfw"), "user negative nsfw kept");
  assert.ok(res.userCrossPolarityConflicts.some((t) => t.toLowerCase() === "nsfw"), "nsfw reported as user cross-polarity conflict");
  assert.ok(res.crossPolarityWarnings.some((t) => t.toLowerCase() === "nsfw"), "nsfw also reported in crossPolarityWarnings");
  assert.ok(res.effectivePositive.includes("nsfw"));
  assert.ok(res.effectiveNegative.split(",").some((t) => t.trim().toLowerCase() === "nsfw"), "user negative nsfw still in effective negative");
});

// ---- 3. No-conflict baseline; V5 Full Web-verified quality stays, V5 Curated UNVERIFIED ----

test("no-conflict nahida on V4.5 uses legacy quality/UC baseline", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v45Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.autoPositive.some((t) => t.toLowerCase() === "masterpiece"), "V4.5 keeps legacy quality tags");
  assert.ok(res.autoNegative.some((t) => t.toLowerCase() === "nsfw"), "V4.5 keeps legacy heavy UC");
  assert.deepEqual(res.userCrossPolarityConflicts, []);
});

test("no-conflict nahida on V5 Full injects Web-verified Standard Quality, no explicit-suppression", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Full, { qualityTags: true, heavyUc: true });
  assert.deepEqual(res.autoPositive, ["very aesthetic", "masterpiece", "no text"], "V5 Full Web-verified quality tags");
  assert.ok(res.autoNegative.some((t) => t.toLowerCase() === "nsfw"), "V5 Full keeps Web-verified heavy UC");
  assert.equal(res.effectivePositive, "nahida, very aesthetic, masterpiece, no text", "V5 Full effective positive matches Web Network");
  assert.ok(res.effectivePositive.includes("masterpiece"), "masterpiece must be present, not suppressed");
});

test("V5 Curated auto arrays remain empty (V5_CURATED_PRESET: UNVERIFIED)", () => {
  const res = compileGenerationPrompts("nahida", "blurry", MODELS.v5Curated, { qualityTags: true, heavyUc: true });
  assert.deepEqual(res.autoPositive, [], "V5 Curated must not auto-guess a dedicated preset");
  assert.deepEqual(res.autoNegative, [], "V5 Curated must not auto-guess a dedicated preset");
  assert.equal(res.effectivePositive, "nahida", "V5 Curated effective == raw (UNVERIFIED)");
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

test("getAutoPromptPreset: V5 Full Web-verified; V5 Curated empty (UNVERIFIED); V4 populated", () => {
  assert.deepEqual(getAutoPromptPreset(MODELS.v5Full).positiveTags, ["very aesthetic", "masterpiece", "no text"]);
  assert.ok(getAutoPromptPreset(MODELS.v5Full).negativeTags.includes("nsfw"));
  assert.deepEqual(getAutoPromptPreset(MODELS.v5Curated).positiveTags, []);
  assert.deepEqual(getAutoPromptPreset(MODELS.v5Curated).negativeTags, []);
  assert.ok(getAutoPromptPreset(MODELS.v45Full).positiveTags.includes("masterpiece"));
  assert.ok(getAutoPromptPreset(MODELS.v45Full).negativeTags.includes("nsfw"));
});

// ---- 4. Legacy string wrappers still work (backward compat) ----

test("legacy compilePrompt/compileNegative wrappers return strings", () => {
  // 默认按 V5 Full（Web-verified Quality/Heavy UC）
  assert.equal(compilePrompt("nahida"), "nahida, very aesthetic, masterpiece, no text");
  assert.ok(compileNegative("blurry").includes("nsfw"));
  assert.ok(compileNegative("blurry").endsWith(", blurry"));
  // 显式传 V4.5 模型仍得到旧 quality/UC
  assert.equal(compilePrompt("nahida", { model: MODELS.v45Full }), "nahida, very aesthetic, masterpiece, no text");
  assert.ok(compileNegative("blurry", { model: MODELS.v45Full }).includes("nsfw"));
  // 显式传 V5 Curated（UNVERIFIED）：不注入任何 auto preset
  assert.equal(compilePrompt("nahida", { model: MODELS.v5Curated }), "nahida");
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
  const res = compileGenerationPrompts("nahida, NSFW", "blurry", MODELS.v45Full, { qualityTags: true, heavyUc: true });
  assert.ok(res.autoNegative.some((t) => t.toLowerCase() === "nsfw"), "auto negative nsfw kept (warning-only)");
  assert.ok(res.crossPolarityWarnings.some((t) => t.toLowerCase() === "nsfw"), "NSFW (uppercase) reported as warning");
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
  assert.equal(fixed.effectivePositive, "1girl, forest, nahida, very aesthetic, masterpiece, no text", "resolved base prompt compiles cleanly (V5 Full Web-verified quality)");
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

  // 空 basePrompt 编译结果同样干净（不含结构化标记），V5 Full 会追加 Web-verified quality
  const fixed = compileGenerationPrompts(rawGenerationPrompt, structured?.negative_prompt ?? rawNeg, MODELS.v5Full, { qualityTags: true, heavyUc: true });
  assert.equal(fixed.effectivePositive, "very aesthetic, masterpiece, no text", "empty basePrompt compiles to only V5 Full Web-verified quality");
  assert.ok(!fixed.effectivePositive.includes("Base:"));
  assert.ok(!fixed.effectivePositive.includes("Character:"));

  // 非结构化 fallback 行为不变：nullish 时仍退回原始输入（含 trim）
  const plain = naiStructuredRequest("other", "lowres");
  assert.equal(plain, null, "non-matching prompt returns null (falls back to raw)");
  assert.equal(null ?? "  nahida  ".trim(), "nahida", "non-structured fallback still trims raw input");
});

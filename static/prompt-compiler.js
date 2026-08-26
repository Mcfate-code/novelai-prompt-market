import { splitPromptTokens, joinPromptTokens } from "./prompt-tokenizer.js";

/**
 * Prompt Compiler — 纯函数，将用户原始输入编译为 NovelAI 实际发送的 Effective Prompt / Negative。
 *
 * 设计原则：
 * - 只做 token 级（逗号分隔、trim、大小写无关精确比较）处理；不引入 fuzzy / embedding / LLM / 反义词推理。
 * - Quality / UC 档位内容以「用户提供的官方档位事实」为唯一事实源（2026-08 同步），按统一官方档位内容
 *   应用于所有模型家族（V5 Full / V5 Curated / V4.5 / V4）：Standard/Light Quality 与
 *   light / heavy / furry_focus / human_focus 四个 UC preset 使用同一官方数组。
 * - V5 Curated 不伪造 Curated 专属差异：不声称已单独抓到 Curated 专属 payload（V5_CURATED_PRESET: UNVERIFIED）。
 * - WEBUI PARITY 为默认行为目标：客户端只做跨极性冲突检测（warning-only），
 *   绝不从 payload 删除/抑制任何 token（不再有「用户显式 > 自动 preset」的本地 suppress）。
 *   用户如需调整，应自行编辑 Prompt/UC preset。
 * - raw（原始输入）永远原样保留；只改变 effective 输出。
 * - 所有函数无副作用、无 DOM 依赖，可直接在 Node / 浏览器中单测。
 */

const V5_MODEL_PREFIX = "nai-diffusion-5-";

/** 透明背景标签 */
const TRANSPARENT_BACKGROUND_TAG = "transparent background";

/**
 * 官方 Quality 档位（用户提供并冻结的唯一事实源，2026-08 同步）。
 * Standard 精确为 `very aesthetic, masterpiece, no text`；
 * Light 精确为 `very aesthetic, amazing quality, no text`。
 */
const QUALITY_PRESETS = Object.freeze({
  standard: Object.freeze(["very aesthetic", "masterpiece", "no text"]),
  light: Object.freeze(["very aesthetic", "amazing quality", "no text"]),
});
export { QUALITY_PRESETS };

/**
 * 官方 UC preset 档位（用户提供并冻结的唯一事实源，2026-08 同步）。
 * 官方 heavy 明确不含 nsfw（修正 preset 数据本身，非冲突 suppress）。
 * furry_focus / human_focus 为官方 UI preset 值；本轮未对真实 NovelAI API 验证其接受性（见 README）。
 */
const UC_PRESETS = Object.freeze({
  light: Object.freeze([
    "lowres",
    "bad hands",
    "bad anatomy",
    "artistic error",
    "sepia",
    "white haze",
    "worst quality",
    "very displeasing",
    "jpeg artifacts",
    "0::ai-generated::",
  ]),
  heavy: Object.freeze([
    "lowres",
    "artistic error",
    "film grain",
    "scan artifacts",
    "worst quality",
    "bad quality",
    "jpeg artifacts",
    "very displeasing",
    "chromatic aberration",
    "dithering",
    "halftone",
    "screentone",
    "multiple views",
    "logo",
    "too many watermarks",
    "negative space",
    "blank page",
  ]),
  furry_focus: Object.freeze([
    "{worst quality}",
    "distracting watermark",
    "unfinished",
    "bad quality",
    "{widescreen}",
    "upscale",
    "{sequence}",
    "{{grandfathered content}}",
    "blurred foreground",
    "chromatic aberration",
    "sketch",
    "everyone",
    "[sketch background]",
    "simple",
    "[flat colors]",
    "ych (character)",
    "outline",
    "multiple scenes",
    "[[horror (theme)]]",
    "comic",
  ]),
  human_focus: Object.freeze([
    "lowres",
    "artistic error",
    "film grain",
    "scan artifacts",
    "worst quality",
    "bad quality",
    "jpeg artifacts",
    "very displeasing",
    "chromatic aberration",
    "dithering",
    "halftone",
    "screentone",
    "multiple views",
    "logo",
    "too many watermarks",
    "negative space",
    "blank page",
    "@_@",
    "mismatched pupils",
    "glowing eyes",
    "bad anatomy",
  ]),
});
export { UC_PRESETS };

/**
 * 兼容旧常量名：V4/V5 统一指向官方数组（官方 heavy 明确不含 nsfw）。
 */
const V4_QUALITY_TAGS = QUALITY_PRESETS.standard;
const V5_FULL_STANDARD_QUALITY = QUALITY_PRESETS.standard;
const V5_FULL_LIGHT_QUALITY = QUALITY_PRESETS.light;
const V5_FULL_HEAVY_UC = UC_PRESETS.heavy;
const V4_HEAVY_UC = UC_PRESETS.heavy;

const V5_AUTO_POSITIVE = QUALITY_PRESETS.standard;
const V5_AUTO_NEGATIVE = UC_PRESETS.heavy;

/**
 * 正面档位（#nai-positive-tier）→ 官方 Quality 数组。
 * off=不注入；standard/light 为官方数组。
 */
const POSITIVE_TIERS = Object.freeze({
  off: Object.freeze([]),
  standard: QUALITY_PRESETS.standard,
  light: QUALITY_PRESETS.light,
});

/**
 * 负面档位（#nai-negative-tier）→ 官方 UC 数组。
 * off=不注入；light/heavy/furry_focus/human_focus 为官方数组。
 */
const NEGATIVE_TIERS = Object.freeze({
  off: Object.freeze([]),
  light: UC_PRESETS.light,
  heavy: UC_PRESETS.heavy,
  furry_focus: UC_PRESETS.furry_focus,
  human_focus: UC_PRESETS.human_focus,
});

/**
 * 依据模型 ID 返回 preset 家族。
 * @param {string} model
 * @returns {"v5" | "v4_5_or_v4"}
 */
export function getModelPresetFamily(model) {
  const m = String(model || "");
  return m.startsWith(V5_MODEL_PREFIX) ? "v5" : "v4_5_or_v4";
}

/**
 * 依据模型家族返回客户端自动注入的 prompt preset。
 * 统一官方档位内容：所有模型家族（V5 Full / V5 Curated / V4.5 / V4）返回同一官方
 * Standard Quality / Heavy UC 数组——不伪造 V5 Curated 专属差异（V5_CURATED_PRESET: UNVERIFIED）。
 * @param {string} model
 * @param {object} [options]
 * @param {boolean} [options.transparentBackground] 是否追加透明背景标签（追加到 auto positive）
 * @returns {{ positiveTags: string[], negativeTags: string[] }}
 */
export function getAutoPromptPreset(model, options = {}) {
  const positive = [...V5_AUTO_POSITIVE];
  if (options.transparentBackground && !positive.includes(TRANSPARENT_BACKGROUND_TAG)) {
    positive.push(TRANSPARENT_BACKGROUND_TAG);
  }
  return { positiveTags: positive, negativeTags: [...V5_AUTO_NEGATIVE] };
}

/**
 * 将逗号分隔的 prompt 字符串拆分为 token 数组（已 trim、去空）。
 * @param {string} text
 * @returns {string[]}
 */
export function splitTokens(text) {
  return splitPromptTokens(text);
}

/**
 * 将 token 数组拼回逗号分隔字符串。
 * @param {string[]} tokens
 * @returns {string}
 */
export function joinTokens(tokens) {
  return joinPromptTokens(tokens);
}

/**
 * 构建一个 lowercase Set 用于精确 token 比较（不 fuzzy）。
 * @param {string[]} tokens
 * @returns {Set<string>}
 */
function lowerSet(tokens) {
  const s = new Set();
  for (const t of tokens) s.add(t.toLowerCase());
  return s;
}

/**
 * 同一极性内去重（保留首个出现的原样 token），大小写无关精确比较。
 * @param {string[]} tokens
 * @returns {string[]}
 */
function dedupeTokens(tokens) {
  const seen = lowerSet([]);
  const out = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/**
 * 跨极性冲突检测（warning-only，恢复 WebUI parity）。
 *
 * 设计：本地客户端不再从 payload 中删除任何 token（不再抑制 auto preset）。
 * 本函数只负责检测跨极性 exact-token 冲突并返回 warning 列表；auto positive/negative
 * 原样返回，effective 组装由调用方使用未抑制的 auto 数组完成。
 *
 * 规则（大小写无关的精确 token 比较，不做 fuzzy / embedding / LLM / 反义词推理）：
 * - 用户 positive 与 auto negative 冲突（如 positive `lowres` + auto Heavy UC `lowres`）→ 两边保留，仅 warning。
 * - 用户 negative 与 auto positive 冲突（如 negative `masterpiece` + auto Quality `masterpiece`）→ 两边保留，仅 warning。
 * - 用户自己同时把同一 token 写进 positive 与 negative → 两边都保留，报告冲突。
 * - 同一极性内去重保留现有行为。
 *
 * @param {string[]} userPositive
 * @param {string[]} userNegative
 * @param {string[]} autoPositive - 候选自动 positive（含透明背景等）
 * @param {string[]} autoNegative - 候选自动 negative
 * @returns {{
 *   autoPositive: string[],
 *   autoNegative: string[],
 *   suppressedAuto: {positive: string[], negative: string[]},
 *   crossPolarityWarnings: string[],
 *   userCrossPolarityConflicts: string[],
 * }}
 */
function resolveCrossPolarity(userPositive, userNegative, autoPositive, autoNegative) {
  const userPositiveLower = lowerSet(userPositive);
  const userNegativeLower = lowerSet(userNegative);
  const autoPositiveLower = lowerSet(autoPositive);
  const autoNegativeLower = lowerSet(autoNegative);

  const warnings = [];

  // 用户 positive 与 auto negative 冲突（不抑制，只记录 warning）
  for (const token of userPositive) {
    if (autoNegativeLower.has(token.toLowerCase())) warnings.push(token);
  }

  // 用户 negative 与 auto positive 冲突（不抑制，只记录 warning）
  for (const token of userNegative) {
    if (autoPositiveLower.has(token.toLowerCase())) warnings.push(token);
  }

  // 用户自己 positive/negative 同时写同一 token → 都保留，报告冲突
  const conflicts = [];
  for (const token of userPositive) {
    if (userNegativeLower.has(token.toLowerCase())) conflicts.push(token);
  }

  return {
    // warning-only：不再抑制，原样返回全部 auto token
    autoPositive: [...autoPositive],
    autoNegative: [...autoNegative],
    // 兼容字段，恒为空：不得再驱动 payload 删除 token（废弃语义，保留仅因旧调用方读取）
    suppressedAuto: { positive: [], negative: [] },
    // 全部跨极性冲突 warning（含用户两侧同 token），顺序 = 检测顺序，去重
    crossPolarityWarnings: dedupeTokens([...warnings, ...conflicts]),
    userCrossPolarityConflicts: conflicts,
  };
}

/**
 * 编译完整 Effective Prompt / Negative（详细结果）。作为 Preview 与实际发送共用的唯一来源。
 *
 * @param {string} rawPositive - 用户原始 prompt
 * @param {string} rawNegative - 用户原始 negative prompt
 * @param {string} model - NovelAI 模型 ID（决定 preset 家族）
 * @param {object} [options]
 * @param {boolean} [options.qualityTags] 是否启用客户端 auto quality tags（旧布尔入口，被 positiveTier 覆盖后仍可强制置空）
 * @param {boolean} [options.heavyUc] 是否启用客户端 auto heavy UC（旧布尔入口，被 negativeTier 覆盖后仍可强制置空）
 * @param {boolean} [options.transparentBackground] 是否追加透明背景标签
 * @param {string} [options.positiveTier] 正面档位：off | standard | light（官方 Quality 数组；优先于模型默认）
 * @param {string} [options.negativeTier] 负面档位：off | light | heavy | furry_focus | human_focus（官方 UC 数组；优先于模型默认）
 * @param {string[]} [options.autoPositive] 覆盖 auto positive 候选（测试/高级用途）
 * @param {string[]} [options.autoNegative] 覆盖 auto negative 候选（测试/高级用途）
 * @returns {{
 *   model: string,
 *   family: string,
 *   rawPositive: string,
 *   rawNegative: string,
 *   userPositive: string[],
 *   userNegative: string[],
 *   autoPositive: string[],
 *   autoNegative: string[],
 *   suppressedAuto: {positive: string[], negative: string[]},
 *   crossPolarityWarnings: string[],
 *   effectivePositive: string,
 *   effectiveNegative: string,
 *   userCrossPolarityConflicts: string[],
 * }}
 */
export function compileGenerationPrompts(rawPositive, rawNegative, model, options = {}) {
  const {
    qualityTags = true,
    heavyUc = true,
    transparentBackground = false,
    positiveTier = null,
    negativeTier = null,
  } = options;

  const userPositive = dedupeTokens(splitTokens(rawPositive));
  const userNegative = dedupeTokens(splitTokens(rawNegative));

  const preset = getAutoPromptPreset(model, { transparentBackground });
  let autoPositive = Array.isArray(options.autoPositive) ? [...options.autoPositive] : preset.positiveTags;
  let autoNegative = Array.isArray(options.autoNegative) ? [...options.autoNegative] : preset.negativeTags;

  // 官方档位（UI selector 值）优先：按档位选择官方 Quality/UC 数组，覆盖模型家族默认。
  // 未知档位明确报错，不静默 fallback。
  if (positiveTier !== null && positiveTier !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(POSITIVE_TIERS, positiveTier)) {
      throw new Error(`不支持的正面档位：${positiveTier}（仅支持 off / standard / light）`);
    }
    autoPositive = [...POSITIVE_TIERS[positiveTier]];
    if (transparentBackground && positiveTier !== "off" && !autoPositive.includes(TRANSPARENT_BACKGROUND_TAG)) {
      autoPositive.push(TRANSPARENT_BACKGROUND_TAG);
    }
  }
  if (negativeTier !== null && negativeTier !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(NEGATIVE_TIERS, negativeTier)) {
      throw new Error(`不支持的负面档位：${negativeTier}（仅支持 off / light / heavy / furry_focus / human_focus）`);
    }
    autoNegative = [...NEGATIVE_TIERS[negativeTier]];
  }

  if (!qualityTags) autoPositive = [];
  if (!heavyUc) autoNegative = [];

  // 同一极性内：auto 与 user 不重复追加
  const userPositiveLower = lowerSet(userPositive);
  const userNegativeLower = lowerSet(userNegative);
  autoPositive = autoPositive.filter((t) => !userPositiveLower.has(t.toLowerCase()));
  autoNegative = autoNegative.filter((t) => !userNegativeLower.has(t.toLowerCase()));

  const resolved = resolveCrossPolarity(userPositive, userNegative, autoPositive, autoNegative);

  // WEBUI PARITY：使用未抑制的 auto tokens 组装 effective（resolved.autoPositive/autoNegative 原样未删 token）。
  const effectivePositiveTokens = [...userPositive, ...resolved.autoPositive];
  const effectiveNegativeTokens = [...resolved.autoNegative, ...userNegative];

  return {
    model,
    family: getModelPresetFamily(model),
    rawPositive,
    rawNegative,
    userPositive,
    userNegative,
    autoPositive: resolved.autoPositive,
    autoNegative: resolved.autoNegative,
    suppressedAuto: resolved.suppressedAuto, // 废弃语义：恒为空，仅兼容旧调用方
    crossPolarityWarnings: resolved.crossPolarityWarnings,
    effectivePositive: joinTokens(effectivePositiveTokens),
    effectiveNegative: joinTokens(effectiveNegativeTokens),
    userCrossPolarityConflicts: resolved.userCrossPolarityConflicts,
  };
}

/**
 * 编译详细 Effective Prompt（只关注 positive 一侧）。
 * 返回对象含 userPositive / autoPositive / suppressedAuto.positive（恒空）/ effectivePositive 等。
 */
export function compilePromptDetailed(rawPositive, model, options = {}) {
  const full = compileGenerationPrompts(rawPositive, "", model, options);
  return {
    model: full.model,
    family: full.family,
    raw: full.rawPositive,
    userPositive: full.userPositive,
    autoPositive: full.autoPositive,
    suppressedAuto: full.suppressedAuto.positive,
    effective: full.effectivePositive,
    crossPolarityWarnings: full.crossPolarityWarnings,
    userCrossPolarityConflicts: full.userCrossPolarityConflicts,
  };
}

/**
 * 编译详细 Effective Negative（只关注 negative 一侧）。
 * 返回对象含 userNegative / autoNegative / suppressedAuto.negative（恒空）/ effectiveNegative 等。
 */
export function compileNegativeDetailed(rawNegative, model, options = {}) {
  const full = compileGenerationPrompts("", rawNegative, model, options);
  return {
    model: full.model,
    family: full.family,
    raw: full.rawNegative,
    userNegative: full.userNegative,
    autoNegative: full.autoNegative,
    suppressedAuto: full.suppressedAuto.negative,
    effective: full.effectiveNegative,
    crossPolarityWarnings: full.crossPolarityWarnings,
    userCrossPolarityConflicts: full.userCrossPolarityConflicts,
  };
}

/**
 * 兼容旧调用者：返回 Effective Prompt 字符串。
 * @param {string} rawPrompt
 * @param {object} [opts]
 * @param {boolean} [opts.qualityTags]
 * @param {boolean} [opts.transparentBackground]
 * @param {string} [opts.model] 默认按 V5 Full（nai-diffusion-5-full）处理，注入官方 Standard Quality
 * @returns {string}
 */
export function compilePrompt(rawPrompt, opts = {}) {
  const model = opts.model || `${V5_MODEL_PREFIX}full`;
  const detailed = compilePromptDetailed(rawPrompt, model, opts);
  return detailed.effective;
}

/**
 * 兼容旧调用者：返回 Effective Negative 字符串。
 * @param {string} rawNegative
 * @param {object} [opts]
 * @param {boolean} [opts.heavyUc]
 * @param {string} [opts.model] 默认按 V5 Full（nai-diffusion-5-full）处理，注入官方 Heavy UC
 * @returns {string}
 */
export function compileNegative(rawNegative, opts = {}) {
  const model = opts.model || `${V5_MODEL_PREFIX}full`;
  const detailed = compileNegativeDetailed(rawNegative, model, opts);
  return detailed.effective;
}

// 供浏览器 <script> 标签使用时挂到 window
if (typeof window !== "undefined") {
  window.PromptCompiler = {
    compilePrompt,
    compileNegative,
    compilePromptDetailed,
    compileNegativeDetailed,
    compileGenerationPrompts,
    getModelPresetFamily,
    getAutoPromptPreset,
    splitTokens,
    joinTokens,
    TRANSPARENT_BACKGROUND_TAG,
    QUALITY_PRESETS,
    UC_PRESETS,
    POSITIVE_TIERS,
    NEGATIVE_TIERS,
    V4_QUALITY_TAGS,
    V4_HEAVY_UC,
    V5_FULL_STANDARD_QUALITY,
    V5_FULL_LIGHT_QUALITY,
    V5_FULL_HEAVY_UC,
    V5_AUTO_POSITIVE,
    V5_AUTO_NEGATIVE,
  };
}

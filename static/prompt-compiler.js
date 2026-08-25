/**
 * Prompt Compiler — 纯函数，将用户原始输入编译为 NovelAI 实际发送的 Effective Prompt / Negative。
 *
 * 设计原则：
 * - 只做 token 级（逗号分隔、trim、大小写无关精确比较）处理；不引入 fuzzy / embedding / LLM / 反义词推理。
 * - 质量/UC 标签按模型家族（model family）区分：V5 与 V4.5/V4 使用不同 preset（见 getModelPresetFamily）。
 * - V5 Full 的 Quality/Heavy-UC 以官网真实 Network 捕获为准（Web-verified）；V5 Curated 无 Web 证据，
 *   标记 V5_CURATED_PRESET: UNVERIFIED，不自动注入专属 preset。
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
 * V4.5/V4 客户端 Quality preset 展开标签。
 * 注意：`masterpiece` 在旧 V4.5 docs 中仅 V4.5/V4 家族使用；但官网真实 Network 已证明 V5 Full
 * Standard Quality 同样包含 `very aesthetic, masterpiece, no text`（见 V5_FULL_STANDARD_QUALITY）。
 * 本数组仅用于 V4.5/V4 家族。
 */
const V4_QUALITY_TAGS = Object.freeze(["very aesthetic", "masterpiece", "no text"]);

/**
 * V5 Full（nai-diffusion-5-full）Web-verified Standard Quality 自动正面标签。
 * 来源：从 NovelAI 官网真实 Network 捕获的 V5 Full（params_version=4）请求，
 * 其最终 effective positive 明确包含这三标签（顺序/内容固定）。
 * 官网真实 Network 高于旧 V4.5 文档，故 V5 Full 必须恢复，不得因旧 docs 误标为 V4.5-only 而删除。
 */
const V5_FULL_STANDARD_QUALITY = Object.freeze(["very aesthetic", "masterpiece", "no text"]);

/**
 * V5 Full（nai-diffusion-5-full）Web-verified Heavy UC 完整基准。
 * 来源：从 NovelAI 官网真实 Network 捕获的 V5 Full Heavy UC 完整列表，原样保留，不按旧 V4.5 文档猜测或改写。
 */
const V5_FULL_HEAVY_UC = Object.freeze([
  "nsfw",
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
]);

/**
 * V4.5/V4 客户端 Heavy UC（undesired content preset）展开内容。
 * 与 NovelAI 官网 ucPresetId=heavy 展开一致。
 */
const V4_HEAVY_UC = Object.freeze([
  "nsfw",
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
]);

/**
 * V5 Full（nai-diffusion-5-full）已通过官网真实 Network 验证 Quality/Heavy-UC 自动注入；
 * V5 Curated（nai-diffusion-5-curated）暂无 Web Network 级 Quality/UC 证据，
 * 标记为 V5_CURATED_PRESET: UNVERIFIED，不自动猜测其专属 preset（不伪造 Curated 专属数组）。
 *
 * 客户端 auto 注入仅服务「WEBUI PARITY」：V5 Full 的 effective positive/negative 与官网真实 Network
 * 一致（冲突检测仅 warning，不删除 token）；V5 的服务器 preset
 * （qualityPresetId="standard" / ucPresetId="heavy"）仍由 provider 负责。
 */
const V5_AUTO_POSITIVE = Object.freeze([...V5_FULL_STANDARD_QUALITY]);
const V5_AUTO_NEGATIVE = Object.freeze([...V5_FULL_HEAVY_UC]);

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
 * V5 Full 返回 Web-verified Quality/Heavy-UC；V5 Curated 返回空（UNVERIFIED）。
 * @param {string} model
 * @param {object} [options]
 * @param {boolean} [options.transparentBackground] 是否追加透明背景标签（追加到 auto positive）
 * @returns {{ positiveTags: string[], negativeTags: string[] }}
 */
export function getAutoPromptPreset(model, options = {}) {
  const family = getModelPresetFamily(model);
  if (family === "v5") {
    // V5 Full：使用 Web-verified Quality/UC；V5 Curated：UNVERIFIED，不自动注入专属 preset。
    const isV5Full = String(model || "") === "nai-diffusion-5-full";
    const positive = [...(isV5Full ? V5_AUTO_POSITIVE : [])];
    if (options.transparentBackground && !positive.includes(TRANSPARENT_BACKGROUND_TAG)) {
      positive.push(TRANSPARENT_BACKGROUND_TAG);
    }
    return {
      positiveTags: positive,
      negativeTags: [...(isV5Full ? V5_AUTO_NEGATIVE : [])],
    };
  }
  // V4.5/V4：继续使用旧质量/UC 字符串（经冲突 resolver 处理）
  const positive = [...V4_QUALITY_TAGS];
  if (options.transparentBackground && !positive.includes(TRANSPARENT_BACKGROUND_TAG)) {
    positive.push(TRANSPARENT_BACKGROUND_TAG);
  }
  return { positiveTags: positive, negativeTags: [...V4_HEAVY_UC] };
}

/**
 * 将逗号分隔的 prompt 字符串拆分为 token 数组（已 trim、去空）。
 * @param {string} text
 * @returns {string[]}
 */
export function splitTokens(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 将 token 数组拼回逗号分隔字符串。
 * @param {string[]} tokens
 * @returns {string}
 */
export function joinTokens(tokens) {
  return tokens.join(", ");
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
 * - 用户 positive 与 auto negative 冲突（如 positive `nsfw` + auto Heavy UC `nsfw`）→ 两边保留，仅 warning。
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
 * @param {boolean} [options.qualityTags] 是否启用客户端 auto quality tags（V5 Full / V4.5/V4 有效；V5 Curated 恒为空）
 * @param {boolean} [options.heavyUc] 是否启用客户端 auto heavy UC（V5 Full / V4.5/V4 有效；V5 Curated 恒为空）
 * @param {boolean} [options.transparentBackground] 是否追加透明背景标签
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
  } = options;

  const userPositive = dedupeTokens(splitTokens(rawPositive));
  const userNegative = dedupeTokens(splitTokens(rawNegative));

  const preset = getAutoPromptPreset(model, { transparentBackground });
  let autoPositive = Array.isArray(options.autoPositive) ? [...options.autoPositive] : preset.positiveTags;
  let autoNegative = Array.isArray(options.autoNegative) ? [...options.autoNegative] : preset.negativeTags;

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
 * @param {string} [opts.model] 默认按 V5 Full（nai-diffusion-5-full）处理，注入 Web-verified Quality
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
 * @param {string} [opts.model] 默认按 V5 Full（nai-diffusion-5-full）处理，注入 Web-verified Heavy UC
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
    V4_QUALITY_TAGS,
    V4_HEAVY_UC,
    V5_FULL_STANDARD_QUALITY,
    V5_FULL_HEAVY_UC,
    V5_AUTO_POSITIVE,
    V5_AUTO_NEGATIVE,
  };
}

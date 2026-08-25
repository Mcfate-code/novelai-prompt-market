/**
 * Prompt Compiler — 纯函数，将用户原始输入编译为 NovelAI V5 实际发送的 Effective Prompt / Negative。
 *
 * 设计原则：
 * - 只做 token 级（逗号分隔、trim、小写比较）去重，不引入 fuzzy matching / embedding。
 * - Quality Tags 和 Heavy UC 是"追加"而非"覆盖"：用户已手写的同名 tag 不重复追加。
 * - 透明背景 tag 由外部控制是否注入。
 * - 所有函数无副作用、无 DOM 依赖，可直接在 Node / 浏览器中单测。
 */

/** NovelAI V5 Standard Quality Preset 展开的标签列表 */
const V5_QUALITY_TAGS = Object.freeze(["very aesthetic", "masterpiece", "no text"]);

/** 透明背景标签 */
const TRANSPARENT_BACKGROUND_TAG = "transparent background";

/**
 * NovelAI Heavy UC（undesired content preset）默认内容。
 * 与 NovelAI 官网 ucPresetId=heavy 展开一致。
 */
const NOVELAI_HEAVY_UC = Object.freeze([
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
 * 将逗号分隔的 prompt 字符串拆分为 token 数组（已 trim、去空）。
 * @param {string} text
 * @returns {string[]}
 */
function splitTokens(text) {
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
function joinTokens(tokens) {
  return tokens.join(", ");
}

/**
 * 构建一个 lowercase Set 用于去重查找。
 * @param {string[]} tokens
 * @returns {Set<string>}
 */
function lowerSet(tokens) {
  const s = new Set();
  for (const t of tokens) s.add(t.toLowerCase());
  return s;
}

/**
 * 编译 Effective Prompt。
 *
 * @param {string} rawPrompt - 用户原始 prompt
 * @param {object} opts
 * @param {boolean} opts.qualityTags - 是否追加 Quality Tags（默认 true）
 * @param {boolean} opts.transparentBackground - 是否追加 transparent background（默认 false）
 * @returns {string} effectivePrompt
 */
export function compilePrompt(rawPrompt, opts = {}) {
  const { qualityTags = true, transparentBackground = false } = opts;
  const rawTokens = splitTokens(rawPrompt);
  const existing = lowerSet(rawTokens);
  const result = [...rawTokens];

  // 透明背景：插入到用户 raw 之后、quality tags 之前
  if (transparentBackground && !existing.has(TRANSPARENT_BACKGROUND_TAG)) {
    result.push(TRANSPARENT_BACKGROUND_TAG);
    existing.add(TRANSPARENT_BACKGROUND_TAG);
  }

  // Quality Tags：追加到末尾，去重
  if (qualityTags) {
    for (const tag of V5_QUALITY_TAGS) {
      if (!existing.has(tag)) {
        result.push(tag);
        existing.add(tag);
      }
    }
  }

  return joinTokens(result);
}

/**
 * 编译 Effective Negative。
 *
 * @param {string} rawNegative - 用户原始 negative prompt
 * @param {object} opts
 * @param {boolean} opts.heavyUc - 是否追加 Heavy UC（默认 true）
 * @returns {string} effectiveNegative
 */
export function compileNegative(rawNegative, opts = {}) {
  const { heavyUc = true } = opts;
  const rawTokens = splitTokens(rawNegative);
  const existing = lowerSet(rawTokens);
  const result = [];

  // Heavy UC 在前，用户 Negative 在后（官网顺序）
  if (heavyUc) {
    for (const tag of NOVELAI_HEAVY_UC) {
      if (!existing.has(tag)) {
        result.push(tag);
      }
    }
  }

  // 用户 Negative 始终保留（不被 Heavy UC 覆盖）
  result.push(...rawTokens);

  return joinTokens(result);
}

// 供浏览器 <script> 标签使用时挂到 window
if (typeof window !== "undefined") {
  window.PromptCompiler = { compilePrompt, compileNegative, V5_QUALITY_TAGS, NOVELAI_HEAVY_UC, TRANSPARENT_BACKGROUND_TAG };
}

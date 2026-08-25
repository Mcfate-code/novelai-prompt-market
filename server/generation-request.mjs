// V5 官网基准默认值（steps=23, guidance=7, noise_schedule=karras）
const V5_DEFAULTS = Object.freeze({
  steps: 23,
  guidance: 7,
});
// 非 V5 模型（V4/V4.5）保留旧默认
const LEGACY_DEFAULTS = Object.freeze({
  steps: 28,
  guidance: 5,
});
const DEFAULTS = Object.freeze({
  model: "nai-diffusion-5-full",
  sampler: "k_euler_ancestral",
  steps: V5_DEFAULTS.steps,
  guidance: V5_DEFAULTS.guidance,
  width: 832,
  height: 1216,
});

// NovelAI 文档公开 Small/Normal/Large 三类及其批量上限；像素值是本项目
// 对官方 width/height 参数的固定预设，不把未公开的完整枚举称为官方原文。
const ALLOWED_MODELS = Object.freeze(new Set([
  "nai-diffusion-5-full",
  "nai-diffusion-5-curated",
  "nai-diffusion-4-5-full",
  "nai-diffusion-4-full",
]));
const LEGACY_MODEL_ALIASES = Object.freeze({
  "nai-diffusion-v5-full": "nai-diffusion-5-full",
  "nai-diffusion-4.5-full": "nai-diffusion-4-5-full",
});
const ALLOWED_SAMPLERS = Object.freeze(new Set(["k_euler_ancestral", "k_euler", "k_dpmpp_2s_ancestral", "k_dpmpp_2m"]));
const ALLOWED_UC_PRESETS = Object.freeze(new Set(["off", "light", "heavy", "furry_focus", "human_focus"]));
const DEFAULT_UC_PRESET = "heavy";
const ALLOWED_QUALITY_PRESETS = Object.freeze(new Set(["off", "standard", "light"]));
const DEFAULT_QUALITY_PRESET = "standard";
const MAX_EDGE = 1536;
const MAX_PIXELS = MAX_EDGE * MAX_EDGE;
const MAX_SEED = 0xFFFFFFFF;
const MIN_SEED = 0;
const MAX_LOCAL_BATCH_COUNT = 100;

export const RESOLUTION_PRESETS = Object.freeze({
  small_portrait: { width: 512, height: 768, category: "small", maxCount: 6 },
  small_square: { width: 640, height: 640, category: "small", maxCount: 6 },
  small_landscape: { width: 768, height: 512, category: "small", maxCount: 6 },
  normal_portrait: { width: 832, height: 1216, category: "normal", maxCount: 4 },
  normal_square: { width: 1024, height: 1024, category: "normal", maxCount: 4 },
  normal_landscape: { width: 1216, height: 832, category: "normal", maxCount: 4 },
  large_portrait: { width: 1024, height: 1536, category: "large", maxCount: 4 },
  large_square: { width: 1472, height: 1472, category: "large", maxCount: 4 },
  large_landscape: { width: 1536, height: 1024, category: "large", maxCount: 4 },
});

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePosition(position) {
  if (!position || position === "auto" || position.mode === "auto") return null;
  const source = position.center || position;
  const x = finiteNumber(source.x, null);
  const y = finiteNumber(source.y, null);
  if (x === null || y === null) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
}

function normalizeCharacter(character = {}) {
  return {
    prompt: String(character.prompt || "").trim(),
    negative_prompt: String(character.negative_prompt ?? character.uc ?? "").trim(),
    position: normalizePosition(character.position),
  };
}

function normalizeSettings(input = {}) {
  const settings = input.settings && typeof input.settings === "object" ? input.settings : input;
  const width = Math.round(finiteNumber(settings.width, DEFAULTS.width) / 64) * 64;
  const height = Math.round(finiteNumber(settings.height, DEFAULTS.height) / 64) * 64;
  const seedMode = String(settings.seed_mode || input.seed_mode || "random");
  const seedRaw = settings.seed;
  const seedValue = seedRaw === null || seedRaw === undefined || seedRaw === ""
    ? null
    : Number(seedRaw);
  if (["fixed", "increment"].includes(seedMode)) {
    if (!Number.isInteger(seedValue) || seedValue < MIN_SEED || seedValue > MAX_SEED) {
      throw new Error("Fixed/Increment 模式下 Seed 需为 0~4294967295 的整数");
    }
  }
  const modelInput = String(settings.model || DEFAULTS.model);
  const model = LEGACY_MODEL_ALIASES[modelInput] || modelInput;
  if (!ALLOWED_MODELS.has(model)) {
    throw new Error(`不支持的模型：${modelInput}`);
  }
  // 按模型选择默认 steps/guidance：V5 用官网基准，非 V5 用旧默认
  const modelDefaults = model.startsWith("nai-diffusion-5-") ? V5_DEFAULTS : LEGACY_DEFAULTS;
  return {
    model,
    sampler: String(settings.sampler || DEFAULTS.sampler),
    steps: clamp(Math.trunc(finiteNumber(settings.steps, modelDefaults.steps)), 1, 50),
    guidance: clamp(finiteNumber(settings.guidance ?? settings.scale, modelDefaults.guidance), 0, 10),
    seed: seedValue,
    seed_mode: String(settings.seed_mode || input.seed_mode || "random"),
    width: clamp(width, 64, MAX_EDGE),
    height: clamp(height, 64, MAX_EDGE),
  };
}

export function normalizeGenerationRequest(input = {}) {
  const mode = input.mode === "img2img" ? "img2img" : "txt2img";
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("提示词不能为空");
  const settings = normalizeSettings(input);
  const resolutionCategory = String(input.resolution_category || settings.resolution_category || "").trim();
  const preset = RESOLUTION_PRESETS[resolutionCategory];
  if (preset) {
    settings.width = preset.width;
    settings.height = preset.height;
  }
  if (!["random", "fixed", "increment"].includes(settings.seed_mode)) {
    throw new Error("Seed 模式必须是 Random、Fixed 或 Increment");
  }
  if (["fixed", "increment"].includes(settings.seed_mode) && !Number.isInteger(settings.seed)) {
    throw new Error("Fixed/Increment 模式需要有效整数 Seed");
  }
  if (!ALLOWED_SAMPLERS.has(String(settings.sampler || DEFAULTS.sampler))) {
    throw new Error(`不支持的采样器：${String(settings.sampler || DEFAULTS.sampler)}`);
  }
  if (!Number.isInteger(settings.width) || !Number.isInteger(settings.height)) {
    throw new Error("分辨率必须是整数");
  }
  if (settings.width * settings.height > MAX_PIXELS) {
    throw new Error("分辨率像素过大，请调整到小于 1536x1536");
  }
  const count = Math.trunc(finiteNumber(input.count, 1));
  // count 是本地串行队列总数；每次真正发往 NovelAI 的请求始终固定为 1 张。
  // 因此它不应复用上游单请求 n_samples 的尺寸上限。
  if (count < 1 || count > MAX_LOCAL_BATCH_COUNT) throw new Error(`批处理数量需为 1-${MAX_LOCAL_BATCH_COUNT}`);
  const references = Array.isArray(input.references) ? input.references : [];
  if (references.length) throw new Error("Vibe / Reference 当前版本仅预留接口，不能发送请求");
  const characters = Array.isArray(input.characters)
    ? input.characters.map(normalizeCharacter).filter((character) => character.prompt)
    : [];
  let img2img = null;
  if (mode === "img2img") {
    const source = input.img2img && typeof input.img2img === "object" ? input.img2img : {};
    const sourceImage = String(source.source_image || source.image || "").trim();
    if (!sourceImage) throw new Error("图生图需要基础图片");
    img2img = {
      source_image: sourceImage,
      source_image_path: String(source.source_image_path || "").trim() || null,
      source_image_name: String(source.source_image_name || "").trim() || null,
      strength: clamp(finiteNumber(source.strength, 0.7), 0.01, 0.99),
      noise: clamp(finiteNumber(source.noise, 0), 0, 0.99),
    };
  }
  const ucPresetRaw = input.uc_preset;
  if (ucPresetRaw !== undefined && ucPresetRaw !== null && ucPresetRaw !== "" && !ALLOWED_UC_PRESETS.has(String(ucPresetRaw))) {
    throw new Error(`不支持的 UC preset：${String(ucPresetRaw)}（仅支持 off / light / heavy / furry_focus / human_focus）`);
  }
  const ucPreset = ucPresetRaw === undefined || ucPresetRaw === null || ucPresetRaw === ""
    ? DEFAULT_UC_PRESET
    : String(ucPresetRaw);
  const qualityPresetRaw = input.quality_preset;
  if (qualityPresetRaw !== undefined && qualityPresetRaw !== null && qualityPresetRaw !== "" && !ALLOWED_QUALITY_PRESETS.has(String(qualityPresetRaw))) {
    throw new Error(`不支持的 Quality preset：${String(qualityPresetRaw)}（仅支持 off / standard / light）`);
  }
  const qualityPreset = qualityPresetRaw === undefined || qualityPresetRaw === null || qualityPresetRaw === ""
    ? DEFAULT_QUALITY_PRESET
    : String(qualityPresetRaw);

  return {
    mode,
    prompt,
    negative_prompt: String(input.negative_prompt || "").trim(),
    snapshot_id: input.snapshot_id ?? null,
    quality_preset: qualityPreset,
    uc_preset: ucPreset,
    // The browser compiler keeps the expanded text for Preview/metadata. The provider
    // uses this marker to avoid adding the same preset a second time.
    prompt_presets_compiled: input.prompt_presets_compiled === true,
    quality_toggle: input.quality_toggle !== false,
    noise_schedule: input.noise_schedule || input.settings?.noise_schedule || null,
    settings: { ...settings, resolution_category: resolutionCategory || null },
    resolution_category: resolutionCategory || null,
    characters,
    img2img,
    references: [],
    count,
    meta: input.meta && typeof input.meta === "object" ? input.meta : null,
  };
}

export function requestForSeed(request, seed) {
  return {
    ...request,
    settings: { ...request.settings, seed },
    count: 1,
    meta: request.meta ?? null,
  };
}

export function createGenerationRecipe(request, seed = request.settings.seed) {
  return {
    version: 1,
    mode: request.mode,
    prompt: request.prompt,
    negative_prompt: request.negative_prompt,
    snapshot_id: request.snapshot_id ?? null,
    quality_preset: request.quality_preset ?? DEFAULT_QUALITY_PRESET,
    uc_preset: request.uc_preset ?? "heavy",
    prompt_presets_compiled: request.prompt_presets_compiled === true,
    quality_toggle: request.quality_toggle,
    noise_schedule: request.noise_schedule || null,
    settings: { ...request.settings, seed },
    resolution_category: request.resolution_category || null,
    characters: request.characters.map((character) => ({
      prompt: character.prompt,
      negative_prompt: character.negative_prompt,
      position: character.position ? { ...character.position } : null,
    })),
    img2img: request.img2img ? {
      source_image_path: request.img2img.source_image_path,
      source_image_name: request.img2img.source_image_name,
      strength: request.img2img.strength,
      noise: request.img2img.noise,
    } : null,
    references: [],
    count: 1,
    meta: request.meta ?? null,
  };
}

export { DEFAULTS, V5_DEFAULTS, LEGACY_DEFAULTS };

// NovelAI official Image Generation API provider.
// This module maps one normalized GenerationRequest to one NovelAI request.
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const ENDPOINT = "https://image.novelai.net/ai/generate-image";
const ACCOUNT_ENDPOINT = "https://image.novelai.net/user/subscription";
const TOKEN_FILE = path.join(os.homedir(), ".workbuddy", "tags-market-settings.json");
const PROBE_TIMEOUT_MS = 12_000;
const GENERATION_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL = "nai-diffusion-5-full";
const DEFAULT_SAMPLER = "k_euler_ancestral";
const DEFAULT_NOISE_SCHEDULE = "karras";
const require = createRequire(import.meta.url);
let JSZip = null;
try {
  // app.py 与 start-nai.sh 均通过 NODE_PATH 提供托管的 JSZip。
  // 使用完整 ZIP 解析器优先处理带中央目录、ZIP64 与数据描述符的官方响应。
  JSZip = require("jszip");
} catch {
  // 测试/便携环境未提供依赖时保留下方的零依赖解析兜底。
}

function readNetworkSettings() {
  if (!existsSync(TOKEN_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    return {
      proxyEnabled: !!data?.proxy_enabled,
      proxyUrl: typeof data?.proxy_url === "string" ? data.proxy_url.trim() : "",
    };
  } catch {
    return {};
  }
}

function createHttpClient() {
  const settings = readNetworkSettings();
  if (!settings.proxyEnabled || !settings.proxyUrl) return { fetch: globalThis.fetch, proxy: "direct" };
  try {
    const { fetch, ProxyAgent } = require("undici");
    const dispatcher = new ProxyAgent(settings.proxyUrl);
    return { fetch: (url, options = {}) => fetch(url, { ...options, dispatcher }), proxy: settings.proxyUrl };
  } catch (cause) {
    throw new Error(`已启用代理但无法加载 HTTP 代理支持：${cause.message}`);
  }
}

function correlationId() {
  return randomBytes(5).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).padEnd(6, "0");
}

function describeApiDetail(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(describeApiDetail).filter(Boolean).join("；");
  if (typeof value === "object") {
    for (const key of ["message", "error", "detail", "reason", "code"]) {
      const text = describeApiDetail(value[key]);
      if (text) return text;
    }
    try { return JSON.stringify(value); } catch { return "未提供可读错误详情"; }
  }
  return String(value);
}

function apiError(response, detail = "") {
  const readableDetail = describeApiDetail(detail);
  const error = new Error(response.status === 401 || response.status === 403
    ? "NovelAI API Token 无效或已失效"
    : response.status === 402
      ? "NovelAI Anlas 余额不足"
      : response.status === 429
        ? "NovelAI 当前限制请求频率，请稍后重试"
        : `NovelAI API 请求失败（HTTP ${response.status}）${readableDetail ? `：${readableDetail}` : ""}`);
  error.code = [401, 403].includes(response.status) ? "AUTH_ERROR" : response.status === 402 ? "INSUFFICIENT_CREDITS" : response.status === 429 ? "RATE_LIMIT" : "API_ERROR";
  error.status = response.status;
  return error;
}

function readToken() {
  if (process.env.NOVELAI_API_KEY?.trim()) return process.env.NOVELAI_API_KEY.trim();
  if (!existsSync(TOKEN_FILE)) return "";
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
    return typeof data?.novelai_api_token === "string" ? data.novelai_api_token.trim() : "";
  } catch {
    return "";
  }
}

function subscriptionTier(subscription) {
  const raw = subscription?.tier ?? subscription?.subscriptionTier ?? subscription?.subscription?.tier;
  if (Number(raw) === 3 || String(raw || "").toLowerCase() === "opus") return "opus";
  if (Number(raw) === 2 || String(raw || "").toLowerCase() === "scroll") return "scroll";
  if (Number(raw) === 1 || String(raw || "").toLowerCase() === "tablet") return "tablet";
  if (Number(raw) === 0 || String(raw || "").toLowerCase() === "paper") return "paper";
  return "unknown";
}

export function readNovelAIBatchLimit() {
  if (!existsSync(TOKEN_FILE)) return 6;
  try {
    const value = Number(JSON.parse(readFileSync(TOKEN_FILE, "utf8"))?.novelai_batch_max_count);
    return Number.isInteger(value) ? Math.max(1, Math.min(100, value)) : 6;
  } catch {
    return 6;
  }
}

function parseZipCentralDirectory(buffer) {
  const maxScan = Math.min(buffer.length, 0xFFFF + 22);
  let eocd = -1;
  for (let i = buffer.length - 4; i >= buffer.length - maxScan; i--) {
    if (i < 0 || i + 4 > buffer.length) continue;
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("NovelAI ZIP 未发现目录结束记录");

  if (eocd + 22 > buffer.length) throw new Error("NovelAI ZIP EOCD 长度异常");
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const centralEnd = centralOffset + centralSize;
  if (centralEnd > buffer.length) throw new Error("NovelAI ZIP 中央目录超出文件边界");

  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > centralEnd) throw new Error("NovelAI ZIP 中央目录不完整");
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("NovelAI ZIP 中央目录签名错误");
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const fileNameStart = cursor + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    if (fileNameEnd > centralEnd) throw new Error("NovelAI ZIP 文件名长度异常");
    const name = buffer.toString("utf8", fileNameStart, fileNameEnd);

    cursor = fileNameEnd + extraLength + commentLength;
    if (cursor > centralEnd) throw new Error("NovelAI ZIP 中央目录字段异常");
    entries.push({ name, method, compressedSize, localHeaderOffset });
  }
  return entries;
}

function readZipImages(buffer) {
  const entries = parseZipCentralDirectory(buffer);
  const images = [];
  for (const entry of entries) {
    let cursor = entry.localHeaderOffset;
    if (cursor + 30 > buffer.length) throw new Error("NovelAI ZIP 局部文件头不完整");
    if (buffer.readUInt32LE(cursor) !== 0x04034b50) throw new Error("NovelAI ZIP 局部文件头签名错误");
    const fileNameLength = buffer.readUInt16LE(cursor + 26);
    const extraLength = buffer.readUInt16LE(cursor + 28);
    const fileDataStart = cursor + 30 + fileNameLength + extraLength;
    const dataEnd = fileDataStart + Number(entry.compressedSize);
    if (dataEnd > buffer.length) throw new Error("NovelAI ZIP 数据不完整");
    const compressed = buffer.slice(fileDataStart, dataEnd);
    let data;
    if (entry.method === 0) data = compressed;
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(compressed);
      } catch {
        throw new Error("NovelAI ZIP 解压失败");
      }
    } else {
      throw new Error(`NovelAI ZIP 使用了不支持的压缩方式：${entry.method}`);
    }
    if (/\.(?:png|jpe?g|webp)$/i.test(entry.name)) images.push({ fileName: entry.name, data });
  }
  return images;
}

async function readZipImagesWithJsZip(buffer) {
  if (!JSZip) return [];
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  const images = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !/\.(?:png|jpe?g|webp)$/i.test(entry.name)) continue;
    images.push({ fileName: entry.name, data: Buffer.from(await entry.async("nodebuffer")) });
  }
  return images;
}

function findSignature(buffer, signature, start = 0, limit = buffer.length) {
  const max = Math.max(0, Math.min(limit, buffer.length - 4));
  for (let i = Math.max(0, start); i <= max; i++) {
    if (buffer.readUInt32LE(i) === signature) return i;
  }
  return -1;
}

function readZipDescriptorCandidate(buffer, dataStart, nextBoundary) {
  const limit = nextBoundary > 0 ? nextBoundary : buffer.length;
  let descriptorOffset = findSignature(buffer, 0x08074b50, dataStart, limit);
  while (descriptorOffset >= 0) {
    const descriptorEnd = descriptorOffset + 16;
    const actual = descriptorOffset - dataStart;
    const compressed = descriptorEnd <= buffer.length
      ? buffer.readUInt32LE(descriptorOffset + 8)
      : -1;
    if (actual > 0 && compressed === actual && descriptorEnd <= limit) {
      return { dataEnd: actual, nextOffset: descriptorEnd };
    }
    descriptorOffset = findSignature(buffer, 0x08074b50, descriptorOffset + 1, limit);
  }
  return null;
}

function readUnsignedZipDescriptorCandidate(buffer, dataStart, boundary) {
  // 无签名的数据描述符固定为 12 字节：CRC32、压缩大小、原始大小。
  const descriptorOffset = boundary - 12;
  if (descriptorOffset <= dataStart || descriptorOffset + 12 > buffer.length) return null;
  const actual = descriptorOffset - dataStart;
  const compressed = buffer.readUInt32LE(descriptorOffset + 4);
  return compressed === actual ? { dataEnd: actual, nextOffset: boundary } : null;
}

function readZipImagesLegacy(buffer) {
  const images = [];
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const isLocalHeader = buffer.readUInt32LE(offset) === 0x04034b50;
    if (!isLocalHeader) {
      const nextHeader = findSignature(buffer, 0x04034b50, offset + 1);
      if (nextHeader < 0) break;
      offset = nextHeader;
    }
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);

    let dataStart;
    const nameStart = offset + 30;
    let dataEnd;
    let nextOffset = -1;
    dataStart = nameStart + fileNameLength + extraLength;

    if (flags & 0x08) {
      const nextLocal = findSignature(buffer, 0x04034b50, dataStart);
      const nextCentral = findSignature(buffer, 0x02014b50, dataStart);
      const eocd = findSignature(buffer, 0x06054b50, dataStart);
      const boundaries = [nextLocal, nextCentral, eocd].filter((value) => value >= 0);
      const nextBoundary = boundaries.length ? Math.min(...boundaries) : -1;
      const descriptorCandidate = readZipDescriptorCandidate(buffer, dataStart, nextBoundary)
        || (nextBoundary >= 0 ? readUnsignedZipDescriptorCandidate(buffer, dataStart, nextBoundary) : null);
      if (descriptorCandidate && descriptorCandidate.nextOffset > 0) {
        dataEnd = dataStart + descriptorCandidate.dataEnd;
        nextOffset = descriptorCandidate.nextOffset;
      } else {
        throw new Error("NovelAI ZIP 中无法定位数据描述符边界");
      }
    } else {
      dataEnd = dataStart + compressedSize;
      nextOffset = dataEnd;
    }

    if (dataEnd > buffer.length) throw new Error("NovelAI ZIP 数据不完整");
    const fileName = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`NovelAI ZIP 使用了不支持的压缩方式：${method}`);
    if (/\.(?:png|jpe?g|webp)$/i.test(fileName)) images.push({ fileName, data });
    if (nextOffset <= dataStart || nextOffset > buffer.length) break;
    offset = nextOffset;
  }
  return images;
}

async function parseImageResponse(buffer, contentType, payload) {
  const lowerType = (contentType || "").toLowerCase();
  const isPng = buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47;
  const isJpeg = buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
  const isWebp = buffer.length >= 12
    && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP";
  if (isPng || isJpeg || isWebp) {
    return [{ base64: buffer.toString("base64"), index: 0, seed: payload.parameters.seed }];
  }

  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    try {
      const images = await readZipImagesWithJsZip(buffer);
      if (images.length) {
        return images.map((image, index) => ({
          base64: image.data.toString("base64"), index, seed: payload.parameters.seed,
        }));
      }
      const fallbackImages = readZipImages(buffer);
      if (fallbackImages.length) {
        return fallbackImages.map((image, index) => ({
          base64: image.data.toString("base64"), index, seed: payload.parameters.seed,
        }));
      }
      throw new Error("NovelAI ZIP 中没有可读取的图片");
    } catch (cause) {
      const fallback = readZipImagesLegacy(buffer);
      if (fallback.length) {
        return fallback.map((image, index) => ({
          base64: image.data.toString("base64"), index, seed: payload.parameters.seed,
        }));
      }
      throw cause;
    }
  }
  if (lowerType.includes("application/zip") || lowerType.includes("application/octet-stream")) {
    try {
      const images = await readZipImagesWithJsZip(buffer);
      if (images.length) {
        return images.map((image, index) => ({
          base64: image.data.toString("base64"), index, seed: payload.parameters.seed,
        }));
      }
      const fallbackImages = readZipImages(buffer);
      if (fallbackImages.length) {
        return fallbackImages.map((image, index) => ({
          base64: image.data.toString("base64"), index, seed: payload.parameters.seed,
        }));
      }
    } catch {
      // fallthrough to 其他解析路径
    }
  }
  if (lowerType.includes("json")) {
    let data;
    try {
      data = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw new Error("NovelAI JSON 响应解析失败");
    }
    return (Array.isArray(data?.images) ? data.images : []).map((image, index) => ({
      base64: typeof image === "string" ? image : image?.image,
      index: image?.index ?? index,
      seed: image?.seed ?? data?.seed ?? payload.parameters.seed,
    }));
  }
  if (!lowerType.includes("json")) {
    throw new Error("NovelAI 图片返回类型无法识别");
  }
  return [];
}

function centerFor(character) {
  return character.position || { x: 0.5, y: 0.5 };
}

function characterCaption(character, field) {
  return {
    char_caption: field === "prompt" ? character.prompt : character.negative_prompt,
    centers: [centerFor(character)],
  };
}

function isStructuredPromptModel(model) {
  return /^nai-diffusion-(?:4|5)/.test(model);
}

/**
 * Build V5-specific parameters to match NovelAI website behavior.
 * Called only for structured models (nai-diffusion-4/5-*).
 * Merges into the existing parameters object in-place.
 */
// UC presets currently used by this provider. Only `light` (图库例图专用链路) and
// `heavy` (普通生成默认) are supported here. Unknown values are rejected explicitly
// rather than silently mapped to another preset.
const ALLOWED_UC_PRESETS = Object.freeze(["light", "heavy"]);

function normalizeUcPreset(value) {
  if (value === undefined || value === null || value === "") return "heavy";
  const preset = String(value);
  if (!ALLOWED_UC_PRESETS.includes(preset)) {
    const error = new Error(`不支持的 UC preset：${preset}（仅支持 light / heavy）`);
    error.code = "INVALID_UC_PRESET";
    throw error;
  }
  return preset;
}

function buildV5Parameters(parameters, model, prompt, negativePrompt, characters, useCoords, ucPreset) {
  // Structured prompt fields (already partially set by buildPayload for V4/V5)
  parameters.prompt = null;
  parameters.params_version = model.startsWith("nai-diffusion-5-") ? 4 : 3;
  parameters.use_coords = useCoords;
  parameters.v4_prompt = {
    caption: {
      base_caption: prompt,
      char_captions: characters.map((character) => characterCaption(character, "prompt")),
    },
    use_coords: useCoords,
    use_order: true,
  };
  parameters.v4_negative_prompt = {
    caption: {
      base_caption: negativePrompt,
      char_captions: characters.map((character) => characterCaption(character, "negative_prompt")),
    },
    legacy_uc: false,
  };
  parameters.characterPrompts = characters.map((character) => ({
    prompt: character.prompt,
    uc: character.negative_prompt,
    center: centerFor(character),
    enabled: true,
  }));

  // V5 behavioral flags (match website defaults)
  parameters.prefer_brownian = true;
  parameters.straight_alpha = true;
  parameters.autoSmea = false;
  parameters.dynamic_thresholding = false;
  parameters.cfg_rescale = 0;
  parameters.deliberate_euler_ancestral_bug = false;
  parameters.legacy = false;
  parameters.legacy_v3_extend = false;

  // Quality & UC presets
  parameters.qualityPresetId = "standard";
  // 图库例图专用链路显式传 `light`，普通生成未传则保持 `heavy` 现状。
  parameters.ucPresetId = ucPreset || "heavy";

  // Tag hints
  parameters.tag_hint_qt = 1;
  parameters.tag_hint_uc_preset = 2;
  parameters.tag_hint_transparent_background = true;

  // Controlnet / reference defaults
  parameters.controlnet_strength = 1;
  parameters.add_original_image = true;
  parameters.normalize_reference_strength_multiple = true;
  parameters.inpaintImg2ImgStrength = 1;

  // Image format
  parameters.image_format = "png";
}

/**
 * Returns a locked-down request object matching the NovelAI website V5 Full txt2img baseline.
 * Useful for integration testing: ensures v4_prompt, qualityPresetId, ucPresetId,
 * prefer_brownian, straight_alpha, etc. are all sent through the V5 construction path.
 */
export function buildWebUiBaselineRequest() {
  return {
    prompt: "nahida\n, transparent background, very aesthetic, masterpiece, no text",
    negative_prompt:
      "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page",
    quality_toggle: true,
    settings: {
      model: "nai-diffusion-5-full",
      sampler: "k_euler_ancestral",
      steps: 23,
      guidance: 7,
      seed: 167394568,
      width: 1216,
      height: 832,
    },
    characters: [],
  };
}

export class NovelAIProvider {
  constructor({ endpoint = ENDPOINT, fetchImpl = null } = {}) {
    this.endpoint = endpoint;
    this.fetch = fetchImpl;
  }

  get network() {
    const settings = readNetworkSettings();
    return settings.proxyEnabled && settings.proxyUrl ? settings.proxyUrl : "direct";
  }

  get configured() {
    return !!readToken();
  }

  validateConfig() {
    if (!readToken()) {
      const error = new Error("未配置 NovelAI Persistent API Token，请在本机设置后重试");
      error.code = "TOKEN_MISSING";
      throw error;
    }
  }

  async probe() {
    if (!this.configured) return { ok: false, configured: false, state: "unconfigured", code: "TOKEN_MISSING", error: "未配置 NovelAI Persistent API Token" };
    const token = readToken();
    let response;
    try {
      const http = this.fetch ? { fetch: this.fetch } : createHttpClient();
      response = await http.fetch(ACCOUNT_ENDPOINT, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (cause) {
      const error = new Error(cause?.name === "TimeoutError" ? "连接 NovelAI 超时，请检查本机代理" : `无法连接 NovelAI：${cause.message}`);
      error.code = cause?.name === "TimeoutError" ? "NETWORK_TIMEOUT" : "NETWORK_ERROR";
      throw error;
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw apiError(response, detail);
    }
    const subscription = await response.json().catch(() => ({}));
    return { ok: true, configured: true, state: "connected", subscriptionTier: subscriptionTier(subscription) };
  }

  buildPayload(request) {
    const prompt = String(request.prompt || "").trim();
    if (!prompt) throw new Error("提示词不能为空");
    const settings = request.settings || request;
    const model = settings.model || DEFAULT_MODEL;
    const negativePrompt = String(request.negative_prompt || "");
    const characters = Array.isArray(request.characters) ? request.characters : [];
    const useCoords = characters.some((character) => !!character.position);
    const ucPreset = normalizeUcPreset(request.uc_preset);
    const parameters = {
      width: settings.width ?? 832,
      height: settings.height ?? 1216,
      scale: settings.guidance ?? settings.scale ?? 5,
      sampler: settings.sampler || DEFAULT_SAMPLER,
      steps: settings.steps ?? 28,
      seed: settings.seed,
      n_samples: 1,
      negative_prompt: negativePrompt,
      prompt,
      noise_schedule: request.noise_schedule || DEFAULT_NOISE_SCHEDULE,
      qualityToggle: request.quality_toggle !== false,
    };

    if (isStructuredPromptModel(model)) {
      buildV5Parameters(parameters, model, prompt, negativePrompt, characters, useCoords, ucPreset);
    }

    let action = "generate";
    if (request.mode === "img2img") {
      action = "img2img";
      const source = request.img2img;
      if (!source?.source_image) throw new Error("图生图需要基础图片");
      parameters.image = source.source_image.replace(/^data:[^;]+;base64,/, "");
      parameters.strength = source.strength;
      parameters.noise = source.noise;
      parameters.extra_noise_seed = settings.seed;
      parameters.inpaintImg2ImgStrength = source.strength;
      parameters.img2img = { color_correct: true, strength: source.strength };
    }

    return {
      input: prompt,
      model,
      action,
      parameters,
      url: request.url || "",
    };
  }

  async generateOne(request) {
    this.validateConfig();
    const id = correlationId();
    const payload = this.buildPayload(request);
    const token = readToken();
    let response;
    try {
      const http = this.fetch ? { fetch: this.fetch } : createHttpClient();
      response = await http.fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/x-zip-compressed, application/octet-stream, application/json",
          "x-correlation-id": id,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
    } catch (cause) {
      const message = cause?.name === "TimeoutError" ? "请求超时，请检查代理或稍后重试" : cause.message;
      const error = new Error(`NovelAI 网络请求失败（correlation_id=${id}）：${message}`);
      error.code = cause?.name === "TimeoutError" ? "NETWORK_TIMEOUT" : "NETWORK_ERROR";
      error.correlationId = id;
      throw error;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const raw = buffer.toString("utf8");
      let detail = raw.slice(0, 500);
      try {
        const parsed = JSON.parse(raw);
        detail = parsed?.message ?? parsed?.error ?? parsed?.detail ?? parsed;
      } catch {}
      const error = apiError(response, detail);
      error.correlationId = id;
      throw error;
    }
    let parsed;
    try {
      parsed = await parseImageResponse(buffer, response.headers.get("content-type") || "", payload);
    } catch (cause) {
      const error = new Error(`NovelAI 图片响应解析失败（correlation_id=${id}）：${cause.message}`);
      error.code = "BAD_RESPONSE";
      error.correlationId = id;
      throw error;
    }
    if (!parsed.length || parsed.some((image) => !image.base64)) {
      const error = new Error(`NovelAI 响应未返回可用图片（correlation_id=${id}）`);
      error.code = "EMPTY_RESPONSE";
      error.correlationId = id;
      throw error;
    }
    return { images: parsed, payload, correlationId: id };
  }
}

export { DEFAULT_MODEL, DEFAULT_SAMPLER, DEFAULT_NOISE_SCHEDULE, ENDPOINT, ACCOUNT_ENDPOINT };

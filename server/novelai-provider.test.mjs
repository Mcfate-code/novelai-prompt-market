import assert from "node:assert/strict";
import test from "node:test";
import { NovelAIProvider } from "./novelai-provider.mjs";
import { normalizeGenerationRequest, requestForSeed } from "./generation-request.mjs";
import { deflateRawSync } from "node:zlib";

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZipWithDataDescriptor({ fileName = "a.txt", data = Buffer.from("hello"), fileComment = "" }) {
  const compressed = deflateRawSync(data);
  const filename = Buffer.from(fileName);
  const comment = Buffer.from(fileComment);
  const crc = crc32(data);
  const compressedSize = compressed.length;
  const uncompressedSize = data.length;
  const localHeader = Buffer.alloc(30 + filename.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0x0808, 6); // UTF-8 filename + data descriptor flags
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(0, 14); // crc placeholder
  localHeader.writeUInt32LE(0, 18); // compressed size placeholder
  localHeader.writeUInt32LE(0, 22); // uncompressed size placeholder
  localHeader.writeUInt16LE(filename.length, 26);
  localHeader.writeUInt16LE(0, 28);
  filename.copy(localHeader, 30);

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);

  const localPart = Buffer.concat([localHeader, compressed, descriptor]);
  const localOffset = 0;
  const centralHeader = Buffer.alloc(46 + filename.length + comment.length);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0x0808, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(compressedSize, 20);
  centralHeader.writeUInt32LE(uncompressedSize, 24);
  centralHeader.writeUInt16LE(filename.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(comment.length, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(localOffset, 42);
  filename.copy(centralHeader, 46);
  comment.copy(centralHeader, 46 + filename.length);

  const cd = centralHeader;
  const centralSize = cd.length;
  const centralOffset = localPart.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, cd, eocd]);
}

function makeZipStreamLikeWithDataDescriptor({
  fileName = "stream.png",
  data = Buffer.from("stream-data"),
  signedDescriptor = true,
  appendEocd = false,
}) {
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const filename = Buffer.from(fileName);
  const localHeader = Buffer.alloc(30 + filename.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed
  localHeader.writeUInt16LE(0x0808, 6); // UTF-8 filename + data descriptor flags
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(0, 14); // crc placeholder
  localHeader.writeUInt32LE(0, 18); // compressed size placeholder
  localHeader.writeUInt32LE(0, 22); // uncompressed size placeholder
  localHeader.writeUInt16LE(filename.length, 26);
  localHeader.writeUInt16LE(0, 28);
  filename.copy(localHeader, 30);

  const descriptor = Buffer.alloc(signedDescriptor ? 16 : 12);
  if (signedDescriptor) {
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(data.length, 12);
  } else {
    descriptor.writeUInt32LE(crc, 0);
    descriptor.writeUInt32LE(compressed.length, 4);
    descriptor.writeUInt32LE(data.length, 8);
  }
  const eocd = Buffer.alloc(22);
  if (appendEocd) eocd.writeUInt32LE(0x06054b50, 0);
  return Buffer.concat([localHeader, compressed, descriptor, ...(appendEocd ? [eocd] : [])]);
}

test("parses NovelAI ZIP using central directory when data descriptor is used", async () => {
  const previous = process.env.NOVELAI_API_KEY;
  process.env.NOVELAI_API_KEY = "x".repeat(32);
  const zip = makeZipWithDataDescriptor({
    fileName: "image.png",
    data: Buffer.from("hello world"),
  });
  const providerForZip = new NovelAIProvider({
    fetchImpl: async () => new Response(zip, {
      status: 200,
      headers: { "Content-Type": "application/zip", "Content-Length": String(zip.length) },
    }),
  });
  const request = normalizeGenerationRequest({
    prompt: "x",
    settings: { model: "nai-diffusion-5-full", seed_mode: "random" },
    count: 1,
  });
  try {
    const result = await providerForZip.generateOne(requestForSeed(request, 1));
    assert.equal(result.images.length, 1);
    assert.equal(Buffer.from(result.images[0].base64, "base64").toString(), "hello world");
  } finally {
    if (previous === undefined) delete process.env.NOVELAI_API_KEY;
    else process.env.NOVELAI_API_KEY = previous;
  }
});

test("parses stream-like ZIP without central directory when data descriptor is used", async () => {
  const previous = process.env.NOVELAI_API_KEY;
  process.env.NOVELAI_API_KEY = "x".repeat(32);
  const zip = makeZipStreamLikeWithDataDescriptor({
    fileName: "image.png",
    data: Buffer.from("stream image payload"),
  });
  const providerForZip = new NovelAIProvider({
    fetchImpl: async () => new Response(zip, {
      status: 200,
      headers: { "Content-Type": "application/zip", "Content-Length": String(zip.length) },
    }),
  });
  const request = normalizeGenerationRequest({
    prompt: "x",
    settings: { model: "nai-diffusion-5-full", seed_mode: "random" },
    count: 1,
  });
  try {
    const result = await providerForZip.generateOne(requestForSeed(request, 1));
    assert.equal(result.images.length, 1);
    assert.equal(Buffer.from(result.images[0].base64, "base64").toString(), "stream image payload");
  } finally {
    if (previous === undefined) delete process.env.NOVELAI_API_KEY;
    else process.env.NOVELAI_API_KEY = previous;
  }
});

test("parses stream-like ZIP with an unsigned data descriptor", async () => {
  const previous = process.env.NOVELAI_API_KEY;
  process.env.NOVELAI_API_KEY = "x".repeat(32);
  const zip = makeZipStreamLikeWithDataDescriptor({
    fileName: "image.png",
    data: Buffer.from("unsigned descriptor payload"),
    signedDescriptor: false,
    appendEocd: true,
  });
  const providerForZip = new NovelAIProvider({
    fetchImpl: async () => new Response(zip, {
      status: 200,
      headers: { "Content-Type": "application/zip", "Content-Length": String(zip.length) },
    }),
  });
  const request = normalizeGenerationRequest({
    prompt: "x",
    settings: { model: "nai-diffusion-5-full", seed_mode: "random" },
    count: 1,
  });
  try {
    const result = await providerForZip.generateOne(requestForSeed(request, 1));
    assert.equal(result.images.length, 1);
    assert.equal(Buffer.from(result.images[0].base64, "base64").toString(), "unsigned descriptor payload");
  } finally {
    if (previous === undefined) delete process.env.NOVELAI_API_KEY;
    else process.env.NOVELAI_API_KEY = previous;
  }
});

const provider = new NovelAIProvider();

test("builds a V5 multi-character payload without flattening characters", () => {
  const request = normalizeGenerationRequest({
    prompt: "2girls, cafe",
    negative_prompt: "lowres",
    settings: { model: "nai-diffusion-5-full", seed: 123, seed_mode: "fixed", width: 832, height: 1216, steps: 28, guidance: 5 },
    characters: [
      { prompt: "girl, red hair", negative_prompt: "blue hair", position: "auto" },
      { prompt: "girl, blue hair", negative_prompt: "red hair", position: { x: 0.8, y: 0.5 } },
    ],
  });
  const payload = provider.buildPayload(requestForSeed(request, 123));
  assert.equal(payload.model, "nai-diffusion-5-full");
  assert.equal(payload.action, "generate");
  assert.equal(payload.parameters.params_version, 4);
  assert.equal(payload.parameters.v4_prompt.caption.base_caption, "2girls, cafe");
  assert.equal(payload.parameters.v4_prompt.caption.char_captions.length, 2);
  assert.equal(payload.parameters.characterPrompts[0].prompt, "girl, red hair");
  assert.equal(payload.parameters.prompt, null);
  assert.equal(payload.parameters.use_coords, true);
});

test("honors an independently disabled character prompt", () => {
  const request = normalizeGenerationRequest({
    prompt: "2girls, cafe",
    settings: { model: "nai-diffusion-5-full", seed_mode: "random" },
    characters: [
      { name: "Visible", prompt: "girl, red hair", enabled: true },
      { name: "Hidden", prompt: "girl, blue hair", enabled: false },
    ],
  });
  const payload = provider.buildPayload(request);
  assert.equal(payload.parameters.characterPrompts[0].enabled, true);
  assert.equal(payload.parameters.characterPrompts[1].enabled, false);
  assert.equal(payload.parameters.v4_prompt.caption.char_captions[1].char_caption, "");
});

test("passes cfg_rescale and autoSmea through to the V5 payload", () => {
  const request = normalizeGenerationRequest({
    prompt: "1girl",
    settings: { model: "nai-diffusion-5-full", cfg_rescale: 0.6, auto_smea: true },
  });
  const payload = provider.buildPayload(requestForSeed(request, 1));
  assert.equal(payload.parameters.cfg_rescale, 0.6);
  assert.equal(payload.parameters.autoSmea, true);

  // 未传时保持官网默认：cfg_rescale 0、autoSmea false
  const defaults = provider.buildPayload(requestForSeed(
    normalizeGenerationRequest({ prompt: "1girl", settings: { model: "nai-diffusion-5-full" } }),
    1,
  ));
  assert.equal(defaults.parameters.cfg_rescale, 0);
  assert.equal(defaults.parameters.autoSmea, false);
});

test("builds an img2img payload with source image, strength and noise", () => {
  const request = normalizeGenerationRequest({
    mode: "img2img",
    prompt: "watercolor",
    settings: { seed: 9, seed_mode: "fixed" },
    img2img: { source_image: "data:image/png;base64,AAAA", strength: 0.4, noise: 0.1 },
  });
  const payload = provider.buildPayload(requestForSeed(request, 9));
  assert.equal(payload.action, "img2img");
  assert.equal(payload.parameters.image, "AAAA");
  assert.equal(payload.parameters.strength, 0.4);
  assert.equal(payload.parameters.noise, 0.1);
  assert.deepEqual(payload.parameters.img2img, { color_correct: true, strength: 0.4 });
});

test("honors a disabled quality toggle", () => {
  const request = normalizeGenerationRequest({ prompt: "1girl", quality_toggle: false });
  const payload = provider.buildPayload(requestForSeed(request, 9));
  assert.equal(payload.parameters.qualityToggle, false);
});

test("maps quality standard/light/off to the V5 payload", () => {
  for (const [quality_preset, expected] of [["standard", "standard"], ["light", "light"]]) {
    const payload = provider.buildPayload({ prompt: "1girl", settings: { model: "nai-diffusion-5-full" }, quality_preset });
    assert.equal(payload.parameters.qualityPresetId, expected);
  }
  const off = provider.buildPayload({ prompt: "1girl", settings: { model: "nai-diffusion-5-full" }, quality_preset: "off" });
  assert.equal("qualityPresetId" in off.parameters, false);
  const legacy = provider.buildPayload({ prompt: "1girl", settings: { model: "nai-diffusion-5-full" } });
  assert.equal(legacy.parameters.qualityPresetId, "standard");
  assert.throws(() => provider.buildPayload({ prompt: "1girl", quality_preset: "ultra", settings: { model: "nai-diffusion-5-full" } }), /不支持的 Quality preset/);
});

test("does not double-inject client-compiled positive and negative presets", () => {
  const payload = provider.buildPayload({ prompt: "girl, amazing quality", negative_prompt: "blurry", quality_preset: "light", uc_preset: "heavy", prompt_presets_compiled: true, settings: { model: "nai-diffusion-5-full" } });
  assert.equal("qualityPresetId" in payload.parameters, false);
  assert.equal("ucPresetId" in payload.parameters, false);
});

test("simulates UI tiers through normalization into the provider payload", () => {
  const normalized = normalizeGenerationRequest({
    prompt: "girl, very aesthetic, amazing quality, no text",
    negative_prompt: "lowres, blurry",
    quality_preset: "light",
    uc_preset: "off",
    prompt_presets_compiled: true,
    settings: { model: "nai-diffusion-5-full" },
  });
  const payload = provider.buildPayload(requestForSeed(normalized, 7));
  assert.equal(normalized.quality_preset, "light");
  assert.equal(normalized.uc_preset, "off");
  assert.equal("qualityPresetId" in payload.parameters, false);
  assert.equal("ucPresetId" in payload.parameters, false);
});

test("uses Light UC preset when uc_preset is light (图库例图专用链路)", () => {
  // 与 /api/novelai/tag-example 路由相同的原始调用形态（不经 normalizeGenerationRequest）。
  const payload = provider.buildPayload({
    prompt: "1girl",
    negative_prompt: "lowres",
    settings: { model: "nai-diffusion-5-full" },
    uc_preset: "light",
  });
  assert.equal(payload.parameters.qualityPresetId, "standard");
  assert.equal(payload.parameters.ucPresetId, "light");
});

test("keeps Heavy UC preset by default when uc_preset is omitted (普通生成)", () => {
  const payload = provider.buildPayload({
    prompt: "1girl",
    negative_prompt: "lowres",
    settings: { model: "nai-diffusion-5-full" },
  });
  assert.equal(payload.parameters.ucPresetId, "heavy");
});

test("uses Heavy UC preset when uc_preset is heavy", () => {
  const payload = provider.buildPayload({
    prompt: "1girl",
    negative_prompt: "lowres",
    settings: { model: "nai-diffusion-5-full" },
    uc_preset: "heavy",
  });
  assert.equal(payload.parameters.ucPresetId, "heavy");
});

test("passes through official furry_focus / human_focus UC preset IDs", () => {
  // 官方 UI preset 值原样透传为 ucPresetId（不在 provider 内复制 tag 数组）。
  for (const value of ["furry_focus", "human_focus"]) {
    const payload = provider.buildPayload({
      prompt: "1girl",
      negative_prompt: "lowres",
      settings: { model: "nai-diffusion-5-full" },
      uc_preset: value,
    });
    assert.equal(payload.parameters.ucPresetId, value, `ucPresetId must be ${value}`);
  }
});

test("omits ucPresetId when uc_preset is off (UI off never sends heavy)", () => {
  const payload = provider.buildPayload({
    prompt: "1girl",
    negative_prompt: "lowres",
    settings: { model: "nai-diffusion-5-full" },
    uc_preset: "off",
  });
  assert.equal("ucPresetId" in payload.parameters, false, "ucPresetId must be absent for off");
});

test("rejects an unknown uc_preset explicitly", () => {
  assert.throws(
    () => provider.buildPayload({
      prompt: "1girl",
      negative_prompt: "lowres",
      settings: { model: "nai-diffusion-5-full" },
      uc_preset: "ultra",
    }),
    (error) => error.code === "INVALID_UC_PRESET" && /不支持/.test(error.message) && /furry_focus/.test(error.message),
  );
});

test("probe distinguishes a configured and connected account", async () => {
  const previous = process.env.NOVELAI_API_KEY;
  process.env.NOVELAI_API_KEY = "test-token";
  let request = null;
  try {
    const probeProvider = new NovelAIProvider({ fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response('{"tier":3}', { status: 200, headers: { "Content-Type": "application/json" } });
    } });
    assert.deepEqual(await probeProvider.probe(), { ok: true, configured: true, state: "connected", subscriptionTier: "opus" });
    assert.match(request.url, /image\.novelai\.net\/user\/subscription/);
    assert.equal(request.options.headers.Authorization, "Bearer test-token");
  } finally {
    if (previous === undefined) delete process.env.NOVELAI_API_KEY;
    else process.env.NOVELAI_API_KEY = previous;
  }
});

test("probe maps an invalid token to AUTH_ERROR", async () => {
  const previous = process.env.NOVELAI_API_KEY;
  process.env.NOVELAI_API_KEY = "bad-token";
  try {
    const probeProvider = new NovelAIProvider({ fetchImpl: async () => new Response("invalid", { status: 401 }) });
    await assert.rejects(() => probeProvider.probe(), (error) => error.code === "AUTH_ERROR" && /无效/.test(error.message));
  } finally {
    if (previous === undefined) delete process.env.NOVELAI_API_KEY;
    else process.env.NOVELAI_API_KEY = previous;
  }
});

test("renders a structured NovelAI API error without object coercion", async () => {
  const previous = process.env.NOVELAI_API_KEY;
  process.env.NOVELAI_API_KEY = "test-token";
  try {
    const errorProvider = new NovelAIProvider({
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "该提示词不被当前请求接受" } }), { status: 400 }),
    });
    await assert.rejects(
      () => errorProvider.generateOne({ prompt: "nsfw", settings: { model: "nai-diffusion-4-5-full" } }),
      (error) => error.code === "API_ERROR" && error.message.includes("该提示词不被当前请求接受") && !error.message.includes("[object Object]"),
    );
  } finally {
    if (previous === undefined) delete process.env.NOVELAI_API_KEY;
    else process.env.NOVELAI_API_KEY = previous;
  }
});

test("treats raw image bytes as a valid single-image response", async () => {
  const previous = process.env.NOVELAI_API_KEY;
  process.env.NOVELAI_API_KEY = "x".repeat(32);
  const rawImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const imageProvider = new NovelAIProvider({
    fetchImpl: async () => new Response(rawImage, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }),
  });
  const request = normalizeGenerationRequest({
    prompt: "x",
    settings: { model: "nai-diffusion-5-full", seed_mode: "random" },
    count: 1,
  });
  try {
    const result = await imageProvider.generateOne(requestForSeed(request, 1));
    assert.equal(result.images.length, 1);
    const parsed = Buffer.from(result.images[0].base64, "base64");
    assert.equal(parsed.length, rawImage.length);
    assert.equal(parsed[0], rawImage[0]);
    assert.equal(parsed[parsed.length - 1], rawImage[rawImage.length - 1]);
  } finally {
    if (previous === undefined) delete process.env.NOVELAI_API_KEY;
    else process.env.NOVELAI_API_KEY = previous;
  }
});

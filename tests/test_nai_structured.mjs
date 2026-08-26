/**
 * 结构化多角色恢复 helper 独立测试（static/nai-structured.js）。
 * 覆盖 P0 结构化边界核心：被保存的多行结构化 display（Base: / Character N: /
 * Character N UC: / Global UC: / Free text:）必须被一次性拆解为
 * { basePrompt, globalUc, characters }，使 Base 干净、Global UC 独立、角色逐项分发，
 * 绝不把 `Character N:` / `Global UC:` 字面量带回 Base。
 * 纯模块（无 DOM 依赖），可直接在 Node 中 import 真实实现。
 *
 * 运行方式: node --test tests/test_nai_structured.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseStructuredRawPrompt,
  structuredBaseLine,
  structuredGlobalUcLine,
} from "../static/nai-structured.js";

const DISPLAY = [
  "Base: 1girl, blue eyes",
  "Character 1: citlali",
  "Character 1 UC: lowres",
  "Character 2: nahida, green hair",
  "Global UC: bad anatomy",
].join("\n");

test("structuredBaseLine extracts only the Base: line, not the whole display", () => {
  assert.equal(structuredBaseLine(DISPLAY), "1girl, blue eyes");
  assert.equal(structuredBaseLine("1girl, flat prompt without base header"), null);
});

test("structuredGlobalUcLine extracts Global UC line content", () => {
  assert.equal(structuredGlobalUcLine(DISPLAY), "bad anatomy");
  assert.equal(structuredGlobalUcLine("Base: 1girl\nCharacter 1: x"), null);
});

test("parseStructuredRawPrompt splits structured display into clean base/uc/characters", () => {
  const parsed = parseStructuredRawPrompt(DISPLAY, "bad anatomy");
  assert.ok(parsed, "structured display must parse");

  // Base 干净：绝不含 Character N:/Global UC: 字面量
  assert.equal(parsed.basePrompt, "1girl, blue eyes");
  assert.ok(!/\bCharacter\s+\d+:/.test(parsed.basePrompt), `base must not contain Character N: literal (got: ${parsed.basePrompt})`);
  assert.ok(!/Global UC:/.test(parsed.basePrompt), "base must not contain Global UC: literal");

  // Global UC 正确传递
  assert.equal(parsed.globalUc, "bad anatomy");

  // 角色逐项分发，顺序与 index 一致
  assert.equal(parsed.characters.length, 2);
  assert.equal(parsed.characters[0].prompt, "citlali");
  assert.equal(parsed.characters[0].negative_prompt, "lowres");
  assert.equal(parsed.characters[1].prompt, "nahida, green hair");
  assert.equal(parsed.characters[1].negative_prompt, "");
});

test("parseStructuredRawPrompt folds Free text into base and keeps Global UC fallback", () => {
  const display = "Base: bedroom, night\nCharacter 1: girl\nFree text: sitting on bed\nGlobal UC: lowres";
  const parsed = parseStructuredRawPrompt(display, "");
  assert.equal(parsed.basePrompt, "bedroom, night, sitting on bed", "free text must not be silently dropped");
  assert.equal(parsed.globalUc, "lowres");
  assert.equal(parsed.characters.length, 1);
  assert.equal(parsed.characters[0].prompt, "girl");
});

test("parseStructuredRawPrompt without Global UC line falls back to rawNegative", () => {
  const parsed = parseStructuredRawPrompt("Base: 1girl\nCharacter 1: citlali", "bad anatomy");
  assert.equal(parsed.globalUc, "bad anatomy");
  assert.equal(parsed.characters.length, 1);
});

test("flat / single-character prompt returns null (keeps ordinary text restore)", () => {
  assert.equal(parseStructuredRawPrompt("1girl, blue eyes", "bad anatomy"), null);
  assert.equal(parseStructuredRawPrompt("Character 1: citlali\nGlobal UC: x", "x"), null);
  assert.equal(parseStructuredRawPrompt("", ""), null);
});

test("single-line structured display with characters still parses", () => {
  const parsed = parseStructuredRawPrompt("Base: 1girl", "");
  assert.ok(parsed, "Base: header must be recognized as structured");
  assert.equal(parsed.basePrompt, "1girl");
  assert.equal(parsed.characters.length, 0, "no character lines -> empty characters");
});

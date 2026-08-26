/**
 * Prompt Syntax Codec 测试 —— static/prompt-tokenizer.js 是前端唯一规范的 NovelAI Prompt 语法编解码器。
 * 语义与 Python 参考实现 prompt/import_parser.py（split_tags / parse_entry）与
 * prompt/novelai_export.py（format_entry / format_number）一致。
 *
 * 运行方式: node --test tests/test_prompt_tokenizer.mjs
 *
 * 覆盖：
 * - splitPromptTokens：权重包裹内逗号不拆、负数权重、关系前缀、强调层级、往返拆分
 * - parsePromptToken：负数权重 / 关系前缀 / 括号层级 / 组合（关系 + 权重）
 * - serializePromptToken：canonical NovelAI 语法（.8 -> 0.8、weight===1 掉包裹、{} / [] 强调）
 * - round-trip：parse -> serialize -> parse 无损
 * - tokenRangeAtCaret：光标定位、逗号归左侧 token、非整数/越界/空文本
 * - compiler + document 全流程：加权逗号 token 作为单 token 贯穿编译
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  splitPromptTokens,
  parsePromptToken,
  serializePromptToken,
  tokenRangeAtCaret,
  joinPromptTokens,
} from "../static/prompt-tokenizer.js";
import { splitTokens, compileGenerationPrompts, parsePromptToken as compilerParse, serializePromptToken as compilerSerialize } from "../static/prompt-compiler.js";
import { reconcileTargetText, createEmpty, serializeTarget } from "../static/prompt-document.js";

// 比较时忽略 raw/strength（raw 会因 canonical 序列化而可能不同；strength 仅为 weight 别名）。
const core = (o) => ({ tag: o.tag, weight: o.weight, weighted: o.weighted, relation: o.relation, brackets: o.brackets });

// 11 个基础输入（不含组合 "source#1.5::hug::"）。
const BASE_INPUTS = [
  "plain tag",
  "citlali (genshin impact)",
  "1.35::blue eyes::",
  "1::rain, night::",
  ".8::tag::",
  "-1::hat::",
  "{{blue eyes}}",
  "[[simple background]]",
  "source#hug",
  "target#hug",
  "mutual#hug",
];

// ---- splitPromptTokens ----

test("splitPromptTokens preserves commas inside weight wrappers (Python parity)", () => {
  assert.deepEqual(splitPromptTokens("1::rain, night::"), ["1::rain, night::"]);
  assert.deepEqual(splitPromptTokens(".8::tag::"), [".8::tag::"]);
  assert.deepEqual(splitPromptTokens("-1::hat::"), ["-1::hat::"]);
  assert.deepEqual(splitPromptTokens("{{blue eyes}}"), ["{{blue eyes}}"]);
  assert.deepEqual(splitPromptTokens("[[simple background]]"), ["[[simple background]]"]);
  assert.deepEqual(splitPromptTokens("source#hug"), ["source#hug"]);
  assert.deepEqual(splitPromptTokens("target#hug"), ["target#hug"]);
  assert.deepEqual(splitPromptTokens("mutual#hug"), ["mutual#hug"]);
  assert.deepEqual(splitPromptTokens("1.5::rain, night::, bedroom"), ["1.5::rain, night::", "bedroom"]);
  assert.deepEqual(splitPromptTokens("-1::hat::, 1girl"), ["-1::hat::", "1girl"]);
});

test("splitPromptTokens on joined input returns all 11 tokens in order", () => {
  assert.deepEqual(splitPromptTokens(BASE_INPUTS.join(", ")), BASE_INPUTS);
});

test("splitPromptTokens drops empty tokens and handles empty input", () => {
  assert.deepEqual(splitPromptTokens("a, , b"), ["a", "b"]);
  assert.deepEqual(splitPromptTokens(""), []);
  assert.deepEqual(splitPromptTokens(null), []);
  assert.deepEqual(splitPromptTokens(undefined), []);
});

// ---- parsePromptToken ----

test("parsePromptToken parses weight, negative weight, relation, brackets", () => {
  assert.deepEqual(core(parsePromptToken("1.35::blue eyes::")), { tag: "blue eyes", weight: 1.35, weighted: true, relation: null, brackets: 0 });
  assert.deepEqual(core(parsePromptToken("1::rain, night::")), { tag: "rain, night", weight: 1, weighted: true, relation: null, brackets: 0 });
  assert.deepEqual(core(parsePromptToken(".8::tag::")), { tag: "tag", weight: 0.8, weighted: true, relation: null, brackets: 0 });
  assert.deepEqual(core(parsePromptToken("-1::hat::")), { tag: "hat", weight: -1, weighted: true, relation: null, brackets: 0 });
  assert.deepEqual(core(parsePromptToken("{{blue eyes}}")), { tag: "blue eyes", weight: 1, weighted: false, relation: null, brackets: 2 });
  assert.deepEqual(core(parsePromptToken("[[simple background]]")), { tag: "simple background", weight: 1, weighted: false, relation: null, brackets: -2 });
  assert.deepEqual(core(parsePromptToken("source#hug")), { tag: "hug", weight: 1, weighted: false, relation: "source", brackets: 0 });
  assert.deepEqual(core(parsePromptToken("target#hug")), { tag: "hug", weight: 1, weighted: false, relation: "target", brackets: 0 });
  assert.deepEqual(core(parsePromptToken("mutual#hug")), { tag: "hug", weight: 1, weighted: false, relation: "mutual", brackets: 0 });
  assert.deepEqual(core(parsePromptToken("source#1.5::hug::")), { tag: "hug", weight: 1.5, weighted: true, relation: "source", brackets: 0 });
});

test("parsePromptToken parses plain tags and strength alias equals weight", () => {
  assert.deepEqual(core(parsePromptToken("plain tag")), { tag: "plain tag", weight: 1, weighted: false, relation: null, brackets: 0 });
  assert.deepEqual(core(parsePromptToken("citlali (genshin impact)")), { tag: "citlali (genshin impact)", weight: 1, weighted: false, relation: null, brackets: 0 });
  const p = parsePromptToken("1.35::blue eyes::");
  assert.equal(p.strength, p.weight);
  assert.equal(p.raw, "1.35::blue eyes::");
});

// ---- serializePromptToken ----

test("serializePromptToken emits canonical NovelAI syntax", () => {
  assert.equal(serializePromptToken({ tag: "blue eyes", weight: 1.35 }), "1.35::blue eyes::");
  assert.equal(serializePromptToken({ tag: "rain, night", weight: 1 }), "rain, night");
  assert.equal(serializePromptToken({ tag: "tag", weight: 0.8 }), "0.8::tag::");
  assert.equal(serializePromptToken({ tag: "hat", weight: -1 }), "-1::hat::");
  assert.equal(serializePromptToken({ tag: "blue eyes", brackets: 2 }), "{{blue eyes}}");
  assert.equal(serializePromptToken({ tag: "simple background", brackets: -2 }), "[[simple background]]");
  assert.equal(serializePromptToken({ tag: "hug", relation: "source" }), "source#hug");
  assert.equal(serializePromptToken({ tag: "hug", relation: "source", weight: 1.5 }), "source#1.5::hug::");
});

test("serializePromptToken uses strength alias and rejects empty/invalid entries", () => {
  assert.equal(serializePromptToken({ tag: "blue eyes", strength: 1.2 }), "1.2::blue eyes::");
  assert.equal(serializePromptToken({ tag: "" }), "");
  assert.equal(serializePromptToken(null), "");
  assert.equal(serializePromptToken({ tag: "x", relation: "not-a-relation" }), "x", "invalid relation ignored");
});

// ---- round-trip ----

test("round-trip parse -> serialize -> parse is lossless for weighted tokens", () => {
  for (const x of ["1.35::blue eyes::", ".8::tag::", "-1::hat::", "source#1.5::hug::"]) {
    const p1 = parsePromptToken(x);
    const p2 = parsePromptToken(serializePromptToken(p1));
    assert.deepEqual(core(p2), core(p1), `round-trip failed for ${x}`);
  }
  // weight === 1 掉包裹（匹配 Python format_entry：strength == 1.0 不写包裹）
  assert.equal(serializePromptToken(parsePromptToken("1::rain, night::")), "rain, night");
  assert.equal(parsePromptToken(serializePromptToken(parsePromptToken("1::rain, night::"))).weight, 1);
});

test("round-trip preserves brackets and relations", () => {
  for (const x of ["{{blue eyes}}", "[[simple background]]", "source#hug", "mutual#hug"]) {
    assert.equal(serializePromptToken(parsePromptToken(x)), x);
  }
});

// ---- tokenRangeAtCaret ----

test("tokenRangeAtCaret locates the token at the caret; comma belongs to left token", () => {
  const text = "1.5::rain, night::, bedroom";
  const inside = tokenRangeAtCaret(text, 10);
  assert.ok(inside);
  assert.equal(inside.index, 0);
  assert.equal(inside.parsed.weight, 1.5);
  assert.equal(inside.parsed.tag, "rain, night");
  const bedroom = tokenRangeAtCaret(text, 22);
  assert.ok(bedroom);
  assert.equal(bedroom.index, 1);
  assert.equal(bedroom.token, "bedroom");
  const comma = tokenRangeAtCaret(text, 18);
  assert.ok(comma);
  assert.equal(comma.index, 0, "caret on comma belongs to left token");
  assert.equal(comma.token, "1.5::rain, night::");
  const end = tokenRangeAtCaret(text, text.length);
  assert.ok(end, "caret at text.length returns a token");
  assert.equal(end.index, 1);
  assert.equal(end.token, "bedroom");
});

test("tokenRangeAtCaret handles non-integer caret, out-of-range caret, and empty text", () => {
  assert.equal(tokenRangeAtCaret("", 0), null);
  assert.equal(tokenRangeAtCaret("", 5), null);
  // 非有限整数 -> 按 text.length 处理，落在最后一个 token
  const nonInt = tokenRangeAtCaret("a, b", 1.5);
  assert.ok(nonInt);
  assert.equal(nonInt.token, "b");
  // 负整数无对应 token -> null
  assert.equal(tokenRangeAtCaret("a, b", -3), null);
});

// ---- compiler + document full flow ----

test("compiler + document full flow preserves weighted comma token as one token", () => {
  assert.equal(splitTokens("1.5::rain, night::").length, 1);
  const doc = reconcileTargetText(createEmpty(), "base", "1.5::rain, night::", new Map());
  const text = serializeTarget(doc, "base");
  assert.equal(text, "1.5::rain, night::");
  assert.equal(splitPromptTokens(text).length, 1);
  const effective = compileGenerationPrompts(text, "", "nai-diffusion-5-full", {}).effectivePositive;
  assert.ok(splitPromptTokens(effective).includes("1.5::rain, night::"), "wrapped comma token survives compile as one token");
  assert.ok(effective.startsWith("1.5::rain, night::"), "wrapped token leads effective positive");
});

test("compiler re-exports parsePromptToken/serializePromptToken from the shared codec", () => {
  assert.deepEqual(core(compilerParse("1.35::blue eyes::")), { tag: "blue eyes", weight: 1.35, weighted: true, relation: null, brackets: 0 });
  assert.equal(compilerSerialize({ tag: "blue eyes", weight: 1.35 }), "1.35::blue eyes::");
});

test("joinPromptTokens joins trimmed non-empty tokens", () => {
  assert.equal(joinPromptTokens([" a ", "b", "", " c "]), "a, b, c");
  assert.equal(joinPromptTokens([]), "");
});

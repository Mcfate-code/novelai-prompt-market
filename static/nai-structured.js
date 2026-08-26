/**
 * 结构化多角色 Prompt 的纯解析 / 恢复 helper。
 *
 * 该模块为纯函数（无 DOM / 无全局状态），供 static/app.js 与 Node 测试共用，
 * 避免在 app.js 里另写一套造成“第二份权威状态”。
 *
 * 结构化 display 行格式（与 /api/export 的 structured 输出同构）：
 *   Base: ...
 *   Character 1: ...
 *   Character 1 UC: ...
 *   Global UC: ...
 *
 * 运行方式: node --test tests/test_nai_structured.mjs
 */

// 从多行 display 中取 Base 行内容（去掉 "Base: " 前缀）；无则返回 null。
// 绝不把整段多行 display 交给识别器 —— 避免把 Character N:/Global UC: 行当作 Base 标签解析。
export function structuredBaseLine(display) {
  const line = String(display || "").split("\n").find((l) => /^Base:\s*/.test(l));
  return line == null ? null : line.replace(/^Base:\s*/, "");
}

// 从多行 display 中取 Global UC 行内容（去掉 "Global UC: " 前缀）；无则返回 null。
export function structuredGlobalUcLine(display) {
  const line = String(display || "").split("\n").find((l) => /^Global UC:\s*/.test(l));
  return line == null ? null : line.replace(/^Global UC:\s*/, "");
}

// P0：把被保存的结构化 display（Base: / Character N: / Character N UC: / Global UC: / Free text:）
// 一次性解析拆分为 { basePrompt, globalUc, characters }，供图库/旧快照恢复时「分发字段」，
// 绝不把整段混合串写回 #nai-prompt（P0 结构化边界）。
//   - basePrompt = Base 行 + Free text 行（与 [base, free_text].join(", ") 语义一致，避免丢 free text）。
//   - globalUc = Global UC 行；无该行时回退 rawNegative。
//   - characters 从 Character N / Character N UC 行解析（position 置 null；调用方若持有
//     characterPrompts 可用其 position 覆盖）。
// 普通 flat / 单角色（无 Base: 行）返回 null，保持普通文本恢复行为。
export function parseStructuredRawPrompt(rawPrompt, rawNegative = "") {
  const display = String(rawPrompt || "");
  const baseLine = structuredBaseLine(display);
  if (baseLine == null) return null;
  const globalUcLine = structuredGlobalUcLine(display);
  const globalUc = globalUcLine != null ? globalUcLine : String(rawNegative || "");
  const freeTextLine = display.split("\n").find((l) => /^Free text:\s*/.test(l));
  const freeText = freeTextLine == null ? "" : freeTextLine.replace(/^Free text:\s*/, "").trim();
  const basePrompt = [baseLine, freeText].filter((p) => p && p.trim()).join(", ");
  const characters = [];
  const charUcRe = /^Character\s+(\d+)\s+UC:\s*(.*)$/;
  const charRe = /^Character\s+(\d+):\s*(.*)$/;
  for (const line of display.split("\n")) {
    const uc = line.match(charUcRe);
    if (uc) {
      const i = Number(uc[1]) - 1;
      while (characters.length <= i) characters.push({ prompt: "", negative_prompt: "", position: null });
      characters[i].negative_prompt = uc[2].trim();
      continue;
    }
    const c = line.match(charRe);
    if (c) {
      const i = Number(c[1]) - 1;
      while (characters.length <= i) characters.push({ prompt: "", negative_prompt: "", position: null });
      characters[i].prompt = c[2].trim();
    }
  }
  return { basePrompt, globalUc, characters };
}

// 供浏览器 <script> 标签使用时挂到 window；Node 测试环境下跳过。
if (typeof window !== "undefined") {
  window.NaiStructured = {
    structuredBaseLine,
    structuredGlobalUcLine,
    parseStructuredRawPrompt,
  };
}

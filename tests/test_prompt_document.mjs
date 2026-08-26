import assert from "node:assert/strict";
import test from "node:test";
import {
  addCharacter, addTag, createEmpty, getTargetEntries, normalize, parseTargetText,
  reconcileTargetText, removeCharacter, removeTag, renameCharacter, serializeTarget,
  updateEntry,
} from "../static/prompt-document.js";

const known = new Map([
  ["blue eyes", "blue eyes"],
  ["citlali (genshin impact)", "citlali (genshin impact)"],
  ["1girl", "1girl"],
]);

test("empty document exposes schema v2 targets and entry contract", () => {
  const doc = createEmpty();
  assert.equal(doc.schema_version, 2);
  assert.deepEqual(getTargetEntries(doc, "base"), []);
  assert.deepEqual(getTargetEntries(doc, "global_uc"), []);
  assert.deepEqual(getTargetEntries(doc, "char:0"), []);
  assert.deepEqual(getTargetEntries(doc, "char:0:uc"), []);
});

test("base, character, character UC and global UC round-trip weights and metadata", () => {
  let doc = createEmpty();
  doc = addTag(doc, "base", { tag: "blue eyes", weight: 1.35, section: "appearance", custom: false, source: "catalog" }, "appearance");
  doc = addTag(doc, "char:0", "1girl", "character");
  doc = addTag(doc, "char:0:uc", { tag: "blue eyes", weight: 0.8 }, "other");
  doc = addTag(doc, "global_uc", "citlali (genshin impact)", "other");
  assert.equal(serializeTarget(doc, "base"), "1.35::blue eyes::");
  assert.equal(serializeTarget(doc, "char:0"), "1girl");
  assert.equal(serializeTarget(doc, "char:0:uc"), "0.8::blue eyes::");
  assert.equal(serializeTarget(doc, "global_uc"), "citlali (genshin impact)");
});

test("P0: parentheses character tag survives reconciliation round-trip", () => {
  const doc = reconcileTargetText(createEmpty(), "base", "citlali (genshin impact)", known);
  assert.equal(serializeTarget(doc, "base"), "citlali (genshin impact)");
  assert.equal(getTargetEntries(doc, "base")[0].tag, "citlali (genshin impact)");
});

test("P0: weighted existing entry is updated rather than replaced", () => {
  let doc = addTag(createEmpty(), "base", { tag: "blue eyes", weight: 1, section: "appearance", source: "catalog" }, "appearance");
  const id = getTargetEntries(doc, "base")[0].id;
  doc = reconcileTargetText(doc, "base", "1.35::blue eyes::", known);
  assert.equal(getTargetEntries(doc, "base")[0].id, id);
  assert.equal(getTargetEntries(doc, "base")[0].weight, 1.35);
  assert.equal(getTargetEntries(doc, "base")[0].section, "appearance");
});

test("P0: weighted parenthesized character tag parses as one canonical entry", () => {
  assert.deepEqual(parseTargetText("1.3::citlali (genshin impact)::", known), [{ tag: "citlali (genshin impact)", weight: 1.3, weighted: true }]);
});

test("unknown plain text is preserved when catalog knowledge is unavailable", () => {
  assert.deepEqual(parseTargetText("a user's free prose", new Map()), [{ tag: "a user's free prose", weight: 1, weighted: false }]);
  const doc = reconcileTargetText(createEmpty(), "base", "a user's free prose", new Map());
  assert.equal(serializeTarget(doc, "base"), "a user's free prose");
});

test("empty knownTags preserves existing catalog metadata instead of clearing or reclassifying", () => {
  let doc = addTag(createEmpty(), "base", { tag: "blue eyes", source: "catalog", custom: false }, "appearance");
  doc = reconcileTargetText(doc, "base", "1.2::blue eyes::", new Map());
  const entry = getTargetEntries(doc, "base")[0];
  assert.equal(entry.tag, "blue eyes");
  assert.equal(entry.weight, 1.2);
  assert.equal(entry.source, "catalog");
  assert.equal(entry.custom, false);
});

test("snapshot-compatible normalization accepts legacy arrays and v2 sections", () => {
  const doc = normalize({ base_prompt: [{ tag: "blue eyes", strength: 1.2, section: "appearance" }], characters: [{ name: "Citlali", prompt: [{ tag: "1girl" }], uc: [{ tag: "blue eyes" }] }], global_uc: [{ tag: "citlali (genshin impact)" }], free_text: "中文", free_text_en: "English", use_free_text_en: true });
  assert.equal(doc.schema_version, 2);
  assert.equal(serializeTarget(doc, "base"), "1.2::blue eyes::");
  assert.equal(serializeTarget(doc, "char:0"), "1girl");
  assert.equal(serializeTarget(doc, "char:0:uc"), "blue eyes");
  assert.equal(serializeTarget(doc, "global_uc"), "citlali (genshin impact)");
  assert.equal(doc.use_free_text_en, true);
});

test("schema v2 envelope accepts legacy base, prompt, uc and global arrays", () => {
  const doc = normalize({ schema_version: 2, base_prompt: [{ tag: "blue eyes" }], characters: [{ prompt: [{ tag: "citlali (genshin impact)" }], uc: [{ tag: "blue eyes", weight: 0.8 }] }], global_uc: [{ tag: "1girl" }] });
  assert.equal(serializeTarget(doc, "base"), "blue eyes");
  assert.equal(serializeTarget(doc, "char:0"), "citlali (genshin impact)");
  assert.equal(serializeTarget(doc, "char:0:uc"), "0.8::blue eyes::");
  assert.equal(serializeTarget(doc, "global_uc"), "1girl");
});

test("character and entry mutations preserve a valid document", () => {
  let doc = addCharacter(createEmpty(), { name: "Second" });
  doc = renameCharacter(doc, 1, "Renamed");
  doc = addTag(doc, "char:1", "1girl", "character");
  const id = getTargetEntries(doc, "char:1")[0].id;
  doc = updateEntry(doc, "char:1", id, { weight: 1.2, section: "appearance" });
  assert.equal(getTargetEntries(doc, "char:1")[0].section, "appearance");
  doc = removeTag(doc, "char:1", id);
  doc = removeCharacter(doc, 1);
  assert.equal(doc.characters.length, 1);
  assert.equal(doc.characters[0].name, "Character 1");
});

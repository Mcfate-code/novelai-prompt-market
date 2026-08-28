import assert from "node:assert/strict";
import test from "node:test";
import { buildPosePlans } from "../pose-variation.js";
import { applyPoseVariation, createEmpty, getTargetEntries, normalize } from "../prompt-document.js";

test("builds six different compatible plans for a two-person batch", () => {
  const plans = buildPosePlans({ count: 6, participantCount: 2, seed: "qa-seed" });
  assert.equal(plans.length, 6);
  assert.equal(new Set(plans.map((plan) => plan.fingerprint)).size, 6);
  assert.ok(plans.every((plan) => plan.participantCount === 2 && plan.adultOnly));
  assert.ok(plans.every((plan) => plan.relations.every((row) => row.source !== row.target)));
});

test("supports six participants without hard-coding a two-person relation", () => {
  const plans = buildPosePlans({ count: 1, participantCount: 6, seed: 7 });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].relations.length, 6);
  assert.deepEqual(plans[0].relations.map((row) => [row.source, row.target]), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0]]);
});

test("applying a new plan replaces generated pose tags and relations atomically", () => {
  let doc = normalize({ ...createEmpty(), characters: [
    { name: "A", prompt_sections: { action: [{ tag: "doggystyle", source: "pose_variation" }] } },
    { name: "B", prompt_sections: {} },
  ], assistant_context: { interactions: [{ id: "old", actor: 0, target: 1, action: "sex", source: "pose_variation" }] } });
  doc = applyPoseVariation(doc, {
    plan: { id: "missionary", label: "正面", participantCount: 2, baseTags: ["missionary"], relations: [{ source: 0, target: 1, action: "sex", relation: "mutual" }] },
    replaceTags: ["doggystyle"],
  });
  assert.equal(getTargetEntries(doc, "base").some((entry) => entry.tag === "doggystyle"), false);
  assert.equal(getTargetEntries(doc, "base").some((entry) => entry.tag === "missionary"), false, "姿势不再写入 Base");
  assert.equal(getTargetEntries(doc, "char:0").some((entry) => entry.tag === "missionary"), true, "角色 1 的动作写入角色卡");
  assert.equal(getTargetEntries(doc, "char:1").some((entry) => entry.tag === "missionary"), true, "角色 2 的动作写入角色卡");
  assert.equal(doc.assistant_context.interactions.length, 1);
  assert.equal(doc.assistant_context.interactions[0].source, "pose_variation");
  assert.equal(doc.assistant_context.interactions[0].action, "sex");
  assert.equal(getTargetEntries(doc, "char:0").some((entry) => entry.tag === "sex"), false);
  assert.equal(getTargetEntries(doc, "char:1").some((entry) => entry.tag === "sex"), false);
});

test("换姿势时自动把旧 Base 姿势 / 状态归类到角色卡，并保留镜头构图", () => {
  let doc = normalize({ ...createEmpty(), characters: [{}, {}], sections: {
    action: [{ tag: "kissing", source: "scene_activity" }],
    expression: [{ tag: "blush" }],
    composition: [{ tag: "lying on back" }, { tag: "full body" }],
  } });
  doc = applyPoseVariation(doc, {
    plan: { id: "standing", participantCount: 2, baseTags: ["standing"], camera: ["from behind"], roleTags: [["standing"], ["standing"]], relations: [] },
  });
  assert.deepEqual(getTargetEntries(doc, "base").map((entry) => entry.tag), ["full body", "from behind"]);
  assert.deepEqual(new Set(getTargetEntries(doc, "char:0").map((entry) => entry.tag)), new Set(["kissing", "blush", "lying on back", "standing"]));
  assert.deepEqual(new Set(getTargetEntries(doc, "char:1").map((entry) => entry.tag)), new Set(["kissing", "blush", "lying on back", "standing"]));
  assert.ok(getTargetEntries(doc, "char:0").every((entry) => entry.section === "action" || entry.section === "expression"));
});

test("Base 中的服装 / 角色状态也按角色卡分区迁移", () => {
  const doc = normalize({ ...createEmpty(), characters: [{}, {}], sections: {
    clothing: [{ tag: "nude" }],
    appearance: [{ tag: "sweat" }],
    expression: [{ tag: "ahegao" }],
  } });
  const migrated = normalize(doc);
  // applyPoseVariation 是用户可见的迁移触发点，同时验证目标 section 不混成 action。
  const result = applyPoseVariation(migrated, { plan: { id: "standing", participantCount: 2, baseTags: ["standing"], roleTags: [[], []], relations: [] } });
  for (const target of ["char:0", "char:1"]) {
    const entries = getTargetEntries(result, target);
    assert.equal(entries.find((entry) => entry.tag === "nude")?.section, "clothing");
    assert.equal(entries.find((entry) => entry.tag === "sweat")?.section, "appearance");
    assert.equal(entries.find((entry) => entry.tag === "ahegao")?.section, "expression");
  }
});

test("Base 旧互动条目带关系时只迁移到对应角色", () => {
  const doc = normalize({ ...createEmpty(), characters: [{}, {}], sections: {
    action: [{ tag: "touching", relation: "source", interaction_id: "old-interaction" }],
  }, assistant_context: { interactions: [{ id: "old-interaction", actor: 0, target: 1, action: "touching", relation: "directional" }] } });
  const result = applyPoseVariation(doc, { plan: { id: "solo", participantCount: 2, baseTags: [], roleTags: [[], []], relations: [] } });
  assert.equal(getTargetEntries(result, "char:0").some((entry) => entry.tag === "touching"), true);
  assert.equal(getTargetEntries(result, "char:1").some((entry) => entry.tag === "touching"), false);
});

test("被替换的旧 Base 姿势迁移后不会与新姿势叠加", () => {
  const doc = normalize({ ...createEmpty(), characters: [{}, {}], sections: { composition: [{ tag: "missionary" }] } });
  const result = applyPoseVariation(doc, {
    plan: { id: "doggystyle", participantCount: 2, baseTags: ["doggystyle"], roleTags: [["doggystyle"], ["doggystyle"]], relations: [] },
    replaceTags: ["missionary", "doggystyle"],
  });
  assert.equal(getTargetEntries(result, "base").some((entry) => entry.tag === "missionary"), false);
  assert.equal(getTargetEntries(result, "char:0").some((entry) => entry.tag === "missionary"), false);
  assert.equal(getTargetEntries(result, "char:1").some((entry) => entry.tag === "missionary"), false);
});

test("explicit non-generic pose actions retain source/target metadata", () => {
  const doc = applyPoseVariation(normalize({ characters: [{}, {}] }), {
    plan: {
      id: "custom-touch", participantCount: 2, baseTags: ["standing"],
      relations: [{ source: 0, target: 1, action: "touching", relation: "directional" }],
    },
  });
  const source = getTargetEntries(doc, "char:0").find((entry) => entry.tag === "touching");
  const target = getTargetEntries(doc, "char:1").find((entry) => entry.tag === "touching");
  assert.equal(source?.relation, "source");
  assert.equal(target?.relation, "target");
});

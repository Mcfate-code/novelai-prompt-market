import assert from "node:assert/strict";
import test from "node:test";
import { addCharacter, addTag, createEmpty, getTargetEntries } from "../static/prompt-document.js";
import {
  MAX_WEIGHT, MIN_WEIGHT, STATUS_SYMBOLS, VisualBuilder, adjustWeight, aggregateStatus,
  buildAddTagAction, buildRemoveTagAction, buildSetWeightAction, completionForSlots,
  formatWeight, inspectorSelectedEntries, mappedSlotIds, nodeStatus, recommendationGroups,
  semanticCards, slotMapForTarget, targetLabel, workspaceForTarget,
} from "../static/visual-builder.js";

const TREE = {
  base: { id: "base", children: [
    { id: "base_style", label: "Style", section: "style", children: [] },
    { id: "base_composition", label: "Composition", section: "composition", children: [] },
    { id: "base_environment", label: "Environment", section: "scene", children: [
      { id: "env_indoor", label: "Indoor", section: "scene", children: [] },
      { id: "env_outdoor", label: "Outdoor", section: "scene", children: [] },
    ] },
    { id: "base_lighting", label: "Lighting", section: "scene", children: [] },
    { id: "base_time_weather", label: "Time / Weather", section: "scene", children: [] },
    { id: "base_objects", label: "Objects", section: "scene", children: [] },
  ] },
  character: { id: "character", children: [
    { id: "char_identity", label: "Identity", section: "character", children: [] },
    { id: "char_appearance", label: "Appearance", section: "appearance", children: [
      { id: "char_hair", label: "Hair", section: "appearance", children: [] },
      { id: "char_eyes", label: "Eyes", section: "appearance", children: [] },
      { id: "char_face", label: "Face", section: "appearance", children: [] },
      { id: "char_body", label: "Body", section: "appearance", children: [] },
    ] },
    { id: "char_clothing", label: "Clothing", section: "clothing", children: [
      { id: "char_clothing_accessory", label: "Accessory", section: "clothing", children: [] },
    ] },
    { id: "char_expression", label: "Expression", section: "expression", children: [] },
    { id: "char_pose", label: "Pose", section: "action", children: [] },
    { id: "char_action", label: "Action", section: "action", children: [] },
  ] },
};
const CHAR_SLOTS = [
  { node_id: "char_identity", status: "filled", evidence_tags: ["Furina"] },
  { node_id: "char_hair", status: "filled", evidence_tags: ["long_hair"] },
  { node_id: "char_eyes", status: "partial", evidence_tags: ["blue eyes"] },
  { node_id: "char_face", status: "empty", evidence_tags: [] },
  { node_id: "char_body", status: "empty", evidence_tags: [] },
  { node_id: "char_clothing", status: "filled", evidence_tags: ["white dress"] },
  { node_id: "char_clothing_accessory", status: "empty", evidence_tags: [] },
  { node_id: "char_expression", status: "empty", evidence_tags: [] },
  { node_id: "char_pose", status: "empty", evidence_tags: [] },
  { node_id: "char_action", status: "empty", evidence_tags: [] },
];
const STATE = { base_slots: [{ node_id: "quality", status: "filled_by_auto_preset", evidence_tags: [] }], character_slots: [[], CHAR_SLOTS] };
const response = (json, ok = true, status = 200) => ({ ok, status, json: async () => json, text: async () => ok ? "" : String(json) });
function bridgeFor(doc, getTarget, dispatched = []) { return { getDocument: () => doc, getActiveTarget: getTarget, setActiveTarget: () => { throw new Error("Visual must not own target"); }, subscribe: () => () => {}, dispatch: (action) => dispatched.push(action) }; }

test("semantic symbols and aggregate status follow Phase D rules", () => {
  assert.deepEqual(STATUS_SYMBOLS, { filled: "✓", filled_by_auto_preset: "✓", partial: "◐", empty: "○" });
  assert.equal(aggregateStatus(["filled", "filled_by_auto_preset"]), "filled");
  assert.equal(aggregateStatus(["filled", "empty"]), "partial");
  assert.equal(aggregateStatus(["partial", "empty"]), "partial");
  assert.equal(aggregateStatus(["empty", "empty"]), "empty");
  const appearance = semanticCards(TREE, "char:1").find((node) => node.id === "char_appearance");
  const slots = slotMapForTarget(STATE, "char:1");
  assert.deepEqual(mappedSlotIds(appearance, slots), ["char_hair", "char_eyes", "char_face", "char_body"]);
  assert.equal(nodeStatus(appearance, slots), "partial");
  const clothing = semanticCards(TREE, "char:1").find((node) => node.id === "char_clothing");
  assert.equal(clothing.children[0].id, "char_clothing_outfit");
  assert.deepEqual(mappedSlotIds(clothing.children[0], slots), ["char_clothing"]);
});

test("completion count is target-local and partial is not complete", () => {
  const polluted = { ...STATE, character_slots: [[], [...CHAR_SLOTS, { node_id: "base_style", status: "filled", evidence_tags: ["anime"] }]] };
  assert.deepEqual(completionForSlots([...slotMapForTarget(polluted, "char:1").values()]), { complete: 3, partial: 1, total: 10 });
  assert.deepEqual(completionForSlots([...slotMapForTarget(STATE, "base").values()]), { complete: 1, partial: 0, total: 1 });
});

test("Appearance drills to Eyes and builds Character 2 breadcrumb path", () => {
  const doc = addCharacter(createEmpty(), { name: "Furina" });
  const builder = new VisualBuilder({ bridge: bridgeFor(doc, () => "char:1") });
  builder.view.tree = TREE; builder.view.semanticState = STATE; builder.view.target = "char:1";
  assert.equal(builder.drillTo("char_appearance"), true);
  assert.deepEqual(builder.view.path.map((node) => node.label), ["Appearance"]);
  assert.equal(builder.drillTo("char_eyes"), true);
  assert.deepEqual([targetLabel(doc, "char:1"), ...builder.view.path.map((node) => node.label)], ["Character 2 · Furina", "Appearance", "Eyes"]);
});

test("Eyes selected evidence excludes Hair despite shared appearance section", () => {
  let doc = addCharacter(createEmpty(), { name: "Furina" });
  doc = addTag(doc, "char:1", "long hair", "appearance");
  doc = addTag(doc, "char:1", "blue_eyes", "appearance");
  const eyes = CHAR_SLOTS.find((slot) => slot.node_id === "char_eyes");
  assert.deepEqual(inspectorSelectedEntries(getTargetEntries(doc, "char:1"), eyes).map((entry) => entry.tag), ["blue_eyes"]);
});

test("current-node recommendations remain separate from next-step groups", () => {
  const groups = recommendationGroups({ recommendations: [{ tag: "green eyes", slot: "char_eyes" }, { tag: "smile", slot: "char_expression" }], next_steps: [{ node_id: "char_expression", label: "Expression", recommendations: [{ tag: "smile" }] }] }, "char_eyes", [{ tag: "blue eyes" }]);
  assert.deepEqual(groups.current.map((item) => item.tag), ["green eyes"]);
  assert.deepEqual(groups.nextSteps.map((item) => item.node_id), ["char_expression"]);
});

test("Quality is display-only, auto preset, and has no seeded masterpiece fallback", () => {
  const quality = semanticCards(TREE, "base").find((node) => node.id === "quality");
  assert.equal(quality.displayOnly, true);
  assert.equal("seedTags" in quality, false);
  assert.equal(nodeStatus(quality, slotMapForTarget(STATE, "base")), "filled");
  assert.deepEqual(recommendationGroups({}, "quality").current, []);
});

test("semantic failure exposes retry state and retry reloads tree/state", async () => {
  const root = { innerHTML: "", addEventListener() {}, removeEventListener() {} };
  const builder = new VisualBuilder({ root, bridge: bridgeFor(createEmpty(), () => "base"), fetchImpl: async () => response("boom", false, 500) });
  await builder.refreshSemantic();
  assert.equal(builder.view.status, "error"); assert.match(root.innerHTML, /语义目录加载失败/); assert.match(root.innerHTML, /Retry/);
});

test("stale semantic response cannot overwrite the current target", async () => {
  let target = "base"; let resolveBase;
  const pending = new Promise((resolve) => { resolveBase = resolve; });
  const builder = new VisualBuilder({ bridge: bridgeFor(addCharacter(createEmpty(), {}), () => target), fetchImpl: async (_url, options) => JSON.parse(options.body).active_target === "base" ? pending : response({ base_slots: [], character_slots: [[], CHAR_SLOTS] }) });
  const first = builder.refreshSemantic(); target = "char:1"; const second = builder.refreshSemantic();
  await second; resolveBase(response({ base_slots: [{ node_id: "old" }], character_slots: [] })); await first;
  assert.equal(builder.view.target, "char:1"); assert.deepEqual(builder.view.semanticState.character_slots[1], CHAR_SLOTS);
});

test("target switch resets old path/Inspector data before new state arrives", () => {
  let target = "base"; const builder = new VisualBuilder({ bridge: bridgeFor(addCharacter(createEmpty(), {}), () => target) });
  builder.view.path = [{ id: "old" }]; builder.view.selectedNodeId = "old"; builder.view.recommendationData = { recommendations: [{ tag: "old" }] };
  target = "char:1"; builder.resetForTarget(target);
  assert.deepEqual(builder.view.path, []); assert.equal(builder.view.selectedNodeId, ""); assert.equal(builder.view.recommendationData, null); assert.equal(builder.view.target, "char:1");
});

test("add destination label and exact active target are visible/authoritative", () => {
  const dispatched = []; const doc = addCharacter(createEmpty(), { name: "Furina" });
  const builder = new VisualBuilder({ bridge: bridgeFor(doc, () => "char:1", dispatched) });
  assert.equal(targetLabel(doc, "char:1"), "Character 2 · Furina");
  assert.equal(builder.addTag("smile", "expression"), true);
  assert.deepEqual(dispatched[0], buildAddTagAction("smile", "char:1", "expression"));
});

test("weight minus/input/plus clamp to 0.10-2.00, format two decimals, and remove dispatches", () => {
  assert.equal(formatWeight(1), "1.00"); assert.equal(adjustWeight(.1, -.05), MIN_WEIGHT); assert.equal(adjustWeight(2, .05), MAX_WEIGHT);
  const dispatched = []; const builder = new VisualBuilder({ bridge: bridgeFor(createEmpty(), () => "base", dispatched) });
  builder.handleClick({ target: { closest: () => ({ dataset: { action: "weight-dec", target: "base", entryId: "e", weight: "0.10" } }) } });
  builder.commitWeightInput({ value: "9", dataset: { target: "base", entryId: "e" } });
  builder.handleClick({ target: { closest: () => ({ dataset: { action: "weight-inc", target: "base", entryId: "e", weight: "1.00" } }) } });
  builder.removeChip("base", "e");
  assert.deepEqual(dispatched, [buildSetWeightAction("base", "e", .1), buildSetWeightAction("base", "e", 2), buildSetWeightAction("base", "e", 1.05), buildRemoveTagAction("base", "e")]);
});

test("PromptBridge is sole target owner", () => {
  const builder = new VisualBuilder({ bridge: bridgeFor(createEmpty(), () => "base") });
  assert.equal(builder._workspaceOverride, undefined); assert.equal(builder.selectWorkspace, undefined); assert.equal("activeTarget" in builder, false); assert.equal(workspaceForTarget("global_uc"), "");
});

test("V3 recommendation payload includes structured_state and generation_config", async () => {
  const captured = []; const doc = addCharacter(createEmpty(), { name: "Furina" });
  const builder = new VisualBuilder({ bridge: bridgeFor(doc, () => "char:1"), getGenerationConfig: () => ({ positiveTier: "light" }), fetchImpl: async (_url, options) => { captured.push(JSON.parse(options.body)); return response({ recommendations: [], next_steps: [] }); } });
  builder.view.tree = TREE; builder.view.semanticState = STATE; builder.view.target = "char:1";
  await builder.selectNode("char_eyes");
  assert.equal(captured[0].structured_state, doc); assert.deepEqual(captured[0].generation_config, { positiveTier: "light" }); assert.equal(captured[0].active_target, "char:1"); assert.equal(captured[0].node_id, "char_eyes");
});

test("recommendation race validates selected node", async () => {
  let resolveEyes; const pending = new Promise((resolve) => { resolveEyes = resolve; }); const doc = addCharacter(createEmpty(), {});
  const builder = new VisualBuilder({ bridge: bridgeFor(doc, () => "char:1"), fetchImpl: async (_url, options) => JSON.parse(options.body).node_id === "char_eyes" ? pending : response({ recommendations: [{ tag: "short hair", slot: "char_hair" }] }) });
  builder.view.tree = TREE; builder.view.semanticState = STATE; builder.view.target = "char:1";
  const eyes = builder.selectNode("char_eyes"); const hair = builder.selectNode("char_hair"); await hair; resolveEyes(response({ recommendations: [{ tag: "green eyes", slot: "char_eyes" }] })); await eyes;
  assert.equal(builder.view.selectedNodeId, "char_hair"); assert.equal(builder.view.recommendationData.recommendations[0].tag, "short hair");
});

test("semantic response also validates selected node", async () => {
  let resolveState; const pending = new Promise((resolve) => { resolveState = resolve; });
  const builder = new VisualBuilder({ bridge: bridgeFor(createEmpty(), () => "base"), fetchImpl: async () => pending });
  builder.view.tree = TREE; const request = builder.refreshSemantic(); builder.view.selectedNodeId = "base_style";
  resolveState(response({ base_slots: [{ node_id: "quality", status: "empty", evidence_tags: [] }], character_slots: [] }));
  assert.equal(await request, false); assert.equal(builder.view.semanticState, null);
});

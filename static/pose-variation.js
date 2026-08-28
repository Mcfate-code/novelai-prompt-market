"use strict";

// 工作台「换姿势」的纯数据层。它只负责挑选成人、自愿场景下的姿势计划，
// 不持有 PromptDocument，也不触碰 DOM；真正写入状态由 prompt-document.js 完成。

const POSE_LIBRARY = Object.freeze([
  { id: "missionary", label: "正面", minParticipants: 2, baseTags: ["missionary", "lying on back"], roleTags: [["missionary", "lying on back"], ["missionary", "on top"]], interaction: "sex", camera: ["full body"] },
  { id: "doggystyle", label: "后方", minParticipants: 2, baseTags: ["doggystyle", "on all fours"], roleTags: [["doggystyle", "on all fours"], ["doggystyle", "standing"]], interaction: "sex", camera: ["from behind", "full body"] },
  { id: "girl_on_top", label: "上位", minParticipants: 2, baseTags: ["girl on top", "cowgirl position"], roleTags: [["girl on top", "cowgirl position"], ["lying on back"]], interaction: "sex", camera: ["full body"] },
  { id: "reverse_cowgirl", label: "背向上位", minParticipants: 2, baseTags: ["reverse cowgirl position", "girl on top"], roleTags: [["reverse cowgirl position", "girl on top"], ["lying on back"]], interaction: "sex", camera: ["from behind"] },
  { id: "spooning", label: "侧卧", minParticipants: 2, baseTags: ["spooning", "on side"], roleTags: [["spooning", "on side"], ["spooning", "on side"]], interaction: "sex", camera: ["on side"] },
  { id: "standing", label: "站立", minParticipants: 2, baseTags: ["standing sex", "standing missionary"], roleTags: [["standing sex", "standing"], ["standing sex", "standing"]], interaction: "sex", camera: ["full body"] },
  { id: "mating_press", label: "压制式", minParticipants: 2, baseTags: ["mating press", "knees to chest"], roleTags: [["knees to chest"], ["mating press"]], interaction: "sex", camera: ["from above"] },
  { id: "prone_bone", label: "俯卧", minParticipants: 2, baseTags: ["prone bone", "lying on stomach"], roleTags: [["prone bone", "lying on stomach"], ["prone bone", "standing"]], interaction: "sex", camera: ["from behind"] },
  { id: "upright_straddle", label: "坐姿跨骑", minParticipants: 2, baseTags: ["upright straddle", "sitting"], roleTags: [["upright straddle", "sitting"], ["lying on back"]], interaction: "sex", camera: ["full body"] },
  { id: "knees_to_chest", label: "屈膝", minParticipants: 2, baseTags: ["knees to chest", "legs up"], roleTags: [["knees to chest", "legs up"], ["kneeling"]], interaction: "sex", camera: ["from above"] },
  { id: "solo_kneeling", label: "跪姿", minParticipants: 1, maxParticipants: 1, baseTags: ["kneeling"], roleTags: [["kneeling"]], camera: ["full body"] },
  { id: "solo_all_fours", label: "四肢着地", minParticipants: 1, maxParticipants: 1, baseTags: ["on all fours"], roleTags: [["on all fours"]], camera: ["from behind", "full body"] },
  { id: "solo_lying", label: "躺姿", minParticipants: 1, maxParticipants: 1, baseTags: ["lying on back"], roleTags: [["lying on back"]], camera: ["full body"] },
  { id: "sixty_nine", label: "交错", minParticipants: 2, baseTags: ["69", "upright 69"], roleTags: [["69", "upright 69"], ["69", "upright 69"]], interaction: "sex", camera: ["full body"] },
]);

function hashSeed(value) {
  let h = 2166136261;
  for (const ch of String(value ?? "")) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function seededRandom(seed) {
  let value = hashSeed(seed);
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 0x100000000; };
}

function participantNumber(value, fallback = 1) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function poseFingerprint(plan) {
  const base = [...new Set([...(plan?.baseTags || []), ...(plan?.cameraTags || []), ...(plan?.camera || [])].map(String).map((v) => v.toLowerCase()).filter(Boolean))].sort();
  const roles = (plan?.roleTags || []).map((tags) => (tags || []).map(String).map((v) => v.toLowerCase()).sort().join("+")).join("|");
  const relations = (plan?.relations || []).map((row) => `${row.source}>${row.target}:${row.action || ""}:${row.relation || ""}`).sort().join("|");
  return [base.join(","), roles, relations].filter(Boolean).join(";");
}

function makeRelations(participantCount, action = "sex") {
  if (participantCount < 2) return [];
  if (participantCount === 2) return [{ source: 0, target: 1, action, relation: "mutual" }];
  // 多人不再写死成两个人：用稳定的环形关系覆盖所有角色，便于编译器和 UI 显示。
  return Array.from({ length: participantCount }, (_, source) => ({
    source, target: (source + 1) % participantCount, action, relation: "directional",
  }));
}

function normalizePlan(raw, participantCount, index = 0) {
  const plan = raw || {};
  const roleTags = Array.from({ length: participantCount }, (_, i) =>
    Array.isArray(plan.roleTags?.[i]) ? plan.roleTags[i].map(String).filter(Boolean) : []);
  const relations = (Array.isArray(plan.relations) ? plan.relations : makeRelations(participantCount, plan.interaction || "sex"))
    .map((row) => ({ source: Number(row.source), target: Number(row.target), action: String(row.action || "sex"), relation: row.relation === "mutual" ? "mutual" : "directional" }))
    .filter((row) => Number.isInteger(row.source) && Number.isInteger(row.target) && row.source >= 0 && row.target >= 0 && row.source < participantCount && row.target < participantCount && row.source !== row.target);
  const cameraTags = [...new Set([...(plan.cameraTags || []), ...(plan.camera || [])].map(String).filter(Boolean))];
  const poseBaseTags = [...new Set((plan.baseTags || []).map(String).filter((tag) => !cameraTags.some((camera) => camera.toLocaleLowerCase() === tag.toLocaleLowerCase())))];
  const hasExplicitRoleTags = Array.isArray(plan.roleTags) && plan.roleTags.some((tags) => Array.isArray(tags) && tags.length);
  const normalizedRoleTags = roleTags.map((tags) => (tags.length ? tags : (hasExplicitRoleTags ? [] : poseBaseTags.slice())));
  const normalized = {
    id: String(plan.id || `pose-${index + 1}`),
    label: String(plan.label || plan.id || `姿势 ${index + 1}`),
    participantCount,
    // baseTags 保留完整姿势指纹的兼容形态；cameraTags 决定哪些词真正留在 Base。
    baseTags: [...new Set([...(plan.baseTags || []), ...cameraTags].map(String).filter(Boolean))],
    cameraTags,
    roleTags: normalizedRoleTags,
    relations,
    positions: Array.isArray(plan.positions) ? plan.positions.slice(0, participantCount).map((p) => ({ x: Number(p?.x), y: Number(p?.y) })) : defaultPositions(participantCount),
    adultOnly: true,
  };
  normalized.fingerprint = String(plan.fingerprint || poseFingerprint(normalized));
  return normalized;
}

function defaultPositions(count) {
  if (count <= 1) return [{ x: 0.5, y: 0.55 }];
  return Array.from({ length: count }, (_, index) => {
    const columns = Math.min(count, 3);
    const row = Math.floor(index / columns);
    const col = index % columns;
    return { x: (col + 1) / (columns + 1), y: 0.55 + row * 0.12 };
  });
}

export function compatiblePoses(participantCount = 1, library = POSE_LIBRARY) {
  const count = participantNumber(participantCount);
  return (library || []).filter((pose) => count >= Number(pose.minParticipants || 1) && (pose.maxParticipants == null || count <= Number(pose.maxParticipants)));
}

export function buildPosePlans({ count = 1, participantCount = 1, seed = Date.now(), recentFingerprints = [], library = POSE_LIBRARY } = {}) {
  const total = Math.max(1, Math.min(6, Number.parseInt(String(count), 10) || 1));
  const people = Math.max(1, Math.min(6, participantNumber(participantCount)));
  const recent = new Set((recentFingerprints || []).map(String));
  const random = seededRandom(seed);
  const pool = compatiblePoses(people, library).slice().sort(() => random() - 0.5);
  const preferred = pool.filter((pose) => !recent.has(poseFingerprint({ ...pose, relations: makeRelations(people, pose.interaction || "sex") })));
  const ordered = [...preferred, ...pool.filter((pose) => !preferred.includes(pose))];
  const plans = [];
  const used = new Set();
  for (const pose of ordered) {
    if (plans.length >= total) break;
    const plan = normalizePlan({ ...pose, relations: makeRelations(people, pose.interaction || "sex") }, people, plans.length);
    if (used.has(plan.fingerprint)) continue;
    used.add(plan.fingerprint);
    plans.push(plan);
  }
  return plans;
}

export { POSE_LIBRARY, makeRelations, normalizePlan, participantNumber, poseFingerprint, defaultPositions };

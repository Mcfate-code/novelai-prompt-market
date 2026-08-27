"""Offline Prompt Prior 构建脚本（BUILD-TIME ONLY，运行时不依赖本模块）。

从公开 Danbooru 元数据构建 data/offline_prompt_prior.sqlite：
  - NPMI 标签共现（`prior_tag_assoc`）
  - 语义槽位候选（`prior_slot_tag`）
  - 上下文关联（`prior_context_tag`）
  - 槽位转移先验（`prior_slot_transition`）
  - 标签 → 语义节点映射（`tag_semantic_node`）
  - 来源清单（`prior_manifest`）

数据源（按优先级）：
  1. HuggingFace ``nyanko-devs/danbooru2026`` metadata/posts.parquet（MIT，列投影
     id/rating/score/fav_count/tag_string_general/tag_string_character/tag_string_copyright）。
  2. 本地 ``data/tags.sqlite``（无逐帖共现，只能生成「合成」关联：同语义节点 ~0.3、
     父子节点 ~0.15，post_count 作为质量代理）。

无 tag 黑名单：年龄含糊标签（young/loli/shota 等）照常参与；adult/general 分割
仅由 Danbooru rating（q/e=adult，g/s=general）决定（本地回退用 curated NSFW taxonomy
作为代理）。安全过滤由运行时 serving 层负责，不在此构建层做任何硬排除。

运行：``python prompt/prior_build.py [--output PATH] [--no-hf]``
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
# 允许 `python prompt/prior_build.py` 直接运行时 import prompt.sections。
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

DATA_DIR = BASE_DIR / "data"
NAV_PATH = BASE_DIR / "config" / "prompt_navigation.json"
NSFW_TAXONOMY_PATH = DATA_DIR / "nsfw_taxonomy.json"
TAGS_DB_PATH = DATA_DIR / "tags.sqlite"
DEFAULT_OUT = DATA_DIR / "offline_prompt_prior.sqlite"

PIPELINE_VERSION = "1.0.0"
HF_DATASET = "nyanko-devs/danbooru2026"
HF_CONFIG = "metadata"
HF_REL_FILE = "metadata/posts.parquet"
HF_LICENSE = "MIT"
HF_COLUMNS = (
    "id", "rating", "score", "fav_count",
    "tag_string_general", "tag_string_character", "tag_string_copyright",
)

ADULT_RATINGS = frozenset({"q", "e"})
GENERAL_RATINGS = frozenset({"g", "s"})

# 输出规模控制（spec：每个 tag 保留 Top 32-64）。
TOP_ASSOC_PER_TAG = 48
CONTEXT_TOP_PER_TAG = 32
SLOT_NODE_PAIR_CAP = 250       # 每个语义节点参与配对的最大 tag 数（本地回退）
MIN_DOC_FREQ = 10              # HF 路径：标签文档频次下限
MAX_TAGS_PER_POOL = 20000      # HF 路径：每个 rating 池最多保留的标签数
MIN_PAIR_SUPPORT = 3           # HF 路径：共现对最低支持度

# 本地回退的合成 NPMI。
SYN_NPMI_SAME_NODE = 0.30
SYN_NPMI_PARENT_CHILD = 0.15
SYN_NPMI_SAME_NSFW_CATEGORY = 0.30

# 分区 → 语义节点（用于 category 0 General 标签，按 sections.py _RULES 关键字归类后映射）。
SECTION_TO_NODE = {
    "character": "char_identity",
    "appearance": "char_appearance",
    "clothing": "char_clothing",
    "expression": "char_expression",
    "action": "char_action",
    "composition": "base_composition",
    "scene": "base_environment",
    "style": "base_style",
    "quality": "base_style",
    "other": None,  # 无法归类则不落节点（不含黑名单语义，纯无法归类）
}

# 年龄含糊标签 → appearance 节点（INCLUSION，非黑名单；user 明确要求其参与学习）。
AGE_APPEARANCE_TAGS = frozenset({
    "young", "loli", "shota", "child", "children", "toddler", "baby", "infant",
    "adolescent", "teen", "teenager", "kid", "boy", "girl", "1boy", "1girl",
})

# NSFW taxonomy 分类 → 语义节点（仅本地回退为成人标签补节点）。
NSFW_CATEGORY_NODE = {
    "nsfw_undress": "char_clothing",
    "nsfw_lingerie": "char_clothing",
    "nsfw_breasts": "char_appearance",
    "nsfw_female": "char_appearance",
    "nsfw_male": "char_appearance",
    "nsfw_butt": "char_appearance",
    "nsfw_face": "char_expression",
    "nsfw_foreplay": "char_action",
    "nsfw_masturbation": "char_action",
    "nsfw_oral": "char_action",
    "nsfw_nonpenetrative": "char_action",
    "nsfw_sex": "char_action",
    "nsfw_positions": "char_action",
    "nsfw_group": "char_action",
    "nsfw_yuri": "char_action",
    "nsfw_yaoi": "char_action",
    "nsfw_futanari": "char_action",
    "nsfw_cum": "char_action",
    "nsfw_after": "char_action",
    "nsfw_toys": "char_clothing",
    "nsfw_bdsm": "char_action",
    "nsfw_camera": "base_composition",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS prior_manifest (
    source TEXT NOT NULL,
    revision TEXT,
    license TEXT,
    retrieved_at TEXT,
    schema_hash TEXT,
    pipeline_version TEXT,
    tag_count INTEGER,
    pair_count INTEGER
);
CREATE TABLE IF NOT EXISTS prior_tag_assoc (
    tag_a TEXT NOT NULL,
    tag_b TEXT NOT NULL,
    npmi REAL NOT NULL DEFAULT 0,
    support INTEGER NOT NULL DEFAULT 0,
    quality_weight REAL NOT NULL DEFAULT 0,
    is_adult INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tag_a, tag_b, is_adult),
    CHECK (tag_a < tag_b)
);
CREATE INDEX IF NOT EXISTS idx_prior_tag_assoc_a ON prior_tag_assoc(tag_a, is_adult);
CREATE INDEX IF NOT EXISTS idx_prior_tag_assoc_b ON prior_tag_assoc(tag_b, is_adult);
CREATE TABLE IF NOT EXISTS prior_slot_tag (
    semantic_node_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 0,
    is_adult INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (semantic_node_id, tag, is_adult)
);
CREATE INDEX IF NOT EXISTS idx_prior_slot_node ON prior_slot_tag(semantic_node_id, is_adult);
CREATE TABLE IF NOT EXISTS prior_context_tag (
    context_tag TEXT NOT NULL,
    related_tag TEXT NOT NULL,
    npmi REAL NOT NULL DEFAULT 0,
    is_adult INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prior_context ON prior_context_tag(context_tag, is_adult);
CREATE TABLE IF NOT EXISTS prior_slot_transition (
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    frequency INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (from_node_id, to_node_id)
);
CREATE TABLE IF NOT EXISTS tag_semantic_node (
    tag TEXT PRIMARY KEY,
    semantic_node_id TEXT,
    confidence REAL,
    source TEXT
);
CREATE INDEX IF NOT EXISTS idx_tag_semantic_node ON tag_semantic_node(semantic_node_id);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _schema_hash() -> str:
    return hashlib.sha256(SCHEMA.encode("utf-8")).hexdigest()[:16]


def norm_tag(tag: str) -> str:
    """统一为 prompt 空格形式（与 prompt/prior.py 的 _norm 一致）。"""
    value = (tag or "").strip().lower().replace("_", " ")
    value = re.sub(r"[^\w\s]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())


def _section_for_tag(tag: str) -> str:
    """用 sections.py 的 _RULES 关键字给 General 标签归类（无 DB 依赖）。"""
    from prompt.sections import _RULES

    normalized = norm_tag(tag)
    for section, keywords in _RULES:
        if any(keyword in normalized for keyword in keywords):
            return section
    return "other"


# --------------------------------------------------------------------------- #
# 数据加载
# --------------------------------------------------------------------------- #
def load_navigation(path: Path) -> dict:
    """读取 prompt_navigation.json，产出：
      seed_to_node: {tag -> node_id}（所有节点 seed_tags）
      tree_children: {node_id -> [child node, ...]}（保持文件顺序）
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    seed_to_node: dict[str, str] = {}
    tree_children: dict[str, list[dict]] = {}

    def walk(node: dict) -> None:
        node_id = str(node.get("id") or "").strip()
        for seed in node.get("seed_tags") or []:
            key = norm_tag(seed)
            if key:
                seed_to_node.setdefault(key, node_id)
        children = node.get("children") or []
        if node_id:
            tree_children[node_id] = list(children)
        for child in children:
            if isinstance(child, dict):
                walk(child)

    for root in data.values():
        if isinstance(root, dict) and root.get("id"):
            walk(root)
    return {"seed_to_node": seed_to_node, "tree_children": tree_children}


def load_vocabulary(db_path: Path) -> dict[str, dict]:
    """加载本地 tags 词表：{normalized_prompt_tag: {category, post_count, prompt_tag}}。"""
    vocab: dict[str, dict] = {}
    if not db_path.is_file():
        return vocab
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT prompt_tag, category, post_count FROM tags"
        ).fetchall()
        for row in rows:
            prompt = (row["prompt_tag"] or "").strip()
            key = norm_tag(prompt)
            if not key:
                continue
            vocab[key] = {
                "prompt_tag": prompt,
                "category": int(row["category"] or 0),
                "post_count": int(row["post_count"] or 0),
            }
    finally:
        conn.close()
    return vocab


def load_adult_set(nsfw_path: Path) -> set[str]:
    """curated NSFW taxonomy 标签集合（明确排除 loli/shota 等，见 taxonomy 的 _note）。"""
    adult: set[str] = set()
    if not nsfw_path.is_file():
        return adult
    data = json.loads(nsfw_path.read_text(encoding="utf-8"))
    for category in data.get("categories") or []:
        for tag in category.get("tags") or []:
            key = norm_tag(tag)
            if key:
                adult.add(key)
    return adult


def _nsfw_category_of_tag(nsfw_path: Path, tag: str) -> str | None:
    """返回成人标签所属的 nsfw taxonomy 分类 id（用于成人标签分组建对）。"""
    if not nsfw_path.is_file():
        return None
    data = json.loads(nsfw_path.read_text(encoding="utf-8"))
    key = norm_tag(tag)
    for category in data.get("categories") or []:
        if key in {norm_tag(t) for t in category.get("tags") or []}:
            return str(category.get("id") or "")
    return None


# --------------------------------------------------------------------------- #
# 语义节点映射
# --------------------------------------------------------------------------- #
def build_semantic_node_map(
    vocab: dict[str, dict],
    nav_seed_to_node: dict[str, str],
    adult_set: set[str],
    nsfw_path: Path,
) -> dict[str, tuple[str, float, str]]:
    """tag -> (semantic_node_id, confidence, source)。

    优先级：导航 seed > Danbooru category(4/3 身份、1 风格) > 年龄含糊→appearance >
            NSFW taxonomy 分类 > sections._RULES 关键字。
    无节点返回 None（纯「无法归类」，绝非黑名单排除）。
    """
    mapping: dict[str, tuple[str, float, str]] = {}
    for tag in vocab:
        # 1) 导航 seed_tags（精确种子）
        node_id = nav_seed_to_node.get(tag)
        if node_id:
            mapping[tag] = (node_id, 1.0, "nav_seed")
            continue
        category = vocab[tag]["category"]
        # 2) Character(4) / Copyright(3) → 身份节点
        if category in (4, 3):
            mapping[tag] = ("char_identity", 0.9, "category")
            continue
        # 3) Artist(1) → 风格节点
        if category == 1:
            mapping[tag] = ("base_style", 0.7, "category")
            continue
        # 4) 年龄含糊 → appearance（参与学习，非排除）
        if tag in AGE_APPEARANCE_TAGS:
            mapping[tag] = ("char_appearance", 0.7, "sections_rules")
            continue
        # 5) 成人标签 → nsfw 分类节点
        if tag in adult_set:
            nsfw_cat = _nsfw_category_of_tag(nsfw_path, tag)
            node_id = NSFW_CATEGORY_NODE.get(nsfw_cat or "", "char_action")
            mapping[tag] = (node_id, 0.8, "nsfw_taxonomy")
            continue
        # 6) General(0) → sections._RULES 关键字
        if category == 0:
            section = _section_for_tag(tag)
            node_id = SECTION_TO_NODE.get(section)
            if node_id:
                mapping[tag] = (node_id, 0.6, "sections_rules")
    return mapping


# --------------------------------------------------------------------------- #
# HF 数据源（可选；不可用/失败则回退本地）
# --------------------------------------------------------------------------- #
def _post_quality(score, fav_count) -> float:
    """log(1+max(0,score)) * (1+log(1+fav_count))，缺失字段按 0 处理。"""
    s = max(0.0, float(score or 0) or 0.0)
    f = max(0.0, float(fav_count or 0) or 0.0)
    return math.log1p(s) * (1.0 + math.log1p(f))


def try_load_hf_posts(vocab: set[str]) -> list[dict] | None:
    """尽力加载 HF posts 并投影为 [(rating, tags_tuple, quality)]；失败返回 None。

    所有重型依赖（datasets / pyarrow / huggingface_hub）均在此函数内惰性导入，
    保证 ``import prompt.prior_build`` 本身零重型依赖。
    """
    records: list[dict] = []

    def consume(rows) -> list[dict] | None:
        out: list[dict] = []
        for row in rows:
            rating = str(row.get("rating") or "").strip().lower()
            tags: set[str] = set()
            for key in ("tag_string_general", "tag_string_character", "tag_string_copyright"):
                raw = row.get(key)
                if isinstance(raw, str) and raw.strip():
                    for piece in raw.split():
                        t = norm_tag(piece)
                        if t and t in vocab:
                            tags.add(t)
            if not tags:
                continue
            out.append({
                "rating": rating,
                "tags": tuple(sorted(tags)),
                "quality": _post_quality(row.get("score"), row.get("fav_count")),
            })
        return out

    # 策略 1：datasets 库
    try:
        from datasets import load_dataset  # noqa: PLC0415

        ds = load_dataset(HF_DATASET, HF_CONFIG, split="train")
        records = consume(ds)
        if records:
            return records
    except Exception:
        records = []

    # 策略 2：huggingface_hub 直接下载 parquet + pyarrow 读列
    try:
        from huggingface_hub import hf_hub_download  # noqa: PLC0415

        local = hf_hub_download(HF_DATASET, HF_REL_FILE, repo_type="dataset")
        import pyarrow.parquet as pq  # noqa: PLC0415

        table = pq.read_table(local, columns=list(HF_COLUMNS))
        records = consume(table.to_pylist())
        if records:
            return records
    except Exception:
        records = []

    return records if records else None


def _select_pool_tags(doc_freq: Counter, min_freq: int, max_tags: int) -> list[str]:
    selected = [t for t, c in doc_freq.items() if c >= min_freq]
    selected.sort(key=lambda t: (-doc_freq[t], t))
    return selected[:max_tags]


def compute_npmi_assoc(records: list[dict], vocab: set[str]) -> list[dict]:
    """从帖子记录计算 NPMI 关联，按 rating 池分割 adult/general。

    NPMI(a,b) = ln(P(a,b) / (P(a)P(b))) / (-ln P(a,b))，截断到 [-1, 1]。
    quality_weight = 共现帖子的质量权重之和。
    """
    adult_df: Counter = Counter()
    general_df: Counter = Counter()
    n_adult = n_general = 0
    for rec in records:
        is_adult = rec["rating"] in ADULT_RATINGS
        df = adult_df if is_adult else general_df
        if is_adult:
            n_adult += 1
        else:
            n_general += 1
        for t in set(rec["tags"]):
            df[t] += 1

    adult_tags = _select_pool_tags(adult_df, MIN_DOC_FREQ, MAX_TAGS_PER_POOL)
    general_tags = _select_pool_tags(general_df, MIN_DOC_FREQ, MAX_TAGS_PER_POOL)

    def count_pairs(tag_set: set[str], is_adult: bool) -> tuple[Counter, Counter]:
        pair_freq: Counter = Counter()
        quality: Counter = Counter()
        for rec in records:
            if (rec["rating"] in ADULT_RATINGS) != is_adult:
                continue
            tags = sorted({t for t in rec["tags"] if t in tag_set})
            if len(tags) < 2:
                continue
            for i in range(len(tags)):
                for j in range(i + 1, len(tags)):
                    pair = (tags[i], tags[j])
                    pair_freq[pair] += 1
                    quality[pair] += rec["quality"]
        return pair_freq, quality

    assoc: list[dict] = []
    for tag_set, is_adult, df, n_pool in (
        (set(adult_tags), True, adult_df, n_adult),
        (set(general_tags), False, general_df, n_general),
    ):
        if n_pool <= 0 or len(tag_set) < 2:
            continue
        pair_freq, quality = count_pairs(tag_set, is_adult)
        for (a, b), support in pair_freq.items():
            if support < MIN_PAIR_SUPPORT:
                continue
            pa = df[a] / n_pool
            pb = df[b] / n_pool
            pab = support / n_pool
            npmi = math.log(pab / (pa * pb)) / (-math.log(pab))
            npmi = max(-1.0, min(1.0, npmi))
            assoc.append({
                "tag_a": a, "tag_b": b,
                "npmi": npmi, "support": support,
                "quality_weight": round(quality.get((a, b), 0.0), 4),
                "is_adult": int(is_adult),
            })
    return assoc


# --------------------------------------------------------------------------- #
# 本地回退：合成关联
# --------------------------------------------------------------------------- #
def synthetic_associations(
    node_map: dict[str, tuple[str, float, str]],
    vocab: dict[str, dict],
    adult_set: set[str],
    nav_tree_children: dict[str, list[dict]],
    nsfw_path: Path,
) -> list[dict]:
    """本地回退：无逐帖共现时生成合成关联（同节点 ~0.3、父子节点 ~0.15）。"""
    # tag -> node
    tag_node: dict[str, str] = {t: m[0] for t, m in node_map.items()}
    # node -> [tags]（general 与 adult 分开）
    node_general: dict[str, list[str]] = {}
    node_adult: dict[str, list[str]] = {}
    for tag, (node_id, _conf, _src) in node_map.items():
        if tag in adult_set:
            node_adult.setdefault(node_id, []).append(tag)
        else:
            node_general.setdefault(node_id, []).append(tag)

    assoc: list[dict] = []
    seen: set[tuple] = set()

    def add(a: str, b: str, npmi: float, is_adult: int) -> None:
        if a == b:
            return
        lo, hi = (a, b) if a < b else (b, a)
        key = (lo, hi, is_adult)
        if key in seen:
            return
        seen.add(key)
        post_count = lambda t: vocab.get(t, {}).get("post_count", 0)  # noqa: E731
        assoc.append({
            "tag_a": lo, "tag_b": hi,
            "npmi": npmi,
            "support": min(post_count(lo), post_count(hi)),
            "quality_weight": float(min(post_count(lo), post_count(hi))),
            "is_adult": is_adult,
        })

    def cap_tags(tags: list[str]) -> list[str]:
        tags = sorted(set(tags), key=lambda t: (-vocab.get(t, {}).get("post_count", 0), t))
        return tags[:SLOT_NODE_PAIR_CAP]

    # general：同节点两两 + 父子节点
    for node_id, tags in node_general.items():
        top = cap_tags(tags)
        for i in range(len(top)):
            for j in range(i + 1, len(top)):
                add(top[i], top[j], SYN_NPMI_SAME_NODE, 0)
    for parent_id, children in nav_tree_children.items():
        parent_tags = cap_tags(node_general.get(parent_id, []))
        for child in children:
            child_id = str(child.get("id") or "")
            child_tags = cap_tags(node_general.get(child_id, []))
            for p in parent_tags:
                for c in child_tags:
                    add(p, c, SYN_NPMI_PARENT_CHILD, 0)

    # adult：同 nsfw taxonomy 分类两两（is_adult=1）
    cat_tags: dict[str, list[str]] = {}
    for tag in adult_set:
        if tag not in vocab:
            continue
        cat = _nsfw_category_of_tag(nsfw_path, tag) or "nsfw_sex"
        cat_tags.setdefault(cat, []).append(tag)
    for cat, tags in cat_tags.items():
        top = cap_tags(tags)
        for i in range(len(top)):
            for j in range(i + 1, len(top)):
                add(top[i], top[j], SYN_NPMI_SAME_NSFW_CATEGORY, 1)

    return assoc


def _cap_top_per_tag(assoc: list[dict], limit: int) -> list[dict]:
    """每个 tag 只保留 NPMI 最高的 limit 个伙伴（确定性 tiebreak）。"""
    by_tag: dict[str, list[dict]] = {}
    for item in assoc:
        by_tag.setdefault(item["tag_a"], []).append(item)
        by_tag.setdefault(item["tag_b"], []).append(item)
    kept: set[tuple] = set()
    for tag, items in by_tag.items():
        items.sort(key=lambda d: (-d["npmi"], -d["quality_weight"], d["tag_b"], d["tag_a"]))
        for d in items[:limit]:
            kept.add((d["tag_a"], d["tag_b"], d["is_adult"]))
    return [d for d in assoc if (d["tag_a"], d["tag_b"], d["is_adult"]) in kept]


def build_slot_tags(node_map, vocab, adult_set) -> list[dict]:
    rows = []
    for tag, (node_id, _conf, _src) in node_map.items():
        rows.append({
            "semantic_node_id": node_id,
            "tag": tag,
            "frequency": vocab.get(tag, {}).get("post_count", 0),
            "is_adult": int(tag in adult_set),
        })
    return rows


def build_transitions(node_map, nav_tree_children) -> list[dict]:
    node_tag_count: Counter = Counter()
    for _tag, (node_id, _conf, _src) in node_map.items():
        node_tag_count[node_id] += 1

    transitions: dict[tuple[str, str], int] = {}
    for parent_id, children in nav_tree_children.items():
        for child in children:
            child_id = str(child.get("id") or "")
            transitions[(parent_id, child_id)] = max(
                node_tag_count.get(child_id, 0), 1
            )
        ordered = [str(c.get("id") or "") for c in children]
        for i in range(len(ordered) - 1):
            transitions[(ordered[i], ordered[i + 1])] = max(
                node_tag_count.get(ordered[i + 1], 0), 1
            )
    return [
        {"from_node_id": f, "to_node_id": t, "frequency": freq}
        for (f, t), freq in sorted(transitions.items())
    ]


# --------------------------------------------------------------------------- #
# 写库
# --------------------------------------------------------------------------- #
def write_prior(
    output: Path,
    source: str,
    revision: str,
    license_: str,
    assoc: list[dict],
    slot_tags: list[dict],
    context_rows: list[dict],
    transitions: list[dict],
    node_map: dict[str, tuple[str, float, str]],
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(".sqlite.tmp")
    if tmp.exists():
        tmp.unlink()
    conn = sqlite3.connect(str(tmp))
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA)

        conn.executemany(
            "INSERT OR REPLACE INTO prior_tag_assoc "
            "(tag_a, tag_b, npmi, support, quality_weight, is_adult) "
            "VALUES (:tag_a, :tag_b, :npmi, :support, :quality_weight, :is_adult)",
            assoc,
        )
        conn.executemany(
            "INSERT OR REPLACE INTO prior_slot_tag "
            "(semantic_node_id, tag, frequency, is_adult) "
            "VALUES (:semantic_node_id, :tag, :frequency, :is_adult)",
            slot_tags,
        )
        conn.executemany(
            "INSERT OR REPLACE INTO prior_context_tag "
            "(context_tag, related_tag, npmi, is_adult) "
            "VALUES (:context_tag, :related_tag, :npmi, :is_adult)",
            context_rows,
        )
        conn.executemany(
            "INSERT OR REPLACE INTO prior_slot_transition "
            "(from_node_id, to_node_id, frequency) "
            "VALUES (:from_node_id, :to_node_id, :frequency)",
            transitions,
        )
        conn.executemany(
            "INSERT OR REPLACE INTO tag_semantic_node "
            "(tag, semantic_node_id, confidence, source) "
            "VALUES (:tag, :semantic_node_id, :confidence, :source)",
            [
                {"tag": tag, "semantic_node_id": node_id, "confidence": conf, "source": src}
                for tag, (node_id, conf, src) in sorted(node_map.items())
            ],
        )
        conn.execute(
            "INSERT INTO prior_manifest "
            "(source, revision, license, retrieved_at, schema_hash, pipeline_version, tag_count, pair_count) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                source, revision, license_, _now_iso(), _schema_hash(),
                PIPELINE_VERSION, len(node_map), len(assoc),
            ),
        )
        conn.commit()
    finally:
        conn.close()
    tmp.replace(output)


def build_context_rows(assoc: list[dict], limit: int) -> list[dict]:
    by_context: dict[str, list[dict]] = {}
    for d in assoc:
        by_context.setdefault(d["tag_a"], []).append(d)
        by_context.setdefault(d["tag_b"], []).append(d)
    rows: list[dict] = []
    for context, items in sorted(by_context.items()):
        items.sort(key=lambda d: (-d["npmi"], d["tag_b"], d["tag_a"]))
        for d in items[:limit]:
            related = d["tag_b"] if d["tag_a"] == context else d["tag_a"]
            rows.append({
                "context_tag": context,
                "related_tag": related,
                "npmi": d["npmi"],
                "is_adult": d["is_adult"],
            })
    return rows


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def build(
    output: Path | str = DEFAULT_OUT,
    use_hf: bool = True,
    quiet: bool = False,
    *,
    tags_db_path: Path | str = TAGS_DB_PATH,
    nav_path: Path | str = NAV_PATH,
    nsfw_path: Path | str = NSFW_TAXONOMY_PATH,
) -> dict:
    """构建离线先验库。路径参数默认为仓库数据文件，可注入合成 fixture 便于测试。"""
    output = Path(output)
    tags_db_path = Path(tags_db_path)
    nav_path = Path(nav_path)
    nsfw_path = Path(nsfw_path)
    nav = load_navigation(nav_path)
    vocab = load_vocabulary(tags_db_path)
    adult_set = load_adult_set(nsfw_path)
    node_map = build_semantic_node_map(
        vocab, nav["seed_to_node"], adult_set, nsfw_path
    )

    if not quiet:
        print(f"[prior_build] vocabulary={len(vocab)} adult={len(adult_set)} nodes={len(node_map)}")

    assoc: list[dict]
    source: str
    revision: str
    license_: str
    if use_hf:
        records = try_load_hf_posts(set(vocab))
        if records:
            assoc = _cap_top_per_tag(compute_npmi_assoc(records, set(vocab)), TOP_ASSOC_PER_TAG)
            source, revision, license_ = "offline_npmi", HF_DATASET, HF_LICENSE
            if not quiet:
                print(f"[prior_build] HF source ok: posts={len(records)} assoc={len(assoc)}")
        else:
            assoc = []
    else:
        assoc = []

    if not assoc:
        assoc = _cap_top_per_tag(
            synthetic_associations(node_map, vocab, adult_set, nav["tree_children"], nsfw_path),
            TOP_ASSOC_PER_TAG,
        )
        source, revision, license_ = "local_fallback", "tags.sqlite", "danbooru"
        if not quiet:
            print(f"[prior_build] local fallback: assoc={len(assoc)}")

    slot_tags = build_slot_tags(node_map, vocab, adult_set)
    context_rows = build_context_rows(assoc, CONTEXT_TOP_PER_TAG)
    transitions = build_transitions(node_map, nav["tree_children"])

    write_prior(
        output, source, revision, license_,
        assoc, slot_tags, context_rows, transitions, node_map,
    )
    if not quiet:
        print(
            f"[prior_build] wrote {output}: source={source} assoc={len(assoc)} "
            f"slots={len(slot_tags)} context={len(context_rows)} transitions={len(transitions)}"
        )
    return {
        "source": source,
        "assoc": len(assoc),
        "slots": len(slot_tags),
        "context": len(context_rows),
        "transitions": len(transitions),
        "tags": len(node_map),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build offline prompt prior SQLite")
    parser.add_argument("--output", type=str, default=str(DEFAULT_OUT))
    parser.add_argument("--no-hf", action="store_true", help="skip HuggingFace, force local fallback")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    result = build(Path(args.output), use_hf=not args.no_hf, quiet=args.quiet)
    return 0 if result else 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Phase 2：成人先验安全边界（§2.2–§2.6）。

覆盖 6 个命名用例 + 集成断言，全部内存/临时 sqlite，绝不发 SiliconFlow API：

  1. explicit-rated sample + minor-like evidence → 不贡献 adult 关联（§2.3）
  2. adult 查询（safety_scope 过滤）无法返回 minor-like 候选（§2.4/§2.5）
  3. classify_tag_safety 单元：young→minor_like、loli→minor_like、
     explicit+minor→minor_like（非 adult）、normal→general、
     explicit/questionable-rated→adult（Danbooru q/e=adult、g/s=general）、
     ambiguous→age_ambiguous
  4. 集成：公共构建 + 合成 minor-like 样本 → 不生成 adult 关联；embedding scope 分配
     minor-like 得到 minor_like safety_scope（§2.6）

Danbooru rating 语义（与 prompt/prior_build.py 保持一致）：
  g/s = general（safe/sensitive），q/e = adult（questionable/explicit）。
"""
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import prompt.prior_build as prior_build  # noqa: E402
import prompt.prior_safety as prior_safety  # noqa: E402
from prompt import prior as prior_mod  # noqa: E402
from prompt.prior_schema import ensure_prior_schema  # noqa: E402
from prompt.prior_safety import classify_tag_safety, has_minor_evidence  # noqa: E402

NAV = {
    "schema_version": 1,
    "base": {
        "id": "base", "label": "Base", "section": "scene", "seed_tags": [],
        "children": [
            {"id": "base_style", "label": "Style", "section": "style",
             "seed_tags": ["masterpiece"], "children": []},
        ],
    },
    "character": {
        "id": "character", "label": "Character", "section": "character",
        "seed_tags": [],
        "children": [
            {"id": "char_identity", "label": "Identity", "section": "character",
             "seed_tags": ["solo"], "children": []},
            {"id": "char_appearance", "label": "Appearance", "section": "appearance",
             "seed_tags": ["long hair", "blue eyes"], "children": []},
        ],
    },
}


# --------------------------------------------------------------------------- #
# 3. classify_tag_safety 单元（§2.2/§2.6）
# --------------------------------------------------------------------------- #
def test_minor_like_young():
    assert classify_tag_safety("young") == "minor_like"


def test_minor_like_loli():
    assert classify_tag_safety("loli") == "minor_like"


def test_explicit_plus_minor_is_minor_like_not_adult():
    """既是 explicit 又带年龄证据 → minor_like 压过 adult（硬规则，§2.2）。"""
    assert classify_tag_safety("loli", rating="e") == "minor_like"
    assert classify_tag_safety("explicit loli", rating="q") == "minor_like"
    assert classify_tag_safety("shota", rating="e") == "minor_like"
    assert classify_tag_safety("young", meta={"explicit": True}) == "minor_like"


def test_normal_tag_is_general():
    assert classify_tag_safety("blue eyes") == "general"
    assert classify_tag_safety("solo") == "general"
    assert classify_tag_safety("girl") == "general"
    assert classify_tag_safety("1girl") == "general"


def test_explicit_rating_is_adult():
    """Danbooru rating：q/e（questionable/explicit）→ adult；g/s（safe/sensitive）→ general。"""
    # 用非成人词汇的 tag 隔离 rating 行为
    assert classify_tag_safety("beach", rating="q") == "adult"
    assert classify_tag_safety("beach", rating="e") == "adult"
    assert classify_tag_safety("beach", rating="s") == "general"  # sensitive ≠ adult
    assert classify_tag_safety("beach", rating="g") == "general"
    # 成人词汇 + explicit rating → adult
    assert classify_tag_safety("breasts", rating="e") == "adult"


def test_ambiguous_is_age_ambiguous():
    assert classify_tag_safety("small girl") == "age_ambiguous"
    assert classify_tag_safety("young woman") == "age_ambiguous"
    # age_ambiguous 永不 adult（即便 explicit）
    assert classify_tag_safety("small girl", rating="e") == "age_ambiguous"


def test_adult_vocab_fallback():
    assert classify_tag_safety("paizuri") == "adult"
    assert classify_tag_safety("creampie") == "adult"


def test_case_and_underscore_normalized():
    assert classify_tag_safety("Loli") == "minor_like"
    assert classify_tag_safety("loli_shota") == "minor_like"
    assert classify_tag_safety("YOUNG") == "minor_like"


def test_has_minor_evidence_helper():
    assert has_minor_evidence("loli")
    assert has_minor_evidence("small girl")
    assert not has_minor_evidence("breasts")
    assert not has_minor_evidence("blue eyes")


# --------------------------------------------------------------------------- #
# 1. explicit-rated sample + minor-like evidence → 不贡献 adult 关联（§2.3）
# --------------------------------------------------------------------------- #
def test_explicit_sample_with_minor_evidence_no_adult_assoc(monkeypatch):
    monkeypatch.setattr(prior_build, "MIN_DOC_FREQ", 1)
    monkeypatch.setattr(prior_build, "MIN_PAIR_SUPPORT", 1)
    monkeypatch.setattr(prior_build, "MAX_TAGS_PER_POOL", 1000)
    vocab = {"breasts", "nipples", "cum", "loli", "young", "blue eyes", "long hair"}
    records = [
        # explicit 样本但带 minor-like 证据 → 必须整体跳过 adult 作用域（§2.3）
        {"rating": "e", "tags": ("breasts", "loli", "young"), "quality": 1.0},
        # 纯成人样本 → 正常进 adult
        {"rating": "e", "tags": ("breasts", "nipples"), "quality": 1.0},
        {"rating": "e", "tags": ("nipples", "cum"), "quality": 1.0},
        {"rating": "e", "tags": ("breasts", "cum"), "quality": 1.0},
        # 一般向样本（minor-like 参与 general 学习，不被排除）
        {"rating": "g", "tags": ("blue eyes", "young"), "quality": 1.0},
        {"rating": "g", "tags": ("blue eyes", "long hair"), "quality": 1.0},
        {"rating": "g", "tags": ("young", "long hair"), "quality": 1.0},
    ]
    assoc = prior_build.compute_npmi_assoc(records, vocab)
    adult_pairs = [(a["tag_a"], a["tag_b"]) for a in assoc if a["is_adult"]]
    general_pairs = [(a["tag_a"], a["tag_b"]) for a in assoc if not a["is_adult"]]
    adult_tags = {t for pair in adult_pairs for t in pair}
    # minor-like 标签绝不进入 adult 关联（即便在 explicit 样本中与成人标签共现）
    assert "loli" not in adult_tags
    assert "young" not in adult_tags
    assert "blue eyes" not in adult_tags
    assert "long hair" not in adult_tags
    # 对照：纯成人样本仍产生 adult 关联
    assert ("breasts", "nipples") in adult_pairs
    # minor-like 仍参与 general 学习（无黑名单）
    assert ("blue eyes", "young") in general_pairs
    assert ("long hair", "young") in general_pairs


def test_build_slot_tags_never_marks_minor_as_adult():
    node_map = {
        "loli": ("char_appearance", 0.7, "sections_rules"),
        "breasts": ("char_appearance", 0.8, "nsfw_taxonomy"),
    }
    vocab = {"loli": {"post_count": 100}, "breasts": {"post_count": 200}}
    rows = prior_build.build_slot_tags(node_map, vocab, adult_set={"loli", "breasts"})
    by_tag = {r["tag"]: r["is_adult"] for r in rows}
    assert by_tag["loli"] == 0       # minor-like 即便在 adult_set 也绝不标 adult
    assert by_tag["breasts"] == 1    # 纯成人标签照常标 adult


# --------------------------------------------------------------------------- #
# 2. adult 查询（safety_scope 过滤）无法返回 minor-like 候选（§2.4/§2.5）
# --------------------------------------------------------------------------- #
def test_adult_prior_query_cannot_return_minor_like(tmp_path):
    db_path = tmp_path / "prior.sqlite"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        ensure_prior_schema(conn)
        conn.executemany(
            "INSERT OR REPLACE INTO prior_semantic_neighbor "
            "(src_tag, dst_tag, similarity, src_node, dst_node, relation_type, "
            "safety_scope, model_id, model_revision) VALUES (?,?,?,?,?,?,?,?,?)",
            [
                ("breasts", "loli", 0.90, "char_body", "char_appearance", "cross_slot",
                 "minor_like", "m", "r"),
                ("breasts", "nipples", 0.85, "char_body", "char_body", "same_slot",
                 "adult", "m", "r"),
            ],
        )
        conn.commit()

        # 数据层：minor-like 邻居的 safety_scope 是 minor_like，绝非 adult
        scope = conn.execute(
            "SELECT safety_scope FROM prior_semantic_neighbor WHERE dst_tag='loli'"
        ).fetchone()
        assert scope["safety_scope"] == "minor_like"
        assert scope["safety_scope"] != "adult"
        # 以 safety_scope='adult' 选取的成人候选绝不包含 minor-like
        adult_dsts = {r["dst_tag"] for r in conn.execute(
            "SELECT dst_tag FROM prior_semantic_neighbor WHERE safety_scope='adult'")}
        assert "loli" not in adult_dsts
        assert "nipples" in adult_dsts
    finally:
        conn.close()

    # 运行时（§2.5）：非成人查询过滤 safety_scope='adult'，minor-like 作为非成人保留
    p = prior_mod.PromptPrior(str(db_path))
    rows = p.semantic_neighbors("breasts", adult=False)
    tags = {r["tag"]: r["safety_scope"] for r in rows}
    assert "nipples" not in tags                       # adult 被过滤
    assert tags.get("loli") == "minor_like"            # minor-like 非成人，保留
    assert all(r["safety_scope"] != "adult" for r in rows)


# --------------------------------------------------------------------------- #
# 4. 集成：公共构建 + 合成 minor-like 样本不生成 adult 关联（§2.6）
# --------------------------------------------------------------------------- #
def _make_tags_db(path: Path) -> None:
    rows = [
        ("loli", "loli", 0, 500),
        ("young", "young", 0, 400),
        ("breasts", "breasts", 0, 300),
        ("nipples", "nipples", 0, 200),
        ("blue_eyes", "blue eyes", 0, 700),
        ("solo", "solo", 0, 900),
    ]
    conn = sqlite3.connect(str(path))
    conn.executescript(
        "CREATE TABLE tags (id INTEGER PRIMARY KEY, danbooru_name TEXT, prompt_tag TEXT, "
        "category INTEGER, post_count INTEGER, is_deprecated INTEGER DEFAULT 0);"
    )
    conn.executemany(
        "INSERT INTO tags (danbooru_name, prompt_tag, category, post_count) VALUES (?,?,?,?)",
        rows,
    )
    conn.commit()
    conn.close()


def _make_nsfw(path: Path) -> None:
    # 故意把 loli 放进成人 taxonomy，验证硬规则：minor-like 绝不写入 adult 作用域
    path.write_text(json.dumps({
        "categories": [
            {"id": "nsfw_breasts", "label": "胸部",
             "tags": ["loli", "breasts", "nipples"]},
        ],
    }, ensure_ascii=False), encoding="utf-8")


def _make_nav(path: Path) -> None:
    path.write_text(json.dumps(NAV, ensure_ascii=False), encoding="utf-8")


def test_public_build_synthetic_minor_like_no_adult_assoc(tmp_path):
    out = tmp_path / "prior.sqlite"
    tags_db = tmp_path / "tags.sqlite"
    nsfw = tmp_path / "nsfw.json"
    nav = tmp_path / "nav.json"
    _make_tags_db(tags_db)
    _make_nsfw(nsfw)
    _make_nav(nav)

    prior_build.build(
        out, use_hf=False, quiet=True,
        tags_db_path=tags_db, nsfw_path=nsfw, nav_path=nav,
    )

    conn = sqlite3.connect(str(out))
    conn.row_factory = sqlite3.Row
    try:
        # 成人关联（is_adult=1）绝不包含 minor-like 标签
        adult_rows = conn.execute(
            "SELECT tag_a, tag_b FROM prior_tag_assoc WHERE is_adult=1"
        ).fetchall()
        adult_tags = {t for r in adult_rows for t in (r["tag_a"], r["tag_b"])}
        assert "loli" not in adult_tags
        assert "young" not in adult_tags
        # 对照：纯成人标签对仍进入 adult 关联
        assert ("breasts", "nipples") in {(r["tag_a"], r["tag_b"]) for r in adult_rows}
        # prior_slot_tag 中 minor-like 恒 is_adult=0，纯成人恒 is_adult=1
        slot = {r["tag"]: r["is_adult"] for r in conn.execute(
            "SELECT tag, is_adult FROM prior_slot_tag")}
        assert slot.get("loli") == 0
        assert slot.get("young") == 0
        assert slot.get("breasts") == 1
        # prior_context_tag（由 assoc 派生）同样不含 minor-like 成人行
        ctx_adult = {r["related_tag"] for r in conn.execute(
            "SELECT related_tag FROM prior_context_tag WHERE is_adult=1")}
        assert "loli" not in ctx_adult and "young" not in ctx_adult
    finally:
        conn.close()


def test_embedding_scope_assignment_sets_minor_like(tmp_path):
    """embedding 构建的 safety_scope 分配：minor-like/age-ambiguous 得到自身值，绝不 adult（§2.4）。"""
    import numpy as np

    import scripts.build_embedding_prior as build

    slot_vectors = {
        "char_body": np.array([1.0, 0.0], dtype=np.float32),
        "char_appearance": np.array([0.0, 1.0], dtype=np.float32),
    }
    meta = {"taxonomy_l1": None, "category": 0, "section": None}
    vec = np.array([0.1, 0.99], dtype=np.float32)

    # 即便 tag 在 adult_set 中，minor-like 硬规则优先
    _, _, _, _, safety = build.resolve_node(
        "loli", meta, vec, slot_vectors, {}, {"loli"}, 0.35, 0.03)
    assert safety == "minor_like"
    assert safety != "adult"

    # age_ambiguous 同样
    _, _, _, _, safety = build.resolve_node(
        "small girl", meta, vec, slot_vectors, {}, {"small girl"}, 0.35, 0.03)
    assert safety == "age_ambiguous"

    # 纯成人标签 → adult；普通标签 → general
    _, _, _, _, safety = build.resolve_node(
        "breasts", meta, vec, slot_vectors, {}, {"breasts"}, 0.35, 0.03)
    assert safety == "adult"
    _, _, _, _, safety = build.resolve_node(
        "blue eyes", meta, vec, slot_vectors, {}, set(), 0.35, 0.03)
    assert safety == "general"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))

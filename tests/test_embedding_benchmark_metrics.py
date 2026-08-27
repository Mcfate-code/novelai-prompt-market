"""修正后的 embedding 近邻质量指标单元测试（§5.1/§5.2）。

仅用合成 neighbor 列表 + fixture，绝不发起真实 API 调用。验证：
- Must-Include Recall@10（真 recall，总命中/总目标）。
- Same-Slot Purity@10（relation_type ∈ {same_slot, same_parent} 占比）。
- Must-Avoid Violation Rate。
- 跨 query 宏聚合口径（而非逐条平均）。
"""
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scripts.build_embedding_prior as build  # noqa: E402


def test_must_include_recall_and_purity():
    # 2 of 4 must_include found → recall 0.5；6 of 10 same_slot/same_parent → purity 0.6
    neighbor_tags = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
    relation_types = ["same_slot", "same_slot", "same_parent", "same_parent",
                      "same_slot", "same_slot", "cross_slot", "cross_slot",
                      "cross_slot", "cross_slot"]
    must_include = ["a", "b", "x", "y"]
    must_avoid = ["z"]
    m = build.compute_neighbor_metrics(neighbor_tags, relation_types, must_include, must_avoid)
    assert m["must_include_found"] == 2
    assert m["must_include_total"] == 4
    assert m["must_include_recall_10"] == pytest.approx(0.5)
    assert m["same_slot_count"] == 6
    assert m["same_slot_total"] == 10
    assert m["same_slot_purity_10"] == pytest.approx(0.6)
    assert m["must_avoid_violation"] is False


def test_must_avoid_violation_detected():
    m = build.compute_neighbor_metrics(
        ["a", "b", "c"], ["same_slot", "cross_slot", "cross_slot"],
        ["a"], ["c"])
    assert m["must_include_recall_10"] == pytest.approx(1.0)
    assert m["must_avoid_violation"] is True


def test_empty_must_include_recall_zero():
    m = build.compute_neighbor_metrics(["a"], ["same_slot"], [], ["b"])
    assert m["must_include_total"] == 0
    assert m["must_include_recall_10"] == 0.0
    assert m["same_slot_purity_10"] == pytest.approx(1.0)


def test_aggregate_is_macro_not_per_query_average():
    # row1：1 目标命中 1 → per-query 1.0；row2：4 目标命中 1 → per-query 0.25
    # 宏口径 = 2/5 = 0.4（逐条平均 = 0.625），据此断言聚合口径正确。
    rows = [
        build.compute_neighbor_metrics(["a"], ["same_slot"], ["a"], []),
        build.compute_neighbor_metrics(
            ["a", "b", "c", "d"],
            ["cross_slot", "cross_slot", "cross_slot", "cross_slot"],
            ["a", "x", "y", "z"], []),
    ]
    agg = build.aggregate_neighbor_metrics(rows)
    assert agg["must_include_recall_10"] == pytest.approx(2 / 5)
    assert agg["same_slot_purity_10"] == pytest.approx(1 / 5)


def test_aggregate_violation_rate():
    rows = [
        build.compute_neighbor_metrics(["a"], ["same_slot"], ["a"], ["z"]),
        build.compute_neighbor_metrics(["a"], ["same_slot"], ["a"], ["a"]),
    ]
    agg = build.aggregate_neighbor_metrics(rows)
    assert agg["must_avoid_violation_rate"] == pytest.approx(0.5)


def test_compute_c_metrics_from_artifact(tmp_path):
    # 合成制品：1 个 query，2 个近邻（1 same_slot / 1 cross_slot）
    db_path = tmp_path / "prior.sqlite"
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE prior_semantic_neighbor (src_tag TEXT, dst_tag TEXT, similarity REAL, "
        "src_node TEXT, dst_node TEXT, relation_type TEXT, safety_scope TEXT, "
        "model_id TEXT, model_revision TEXT, PRIMARY KEY(src_tag, dst_tag))")
    conn.execute(
        "INSERT INTO prior_semantic_neighbor VALUES "
        "('blue eyes','red eyes',0.99,'char_eyes','char_eyes','same_slot','general','m','r')")
    conn.execute(
        "INSERT INTO prior_semantic_neighbor VALUES "
        "('blue eyes','blonde hair',0.80,'char_eyes','char_hair','cross_slot','general','m','r')")
    conn.commit()
    conn.close()

    c_entries = [{"tag": "blue eyes", "must_include": ["red eyes", "green eyes"],
                  "must_avoid": ["blonde hair"]}]
    agg = build.compute_c_metrics_from_artifact(db_path, c_entries)
    assert agg["queries_evaluated"] == 1
    assert agg["must_include_recall_10"] == pytest.approx(0.5)
    assert agg["same_slot_purity_10"] == pytest.approx(0.5)
    assert agg["must_avoid_violation_rate"] == pytest.approx(1.0)
    assert agg["C_missing_query_tags"] == 0


def test_compute_c_metrics_from_artifact_missing_tag(tmp_path):
    db_path = tmp_path / "prior2.sqlite"
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE prior_semantic_neighbor (src_tag TEXT, dst_tag TEXT, similarity REAL, "
        "src_node TEXT, dst_node TEXT, relation_type TEXT, safety_scope TEXT, "
        "model_id TEXT, model_revision TEXT, PRIMARY KEY(src_tag, dst_tag))")
    conn.commit()
    conn.close()

    c_entries = [{"tag": "not in corpus", "must_include": ["x"], "must_avoid": []}]
    agg = build.compute_c_metrics_from_artifact(db_path, c_entries)
    assert agg["queries_evaluated"] == 0
    assert agg["C_missing_query_tags"] == 1

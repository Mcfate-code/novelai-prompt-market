# Embedding Model Benchmark

- Generated: 2026-08-27T12:16:35Z
- Decision: **BAAI/bge-m3** — composite=0.7653 (0.4*zh_recall10 + 0.3*slot_top1 + 0.3*neighbor_recall10), avg_latency=0.5534s

> Semantic Neighbor 语义 = **同义/同类（alternative, same-class）**，
> 由 embedding 相似度 + 元数据节点归属推导，**不是**标签共现（co-occurrence/NPMI）。
> neighbor 指标为修正后的真实口径：Must-Include Recall@10 / Same-Slot Purity@10 /
> Must-Avoid Violation Rate（旧版 precision@10=found/10 已被移除）。

## BAAI/bge-m3
- corpus_size: 33607
- zh→en Recall@1/5/10: 0.6939 / 0.9847 / 1.0
- slot Top1 / Top3: 0.9238 / 1.0
- neighbor Must-Include Recall@10: 0.2938 | Same-Slot Purity@10: 0.8119 | must_avoid violation rate: 0.3051
- avg latency: 0.5534s | error rate: 0.0000 | requests: 16 (ok 16) | prompt tokens: 11411

## BAAI/bge-large-zh-v1.5
- corpus_size: 33607
- zh→en Recall@1/5/10: 0.6939 / 0.9745 / 0.9847
- slot Top1 / Top3: 0.8117 / 0.9013
- neighbor Must-Include Recall@10: 0.2938 | Same-Slot Purity@10: 0.8051 | must_avoid violation rate: 0.2712
- avg latency: 0.4948s | error rate: 0.0000 | requests: 16 (ok 16) | prompt tokens: 14891

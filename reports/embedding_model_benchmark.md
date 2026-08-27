# Embedding Model Benchmark

- Generated: 2026-08-27T02:50:44Z
- Decision: **BAAI/bge-m3** — composite=0.7036 (0.4*zh_recall10 + 0.3*slot_top1 + 0.3*neighbor_prec10), avg_latency=0.5534s

## BAAI/bge-m3
- corpus_size: 33607
- zh→en Recall@1/5/10: 0.6939 / 0.9847 / 1.0
- slot Top1 / Top3: 0.9238 / 1.0
- neighbor Precision@10: 0.0881 (must_avoid violation 0.3051)
- avg latency: 0.5534s | error rate: 0.0000 | requests: 16 (ok 16) | prompt tokens: 11411

## BAAI/bge-large-zh-v1.5
- corpus_size: 33607
- zh→en Recall@1/5/10: 0.6939 / 0.9745 / 0.9847
- slot Top1 / Top3: 0.8117 / 0.9013
- neighbor Precision@10: 0.0881 (must_avoid violation 0.2712)
- avg latency: 0.4948s | error rate: 0.0000 | requests: 16 (ok 16) | prompt tokens: 14891

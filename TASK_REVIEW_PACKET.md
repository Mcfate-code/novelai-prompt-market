# TASK_REVIEW_PACKET.md

> 任务：NovelAI V5 本地提示词标签超市（Prompt Builder）收尾 —— 按《收尾执行说明》完成 Stage 1–4，接入用户预置的受限标签 taxonomy。
> 位置：`F:\tags\novelai-prompt-builder\`
> 生成日期：2026-08-24

---

## 1. 任务目标

按《Workbuddy_NovelAI_PromptBuilder_收尾执行说明》把项目从 PARTIAL 收敛为可日常使用的本地 Prompt Builder。
本轮范围：**Stage 1（统一 Tag API DTO）→ Stage 2（收藏）→ Stage 3（接入受限 taxonomy）→ Stage 4（navigation 折叠）**，
达到 SUCCESS 判定线；Stage 5–17 属体验增强，不在本轮。

核心约束：数据值与工程逻辑分离——受限 taxonomy 是用户预置的现成数据，模型只负责 schema / 代码 / 校验 / UI，
不生成、不扩写、不逐条解释、不在任何文档里 dump 全量标签值。

## 2. 最终状态

**Status: SUCCESS**

Stage 1–4 全部完成并通过验收：目录字段 bug 已修、收藏持久化可用、受限 taxonomy 已程序化接入并给出 resolve 统计、
一级导航折叠（受限标签默认折叠）。38 个单元测试全绿，真实 smoke test 通过。

## 3. 输入与依据

- 《NovelAI_V5_本地提示词标签超市_规格与标签库.md》—— 实现规格。
- 《Workbuddy_NovelAI_PromptBuilder_收尾执行说明_仅工程接入版.md》—— 本轮蓝图（Stage 1–4）。
- `novelai_prompt_tag_taxonomy_seed.json`（= `data/taxonomy_seed.json`，77 类 / 2836 成员 / 2543 去重）—— 主 taxonomy。
- `adult_curated_taxonomy_seed.json`（24 分区 / 655 成员 / 583 去重）—— 受限标签 curated taxonomy（本轮新接入，位于项目上级目录）。
- `data/zh_aliases.json` / `data/zh_characters.json` —— 中文别名与角色名。
- `data/tags.sqlite`（5.2 万 tag，已含 99.4% 中文）—— 已同步完成的 canonical 词库。

## 4. 改动后的架构

```
   taxonomy_seed.json（数据分类 77 类）        adult_curated_taxonomy_seed.json（受限 24 分区）
        │  import_taxonomy                        │  import_restricted（exact_canonical → alias → normalized → unresolved）
        ▼                                         ▼
   taxonomy_map                            restricted_taxonomy_map
        │                                         │
        └──────────────┬──────────────────────────┘
                       ▼
              navigation.json（UI 一级导航，9 组折叠目录）
                       │  build_catalog
                       ▼
                  tag_catalog 表
                       │
                       ▼
        /api/catalog · /api/search · /api/favorites · /api/recent
                 （统一 DTO：tag / canonical / zh / category / post_count / favorite）
                       │
                       ▼
              原生前端 index.html / app.js（折叠目录树 + 收藏 + 分页）
```

[KEEP] FastAPI + SQLite + 原生 JS、三层数据底座（canonical / curated taxonomy / model overlay）不变。
[CHANGE] 目录源从 `tag_catalog.json`（手工）改为 `navigation.json`（一级导航 + 二级引用）。
[NEW] `restricted_taxonomy_map` 表 + `import_restricted.py` + 统一 DTO `serialize_tag`。

## 5. 实际执行过程（Stage 1–4）

### Stage 1 — 统一 Tag API DTO
- 做了什么：`db.serialize_tag()` 统一公开 DTO（tag/canonical/zh/category/post_count/favorite），
  目录 / 搜索 / 收藏 / 最近全部走同一序列化；修复 `resolve_tag` 返回旧键名导致的 4 个测试回归（改为 `tag`/`canonical`）。
- 为什么：消除 `prompt_tag` vs `tag` 双轨，不再在前端做 `t.tag || t.prompt_tag` 兼容。
- 结果：目录英文名正常、点击不再加空 tag；新增 `test_catalog_contract.py` 契约测试。

### Stage 2 — 收藏
- 做了什么：确认收藏 UI（卡片 ☆ 与购物车分离）与后端 /api/favorites 已就绪；补 `test_favorite_persistence.py`（幂等 / 取消即消失 / 重开仍在 / 与购物车分离）。
- 结果：收藏持久化可用，收藏与「加入购物车」相互独立。

### Stage 3 — 接入受限 taxonomy
- 做了什么：新增 `importer/import_restricted.py`，程序化读取 `adult_curated_taxonomy_seed.json`，
  按 `exact_canonical → exact_alias → normalized_canonical → unresolved_seed` 逐条 resolve，
  写入 `restricted_taxonomy_map`（含 status / canonical_name）；异常条目单独标记 `anomalous`。
- 为什么：curated 与 raw 分开；受限目录必须来自用户预置文件，不用 `LIKE '%kw%'` 自动构造。
- 结果统计：`categories=24, memberships=655, resolved_canonical=474, resolved_alias=0, unresolved_seed=180, duplicates=0, anomalous=1`。
  unresolved 保留原始值、不丢弃、不猜。

### Stage 4 — navigation 折叠
- 做了什么：新增 `data/navigation.json`（9 组一级导航 + 二级引用），`build_catalog` 改读 navigation.json；
  前端 `renderTree` 改为可折叠一级目录，受限标签默认折叠。
- 为什么：一级导航从 77 类扁平压到 10 个可折叠组；导航与数据分类分离，底层 taxonomy 不重写。
- 结果：`groups=10, children=107`；受限标签 30 个子目录（6 个主 taxonomy NSFW + 24 个受限分区）默认折叠。

## 6. 关键决策记录

| 决策 | 依据 | 最终动作 |
| --- | --- | --- |
| 后端统一 DTO，不做前端字段兼容 | 规格明确禁止 `t.tag \|\| t.prompt_tag` | `serialize_tag` 统一序列化，更新测试契约 |
| 受限 taxonomy 独立表 `restricted_taxonomy_map` | curated 与 raw 分开，需记录 resolve 状态 | 新增表 + 专用 importer，不塞进 taxonomy_map |
| 受限文件按 config 引用、不复制第二份 | 规格「不复制第二份数据」 | `app_settings.restricted_taxonomy_path = "../adult_curated_taxonomy_seed.json"` |
| unresolved 保留原始值展示 | 规格「不静默丢弃、不猜、不 LLM 补词」 | COALESCE(t.prompt_tag, m.seed)，可直接加入购物车 |
| 脏条目（误粘贴的中文说明）标记 anomalous 不进 UI | 不静默修改用户源文件、但不污染 UI | `_is_anomalous` 检测，DB 保留、UI 过滤、报告计数 |

## 7. 文件修改记录

| 文件 | 修改内容 |
| --- | --- |
| `db.py` | 新增 `restricted_taxonomy_map` 表；`tag_dict` → `serialize_tag` 统一 DTO（含 favorite） |
| `search.py` | `resolve_tag`/`search` 走统一 DTO + favorite 标记 |
| `app.py` | 新增 `restricted_taxonomy` 目录 kind、`_query_restricted_tags`、`_serialize_catalog_rows`；修复 recent 目录 JOIN 缺失；`ensure_seeded` 接入 `import_restricted`；catalog 返回 icon/collapsed |
| `importer/import_restricted.py` | 新增：受限 taxonomy 程序化 resolve + 统计 |
| `importer/build_catalog.py` | 改读 `navigation.json`，生成一级导航 + 受限分区子目录 |
| `data/navigation.json` | 新增：9 组一级导航定义 |
| `config/app_settings.json` | 新增 `restricted_taxonomy_path` |
| `static/app.js` | 目录树可折叠（图标 + 折叠状态 + 受限标签默认折叠） |
| `static/app.css` | 折叠目录样式 |
| `tests/test_catalog_contract.py` | 新增：DTO 契约 |
| `tests/test_favorite_persistence.py` | 新增：收藏持久化 |
| `tests/test_restricted_taxonomy.py` | 新增：受限 taxonomy schema / 解析统计 / 无重复 canonical / unresolved 保留 |
| `tests/test_alias_resolution.py` | 更新为统一 DTO 键名 |
| `README.md` | 同步 DTO / 收藏 / navigation / 受限 taxonomy / 解析规则 / 中文策略 / 不做的能力 |

## 8. README 更新

**README updated: YES** —— 已补充 Tag API DTO、收藏与购物车分离、navigation vs taxonomy 区别、
受限 taxonomy 接入方式与统计、canonical/alias 解析规则、中文策略、当前明确不做的能力。
未 dump 受限标签的全量具体值。

## 9. 失败与调整

### 失败 1 — 测试回归：resolve_tag 返回旧键名（已修）
原状况：`serialize_tag` 上线后 `resolve_tag` 返回 `tag`/`canonical`，但 `test_alias_resolution.py` 仍断言
`danbooru_name`/`prompt_tag`，4 个用例报错。
调整：更新测试为新 DTO 键名，并新增契约测试锁定「内部字段不泄漏」。
结果：修复，38 测试全绿。

### 失败 2 — navigation.json 引用了带数字前缀的分类名（已修）
原状况：`taxonomy_map.category_l1` 存的是「人物数量与主体」（无「01 」前缀），navigation.json 误写成「01 人物数量与主体」，
导致 taxonomy 目录 total=0。
调整：以脚本 strip 数字前缀并逐条校验 77 个标签名与 DB 一致后回写。
结果：修复，77 类全部可浏览。

### 失败 3 — 旧服务占用 8123 端口（已处理）
原状况：端口被上一会话遗留的旧代码服务占用，新服务 bind 失败。
调整：定位并停止旧进程，重启新服务。
结果：处理完成。

### 发现（未改用户源文件）— 受限 seed 含 1 条脏数据
`adult_curated_taxonomy_seed.json` 的「胸部」分区第 36 条是一段 334 字的中文审阅说明（误粘贴），
非合法 tag。已由 importer 标记为 `anomalous`（保留在 DB、不进 UI、计入统计），未静默修改用户源文件。
**建议用户在源文件里删除这一行。**

## 10. 验证记录

### Check 1 — 单元测试全绿
`python -m unittest discover -s tests` → **PASS，38/38**（新增 catalog 契约 / 收藏 / 受限 taxonomy 11 个用例）。

### Check 2 — 目录 DTO 契约
`/api/catalog/tax_人物数量与主体/tags` → 返回 `{tag, canonical, zh, category, post_count, favorite}`，无 `prompt_tag`。**PASS**。

### Check 3 — 受限 taxonomy 目录
`/api/catalog/restricted_1/tags`（裸露与脱衣状态）→ total=57，resolved 显示 canonical+中文，
unresolved 以原始值展示（post_count=0）。**PASS**。

### Check 4 — 收藏持久化
POST → GET → DELETE 往返：收藏出现 → 取消即消失。**PASS**。

### Check 5 — 搜索 / 解析中文命中
「蓝眼」→ `blue eyes` / `blue_eyes` / `蓝眼睛`，含 favorite 字段。**PASS**。

### Check 6 — navigation 折叠
`/api/catalog` 返回 10 组，受限标签 `collapsed=true`、`nsfw=true`、30 个子目录；其余组默认展开。**PASS**。

## 11. 关键证据

Evidence 1：`/api/catalog` 返回 10 组折叠目录（受限标签 collapsed=true，children=30）。
Evidence 2：受限 taxonomy 解析统计 `resolved_canonical=474 / unresolved_seed=180 / duplicates=0 / anomalous=1`。
Evidence 3：目录/搜索/收藏/最近响应均为统一 DTO（无内部字段泄漏），grep 已确认。
Evidence 4：38 个单元测试 `OK`。
Evidence 5：recent 目录（原 JOIN 缺失会报错）现已正常返回 total=33。

## 12. 未解决问题（非阻塞）

1. **受限 seed 有 1 条脏数据**：`adult_curated_taxonomy_seed.json` 的「胸部」分区混入一段中文审阅说明，已标记 anomalous，建议用户清理源文件这一行。
2. **180 个 unresolved seed**：多为本地 Danbooru 快照未覆盖的 NSFW tag（`erect nipples`、`vagina` 等），
   已按规格保留原始值并可直接使用；如需提升 resolve 率，需扩展 Danbooru 同步范围（非本轮范围）。
3. **画师中文 / 自然语言翻译 / 例图**：属 Stage 5–17 体验增强，本轮未做（见原审阅包）。

## 13. 与原目标的对应关系

| 原要求（Stage 1–4） | 结果 | 证据 |
| --- | --- | --- |
| 统一 Tag API DTO | 完成 | serialize_tag + 契约测试 |
| 收藏持久化 | 完成 | /api/favorites 往返 + 测试 |
| 接入受限 taxonomy | 完成 | import_restricted + 解析统计 |
| navigation 折叠 | 完成 | navigation.json + 折叠目录树 |
| README 更新 | 完成 | DTO/解析规则/不做的能力 |

## 14. 最终产物

- `app.py` / `db.py` / `search.py` —— 后端（统一 DTO + 受限 taxonomy + 修复 recent JOIN）
- `importer/import_restricted.py` / `build_catalog.py` —— 受限 taxonomy 接入 + navigation 目录
- `data/navigation.json` —— UI 一级导航
- `static/*` —— 折叠目录树
- `tests/*` —— 38 用例（新增 catalog 契约 / 收藏 / 受限 taxonomy）
- `README.md`、本审阅包

---

# EXTERNAL REVIEW REQUEST

请审阅者重点检查：

1. 统一 DTO 方案（后端 `serialize_tag` + 更新测试契约）是否比「前端字段兼容」更利于长期维护；
2. 受限 taxonomy 的 resolve 顺序与 unresolved 保留策略是否符合「不猜、不丢弃」；
3. `navigation.json` 的 9 组一级导航划分是否合理（77 类 → 人物/服装/镜头/场景/风格/道具/受限/NovelAI 的映射）；
4. 脏数据（anomalous）处理方式（DB 保留 + UI 过滤 + 报告）是否恰当，是否应直接清理源文件；
5. 是否有更小、更直接的实现。

请勿因为「做法少见」判定错误；只有确实影响真实使用场景时才作为问题报告。

---

===== REVIEW HANDOFF =====

任务：NovelAI V5 本地 Prompt Builder 收尾，完成 Stage 1–4（统一 DTO / 收藏 / 受限 taxonomy / navigation 折叠）。

最终状态：SUCCESS —— 38 测试全绿，目录/搜索/收藏/最近统一 DTO，受限 taxonomy 程序化接入（24 分区 / 474 resolved / 180 unresolved 保留），10 组折叠导航。

关键改动：
1. `db.serialize_tag` 统一 DTO（tag/canonical/zh/category/post_count/favorite），更新测试契约。
2. 新增 `import_restricted.py` + `restricted_taxonomy_map` 表，程序化 resolve 受限 taxonomy。
3. 新增 `navigation.json`（9 组一级导航），前端目录树可折叠、受限标签默认折叠。
4. 修复 recent 目录 JOIN 缺失、resolve_tag 测试回归、navigation 标签名前缀不匹配。

关键证据：
1. 38 单元测试 OK；目录/搜索/收藏/最近响应统一 DTO（无内部字段泄漏）。
2. 受限 taxonomy 统计：categories=24 / memberships=655 / resolved_canonical=474 / unresolved_seed=180 / duplicates=0 / anomalous=1。
3. smoke test：中文「蓝眼」→ blue eyes；收藏往返正常；recent 目录 total=33。

发生过的失败（均已修）：resolve_tag 测试回归、navigation 标签名数字前缀不匹配、旧服务占用 8123。

未解决问题（非阻塞）：
1. 受限 seed 含 1 条误粘贴的中文说明（已标记 anomalous，建议清理源文件）。
2. 180 个 unresolved seed 属本地快照未覆盖的 NSFW tag，已保留原始值。
3. 画师中文 / 自然语言翻译 / 例图属 Stage 5–17，本轮未做。

修改文件：db.py / search.py / app.py / importer/* / data/navigation.json / config/app_settings.json / static/* / tests/* / README.md

README：UPDATED

请重点审阅：DTO 方案、受限 resolve 策略、navigation 分组、anomalous 处理、以及是否有更该优先修的问题。

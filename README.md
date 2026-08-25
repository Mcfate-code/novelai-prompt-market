# NovelAI 提示词超市 V2

本项目是一个本地优先的 NovelAI Prompt 工作台，技术栈保持为 **FastAPI + SQLite + 原生 JavaScript**。V2 的目标是把原来的“搜索 Tag → 加入购物车”扩展为完整闭环：

> 搜得到 → 选得快 → 自动整理 → 能复用 → 能从历史图片反向继续生成

默认只监听 `127.0.0.1`。NovelAI Persistent API Token 只由本地 Node 服务读取，不返回浏览器、不写入项目源码。

## 快速开始

### 启动应用

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

Windows：

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python app.py
```

启动 `app.py` 后会自动检测并拉起 NovelAI 本地服务 `127.0.0.1:8787`，无需再开第二个终端。统一从 <http://127.0.0.1:8787> 使用面板；该入口会把标签、例图、图库和设置请求转发给 FastAPI `8123`，NovelAI 官方 API 和进度事件由 Node 处理。生图只走官方 API，不需要 NovelAI 网页、Edge/CDP 或网页控件。退出 Python 应用时，本次自动启动的 Node 子服务也会一起退出；若 8787 已由用户手工启动，则会直接复用且不会关闭它。

本地启动默认开启 Python 自动重载和 Node 文件监听，修改服务端或 Node 源码后会自动重启对应进程，避免新前端调用旧接口。需要稳定运行时可设置 `TAGS_MARKET_RELOAD=0` 后再启动。

需要 Node.js 22+。Token 可通过环境变量 `NOVELAI_API_KEY` 提供，也可在应用设置中保存到本机用户配置 `~/.workbuddy/tags-market-settings.json`。自动启动失败时查看 `.workbuddy/runtime/novelai-service.log`。如需调试并关闭自动启动，可设置 `TAGS_MARKET_AUTOSTART_NAI=0`。

## V2 核心能力

### 搜索 V2

输入会统一处理大小写、下划线、连字符、标点和空格。匹配优先级为：

1. `exact`
2. `token_exact`
3. `token_unordered`
4. `prefix`
5. `substring`
6. `fuzzy`

结果返回 `match_type`、`match_reason` 和相似度。SQL 先分层召回有限候选，再执行相似度计算，避免全表 Python 模糊匹配。真实词库中 `range murata` 可将 `murata range` 排在首位，`orange hat` 不会抢到前面；本机基准约 `0.11s`。

### PromptState V2

草稿使用 `schema_version: 2`，固定分区为：

```text
character / appearance / clothing / expression / action
composition / scene / style / quality / other
```

每个 Tag 内部保存 `tag`、`weight`、`section`、顺序和来源。权重统一存 float，导出时再转换成 NovelAI 原生语法，如 `1.25::blue eyes::`。

```json
{
  "schema_version": 2,
  "sections": {},
  "characters": [
    {
      "name": "Character 1",
      "prompt_sections": {},
      "uc_sections": {}
    }
  ],
  "global_uc_sections": {},
  "free_text": ""
}
```

分类只使用 Danbooru category、本地 taxonomy/关键词规则和用户覆盖，不调用 AI。优先级为：用户覆盖 → Danbooru Artist/Character → 本地规则 → `other`。

### 导入四态

Prompt 导入预览将条目标记为：

- `exact`：直接命中。
- `normalized`：规范化后命中。
- `candidate`：仅提供候选，用户确认前不写入 Prompt。
- `custom`：已存在的本地自定义 Tag，或用户明确选择“保留原文”。

除导入流程外，也可在购物车的「＋ 自定义标签」按钮直接新增本地自定义 Tag（同时写入 `user_tags` 词库并加入当前 Prompt）；设置页「自定义标签」区块可查看与删除已添加的本地自定义标签。本地自定义 Tag 在搜索时作为 `via: "user_tags"` 命中。

支持 `Base:`、`Character N:`、`Character N UC:`、`Global UC:` 多段输入；角色 UC 会进入对应 `char:n:uc`，不会混入角色正向 Prompt。

### Bundle 与 Preset 分离

- `TagBundle`：只保存 Tag、分区、权重和顺序，适合复用角色外观、画风、构图等组合。
- `Preset`：保存生图参数和生成工作台设置。

二者职责分离，避免“想复用一组 Tag”时连尺寸、Seed 等参数一起覆盖。

### 推荐与冲突

- `tag_cooccurrence` 记录本地历史共现。
- `recent_tags.use_count` 记录个人使用频率。
- `tag_conflict` 提供轻量冲突提醒，例如长发/短发、睁眼/闭眼。

推荐与冲突只用于提示，不自动改写 Prompt。

### Snapshot 与图库闭环

正式生成通过 Prompt、API、参数和 Seed 校验后，恰好创建一次 `PromptSnapshot`。Snapshot 保存失败会阻止生成，旧 `snapshot_id` 不会被复用。

```text
PromptState
  → PromptSnapshot
  → Node 串行生成（1-6 张）
  → Node Asset
  → Python Gallery（snapshot_id + source_asset_id）
  → 全部 / 角色 / 画风 / 构图分区恢复
```

`source_asset_id` 在 Python 图库建立唯一索引，保证 Node 重试回写时幂等。Node 原图已保存但 Python 图库同步失败时，保留已经写入的 Node asset，并将该图片记录标记为 `gallery_sync: failed`、广播 `asset.sync` 告警；批次继续按“原图已安全保存”处理，避免把可恢复的图库索引故障误报为付费生成失败。

## 主要 API

| API | 用途 |
| --- | --- |
| `GET /api/search?q=` | 搜索 V2，返回匹配类型、原因和相似度 |
| `GET /api/prompt/sections` | 固定 Prompt 分区定义 |
| `POST /api/prompt/classify` | 本地确定性分类 |
| `POST /api/prompt/section-override` | 保存用户分区覆盖 |
| `GET/POST /api/bundles` | Bundle 列表与创建 |
| `GET/PUT/DELETE /api/bundles/{id}` | Bundle 读取、更新、删除 |
| `POST /api/import/preview` | 导入四态预览 |
| `POST /api/cooccurrence/record` | 记录本地共现 |
| `POST /api/recommendations` | 本地推荐 |
| `GET /api/conflicts` | 冲突规则 |
| `POST/GET /api/snapshots` | 创建与列出 Snapshot |
| `GET /api/snapshots/{id}` | 读取 Snapshot |
| `POST /api/snapshots/{id}/restore` | 全部或指定分区恢复 |
| `POST /api/gallery/item` | Node 图片回写 Python 图库 |

## 数据表

V2 在原词库和收藏表之外新增：

```text
tag_section_override
tag_bundle
tag_bundle_item
tag_cooccurrence
tag_conflict
prompt_snapshot
generation
```

`gallery` 增加 `snapshot_id` 与 `source_asset_id`。SQLite 使用 `PRAGMA user_version=2`，迁移可重复执行。

## NovelAI 生图规则

- 生图主链使用 NovelAI 官方 API，正式模型为 `nai-diffusion-5-full` 和 `nai-diffusion-5-curated`。
- 官方文档公开 `Small`、`Normal`、`Large` 三类尺寸：Small 最多 6 张，Normal/Large 最多 4 张；面板尺寸档位映射为官方 API 的 `width`/`height` 参数。
- 每次官方请求固定生成一张，批次严格串行；Seed 支持 `Random`、`Fixed`、`Increment`，每张结果保存该图实际使用的 Seed。
- 积分提示只展示可由官方规则确认的结论：连接到 Opus 后，文生图、Normal 尺寸、Steps 不高于 28 的本地串行队列会按单张请求显示为预计 `0 Image Anlas`；V5 仍可能受 Opus 使用额度限制。其他套餐、图生图、Small/Large/自定义尺寸或更高 Steps 不显示臆测数值，均以 NovelAI 实际扣费为准。
- 任意一张失败即停止后续请求；取消只阻止未发送的请求，当前已发送请求允许完成。
- Multi-Character 保持 Base Prompt、各角色 Prompt、各角色 UC 和 Global UC 分离，支持排序、Auto Position 和手动 X/Y 坐标。
- Img2Img 支持本地上传或历史图作为基础图，并透传 Strength、Noise。上传的基础图先保存到本地 `library/assets/`，Recipe 只记录可恢复 URL、文件名和参数，不记录 base64。
- 每张结果保存独立 Recipe。历史缩略图点击只切换预览，只有“恢复设置”或“以此图进行图生图”会改写编辑区。
- 用户手工修改生图文本后，自动退化为平面 Prompt，避免旧结构暗中混入。
- `references` 仅为 Vibe Transfer、Character Reference、Style Reference 预留；当前版本非空即拒绝，不显示 UI，也不发送 NovelAI 请求。
- 生图运行链路为官方 API-only：Node 不等待或连接 Edge/CDP，不读取 NovelAI 网页状态，不通过网页控件同步设置，也没有网页兼容 fallback。
- UC Preset、Transparent BG 和旧网页批量入口已从生图面板移除；官方 API 未验证的字段不会发送。
- 官方 `/user/subscription` 只读探针仅验证 Token、代理和网络，不调用 `/ai/generate-image`，不会消耗 Anlas。
- 新生成的标签例图默认 Prompt 由服务端按 taxonomy 生成：普通标签为 `{{目标标签}}, safe, masterpiece, best quality, very aesthetic, absurdres`，NSFW taxonomy 标签为 `{{目标标签}}, nsfw, masterpiece, best quality, very aesthetic, absurdres`。目标标签采用 NovelAI 双花括号强调，且不预设人物、场景或画风。该默认提示词可在设置页的「NovelAI 例图提示词模板」中自定义，模板支持 `{tag}`（目标标签，自动加双花括号强调）与 `{rating}`（`safe` / `nsfw`）两个占位符，保存时强制要求包含 `{tag}`。已缓存例图保持原样，避免无提示地额外消耗 Anlas；可在卡片上选择“重新生成”以明确覆盖旧图。

当前状态为 `PARTIAL`：已完成 API-only 改造、尺寸规则、失败详情持久化和非付费测试；真实 Token 下的单张/多张付费 Gate、401/429 实网映射仍未执行。

## 数据与目录

| 路径 | 说明 |
| --- | --- |
| `data/tags.sqlite` | 标签、别名、分类、收藏、V2 状态和图库索引 |
| `data/taxonomy_seed.json` | 人工浏览 taxonomy |
| `data/navigation.json` | UI 导航结构 |
| `data/zh_aliases.json` | 中文别名 |
| `config/model_overlays.json` | V5 / V4.5 / V4 模型语义 |
| `config/app_settings.json` | 端口、代理和数据源设置 |
| `prompt/sections.py` | 固定分区与本地分类器 |
| `server/generation-request.mjs` | GenerationRequest 规范化和单图 Recipe |
| `server/novelai-provider.mjs` | V5 txt2img、Multi-Character、Img2Img 官方 API payload |
| `server/api-batch.mjs` | 1-6 张严格串行批次 |
| `server/server.mjs` | 8787 API、SSE、基础图/结果资产保存和图库同步 |
| `tests/test_v2_backend.py` | V2 schema、搜索、Bundle、导入、Snapshot、图库测试 |

图库目录删除不会永久删除文件，而是先移动到项目 `待清理/图库/`，再移除活动索引。

## 测试

```bash
python -m unittest discover -s tests -v
env -u NODE_OPTIONS node --test server/*.test.mjs
env -u NODE_OPTIONS node --check static/app.js
git diff --check
```

当前非付费回归基线：

- Python：`65/65` 通过。
- Node：`17/17` 通过，覆盖 GenerationRequest、V5 payload、严格串行、取消、Recipe、图库同步和 Img2Img 基础图持久化路由。
- `static/app.js`、`server/server.mjs`、`server/api-batch.mjs` 语法通过。
- 桌面与移动端布局数据以最近一次浏览器验收结果为准。

## 预留接口与明确边界

当前仅为 References 保留统一数组字段：

```json
{
  "references": []
}
```

非空 `references` 会在 GenerationRequest 规范化阶段直接拒绝。当前不显示 Vibe Transfer、Character Reference 或 Style Reference UI，也不会把这些数据发送到 NovelAI。

当前明确不实现：

- Provider 框架或多供应商路由
- 并发生成、Scene Queue
- Canvas、Inpaint、图片 Hash 管理
- LLM 自动优化 Prompt
- 向量数据库或 embedding 搜索
- 节点编辑器
- Prompt Git
- 自动质量评分
- React/Vue/Electron 重构

保持本地、确定性、可解释的 FastAPI + SQLite + 原生 JavaScript 架构。

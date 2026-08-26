# NovelAI 提示词标签超市

本地优先的 NovelAI Prompt 工作台：搜索标签 → 加入购物车 → 整理分区与权重 → 直接调用 NovelAI 官方 API 生图 → 图库管理与恢复，形成完整闭环。

技术栈：**FastAPI + SQLite + 原生 JavaScript 前端 + Node.js 代理**。默认只监听 `127.0.0.1`，单机工具，无需认证 / TLS。NovelAI Persistent API Token 只由本地 Node 服务读取，不返回浏览器、不写入项目源码。

> 闭环：搜得到 → 选得快 → 自动整理 → 能复用 → 能从历史图片反向继续生成

## 功能特性

### 标签搜索（V2）

- 输入统一处理大小写、下划线、连字符、标点和空白。
- 分层匹配，返回 `match_type`、`match_reason` 与相似度：
  `exact` → `token_exact` → `token_unordered` → `prefix` → `substring` → `pinyin_exact` → `pinyin_partial` → `fuzzy`。
- 词序无关匹配：输入 `range murata` 也能命中 `murata range`，字符巧合（如 `orange hat` 含子串 `range`）不会抢到前面。
- **拼音搜索**：对每个标签的中文名 / 中文别名生成全拼（`lan yan`）与首字母（`ly`），输入 `lanyan` / `lan yan` / `ly` 可命中对应中文名的英文标签（如「蓝眼」→ `blue eyes`）。
- 别名解析：`/api/resolve` 支持精确、token 词序无关、前缀与中文别名前缀解析。

### 语义找词

搜索框旁「语义找词」按钮：输入中文自然语言，后端代理到 Danbooru 语义检索服务，返回英文标签候选列表。

### 自定义标签（user_tags）

本地词库没有的标签（如 `original character`、`my_style`）可通过购物车「＋ 自定义标签」或设置页添加。自定义标签写入本地 `user_tags` 表，之后在搜索中作为 `via: "user_tags"` 直接命中；设置页可查看与删除。

### 权重调节

购物车条目权重支持快速档（弱 0.8 / 普通 1.0 / 强 1.2）、步进微调（±0.05）与**手动输入**。手动输入时面板不自动关闭，支持连续键入不失焦；导出时自动转换为 NovelAI 原生语法，如 `1.25::blue eyes::`。

### 分区组织与记忆

Prompt 使用固定 10 分区：`character / appearance / clothing / expression / action / composition / scene / style / quality / other`。

- 分类完全本地确定性：用户分区覆盖 → Danbooru Artist / Character 分类 → 本地关键词规则 → `other`，不调用 AI。
- **分区记忆**：用户把某标签移动到某分区后写入 `tag_section_override`，之后任何草稿加载（含换浏览器、清站点数据）都会自动归位到记住的分区。

### 购物车与多角色

- 购物车支持 Base Prompt、Global UC、多角色（每个角色独立 Prompt 与 UC）。
- 「添加到：[Base / Scene ▼]」目标选择器：标签可写入 Base 或指定角色，角色增删排序时目标自动跟随/回退。
- **TagBundle**：只保存 Tag、分区、权重与顺序的复用组合（如角色外观、画风、构图）。
- **Preset**：保存生图参数与工作台设置。二者职责分离。

### 推荐与冲突提示

- 本地共现（`tag_cooccurrence`）、个人使用频率（`recent_tags.use_count`）提供轻量推荐。
- 冲突规则（`tag_conflict`，如长发/短发、睁眼/闭眼）给出提示。
- 推荐与冲突只用于提示，**不自动改写 Prompt**。

### 提示词导入

支持 `Base:`、`Character N:`、`Character N UC:`、`Global UC:` 多段文本解析，逐标签四态预览：

- `exact`：直接命中；
- `normalized`：规范化后命中；
- `candidate`：仅提供候选，用户确认前不写入；
- `custom`：已有自定义标签，或用户选择「保留原文」。

### NovelAI 生图（官方 API）

生图链路为官方 API-only（`https://image.novelai.net`），Node 不依赖网页 / Edge / CDP。面板提供：

- 模型：`nai-diffusion-5-full`、`nai-diffusion-5-curated`、`nai-diffusion-4-5-full`、`nai-diffusion-4-full`（全链路 exact-ID，未知模型明确报错）。
- 文生图 / 图生图（本地上传或历史图作为基础图，透传 Strength / Noise）。
- 尺寸档位（Small / Normal / Large 纵向、方形、横向 + 自定义宽高）、批次图片数 1–6，每次请求固定生成一张、批次严格串行。
- Seed 模式：Random / Fixed / Increment，每张结果保存实际使用的 Seed。
- **正面 / 负面提示词档位**：正面 `off / standard / light`，负面 `off / light / heavy / furry_focus / human_focus`，默认 `standard + heavy`；档位内容为统一官方 Quality / UC 数组。
- Multi-Character：Base 与各角色 Prompt / UC 分离，支持角色位置（Auto 居中或手动 X/Y 坐标）。
- 透明背景、Advanced Settings（Sampler / Scheduler / Steps / CFG / CFG Rescale / Auto SMEA）。
- **Effective Preview**：预览与实际发送共用同一份编译结果（含 Quality / UC 来源与跨极性冲突 warning-only 提示），raw prompt 永不改写。
- 积分提示只展示可由官方规则确认的结论；是否扣费以 NovelAI 实际结算为准。任意一张失败即停止后续请求；取消只阻止未发送的请求。

### 标签例图

新生成的标签例图默认 Prompt 由服务端按 taxonomy 生成：普通标签 `{{标签}}, safe, masterpiece, best quality, very aesthetic, absurdres`，NSFW 标签将 `safe` 换为 `nsfw`。模板可在设置页自定义（支持 `{tag}` 与 `{rating}` 占位符，必须包含 `{tag}`）；例图使用固定 V4.5 Full / 832×832 / 28 steps，生成会消耗 Anlas，需明确确认。

### 图库与闭环

- 正式生成经 Prompt、API、参数与 Seed 校验后创建一次 `PromptSnapshot`；生成结果回写图库并关联 `snapshot_id`。
- 图库支持目录树、网格密度调整、收藏、全选、「移入待清理」（软删除，进入项目 `待清理/图库/`）、zip 图包导入。
- **元数据恢复**：图库图片可一键「恢复设置」（还原 Prompt / Negative / 各开关 / 参数 / Seed / 角色），或按分区恢复 Snapshot（全部 / 角色 / 画风 / 构图）。
- **审阅模式**：双击图片进入沉浸式全屏审阅（`←`/`→` 翻页、Fit / 1:1 缩放、收藏/删除同步、`Esc` 退出恢复原布局）。

### 翻译

设置页填写百度翻译 APP ID / 密钥后可手动触发翻译（仅点击时请求，不会自动上传）；自定义标签支持中文名，自然语言补充可保留中文 Raw 并选择英文译文作为 Effective Prompt。

### 数据维护

- 设置页提供缓存统计与清理（标签缩略图缓存、例图缓存）。
- 「更新标签库」从 Danbooru 增量同步标签（`/api/sync`、`/api/sync-hot`）。
- 青少年模式：开启时隐藏 NSFW 目录与语义搜索结果。

## 系统架构

```text
浏览器（static/ 原生 JS，无框架）
   │
   ├── FastAPI 后端（Python：app.py / db.py / search.py / importer/ / prompt/）
   │      127.0.0.1:8123
   │      标签数据、搜索、导入、图库索引、设置、翻译（SQLite：data/tags.sqlite）
   │
   └── Node 代理（server/：server.mjs / novelai-provider.mjs / generation-request.mjs …）
          127.0.0.1:8787
          静态面板服务 + Python 路由反向代理
          NovelAI 官方 API 生图（Token 只在本层持有）
          SSE 进度事件推送 / 生成资产保存（library/）/ 图库回写
```

**为什么有 Node 层**：NovelAI Persistent API Token 不能暴露给浏览器；官方生图 API 的 payload 构建（V5 `params_version=4`、V4 `params_version=3`）、严格串行批次、进度事件推送与资产落盘由 Node 层负责，Python 层负责标签与图库索引。前端统一从 8787 入口访问（Node 把标签 / 例图 / 图库 / 设置请求转发给 FastAPI）。

### 目录结构（主要文件）

| 路径 | 职责 |
| --- | --- |
| `app.py` | FastAPI 后端入口：全部标签 / 搜索 / 导入 / 图库 / 设置 API，并自动拉起 Node 服务 |
| `db.py` | SQLite 数据底座（tags / user_tags / tag_section_override / tag_bundle / prompt_snapshot / gallery 等） |
| `search.py` | 搜索排序、别名解析、拼音匹配、分类浏览 |
| `importer/` | Danbooru 数据导入、中文别名、拼音回填、受限分类、目录构建 |
| `prompt/` | 固定分区与本地分类器、导入解析、NovelAI 语法导出 |
| `server/server.mjs` | Node 服务入口：静态面板、Python 路由代理、SSE、官方 API 生图路由 |
| `server/novelai-provider.mjs` | NovelAI 官方 API payload 构建与响应解析 |
| `server/generation-request.mjs` | 生图请求规范化与模型默认值 |
| `server/api-batch.mjs` | 1–6 张严格串行批次控制器 |
| `static/` | 前端（index.html / app.js / app.css / prompt-compiler.js） |
| `data/` | 本地 SQLite 与种子数据（已 gitignore，首次启动自动生成） |

## 快速开始

环境要求：**Python 3.10+**、**Node.js 22+**（生图依赖 Node 层；若本机没有，可用 `NODE_BIN` 指向可执行文件，或将 Node 放到 `$WORKBUDDY_HOME/binaries/node/` 下）。

### 安装依赖并启动

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
python app.py
```

Windows（PowerShell）：

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python app.py
```

### 访问

- **统一面板入口：<http://127.0.0.1:8787>**（Node 服务，含前端与 API 代理，推荐）
- FastAPI 直连：<http://127.0.0.1:8123>（标签 / 图库 / 设置 API）

启动 `app.py` 后会自动检测并拉起 Node 服务（127.0.0.1:8787），无需另开终端；退出 Python 应用时，本次自动启动的 Node 子服务也会一起退出。若 8787 已由用户手工启动，则会直接复用且不会关闭它。多实例防互杀：某个实例因端口被占而启动失败、即将退出时不会误杀仍在健康服务的 node。

本地启动默认开启 Python 自动重载与 Node 文件监听；需要稳定运行时设置 `TAGS_MARKET_RELOAD=0` 再启动。自动启动失败时查看 `.workbuddy/runtime/novelai-service.log`；如需关闭自动启动，设置 `TAGS_MARKET_AUTOSTART_NAI=0`。

### 单独启动 Node 层（可选）

```bash
./server/start-nai.sh          # 启动 Node 联动层（8787，官方 API-only）
```

脚本使用 `$HOME/.workbuddy` 作为默认本机目录（可用 `WORKBUDDY_HOME` 覆盖），Node 可用 `NODE_BIN` 指定。生图走官方 API，无需 Edge / CDP / 浏览器登录。

### macOS 常驻运行（可选）

`bash install-launchagent.sh` 安装 LaunchAgent 使服务开机常驻，日志位于 `$HOME/Library/Logs/TagSupermarket/`；故障排查可用仓库根目录的 `标签超市-诊断.command`。关闭窗口 ≠ 停止服务。

### 首次使用

1. 打开面板 → 设置页：
   - 填写 **NovelAI Persistent API Token**（生图与例图必需，只保存在本机，也可用环境变量 `NOVELAI_API_KEY`）。
   - 可选：Danbooru 账号 / API Key（更新标签库与抓取例图）、百度翻译凭据、代理。
2. 标签库首次启动自动种子化（`data/`）；「更新标签库」可从 Danbooru 增量同步更多标签。

## 配置

项目不随仓库提交任何本机私密配置，全部通过环境变量或仓库外的用户设置文件提供。

### 用户设置文件

- 路径：`$WORKBUDDY_HOME/tags-market-settings.json`（默认 `~/.workbuddy/tags-market-settings.json`，可用环境变量 `WORKBUDDY_HOME` 覆盖，与 `server/start-nai.sh` 一致）。
- 保存内容：NovelAI Token、Danbooru 登录 / API Key、百度翻译凭据、代理、青少年模式、缓存上限、例图提示词模板等；凭据不回显，文件权限 0600。

### 环境变量

项目不会自动读取 `.env`；这些变量需要在启动进程前 export（或在启动脚本中设置），示例见仓库内 `.env.example`：

| 变量 | 说明 |
| --- | --- |
| `NAI_PROXY_URL` | 出网代理地址（留空 = 不用代理） |
| `WORKBUDDY_HOME` | 覆盖本机 WorkBuddy 目录（默认 `~/.workbuddy`） |
| `NODE_BIN` | 指定 Node.js 22+ 可执行文件 |
| `NOVELAI_API_KEY` | NovelAI Persistent API Token |
| `DANBOORU_API_KEY` | Danbooru API Key |
| `BAIDU_TRANSLATE_APPID` / `BAIDU_TRANSLATE_SECRET` | 百度翻译凭据 |
| `TAGS_MARKET_RELOAD` | 设为 `0` 关闭开发热重载 |
| `TAGS_MARKET_AUTOSTART_NAI` | 设为 `0` 关闭 Node 服务自动启动 |

### 项目级配置

`config/app_settings.json`（端口 / 主机等，本机文件，已被 gitignore，不提交）与 `config/model_overlays.json`（模型能力语义，随仓库维护）。

## 使用指南

1. **找标签**：顶部搜索框输入英文 / 中文 / 拼音（如 `蓝眼`、`lan yan`、`ly`）；或点击「语义找词」用中文自然语言描述；也可在「标签目录」按分类浏览。
2. **加入购物车**：点击标签写入当前目标（Base / Scene 或指定角色）。分类由本地规则自动判定；在购物车「高级编辑」中可调整分区与权重（支持手动输入）。
3. **整理与复用**：把常用标签组合保存为「标签模板」（Bundle），把生图参数保存为 Preset；「导入提示词」可把已有 NovelAI 提示词结构化拆入购物车。
4. **生图**：切到「生图」工作台，选择模型 / 尺寸档位 / 批次数量 / Seed 模式，可展开角色设置做 Multi-Character，确认「实际发送内容」后点生成；进度实时推送，失败即停。
5. **图库**：生成结果自动进入图库；双击进入审阅模式；「恢复设置」或按分区加载 Snapshot 可还原参数继续生成；「以此图进行图生图」可从历史图继续。
6. **设置**：管理 Token / 凭据、代理、缓存、青少年模式、例图提示词模板与自定义标签。

## API 摘要

### Python 后端（8123，也可经 8787 代理）

| API | 用途 |
| --- | --- |
| `GET /api/search?q=` | 搜索 V2（含拼音、词序无关，返回 match_type / reason / similarity） |
| `GET /api/resolve?q=` | 别名 / 前缀解析为 canonical tag |
| `POST /api/semantic-search` | 中文自然语言语义找词（代理 Danbooru 语义检索） |
| `GET /api/taxonomy` / `GET /api/catalog` | 分类浏览树 / 目录树 |
| `GET /api/zh` / `POST /api/zh-notes` | 中文名映射 / 自定义中文备注 |
| `GET /api/thumbs` | 标签例图 URL（懒抓取 + 本地缓存） |
| `GET/POST /api/settings` | 读取 / 保存用户设置（凭据不回显） |
| `POST /api/translate` | 百度翻译（手动触发） |
| `GET /api/prompt/sections` | 固定 Prompt 分区定义 |
| `POST /api/prompt/classify` | 本地确定性分类 |
| `POST /api/prompt/section-override` / `GET /api/prompt/section-overrides` | 用户分区覆盖（购物车分区记忆） |
| `GET/POST/PUT/DELETE /api/bundles/{id}` | TagBundle 复用组合 |
| `POST /api/import` / `POST /api/import/preview` | 提示词导入与四态预览 |
| `GET /api/inbox` | 导入结果轮询 |
| `GET/POST/DELETE /api/user-tags` | 自定义标签管理 |
| `POST /api/export` | 按模型导出 NovelAI 原生语法（含权重） |
| `GET/POST /api/favorites` / `GET/POST /api/recent` | 收藏 / 最近使用 |
| `GET/POST/DELETE /api/presets` | 生图 Preset |
| `POST /api/cooccurrence/record` / `POST /api/recommendations` / `GET /api/conflicts` | 推荐与冲突提示 |
| `POST/GET /api/snapshots` / `POST /api/snapshots/{id}/restore` | PromptSnapshot 创建 / 分区恢复 |
| `GET /api/gallery` / `POST /api/gallery/import` / `POST /api/gallery/item` | 图库列表 / zip 导入 / 图片回写 |
| `POST /api/gallery/favorite` / `DELETE /api/gallery/{dir}` | 图库收藏 / 删除（移入待清理） |
| `GET /api/novelai-examples` / `POST /api/novelai-examples/{tag}` | 标签例图查询 / 生成 |
| `POST /api/cache/clear` / `POST /api/novelai-examples/clear` | 缓存清理 |
| `GET /api/models` / `GET /api/overlay/{model_id}` | 模型列表 / 模型能力 |
| `POST /api/sync` / `POST /api/sync-hot` | Danbooru 标签库更新 |

### Node 代理（8787）

| API | 用途 |
| --- | --- |
| `GET /` | 静态面板 |
| `GET /events` | SSE 事件流（进度 / 资产 / 图库同步） |
| `GET /api/status` | Node 服务状态（mode: api-only） |
| `GET /api/novelai/status` | 官方 API 探针（只读验证 Token / 代理 / 网络，不消耗 Anlas） |
| `POST /api/novelai/generate` | 发起串行生图批次（1–6 张） |
| `GET /api/novelai/generate/{batchId}` / `POST .../cancel` | 批次状态 / 取消 |
| `POST /api/novelai/tag-example` | 标签例图单图生成（固定 V4.5 Full / 832×832 / 28 steps） |
| `POST /api/novelai/img2img-source` | 图生图基础图上传 |
| `GET /api/batches` / `GET /api/assets` / `GET /api/jobs` | 诊断用批次 / 资产 / 任务列表 |

## 开发相关

### 运行测试

```bash
# Python（后端）
python -m unittest discover -s tests

# Node（服务端 + Prompt Compiler）
node --test server/*.test.mjs tests/test_prompt_compiler.mjs
node --test tests/test_app_helpers.mjs

# 前端 / 服务端语法检查
node --check static/app.js
node --check server/server.mjs
```

当前回归基线（非付费）：Python 120 项、Node 服务端与 Prompt Compiler 74 项、app.js 纯函数 24 项全部通过；覆盖搜索、拼音、导入、Bundle、Snapshot、图库、NovelAI payload、串行批次、取消、翻译、设置与防互杀守卫。

### 本地工作流提示

- 开发期默认热重载（Python + Node 文件监听），稳定运行设 `TAGS_MARKET_RELOAD=0`。
- `importer/backfill_pinyin.py` 可幂等回填拼音列（首次导入或词库更新后）。
- 删除图库目录是软删除：先移入 `待清理/图库/`，再移除活动索引。

## 许可证与免责声明

- 仓库当前**未包含 LICENSE 文件**；在作者明确许可证之前，请仅将本仓库用于个人学习与参考。
- 本项目与 NovelAI 官方无关联，`NovelAI` 及相关商标归其所有者所有；生图 / 例图会消耗 NovelAI 账户 Anlas，所有付费请求均需用户明确确认。
- 项目完全本地运行，标签数据来自 Danbooru（含语义检索代理服务），请遵守相应平台的使用条款。
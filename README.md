# NovelAI V5 本地提示词「标签超市」

一个 **NovelAI V5-first** 的本地 Tag Prompt Builder：从 Danbooru 同步 canonical 全量词库，
用人工整理的 77 类中文分类层做「标签超市」，叠加 V5 / V4.5 / V4 模型语义，最终拼装并导出
NovelAI 原生语法 Prompt。

只做「找 Tag → 组织 Tag → 输出 Prompt」，不做生图、不存 NovelAI 账号、不上云、只监听
`127.0.0.1`。

---

## 快速开始

```bash
# 1. 建虚拟环境并安装依赖
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # Windows
# source .venv/bin/python -m pip install -r requirements.txt  # macOS/Linux

# 2. 初始化本地词库（导入 77 类人工 Seed + 中文别名）
.venv/Scripts/python -c "import db; from importer import import_taxonomy, import_aliases; db.init_db(); c=db.get_conn(); import_taxonomy.import_taxonomy(c); import_aliases.import_zh(c); c.close()"

# 3. 启动（127.0.0.1:8123）
.venv/Scripts/python app.py
```

打开 <http://127.0.0.1:8123> 即可。

> 首次启动 app 时若 `data/tags.sqlite` 为空，会自动导入 Seed 与中文别名，无需手动执行第 2 步。

## 更新全量标签库（可选，需联网访问 Danbooru）

Danbooru 需走代理（默认 `http://127.0.0.1:7890`，见 `config/app_settings.json` 的 `proxy`）。账号认证不要写入项目配置文件，使用环境变量：

```bash
export DANBOORU_LOGIN="你的 Danbooru 用户名"
export DANBOORU_API_KEY="你的 Danbooru API Key"
```

按热度同步热门 general / character / artist / copyright / meta 词库：

```bash
# 经代理同步热门 tag（数量见 app_settings.json 的 hot_sync）
.venv/Scripts/python -c "from importer.sync_danbooru import run_hot_sync; import json; print(json.dumps(run_hot_sync(), ensure_ascii=False, indent=2))"
```

或页面点「更新标签库」。同步后词库约 **5.2 万 tag**：
general 1.3 万（含大量 NSFW）+ character 1.7 万 + artist 1.7 万 + copyright 0.4 万 + meta 0.1 万。
**不随启动强制联网**；断网时本地 Seed 照常可用。

## 导入中文对照表（一次性，需联网）

下载 ffdkj 的 32 万条中英对照表并批量填充中文名（手动别名优先，不覆盖）：

```bash
curl -x http://127.0.0.1:7890 -o data/danbooru_zh.sqlite \
  "https://raw.githubusercontent.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table/main/tag.sqlite"
.venv/Scripts/python -c "import db; from importer import import_danbooru_zh; db.init_db(); c=db.get_conn(); print(import_danbooru_zh.import_danbooru_zh(c)); c.close()"
```

对照表每日更新，数据源与许可见 https://github.com/ffdkj/ffdkj-Danbooru_Tag-Chinese-English-Translation-Table 。

## 数据与文件

| 路径 | 说明 |
|---|---|
| `data/tags.sqlite` | 本地词库（tags / tag_aliases / taxonomy_map / restricted_taxonomy_map / favorites / recent_tags / presets / tag_catalog / user_zh / tag_thumbs） |
| `data/taxonomy_seed.json` | 人工浏览层（数据分类）：77 类 / 2836 成员 / 2543 去重 Seed |
| `data/navigation.json` | UI 导航（一级折叠目录 + 二级引用）；只影响 UI，不重写底层 taxonomy |
| `../adult_curated_taxonomy_seed.json` | 受限标签 curated taxonomy（用户预置，24 分区 / 655 成员 / 583 去重）；路径见 `app_settings.json` 的 `restricted_taxonomy_path`，不复制第二份数据 |
| `data/zh_aliases.json` | 通用 tag 中文别名层（2543 条全覆盖） |
| `data/zh_characters.json` | 热门角色（Character）中文名：nahida→纳西妲、silver wolf→银狼 等（裸名自动解析到带版权后缀的规范 tag） |
| `data/danbooru_zh.sqlite` | ffdkj Danbooru 中英对照表（32 万条，post_count≥10，Gemini 机翻+人工校对），批量填充中文名 |
| `config/model_overlays.json` | V5 / V4.5 / V4 语义：特殊标签、质量/UC 预设、renamed tags、权重与多角色能力 |
| `config/app_settings.json` | 端口、代理、Danbooru 源、热门同步数量、受限 taxonomy 路径配置 |

## 数据分层

1. **Canonical Machine Corpus** —— Danbooru API → SQLite，是「尽可能全」的来源（含 alias / category / post_count / deprecated）。
2. **Curated Browse Taxonomy** —— 本文档的 77 类中文分类 + 2543 个 Seed，负责「好找」（数据分类）。
3. **Restricted Curated Taxonomy** —— 用户预置的受限标签（24 分区），独立的成人 curated 目录层，程序化 resolve 后接入（resolved / unresolved 分离，不静默丢弃）。
4. **NovelAI Model Overlay** —— V5 / V4.5 / V4 的特殊标签、预设、renamed、权重与多角色能力。

人工 Seed 不与 canonical 混为一谈：导入时做存在性校验，标记 `canonical` / `alias` /
`overlay_only` / `unresolved`，不把不存在的标签冒充 canonical。

> `navigation.json`（UI 导航）与 `taxonomy_seed.json`（数据分类）分离：导航只决定一级目录如何折叠、
> 二级如何引用分类/受限标签；底层 taxonomy 不被导航重写。

## Tag API DTO（统一契约）

搜索 / 目录 / 收藏 / 最近 / 受限标签 全部返回同一公开结构，前端不再做字段兼容：

```json
{
  "tag": "blue eyes",       // 最终写入 Prompt 的字符串（空格形式，英文显示名）
  "canonical": "blue_eyes", // 数据库 canonical（下划线形式，alias 解析 / 调试）
  "zh": "蓝眼睛",            // 中文显示名（无则空串）
  "category": 0,            // Danbooru category 编号
  "post_count": 123456,     // 热度
  "favorite": false         // 是否已收藏
}
```

内部字段 `prompt_tag` / `tag_name` / `zh_name` / `danbooru_name` 一律不出现在 API 响应中。

## 功能

- 中 / 英 / 日 alias 搜索，最终输出英文 canonical；中文如「蓝眼」→ `blue eyes`、「纳西妲」→ `nahida (genshin impact)`。
- 一级折叠目录（9 组：我的 / 人物 / 服装 / 镜头与构图 / 场景 / 风格与画面 / 道具与主题 / Danbooru 词库 / 受限标签 / NovelAI），二级引用分类与受限标签，受限标签默认折叠。
- **受限标签（成人 curated taxonomy）**：程序化接入用户预置的 24 分区 taxonomy，逐条 resolve（canonical / alias / normalized），unresolved 保留原始值不丢弃、不猜、不 LLM 补词。
- 分类树浏览（77 类）+ General / Character / Artist / Copyright / Meta 过滤。
- **左侧 Danbooru 词库分组**：可直接选「角色 / 画师 / 系列 / Meta」浏览对应类别的热门 tag（按 post_count 降序）。
- **词库规模**：Danbooru 热门同步后约 5.2 万 tag（character 1.7 万含 nahida/silver wolf 等角色、artist 1.7 万、general 1.3 万含大量 NSFW）。
- **中文覆盖 99.4%**：手动别名 2543 条 + 热门角色名 + ffdkj 32 万对照表批量填充，5.2 万 tag 中 5.2 万有中文名（画师名保持原名）。
- **角色/画师中文名**：热门角色自动解析到规范 tag 并显示中文（nahida→纳西妲、silver wolf→银狼、raiden shogun→雷电将军…）。
- Base Prompt + 多 Character（每角色独立 Prompt 与 UC）+ 全局 UC + 自由自然语言。
- `{}` / `[]` 逐层强调、数值权重 `1.5::tag::`、V4.5+ 负数权重 `-1::hat::`。
- 多角色关系前缀 `source#` / `target#` / `mutual#`。
- V5 不硬编码旧 6 角色上限（官方测试曾做到约 22 个角色）。
- 收藏 / 最近使用 / 本地 Preset 持久化；一键复制导出；轻量冲突提示（不禁止导出）。
- **收藏与购物车分离**：卡片右上角 ☆ 收藏/取消，点击卡片正文才加入购物车。
- **自定义标签备注中文**：购物车里任何 tag（含自己加的 / 未解析的）都可点「中文」按钮备注中文，备注持久化并覆盖默认中文。
- **例图缩略图**：浏览卡片自动加载 Danbooru 180×180 预览图（懒加载 + 本地缓存，无图则不显示，离线降级）。
- **购物车中文显示**：右侧每个 tag 旁自动显示中文名（有中文名则显示，无则仅英文）。
- **Prompt 导入（可选目标）**：粘贴一段 NovelAI 提示词（或直接在对话里发给 WorkBuddy），自动解析成
  tag 并填充右侧购物车。支持 `1.5::tag::` 数值权重、`-1::hat::` 负数权重、`{{}}`/`[[]]` 强调、
  `source#`/`target#`/`mutual#` 关系前缀、`Base:`/`Character N:`/`Character N UC:`/`Global UC:`
  多角色分段，以及自然语言自由文本自动识别。两种用法：
  1. **页面内**：右上「导入」按钮 → 选择「导入到」（Base / Global UC / 某角色 Prompt / 某角色 UC）→ 粘贴 → 替换或追加；
  2. **对话内**：直接把提示词发给 WorkBuddy，让它调用 `/api/import`，页面轮询 `/api/inbox` 自动接收并填充。

## NovelAI 语法要点（规格第 4–5 节）

- 输出小写、`, ` 分隔；不输出 SD WebUI 的 `(tag:1.2)`。
- 每层 `{}` ≈ ×1.05，每层 `[]` ≈ ÷1.05。
- 数值权重：`1.5::rain, night::`；负数权重：`-1::hat::`（仅 V4.5+）。
- 多角色：人数放 Base（`2girls`），每个角色 Prompt 不再写 `1girl`；互动用 `source#hug` 等。

## 目录结构

```text
app.py                    FastAPI 后端（127.0.0.1 only）
db.py                     SQLite 数据底座（schema + upsert + 统一 DTO serialize_tag）
search.py                 搜索 / alias 解析 / 分类浏览 / Seed 状态
config/model_overlays.json
config/app_settings.json
data/navigation.json      UI 一级导航（9 组折叠目录）
importer/import_taxonomy.py
importer/import_aliases.py
importer/import_restricted.py   受限标签 taxonomy 程序化接入 + resolve
importer/sync_danbooru.py
prompt/composer.py
prompt/novelai_export.py
prompt/import_parser.py     Prompt 导入解析器（语法感知）
static/index.html app.js app.css
tests/                    alias / export / overlay / import / catalog 契约 / 收藏 / 受限 taxonomy
```

## 测试

```bash
.venv/Scripts/python -m unittest discover -s tests -v
```

## 边界说明

- `post_count` 只代表 Danbooru 使用量，**不代表** NovelAI 熟悉度，UI 只显示 `Danbooru posts: N`。
- V5 于 2026-08-21 发布，其 preset 作为独立 overlay，随官方页面后续更新，不擅自沿用 V4.5 固定值。
- 成人 NSFW 分类仅保留「成人角色之间自愿」的内容；不纳入未成年 / 非自愿 / 人兽性内容。
- 中文别名层为人工整理，全量多语言可后续接入 `danbooru-tag-index` 增补（注意确认其许可证）。

### canonical / alias 解析规则

受限 taxonomy 的每个 seed 按 `exact_canonical → exact_alias → normalized_canonical → unresolved_seed` 顺序解析：

1. `exact_canonical`：`prompt_tag`（空格）或 `danbooru_name`（下划线）精确命中 tags；
2. `exact_alias`：`tag_aliases.alias` 精确命中；
3. `normalized_canonical`：下划线 ↔ 空格互转后再精确命中；
4. `unresolved_seed`：以上都不中，**保留原始值、标记 unresolved，不自动猜、不静默修改、不 LLM 补词**。

`resolved` 的 seed 显示 canonical + 中文；`unresolved` 的 seed 以原始值展示（post_count=0），可直接加入购物车（可能是 NovelAI 特有或本地未同步的 tag）。同一 canonical 不因多个 alias 展示成重复卡片。

### 中文策略

- General：有可靠中文 → 中文；没有 → 英文。
- Character：优先官方 / 稳定中文名，显示「中文名 + canonical + [角色]」。
- Copyright：显示「中文作品名 + canonical + [作品]」。
- Artist：保留原文，显示「artist name + [画师]」，不自行发明译名。

### 当前明确不做的能力

React/Vue 重构、Electron、Elasticsearch、向量数据库、embedding 搜索、用户系统、云同步、
LLM 全库翻译、推荐模型、协同过滤、复杂用户画像、数据库 schema 大迁移、例图本地缓存与图源爬取。
保持 FastAPI + SQLite + 原生 JS。

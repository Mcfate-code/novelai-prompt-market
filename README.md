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

#### PromptDocument 数据契约（schema_version=2）

前端纯数据层位于 `static/prompt-document.js`，是 Prompt 的统一契约；`state.prompt` 保持唯一权威状态，旧的 `base` / `characters` / `global_uc` 数组仅作为兼容投影。文档包含 `sections`、`characters[].prompt_sections/uc_sections`、`global_uc_sections`、自由文本字段与 `assistant_context`（推荐 / Scene Composer V2 的 metadata，包括独立的 `primary_act` 与 Environment/Scenario `primary_scene_type`、1–3 人精确角色槽、Stage/Position/Body Focus/Composition、逐角色状态及 snapshot 可恢复的 `interactions` 行）；条目统一保存 `id`、`tag`、`weight`、`section`、relation/brackets、来源与 Bundle/provenance 元数据。互动行原子物化为角色 `source/target/mutual` relation 条目（固定 weight=1），并沿用既有 relation codec；本阶段不改变 relation+numeric-weight 顺序，也不作新的官方语法结论。

### 推荐与冲突提示

- 推荐由 Recommendation V2 多源确定性引擎提供：全局关联（远程可注入，失败回退本地）/ 本地共现（`tag_cooccurrence`）/ 个人最近使用（`recent_tags_scoped.use_count`，按 base/character/interaction/scene 作用域隔离读取，缺失时回退全局 `recent_tags`）/ 语义节点 seed / 成人场景上下文（`mode=adult`）。
- 语义相似替代项（embedding 邻居，如 blue eyes → red eyes、ponytail → short ponytail）作为独立的 `semantic_alternative` 源以「相似/替代」形式展示，**不进入**默认「Next Step」加法推荐列表（同槽位替代优先于叠加共现）。
- 冲突规则（`tag_conflict`，如长发/短发、睁眼/闭眼）给出提示；严格互斥组（`SET_EXCLUSIVE_GROUP`）原子处理，普通冲突仍 warning-only。
- 推荐与冲突只用于提示，**不自动改写 Prompt**（点击 `+` 才 ADD_TAG）。

#### Recommendation Engine V2（纯 Python service）

`prompt/recommendation.py` 提供不依赖 FastAPI、LLM、embedding 或向量数据库的只读 `RecommendationService`。Integrator 可传入 `conn` 和可注入 source adapter，调用：

```python
from prompt.recommendation import RecommendationService

result = RecommendationService(conn, hidden_tags=hidden, adolescent_mode=True).recommend(
    tags=positive_tags, target="base", node_id="env_indoor", limit=20,
    mode="general", active_target="base", active_section="scene",
)
```

输入还支持 `participant_count / primary_scene_type / stage / position / body_focus / semantic_node / last_added_tag`；返回 `groups` 与扁平 `recommendations`，每项含 `tag / canonical / zh / group / reason / sources`。候选源分别为全局关联、本地共现、个人最近使用、语义上下文和成人场景上下文；各源独立排序后用固定 `RRF_K=60` 融合，再做上下文重排和分组多样性。远程 related adapter（`prompt/related_client.py`）超时或异常时返回空源，由本地源继续工作。

硬过滤发生在融合前：已选标签、青少年隐藏/NSFW、成人未成年或幼态候选、人数、target/section/node 不兼容及 exclusive/conflict 均不出现在结果中；`post_count` 只作弱 tie-break。成人模式支持 `PREPARATION / FOREPLAY / MAIN_ACT / CLIMAX / AFTERMATH`，并保留当前阶段/下一阶段分组。V2 service 只读，不修改 `PromptDocument` 或学习表；snapshot/generation 学习链路仍只记录一次 positive Base/Character，Global UC / Character UC 不作为 positive 样本。

### Tag Assistant（独立前端组件）

`static/tag-assistant.js` + `static/tag-assistant.css` 提供挂载到 `#tag-assistant-root` 的原生 JS 组件（无框架 / 零依赖），由 Workbench V3 通过 `PromptBridge` 接入：

- **四入口**：推荐（默认）/ 目录 / 搜索 / 收藏。
- **推荐**：按当前 Prompt 的 positive 标签、active target、语义节点调 `POST /api/recommendations`；结果按语义分区分组显示（紧凑 Tag card：英文 tag、中文名、热度、reason/source、`+`，非图片墙）；已选标签自动去重。
- **目录**：显示创作意图骨架（`GET /api/catalog/semantic`，Base/Character 概念树，最多两级），点击节点（如 Indoor → `bedroom`）只显示该节点的推荐标签，**不展开全量标签树**；无推荐结果时回退展示节点 `seed_tags`（词库真实标签）。
- **搜索**：复用 `GET /api/search`（英文 / 中文 / 拼音 / 别名由后端支持），输入防抖 250ms，Enter 立即搜索，Esc 清空。
- **收藏**：复用 `GET /api/favorites`，进入即刷新。
- **PromptBridge 消费**：只读 `getDocument()` / `getActiveTarget()`，`subscribe()` 变化 400ms 防抖合并刷新推荐（不随每次按键请求）；点击 `+` 只 dispatch `ADD_TAG`，**不维护第二份 Prompt 权威状态**（组件只缓存视图数据，文档每次按需读取）。
- **健壮性**：无 PromptBridge / 后端不可用时显示空态或错误态（带重试），不崩溃；事件委托（root 单监听器）、tab 方向键、原生按钮焦点、aria labels。
- 挂载方式与 PromptBridge 契约见下方「Tag Assistant 集成契约」。

#### Tag Assistant 集成契约

```js
import { createTagAssistant } from "/static/tag-assistant.js";
const assistant = createTagAssistant({
  root: document.getElementById("tag-assistant-root"),
  bridge: window.PromptBridge,   // 缺省自动回退 window.PromptBridge
  apiBase: "",                   // 后端前缀（默认同源）
  limit: 20,                     // 推荐 / 搜索条数
  debounceMs: 400,               // Prompt 变化 -> 推荐刷新防抖
  nodeId: "",                    // 初始语义节点（可选）
});
assistant.mount();               // 卸载：assistant.destroy()
```

PromptBridge 由集成方提供，需实现：

| 方法 | 说明 |
| --- | --- |
| `getDocument()` | 返回 PromptDocument（schema v2，见 `static/prompt-document.js`） |
| `getActiveTarget()` | 返回 `base` / `global_uc` / `char:N` / `char:N:uc` |
| `subscribe(listener)` | Prompt 变化时调用 listener；返回 unsubscribe |
| `dispatch(action)` | 消费组件发出的 action |

组件只发出一种 action：`{ type: "ADD_TAG", payload: { tag, target, section?, weight? } }`（`target` 为当前 active target）。`REMOVE_TAG / SET_WEIGHT / MOVE_SECTION` 由集成方定义，组件不直接使用。组件导出纯函数（`positiveTagsFromDocument` / `buildRecommendPayload` / `filterSelected` / `groupRecommendations` / `flattenSemanticTree` / `toCard` / `buildAddTagAction` 等）供测试与集成方复用。

### Visual Prompt Builder（独立前端组件）

`static/visual-builder.js` + `static/visual-builder.css` 提供挂载到 `#visual-prompt-root` 的原生 JS 组件（无框架 / 零依赖），由 Workbench V3 接入，用**语义卡片 + chip 编辑**方式编辑 Prompt（不做无限画布 / 无连线）：

- **一级工作区**：Base / Character 1..N / 「+」添加角色；Base 与 Character 内容互不串用（每个工作区只渲染自己目标的 chip；新增标签一律按 `ADD_TAG` 写入当前 active target，与 Text 编辑保持同一目标）。
- **语义卡片**：来自 `GET /api/catalog/semantic` 的 Base/Character 概念骨架（不硬编码数千 taxonomy）——Base 卡片 Subject / Count / Style / Composition / Environment / Lighting / Time-Weather / Objects / Quality（Quality 为组件内置最小兜底节点：当后端 base 树无 `section=quality` 节点时注入，seed_tags 仅 4 个核心质量词）；Character 卡片 Identity / Appearance（Body Skin Hair Face Eyes）/ Clothing / Expression / Pose / Action-Interaction。点击卡片下钻 `?node_id=` 刷新推荐 / seed tags（青少年模式由后端裁剪 nsfw 节点，组件原样渲染不绕过），点「＋ 标签」ADD_TAG 到当前 active target（携带卡片对应分区）。
- **chip 编辑**：已选标签按固定 10 分区成组显示为 chip；每个 chip 支持删除（`REMOVE_TAG`）、权重显示与 `−`/`＋` 步进调权（`SET_WEIGHT`，±0.05 夹底 0.1）、分区移动（`MOVE_SECTION` 下拉）；`weight=1` 简洁显示 tag，非 1 显示如 `blue eyes · 1.3`。
- **Character UC / Global UC**：折叠面板（`<details>`）且底色 / 边框明显区分，与正片互不混淆。
- **角色管理**：工作区头部的角色名输入（change 时 `RENAME_CHARACTER`）与「移除角色」按钮（`REMOVE_CHARACTER`，仅剩 1 个角色时禁用），tab 栏「+」添加角色（`ADD_CHARACTER`）。
- **Text/Visual 一致性**：所有编辑动作只 `dispatch`，组件通过 `PromptBridge.subscribe()` 收到变化后从 `getDocument()` **按需重读**并刷新——**不维护第二份 Prompt 权威状态**（只缓存视图数据：语义卡片树 / 选中节点 / 工作区选择 / UC 折叠态），与 Tag Assistant 同一契约精神。
- **健壮性 / 无障碍**：无 PromptBridge / 无文档 / 接口错误均有可见空态或错误态（带重试）；事件委托（root 单监听器）、工作区 tab 方向键、原生按钮 / select / details、aria-labels / aria-selected / aria-expanded。

#### Visual Prompt Builder 集成契约

```js
import { createVisualBuilder } from "/static/visual-builder.js";
const builder = createVisualBuilder({
  root: document.getElementById("visual-prompt-root"),
  bridge: window.PromptBridge,   // 缺省自动回退 window.PromptBridge
  apiBase: "",                   // 后端前缀（默认同源）
  fetchImpl: undefined,          // 自定义 fetch（测试注入）
});
builder.mount();                 // 卸载：builder.destroy()
```

PromptBridge 与 Tag Assistant 同源（`getDocument()` / `getActiveTarget()` / `subscribe()` / `dispatch()`，见上方表格）。Visual Builder 发出以下全部 action（`REMOVE_TAG / SET_WEIGHT / MOVE_SECTION / ADD_CHARACTER / REMOVE_CHARACTER / RENAME_CHARACTER` 由集成方实现）：

| Action | payload | 触发 |
| --- | --- | --- |
| `ADD_TAG` | `{ tag, target, section?, weight? }` | 语义卡片点「＋ 标签」（target 恒为当前 active target） |
| `REMOVE_TAG` | `{ target, entryId }` | chip 删除（target 为 chip 所属目标） |
| `SET_WEIGHT` | `{ target, entryId, weight }` | chip `−` / `＋` 步进调权（绝对值） |
| `MOVE_SECTION` | `{ target, entryId, section }` | chip 分区下拉 |
| `ADD_CHARACTER` | `{ name? }` | 工作区 tab「+」 |
| `REMOVE_CHARACTER` | `{ index }` | 角色工作区「移除角色」 |
| `RENAME_CHARACTER` | `{ index, name }` | 角色名输入 change |

组件导出纯函数（`chipLabel` / `adjustWeight` / `workspaceForTarget` / `workspaceTabs` / `buildWorkspaceChips` / `semanticCards` / `normalizeSemanticNode` / `buildRemoveTagAction` / `buildSetWeightAction` / `buildMoveSectionAction` / `buildAddCharacterAction` / `buildRemoveCharacterAction` / `buildRenameCharacterAction` / `dispatchAction` 等）供测试与集成方复用。

### NSFW Scene Builder（Scene Composer，产品化）

`static/nsfw-builder.js` + `static/nsfw-builder.css` 提供挂载到 `#nsfw-builder-root` 的原生 JS 组件（无框架 / 零依赖），产品化为成人内容场景的「Scene Composer」：高层语义小集合而非成人词库整面墙。`app.js` 在 `mountWorkbenchComponents()` 中挂载，`adolescentMode` 从 `/api/settings` 注入，候选从 `GET /api/nsfw-builder/options` 派生（后端按 `config/scene_composer.json` + `data/nsfw_taxonomy.json` 逐条校验 `data/tags.sqlite` 后下发，未命中即 drop，绝不发明 tag）。组件遵守后端 adolescent / NSFW 内容策略，不绕过：

- **V2 信息架构**：首屏是可自由跳转的「人物 / 主要行为 / 互动关系 / 阶段体位 / 角色状态 / 镜头环境」六组 dashboard，并显示 Scene-only 完成数和实时摘要；不是强制向导。
- **人数行为**：仅支持 1/2/3，人数与 Character 槽通过单个原子 action 同步；减少时非空尾部角色会阻止并提示。当前 SQLite 不含已验证的 `<N>people` / `<N>persons` / `<N>characters` 精确非性别人数标签，因此只同步结构状态、不猜性别、不发明 Base tag，Semantic State 将 Participants 标记为 partial。

- **唯一权威状态**：`PromptDocument.assistant_context` 是唯一场景上下文；组件无 `this.selections` / 无业务副本，每次刷新从 `bridge.getDocument().assistant_context` 水合（`currentContext()` / `_hydrateContext()` 是唯一水合路径）。
- **环境/情境**：环境/情境为场景候选（`scenarios` 卧室/户外/旁观 + `environments` 白天/夜晚，带已校验 canonical tag，route → Base、section=scene），取代旧的高层「主场景」概念（该概念无独立语义，已删除）；`minParticipants` 用于人数兼容。
- **UI 分区（渲染顺序）**：人数 → 主要行为 → 互动关系 → 阶段（`PREPARATION / FOREPLAY / MAIN_ACT / CLIMAX / AFTERMATH`，语义标识而非 canonical tag）→ 角色（**每个角色一条服装子组，全部同时可见**）→ 体位 → 附加活动 → 身体聚焦 → 镜头环境（构图 + 环境/情境）→ 推荐（分组展示）。
- **人数增减策略**：`selectParticipants` 增多时 dispatch 单个 `SET_EXCLUSIVE_GROUP(participant_count)` + `SCENE_PROPOSAL{kind:"sync_participants"}`；减少时检查尾部角色：尾部全空则允许并附 `autoRemovableEmptyIndices`；任一尾部角色含内容则**不改 participant_count**，显示 `Character N 仍有内容，请手动移除` 提示并 dispatch `SCENE_PROPOSAL{kind:"remove_characters_blocked"}`——**不猜测性别、不静默删除**。
- **strict exclusive groups**：`participant_count` / `primary_scene_type` / `stage` / `position` / `clothing_state:char:N`。新选择 dispatch **一个** `SET_EXCLUSIVE_GROUP` action，Integrator 原子删除同组旧 entries、加新 tag、更新 context、只通知一次。作用域：scene/stage/participant_count → `target:"base"`；position / primary_act → 各角色卡的 `action`；clothing_state → `target:char:N`（Character Assignment）。旧 Base 中的动作、表情和姿势状态在换姿势 / 选择体位时自动迁移到角色卡；镜头构图仍留在 Base。
- **上下文不泄漏为 tags**：所有上下文 metadata 通过 `SET_ASSISTANT_CONTEXT`（对齐 Recommendation V2）交给 Integrator，不直接编译成 Prompt tags；只有带 canonical tag 的选择（活动新增、推荐点击）才 `ADD_TAG`。
- **附加活动对称 + 溯源**：新增 = context + `ADD_TAG{source:"scene_activity", bundle_name:"scene-builder"}`；取消 = context + 仅移除带该溯源标记的 `REMOVE_TAG`——不删用户自有同名 tag。
- **位置过滤**：按 `minParticipants` / `requiresScenes` 过滤；participant_count 为 1 或未选时隐藏并提示「选择多人以启用体位」。
- **推荐分组**：`POST /api/recommendations` 返回 `{groups:[{group,recommendations}]}` 时按返回顺序分组渲染（group 字符串作标题）；否则回退平铺 `recommendations`。点击推荐只 `ADD_TAG` 到 active target，不自动改 stage / 不触发 strict group。
- **青少年门控**：`adolescent_mode=true` 时 `isDisabled()`，所有 select/toggle/recommend 返回 false、零 dispatch，渲染仅禁用空态。

#### NSFW Scene Builder 集成契约

```js
import { createNsfwBuilder } from "/static/nsfw-builder.js";
const builder = createNsfwBuilder({
  root: document.getElementById("nsfw-builder-root"),
  bridge: window.PromptBridge,              // 缺省自动回退 window.PromptBridge
  apiBase: "",                              // 后端前缀（默认同源）
  fetchImpl: undefined,                     // 自定义 fetch（测试注入）
  adolescentMode: settings.adolescent_mode, // 必须注入后端 /api/settings，true=禁用
  mode: "adult",                            // Recommendation V2 mode（app.js 传 "adult"）
  // 真实候选（canonical tag 已由后端逐条校验 sqlite；缺 tag 只更新 context 不 ADD_TAG）：
  participants: [{ key: "1", label: "1" }, { key: "2", label: "2" }, { key: "3", label: "3" }, { key: "4+", label: "4+" }],
  scenarios: [{ key: "bedroom", label: "卧室", tag: "bedroom", route: "base", section: "scene" }],
  environments: [{ key: "night", label: "夜晚", tag: "night", route: "base", section: "scene" }],
  positions: [{ key: "missionary", label: "missionary", tag: "missionary", minParticipants: 2 }],
  clothingStates: [{ key: "nude", label: "全裸", tag: "nude" }],
  activities: [{ key: "kissing", label: "接吻", tag: "kissing", section: "action" }],
  bodyFocus: [{ key: "breasts", label: "胸部", tag: "breasts" }],
  recommend: async (payload) => [...],        // 可选注入推荐来源
});
builder.mount();                 // 卸载：builder.destroy()
```

PromptBridge 与 Tag Assistant / Visual Builder 同源（`getDocument()` / `getActiveTarget()` / `subscribe()` / `dispatch()`）。NSFW Scene Builder 发出的 action：

| Action | payload | 触发 |
| --- | --- | --- |
| `SET_EXCLUSIVE_GROUP` | `{ group, key, newTag, target, characterIndex, members }` | strict 互斥组新选择（Integrator 原子处理；`newTag` 为空只设 group 不 ADD_TAG；clothing 组 `target:char:N` + `characterIndex`） |
| `SET_ASSISTANT_CONTEXT` | `{ context }` | body_focus / activities / 全量 context 快照（metadata 不编译为 tags） |
| `ADD_TAG` | `{ tag, target, section?, source?, bundle_name? }` | 带 tag 的活动新增（带 `source:"scene_activity"` / `bundle_name:"scene-builder"`）、推荐点击 |
| `REMOVE_TAG` | `{ target, entryId }` | 活动取消（仅移除带 scene_activity / scene-builder 溯源标记的自身条目） |
| `SCENE_PROPOSAL` | `{ kind, count?, autoRemovableEmptyIndices?, blockedIndices? }` | 参与者增减高层提议，`kind:"sync_participants"` / `"remove_characters_blocked"`（Integrator 决定角色槽增删 / 基础主体数同步 / 手动移除提示；组件本身不直接增删角色） |

组件导出纯函数（`buildContext` / `buildRecommendPayload` / `buildSetExclusiveGroupAction` / `buildSetAssistantContextAction` / `buildAddTagAction` / `exclusiveMembers` / `filterPositions` / `normalizeOption(s)` / `normalizeRecommendation(s)` / `participantNumber` / `radioMoveIndex` / `isSelected` / `optionVisibleForCount` / `positiveTagsFromDocument` / `dispatchAction` / `esc` 等）供测试与集成方复用。组件由 `app.js` 的 `mountWorkbenchComponents()` 挂载为第三模式（Scene）并随 `#prompt-mode-switch` 切换显隐；`SCENE_PROPOSAL`（参与者增减 → 角色槽增删 / 基础主体数同步）这一高层提议的最终落库处理由 Integrator 在 `dispatch` 侧实现（组件只发提议，不直接增删角色）。

### Prompt Input / Autocomplete 键盘契约（Phase 2，独立模块，已接入）

`static/nai-input-keys.js` 提供 Prompt 输入框（含 autocomplete 弹窗）的键盘决策纯模块（无 DOM / 无 PromptDocument / 不引用 app.js），由 `app.js` 在现有 `bindNaiAutocomplete` handler 上接线（`createNaiInputKeys` 有状态 controller；模块以 `<script type="module">` 加载并挂到 `window.NaiInputKeys`）。核心入口 `handleKeydown(event, context)` 返回统一 action：

```js
import { handleKeydown, createNaiInputKeys, ACCEPT_DELIMITER, HINT_TEXT } from "/static/nai-input-keys.js";
```

- **方向键**：弹窗打开时 `ArrowUp` / `ArrowDown` 导航候选（首尾回卷），action `{ action:"navigate", direction, index, preventDefault:true }`。
- **Tab 接受**：接受当前选中（越界夹到末项）候选并追加分隔符 `, `（`ACCEPT_DELIMITER`），action `{ action:"accept", index, tag, delimiter:", ", preventDefault:true }`；用 `delimiterToAppend(afterText)` 避免与既有分隔符重复。
- **Esc 关闭**：action `{ action:"close", preventDefault:true }`。
- **单 Enter 永远换行**：即使弹窗打开也绝不接受候选，action `{ action:"newline" }`（不 preventDefault）。
- **Enter×2 生成**：第二击 Enter 在 300–400ms 窗口内（默认 `DEFAULT_DOUBLE_ENTER_MS=350`）触发 `{ action:"generate", undo:true, preventDefault:true }` **恰好一次** —— preventDefault 使第二击的空行不插入，即撤销本次检测产生的额外空行；第一击已插入的换行属既有换行，绝不删除。生成后计时器复位，第三击快速 Enter 是全新换行。
- **IME 组合**：`event.isComposing` 与 `context.composing`（`compositionstart`/`end` 维护）优先；组合中的 Enter 一律普通换行，不计入 double-enter、不生成、不导航 / 不接受弹窗。
- **鼠标接受契约**：弹窗 option 的 `mousedown` handler 调用 `acceptActionFor(index, results)`（即 `mouseAcceptAction`），返回与 Tab 相同的 accept action，由 Integrator 自行应用。
- **撤销额外空行工具**：`trailingNewlineRange(value, caret)` 定位 caret 正前方那一个换行，`removeRange(value, range)` 只删它——用于「已放任第二击换行插入后」的补救路径。
- **轻量 UI hint**：`buildHintHtml()` 生成 `Tab 补全 · Enter 换行 · Enter×2 生成`（`HINT_TEXT`），Integrator 可挂载到弹窗底部（`.nai-ac-hint` 样式在 app.css，由 Integrator 挂载，本模块不改 index.html）。
- **主题**：autocomplete 弹窗是 body 级 fixed 覆盖层，`--nai-*` 主题变量已提升至 `:root` 公共 scope（`.nai-layout` 直接继承），弹窗背景 `var(--nai-card)` 稳定不透明，无 opacity hack。

#### Prompt Input 键盘契约接入说明

```js
// 纯函数式（double-enter 状态自行持有）：
let doubleEnter = {};
function onKeydown(event) {
  const action = handleKeydown(event, {
    popup:  { open: boxOpen, results, selected },
    doubleEnter,
    composing: isComposingState,          // compositionstart/end 维护
    options: { doubleEnterMs: 350, now: Date.now },
  });
  if (action.nextDoubleEnter) doubleEnter = action.nextDoubleEnter;
  apply(event, action);
}

// 或一行接入的有状态 controller：
const keys = createNaiInputKeys({ doubleEnterMs: 350 });
input.addEventListener("keydown", (e) => apply(e, keys.handleKeydown(e, { popup })));
input.addEventListener("compositionstart", () => keys.setComposing(true));
input.addEventListener("compositionend",   () => keys.setComposing(false));

function apply(event, action) {
  if (action.preventDefault) event.preventDefault();
  switch (action.action) {
    case "navigate": popupSelected = action.index; render(); break;
    case "accept": {
      // 1) Integrator 既有 token 替换（replacePromptTokenWithCaret）
      const { value, caret } = replacePromptTokenWithCaret(input.value, input.selectionStart, action.tag);
      // 2) 新契约：追加分隔符 `, `（不重复）
      input.value = value + delimiterToAppend(value.slice(caret), action.delimiter);
      closePopup();
      break;
    }
    case "close": closePopup(); break;
    case "generate": triggerGenerate(); break;      // undo:true 已由 preventDefault 达成
    case "newline": break;                           // 默认换行
    case "none": break;
  }
}
```

模块导出纯函数（`handleKeydown` / `createNaiInputKeys` / `stepDoubleEnter` / `moveSelection` / `clampSelection` / `classifyPopupKey` / `acceptActionFor` / `mouseAcceptAction` / `delimiterToAppend` / `trailingNewlineRange` / `removeRange` / `isComposing` / `buildHintHtml` 及常量）供测试与集成方复用，详见 `tests/test_nai_input_keys.mjs`。

#### 语义导航与确定性推荐

- **语义导航树**：`config/prompt_navigation.json` 定义 Base / Character 两棵创作概念骨架
  （Style、Composition、Environment（室内/室外）、Lighting、Time/Weather、Objects；
  Identity、Appearance（体型/皮肤/头发/面部/眼睛）、Clothing、Expression、Pose、Action）。
  节点字段固定为 `id / label / zh / target / section / nsfw / seed_tags / children`；
  `seed_tags` 全部取自本地词库的真实标签。接口复用 catalog 家族：
  `GET /api/catalog?semantic=1` 或 `GET /api/catalog/semantic`，支持 `node_id` 下钻单节点；
  青少年模式下自动裁剪 `nsfw` 节点，旧目录树请求不受影响。
- **确定性简单评分**（无 embedding / LLM / 向量库），信号按优先级：
  1. 当前 Prompt positive 标签的共现（`tag_cooccurrence`）；
  2. 语义节点 `seed_tags`（含祖先）上下文加分 —— 例如 bedroom 节点优先
     `bed / pillow / lamp`，`blue eyes + long hair` 优先角色外观而非随机场景；
  3. `recent_tags_scoped.use_count` 个人偏好（有界小权重，按 base/character/interaction/scene 作用域隔离）；
  4. `post_count` 弱先验 / 同分排序。
  排除已选标签与青少年模式隐藏标签；`target=base|character` 对候选做分区过滤；
  Global UC / Character UC 不作为 positive 样本。
- **共现记录审计**：snapshot / 正式 generation 只对 Base positive 与 Character positive
  记录一次正面共现（同标签跨目标去重）；不记录 Global UC / Character UC，键盘输入不入库。
- `POST /api/recommendations` 接受 `tags / target / node_id / limit`（旧请求仅 `tags/limit`
  兼容）与 V2 上下文 `mode / participant_count / primary_scene_type / stage / position /
  body_focus / active_target / active_section / last_added_tag`；返回 `{ groups, recommendations }`，
  每项含 `tag / canonical / zh / group / reason / sources`，并附旧前端兼容的 `section / count`。

### 提示词导入

支持 `Base:`、`Character N:`、`Character N UC:`、`Global UC:` 多段文本解析，逐标签四态预览：

- `exact`：直接命中；
- `normalized`：规范化后命中；
- `candidate`：仅提供候选，用户确认前不写入；
- `custom`：已有自定义标签，或用户选择「保留原文」。

#### Prompt Auto-Split（Phase 2，纯 Python）

`prompt/auto_split.py` 的 `auto_split(prompt, metadata_resolver=None, manual_assignments=None)`
只生成归属 proposal，不修改 `PromptDocument`，不调用 LLM，也不应绑定到 keypress。输入可以是 flat prompt 文本、
`prompt/import_parser.py` 的结构化结果，或已有 schema v2 文档；后两者带有明确角色段时会直接保留，避免二次拆分。
返回 `base`、`characters`、`global_uc`、`summary`、`unassigned`，以及 `assistant_context`。

归属顺序是明确结构 / 项目 separator → metadata-backed character identity → 确定性语义分区 → Base。
角色身份应通过注入的 metadata resolver 提供（支持 canonical / alias 与 Danbooru character category 4，括号名称不会被拆坏）。
人数计算：gender-specific 标签（`1girl`/`2boys`…）求和、aggregate 标签（`3people`/`2persons`…）单独取值、identity 锚点数，
三者取 max 作为参与人数；`assistant_context` 同时保留 `actual_participant_count`（原始值）与 `participant_count`（4+ 映为 4 档）。
无法建立可靠边界时 `summary` 明确报告 `detected multiple subjects but no reliable character boundary`，
人数标签仍只进入 Base。`source#`/`target#`/`mutual#` 关系：有当前 Character anchor 时归当前 Character（保留 relation 元数据），
无 anchor 时留在 Base。人工映射可使用 `base`、`global_uc`、`char:N`、`char:N:uc`，优先级最高。

接入：`POST /api/prompt/auto-split`（body `{ text | prompt, manual_assignments? }`）调用同一 service，
对 proposal 的每个 tag 用 `classify_tag` 补 `section`，返回 `{ proposal, summary, unassigned, structured, resplit, assistant_context }`，
并附前端易用字段 `base_count`、`characters:[{name,prompt_count,uc_count}]`、`unassigned_count`；不返回 HTML，
**不修改** PromptDocument（Apply 由前端执行）。

前端 Import 弹窗「自动整理角色」按钮是**非破坏性** analyze → preview → apply/cancel 流程：点击只请求该接口并在弹窗内渲染预览
（`Base · N tags`、`Character 1 <name> · M tags`、…、`无法确定 · R`，计数全部取自 proposal 的真实字段
`base` / `characters[].{name,prompt,uc}` / `unassigned`），**不改动当前 PromptDocument**；「应用拆分」才 dispatch 单个
`APPLY_AUTO_SPLIT`（`PromptBridge` 一次 proposal → `documentFromProposal` → `PromptDocument` 整体替换 → 单次 notify，
不逐 tag dispatch），「取消」关闭预览、零状态变更；预览可重复打开，每次重新分析。Apply 复用现有 `undo` 回退；
不在 keypress 上重拆，已有 structured metadata（`resplit=false`）直接恢复，不二次 split。

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

#### 生图工作台布局（Prompt-first）

生图视图为三栏桌面布局，高信息密度、Prompt 优先，参照 NovelAI 官方信息架构：

- **左：Prompt Editor** — 单一 `#nai-editor` 编辑器，Prompt / UC 作为 Text 模式下的 pane tabs 切换；Base / Character tabs 与多角色设置（角色名 / 位置 / 排序 / 移除，不含 textarea）；Base 下的「自然语言补充」独立折叠区；「实际发送内容」Effective Preview 折叠展开。`#prompt-mode-switch` 提供 Text / Visual / Scene 切换，`#tag-assistant-root` / `#visual-prompt-root` / `#nsfw-builder-root` 由 Workbench V3 自动挂载；各视图只通过正式 `window.PromptBridge` 读写同一份 PromptDocument。
- **中：Image Viewer** — 中心画布，Fit / 缩放 / 点击 100% 查看、Pin 收藏、「恢复设置」、「以此图图生图」。
- **右：Generation Settings** — 基础参数常显：Model / 尺寸档位 / 批次 / Seed（Random / Fixed / Increment）/ 文生图·图生图（Strength / Noise）/ 透明背景 / 正负提示词档位；Advanced Settings（Sampler / Scheduler / Steps / CFG / CFG Rescale / Auto SMEA）折叠；Generate / Cancel 与积分预估常驻底部。History 位于同栏底部，点击标题可折叠隐藏。
- 移动端单列堆叠：Prompt → Generation Settings / History → Viewer，无横向溢出。

#### Workbench Architecture（单一权威收敛）

生图工作台的 Prompt 编辑完全收敛到 `PromptDocument`（`static/prompt-document.js`），编辑器只做读写投影，不引入第二份权威状态：

- **单一编辑器**：全局只保留一个 `<textarea id="nai-editor">`；Base / Character N 通过 GLOBAL TARGET tabs 切换，Prompt / UC 通过 pane tabs 切换，解析为 `base` / `global_uc` / `char:N` / `char:N:uc` 目标（`resolveWorkbenchEditorTarget`）。不再有 Base/GlobalUC/CharPrompt/CharUC 各自独立 textarea。
- **Text → Document**：编辑输入只经 `PromptBridge.dispatch({type:"RECONCILE_TEXT"})` 写入，handler 调 `reconcileTargetText(document, target, text)`，逐键不压历史。
- **Document → Text**：`renderWorkbenchEditorFromDocument()` 由 `serializeTarget(target)` 回流编辑器；编辑器聚焦时 GUARD 跳过，避免打字被重写。PromptBridge 订阅者在任意 PromptDocument 变更时触发回流。
- **生成读 PromptDocument**：`naiGenerate` / `naiUpdateEffectivePreview` 一律经 `buildGenerationPromptState(document)` 取 `{basePrompt, globalUc, characters}`，与 Effective Preview 共用同一编译函数，保证 Preview == payload；绝不读 textarea。
- **恢复读 PromptDocument**：图库/历史/剪贴板/快照恢复统一走 `restorePromptDocumentFromGeneration()`（restore → PromptDocument → notify → UI），绝不写 DOM。
- **TagBundle = 当前目标 only**：`bundleItemsFromPrompt` 捕获 `getTargetEntries(document, target)`，`addBundle` 经 `reconcileTargetText` 只应用到当前目标，不 flatten 全部角色。
- **Undo = 一次编辑会话**：`#nai-editor` focus 保存一次 pre-edit 快照，blur / 目标切换 / 模式切换时若内容变化恰好压入一个 history 项；`undo()` 弹栈后 `commitPromptChange` + `renderWorkbenchEditorFromDocument({force:true})`。
- **Autocomplete caret 契约**：`tokenRangeAtCaret`（`static/prompt-tokenizer.js`）是 caret-range 唯一权威，尊重 `weight::tag::` 包裹；`acceptNaiAutocomplete` 据此替换，`blue ey|, long hair` → Tab → `blue eyes, |long hair`。

### 标签例图

新生成的标签例图默认 Prompt 由服务端按 taxonomy 生成：普通标签 `{{标签}}, safe, masterpiece, best quality, very aesthetic, absurdres`，NSFW 标签将 `safe` 换为 `nsfw`。模板可在设置页自定义（支持 `{tag}` 与 `{rating}` 占位符，必须包含 `{tag}`）；例图使用固定 V4.5 Full / 832×832 / 28 steps，生成会消耗 Anlas，需明确确认。

### 图库与闭环

- 正式生成经 Prompt、API、参数与 Seed 校验后创建一次 `PromptSnapshot`；生成结果回写图库并关联 `snapshot_id`。
- 图库支持目录树、网格密度调整、收藏、全选、「移入待清理」（软删除，进入项目 `待清理/图库/`）、zip 图包导入。
- **元数据恢复**：图库图片可一键「恢复设置」（还原 Prompt / Negative / 各开关 / 参数 / Seed / 角色），或按分区恢复 Snapshot（全部 / 角色 / 画风 / 构图）。
- **审阅模式**：双击图片进入沉浸式全屏审阅（`←`/`→` 翻页、Fit / 1:1 缩放、收藏/删除同步、`Esc` 退出恢复原布局）。

### 翻译

翻译走百度通用翻译开放平台（`https://fanyi-api.baidu.com/api/trans/vip/translate`，签名 = MD5(appid + q + salt + secret)）。两种配置方式任选其一（环境变量优先于设置文件）：

- **设置页**：填入百度翻译「APP ID」与「密钥」，保存在 `~/.workbuddy/tags-market-settings.json`（0600，不回显）。
- **环境变量**：启动前 `export BAIDU_TRANSLATE_APPID=... BAIDU_TRANSLATE_SECRET=...`（项目不自动读取 `.env`，见 `.env.example`）。

仅点击时请求，不会自动上传；自定义标签支持中文名，自然语言补充可保留中文 Raw 并选择英文译文作为 Effective Prompt。

翻译请求的出网代理与语义搜索一致：优先用户设置 `proxy_enabled` / `proxy_url`（或环境变量 `NAI_PROXY_URL`），未配置时回退到 `config/app_settings.json` 的 `proxy.enabled` / `proxy.url`。注意 `fanyi-api.baidu.com` 为国内服务——若经代理出口到海外 IP 可能触发百度 `58000 客户端 IP 非法`，此时请在代理规则中把该域名设为直连，或关闭代理。错误响应会携带百度原始错误码（`54001` 签名错误 / `52003` 未授权未开通 / `54003` QPS / `54004` 余额不足 / `58000` IP 限制等）便于定位。

### 数据维护

- 设置页提供缓存统计与清理（标签缩略图缓存、例图缓存）。
- 「更新标签库」从 Danbooru 增量同步标签（`/api/sync`、`/api/sync-hot`）。
- 青少年模式：开启时隐藏 NSFW 目录与语义搜索结果。

### Offline Prior（数据先验）

离线先验库 `data/offline_prompt_prior.sqlite`（NPMI 关联 / 语义槽位 / 槽位转移 / 语义近邻）**不属于仓库**（`data/` 与 `*.sqlite` 均被 gitignore），需要单独获取：

- **普通用户**：从 GitHub Releases 下载预构建的 `offline_prompt_prior.sqlite`，放入 `data/`；或运行 `python scripts/bootstrap_prior.py`（若设置了环境变量 `PRIOR_DOWNLOAD_URL`，该脚本会直接下载到 `data/`）。
- **开发者**：本地重建
  - `python -m prompt.prior_build` —— 公共先验（NPMI / 槽位 / 上下文 / 转移），使用公开 Danbooru 元数据，无需密钥；
  - `python -m scripts.build_embedding_prior` —— embedding 语义先验（`prior_semantic_neighbor` / 共享的 `tag_semantic_node`），**需要 `SILICONFLOW_API_KEY`**。
- **缺失时行为**：启动时 app 会打印一行 WARNING 告警（`Offline Prior MISSING at ...`），`GET /api/offline-prior/status` 返回 `{"available": false, ...}`，系统使用优雅降级 —— 推荐仍通过 NPMI / seed 正常工作，仅语义替代（semantic alternative）质量下降。
- **运行时不需要 `SILICONFLOW_API_KEY`**：该密钥仅构建期 embedding 脚本使用，正常启动与推荐不读取。

## Recommendation Target Isolation

- `recommendationContextTags(document, target)`（`static/prompt-document.js`）是正向推荐上下文的唯一来源：`base` → 仅 Base positive；`char:N` → Base + Character N；`global_uc` / `char:N:uc` → 无正向推荐（返回 `[]`）。
- `selectedTagKeysForTarget(document, target)` 让推荐去重变为 target-local：Character 1 的已选标签不会过滤 Character 2 的推荐。
- Visual Composer 不再持有第二份 workspace/target 状态：始终跟随 `PromptBridge.getActiveTarget()`；`_workspaceOverride` 与 `selectWorkspace` 已移除。
- Inspector 的「已选」按当前语义节点分区（section）局部显示（未选中节点时返回全部）。
- Tag Assistant 目录按 active target 感知（base vs character 根，不混合）；UC 目标不参与正向推荐。

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
| `config/prompt_navigation.json` | 语义导航骨架（Base/Character 概念树与推荐 seed 上下文，随仓库维护） |
| `server/server.mjs` | Node 服务入口：静态面板、Python 路由代理、SSE、官方 API 生图路由 |
| `server/novelai-provider.mjs` | NovelAI 官方 API payload 构建与响应解析 |
| `server/generation-request.mjs` | 生图请求规范化与模型默认值 |
| `server/api-batch.mjs` | 1–6 张严格串行批次控制器 |
| `static/` | 前端（index.html / app.js / app.css / prompt-compiler.js / prompt-document.js / nai-structured.js / nai-input-keys.js） |
| `static/tag-assistant.js` + `static/tag-assistant.css` | Tag Assistant 独立组件（推荐 / 目录 / 搜索 / 收藏四入口，消费 PromptBridge，见「Tag Assistant 集成契约」） |
| `static/visual-builder.js` + `static/visual-builder.css` | Visual Prompt Builder 独立组件（语义卡片 + chip 编辑，消费 PromptBridge 全量 action，见「Visual Prompt Builder 集成契约」） |
| `static/nsfw-builder.js` + `static/nsfw-builder.css` | NSFW Scene Builder 独立组件（strict exclusive groups / 成人上下文，消费 PromptBridge，见「NSFW Scene Builder 集成契约」） |
| `prompt/recommendation.py` + `prompt/related_client.py` + `prompt/auto_split.py` + `prompt/semantics.py` | Recommendation V2（多源 RRF）+ 远程 related adapter + 确定性 Auto-Split proposal + 语义 helper |
| `data/` | 本地 SQLite、图库与可选用户种子（已 gitignore；运行目录与数据库首次启动自动创建） |

## 快速开始

环境要求：**Python 3.10+**、**Node.js 22.5+**（生图依赖 Node 层；若本机没有，可用 `NODE_BIN` 指向可执行文件，或将 Node 放到 `$WORKBUDDY_HOME/binaries/node/` 下）。

### 安装依赖并启动

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
npm install                          # Node 层运行时依赖（undici、jszip）
python app.py
```

Windows（PowerShell）：

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
npm install
.venv\Scripts\python app.py
```

> `npm install` 只安装源码真实用到的两个运行时依赖（`undici` 代理支持、`jszip` 官方响应解压），不涉及任何前端构建。安装产物落在仓库根目录 `node_modules/`（已 gitignore）。

### 访问

- **统一面板入口：<http://127.0.0.1:8787>**（Node 服务，含前端与 API 代理，推荐）
- FastAPI 直连：<http://127.0.0.1:8123>（标签 / 图库 / 设置 API）

启动 `app.py` 后会自动检测并拉起 Node 服务（127.0.0.1:8787），无需另开终端；退出 Python 应用时，本次自动启动的 Node 子服务也会一起退出。若 8787 已由用户手工启动，则会直接复用且不会关闭它。多实例防互杀：某个实例因端口被占而启动失败、即将退出时不会误杀仍在健康服务的 node。

本地启动默认开启 Python 自动重载与 Node 文件监听；需要稳定运行时设置 `TAGS_MARKET_RELOAD=0` 再启动。自动启动失败时查看 `.workbuddy/runtime/novelai-service.log`；如需关闭自动启动，设置 `TAGS_MARKET_AUTOSTART_NAI=0`。

### 单独启动 Node 层（可选）

```bash
./server/start-nai.sh          # Linux / macOS：启动 Node 联动层（8787，官方 API-only）
```

脚本使用 POSIX `sh`，不依赖 zsh、Edge、CDP 或图形桌面。它使用 `$HOME/.workbuddy` 作为默认本机目录（可用 `WORKBUDDY_HOME` 覆盖），Node 可用 `NODE_BIN` 指定。生图只走 NovelAI 官方 API。

Node 依赖加载方式：`server/novelai-provider.mjs` 通过 `require("undici")` / `require("jszip")` 加载，按标准 Node 解析从 `server/` 向上找到仓库根目录的 `node_modules/`——即 `npm install` 后的产物。为兼容本机 WorkBuddy 托管环境，`start-nai.sh` 与 `app.py` 会额外把 `NODE_PATH` 指向 `$WORKBUDDY_HOME/binaries/node/workspace/node_modules` 作为**可选 fallback**；这不是运行前提，`npm install` 后使用任意系统 Node 22.5+ 即可独立运行。

### Linux 服务器运行与部署

推荐 Ubuntu / Debian 等常规 Linux 发行版。项目默认只监听 `127.0.0.1`，服务器部署时建议保留这一方式，通过 SSH 隧道访问，不直接暴露 8123 / 8787。

首次部署：

```bash
git clone https://github.com/Mcfate-code/novelai-prompt-market.git
cd novelai-prompt-market
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
TAGS_MARKET_RELOAD=0 python app.py
```

服务启动后，FastAPI 位于 `127.0.0.1:8123`，Node 统一入口位于 `127.0.0.1:8787`。从自己的电脑访问服务器时：

```bash
ssh -N -L 8787:127.0.0.1:8787 用户名@服务器地址
```

随后本机浏览器打开 `http://127.0.0.1:8787`。NovelAI Token 可在设置页保存，也可通过服务器环境变量 `NOVELAI_API_KEY` 提供。

需要常驻运行时可建立 `/etc/systemd/system/novelai-prompt-market.service`：

```ini
[Unit]
Description=NovelAI Prompt Market
After=network-online.target

[Service]
Type=simple
User=你的Linux用户名
WorkingDirectory=/opt/novelai-prompt-market
Environment=TAGS_MARKET_RELOAD=0
ExecStart=/opt/novelai-prompt-market/.venv/bin/python app.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

如果 Node 不在 systemd 的 `PATH` 中，在 `[Service]` 增加 `Environment=NODE_BIN=/实际/node/路径`。仓库的 `.github/workflows/linux.yml` 会在 Ubuntu 上验证 fresh-clone 首次启动、POSIX shell、8123/8787 双服务和现有回归测试。

### macOS 常驻运行（可选）

`bash install-launchagent.sh` 安装 LaunchAgent 使服务开机常驻，日志位于 `$HOME/Library/Logs/TagSupermarket/`；故障排查可用仓库根目录的 `标签超市-诊断.command`。关闭窗口 ≠ 停止服务。

### 首次使用

1. 打开面板 → 设置页：
   - 填写 **NovelAI Persistent API Token**（生图与例图必需，只保存在本机，也可用环境变量 `NOVELAI_API_KEY`）。
   - 可选：Danbooru 账号 / API Key（更新标签库与抓取例图）、百度翻译凭据、代理。
2. 全新 clone 不要求私有 `config/app_settings.json` 或 `data/*.json`：SQLite 与基础目录会自动创建，目录使用仓库内 `config/navigation.default.json`。
3. 若已有本地 `data/navigation.json`，它会覆盖默认导航；若放置 `data/taxonomy_seed.json`，首次启动会导入该人工 taxonomy。两者都不是启动必需项。
4. 全新空库可在设置页点击「更新标签库」，从 Danbooru 同步实际标签数据。

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
| `NODE_BIN` | 指定 Node.js 22.5+ 可执行文件 |
| `NOVELAI_API_KEY` | NovelAI Persistent API Token |
| `DANBOORU_API_KEY` | Danbooru API Key |
| `BAIDU_TRANSLATE_APPID` / `BAIDU_TRANSLATE_SECRET` | 百度翻译凭据 |
| `TAGS_MARKET_RELOAD` | 设为 `0` 关闭开发热重载 |
| `TAGS_MARKET_AUTOSTART_NAI` | 设为 `0` 关闭 Node 服务自动启动 |

### 项目级配置

- `config/app_settings.json`：可选本机覆盖（端口 / 主机 / `proxy.enabled`·`proxy.url` 出网代理兜底 / 受限 taxonomy 路径等），已被 gitignore；缺失时使用内建默认值，不阻塞启动。
- `config/navigation.default.json`：随仓库维护的最小默认目录；本地存在 `data/navigation.json` 时优先使用本地版本。
- `config/model_overlays.json`：模型能力语义，随仓库维护。

出网代理的生效优先级：用户设置 `proxy_enabled`/`proxy_url`（或环境变量 `NAI_PROXY_URL`）> `config/app_settings.json` 的 `proxy.enabled`/`proxy.url` 兜底；用户设置关闭代理（`proxy_enabled=false`）时强制直连。

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
| `GET /api/taxonomy` / `GET /api/catalog` | 分类浏览树 / 目录树（`?semantic=1` 返回语义导航树） |
| `GET /api/catalog/semantic` | 语义导航树专用路由（Base/Character 概念骨架，可 `node_id` 下钻） |
| `GET /api/zh` / `POST /api/zh-notes` | 中文名映射 / 自定义中文备注 |
| `GET /api/thumbs` | 标签例图 URL（懒抓取 + 本地缓存） |
| `GET/POST /api/settings` | 读取 / 保存用户设置（凭据不回显） |
| `GET /api/runtime-info` | 前后端运行契约版本检查，避免静态页面与旧后端进程错配 |
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
| `POST /api/cooccurrence/record` / `POST /api/recommendations` / `GET /api/conflicts` | 共现记录 / 确定性推荐（Recommendation V2 多源 RRF + 语义节点与成人上下文）/ 冲突提示 |
| `POST /api/prompt/auto-split` / `GET /api/nsfw-builder/options` | 确定性 Auto-Split proposal（不修改文档）/ Scene Builder 候选（受限分类真实 tag） |
| `POST /api/templates/import/text` / `POST /api/templates/import/file` | 导入文本或本地 PNG/JSON 元数据，生成待审核成人姿势模板 |
| `POST /api/templates/import/civitai` | 按 Civitai 图片 ID/URL 读取公开元数据并生成待审核模板 |
| `GET /api/templates?status=pending|approved|blocked|all` / `POST /api/templates/{id}/review` | 查看候选或已审核模板 / 批准或拒绝候选（成人模式） |
| `POST/GET /api/snapshots` / `POST /api/snapshots/{id}/restore` | PromptSnapshot 创建 / 分区恢复 |
| `GET /api/gallery` / `POST /api/gallery/import` / `POST /api/gallery/item` | 图库列表 / zip 导入 / 图片回写 |
| `POST /api/gallery/favorite` / `DELETE /api/gallery/{dir}` | 图库收藏 / 删除（移入待清理） |
| `GET /api/novelai-examples` / `POST /api/novelai-examples/{tag}` | 标签例图查询 / 生成 |
| `POST /api/cache/clear` / `POST /api/novelai-examples/clear` | 缓存清理 |
| `GET /api/models` / `GET /api/overlay/{model_id}` | 模型列表 / 模型能力 |
| `GET /api/offline-prior/status` | 离线先验交付契约状态（available / path / node_count / source_count，见「Offline Prior（数据先验）」） |
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

### Visual Workspace V2

Visual Workspace 使用 Semantic Prompt Composer：固定语义节点总览与右侧 Inspector，节点显示已选数量和最多三个摘要，Inspector 提供当前目标的上下文推荐、加标签、权重和删除操作。Base 与角色共用一个全局 Target Bar；Text、Visual、Tag Assistant、NSFW Scene Builder 都通过 `PromptBridge` 观察同一个 active target。

`PromptDocument` schema v2 是唯一状态源。角色增删、移动、重命名、位置编辑和文本 reconciliation 全部通过 PromptBridge action 完成；生图请求从文档即时生成 Base、Global UC 与逐角色 prompt/UC/position projection，避免 `naiCharacters` 成为第二份业务状态。无效的 `char:N` mutation 会被拒绝，不会回退污染 Base。

Visual 推荐向 `/api/recommendations` 发送当前文档、active target、semantic node 和 assistant context；仅在请求失败或无结果时使用节点 seed tags。NSFW 上下文从 `assistant_context` 即时 hydration，活动开启会添加 canonical tag，关闭会移除对应 tag，并同步上下文。

```bash
# Python（后端）
python -m unittest discover -s tests

# Node（服务端 + Prompt Compiler）
node --test server/*.test.mjs tests/test_prompt_compiler.mjs
node --test tests/test_app_helpers.mjs
node --test tests/test_prompt_document.mjs
node --test tests/test_tag_assistant.mjs
node --test tests/test_visual_builder.mjs
node --test tests/test_nsfw_builder.mjs
node --test tests/test_nai_structured.mjs
node --test tests/test_nai_input_keys.mjs
node --test tests/test_phase2_integration.mjs

# 前端 / 服务端语法检查
node --check static/app.js
node --check static/tag-assistant.js
node --check static/visual-builder.js
node --check static/nai-input-keys.js
node --check server/server.mjs
```

测试中的 taxonomy / 中文别名使用 `tests/fixtures/` 内的最小固定数据，不依赖 `.gitignore` 的本机 `data/`。

当前回归基线（非付费）：Python 182 项（含 Recommendation V2 / Auto-Split 与 Phase 2 集成）、Node `npm test` 287 项全部通过；覆盖搜索、拼音、导入、Bundle、Snapshot、图库、NovelAI payload、串行批次、取消、翻译、设置、推荐（V2 RRF / 语义节点 / 成人上下文 / adolescent gating）、Tag Assistant 四入口、Visual Builder 语义卡片与 chip 编辑与防互杀守卫、NSFW Scene Builder 严格互斥组 / 多选活动 / 位置与逐角色服装作用域、Auto-Split（含权重 / 结构化不重拆）、assistant_context 随 snapshot 保留且不泄漏进编译 Prompt、图库恢复参数后的结构化多角色重建、autocomplete 方向键/Tab 接受追加 `, `/Esc 关闭/单 Enter 换行/Enter×2 生成一次/IME composing/弹窗主题 scope。

### Prompt 语法 Codec（`static/prompt-tokenizer.js`）

前端唯一规范的 NovelAI Prompt 语法编解码器，语义与 Python 参考实现一致：`prompt/import_parser.py`（`split_tags` / `parse_entry`）、`prompt/composer.py`（`format_number`）、`prompt/novelai_export.py`（`format_entry`）。`static/prompt-document.js` 与 `static/prompt-compiler.js` 均通过它完成 token 拆分 / 解析 / 序列化。

- `splitPromptTokens(text)`：按逗号拆分，`::…::` 权重包裹内的逗号不拆（成对切换 `inWeight`），trim 后丢弃空 token。
- `parsePromptToken(token)`：解析为 `{ raw, tag, weight, weighted, relation, brackets, strength }`；支持负数权重 `-1::hat::`、关系前缀 `source#/target#/mutual#`、强调层级 `{{}}`/`[[]]`。
- `serializePromptToken(entry)`：反向序列化（关系前缀 → 权重包裹 → 括号层级 → 原样 tag），与 `format_entry` 一致；`.8` 归一化为 `0.8`，`weight === 1` 不写包裹。
- `tokenRangeAtCaret(text, caret)`：返回光标所在 token 的 `{ index, start, end, token, raw, parsed }`（逗号归左侧 token）。
- `joinPromptTokens(tokens)`：以 `", "` 连接 token。

测试：`tests/test_prompt_tokenizer.mjs`（拆分 / 解析 / 序列化 / 往返 / 光标范围 / 编译集成）。

### 本地工作流提示

- 开发期默认热重载（Python + Node 文件监听），稳定运行设 `TAGS_MARKET_RELOAD=0`。
- `importer/backfill_pinyin.py` 可幂等回填拼音列（首次导入或词库更新后）。
- 删除图库目录是软删除：先移入 `待清理/图库/`，再移除活动索引。

## 许可证与免责声明

- 仓库当前**未包含 LICENSE 文件**；在作者明确许可证之前，请仅将本仓库用于个人学习与参考。
- 本项目与 NovelAI 官方无关联，`NovelAI` 及相关商标归其所有者所有；生图 / 例图会消耗 NovelAI 账户 Anlas，所有付费请求均需用户明确确认。
- 项目完全本地运行，标签数据来自 Danbooru（含语义检索代理服务），请遵守相应平台的使用条款。

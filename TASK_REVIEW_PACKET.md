# TASK_REVIEW_PACKET.md

## 1. 任务目标

- 修复 NovelAI 无法连接。
- 修复标签例图不加载。
- 合并重复的“收藏 / 最近使用”等导航入口。
- 参考成熟 NovelAI 面板，改善单一入口、连接状态、错误分类与请求超时。
- 完成自动测试和桌面/移动端浏览器验收；不触发付费生图。
- 移除 CDP、NovelAI 网页和网页兼容模块，正式生图统一走 NovelAI 官方 API。
- 尺寸档位采用官方 Small / Normal / Large 分类，映射为项目固定 API 宽高预设，并按官方批次数量限制生图。
- 标签例图增加前端确认与 Python/Node 服务端双层 Anlas Gate，未确认不得调用官方生图。

## 2. 最终状态

Status: COMPLETE

用户报告的连接、例图和重复导航均已修复并通过真实本地浏览器验收。付费生图 Gate 不属于本次非付费修复验证，仍维持项目原有 PARTIAL 边界。

## 3. 输入与依据

- `server/server.mjs`
  用途：确认 Node 面板静态文件路由、NovelAI API、SSE 和兼容层端点。
- `server/novelai-provider.mjs`
  用途：确认 Token、代理、官方图片 API 和错误映射。
- `static/index.html`、`static/app.js`、`static/app.css`
  用途：定位重复导航、例图加载死锁和连接状态展示。
- `app.py`
  用途：确认 FastAPI 标签、例图、图库和设置 API 可用。
- GitHub 公开项目与 SDK资料
  用途：确认账户端点已迁移到 `image.novelai.net/user/subscription`，并参考连接状态与错误处理。

## 4. 原始实现 / 原始工作流

```text
8123 FastAPI：完整标签/例图/图库 UI
8787 Node：NovelAI API + 半套静态面板

Node /static/app.js -> static/static/app.js -> 404
Node 未代理 FastAPI 数据接口
HTML 同时存在顶部、二级栏、侧栏三套导航
例图 img: loading=lazy + display:none -> 浏览器不加载 -> onload 永不触发
状态接口只报告 Token 已配置，不验证真实网络/认证
```

## 5. 改动后的架构图

```text
浏览器 -> 127.0.0.1:8787（统一入口）
              |
              +-- [CHANGE] /static/* -> 项目 static/*
              +-- [KEEP] /api/novelai/*、/events -> Node
              +-- [CHANGE] V2 数据 API、/gallery/* -> FastAPI 8123
              +-- [CHANGE] /api/legacy/* -> 旧兼容层

NovelAI 状态 -> [NEW] image.novelai.net/user/subscription 只读探测
例图 -> [CHANGE] 图片保留布局、加载前 opacity:0、onload 后显示
导航 -> [CHANGE] 单一顶部主导航
```

## 6. 实际执行过程

### Step 1 - 确认根因

验证 `8787/static/app.js` 为 404、`8787/app.js` 为 200；确认 HTML 存在三套同类导航；确认 `8123/api/thumbs?tags=1girl` 能返回本地图片路径。

### Step 2 - 统一入口

修复 Node 的 `/static/*` 映射，并为 FastAPI V2 API、图库文件建立显式白名单代理。把 Node 旧预设和同步端点迁到 `/api/legacy/*`，避免 `/api/presets`、`/api/sync` 同名冲突。

### Step 3 - NovelAI 连接诊断

新增只读账户探测与超时。初始使用旧域名 `api.novelai.net` 返回 400；依据公开 SDK 最新迁移说明改为 `image.novelai.net/user/subscription`。真实本机状态返回 `connected`，网络经本机代理连通（代理地址为本机个人配置，已脱敏）。

### Step 4 - 导航与错误提示

移除二级栏和侧栏重复入口，只保留“标签 / 收藏 / 最近 / 图库 / 生图”。前端区分未配置、服务未启动、网络错误、超时、认证错误、余额不足和限流。

### Step 5 - 修复例图死锁

浏览器实测 API 有路径但 `naturalWidth=0`。定位到 `loading="lazy"` 与 `display:none` 组合导致浏览器不发起图片请求，而代码又等待 `onload` 才显示。改为 `display:block; opacity:0`，加载完成后 `opacity:1`。

## 7. 关键决策记录

| 决策 | 依据 | 最终动作 |
| --- | --- | --- |
| 统一使用 8787 | 双入口各自只有半套功能 | Node 代理 FastAPI 数据层 |
| 使用显式代理白名单 | 避免生图端点误转发并限制攻击面 | 仅列出 V2 API 与图库路径 |
| 旧兼容端点改 `/api/legacy/*` | 与 V2 `/api/presets`、`/api/sync` 冲突 | 分离命名空间 |
| 状态探测使用图片域名 | 旧账户域名明确提示迁移 | 改为 image.novelai.net |
| 不做测试生图 | 会真实消耗 Anlas | 只做只读认证与网络探测 |

## 8. 文件修改记录

| 文件 | 修改内容 |
| --- | --- |
| `server/server.mjs` | 静态路由、FastAPI 白名单代理、统一入口、健康状态、legacy 路由 |
| `server/novelai-provider.mjs` | 只读连接探测、正确账户域名、请求超时、错误映射复用 |
| `server/server-routing.test.mjs` | 新增真实 HTTP 路由集成测试 |
| `server/novelai-provider.test.mjs` | 新增连接成功和 401 映射测试 |
| `static/index.html` | 合并为单一主导航 |
| `static/app.js` | 同源 Node 地址、连接状态和错误提示、legacy 端点 |
| `static/app.css` | 主导航激活态、例图加载显示修复 |
| `README.md` | 统一入口和当前验证边界 |

## 9. README 更新

README updated: YES

## 10. 失败与调整

### Failure 1

初始只读探测请求 `api.novelai.net/user/subscription` 返回 HTTP 400，并提示第三方工具迁移到 image URL。查阅当前 SDK 资料后改为 `image.novelai.net/user/subscription`，真实返回 connected。

### Failure 2

例图 API 返回成功，但浏览器图片仍为 `naturalWidth=0`。静态图片响应实际为 200，进一步定位为 lazy 图片与 `display:none` 的加载死锁；CSS 修正后图片实际解码。

### Failure 3

首选浏览器 CLI 未安装，改用本机已配置的 Edge 自动化通道完成验收；会话已正常关闭。

### Failure 4

最终外部送审时 ChatGPT 登录态已过期，只显示登录页；未触碰账号凭据并正常关闭会话。随后启动的独立只读审阅代理超出执行轮次上限，未返回有效结论。因此本包不声称已完成外部审阅，最终结论来自人工代码复核、自动测试和真实浏览器验收。

### Review hardening

人工复核发现 `proxyToPython()` 直接以 `req.url` 构造目标 URL，普通浏览器请求无异常，但绝对形式 request-target 理论上可能覆盖上游 host。已改为仅提取 pathname 和 search，再以固定 `PYTHON_APP_URL` 构造目标；同时补充请求体转发、非本机 Origin 拦截和绝对形式 URL 不得逃逸的集成测试。另移除已删除侧栏导航遗留的无效 CSS。

## 11. 验证记录

### Check 1 - 自动回归

目标失败：路由重排破坏既有 V2 或 NovelAI 请求契约。

实际结果：PASS。Python `86/86`；Node `19/19`；JavaScript/Node 语法与 `git diff --check` 通过。路由集成测试还覆盖 query、POST body、非本机 Origin 拒绝和绝对形式 request-target 固定到 FastAPI 上游；批次测试覆盖 `error_code`、`error_message`、`correlation_id` 持久化，设置测试覆盖未确认例图请求的 Anlas Gate。

### Check 2 - 统一入口

目标失败：`/static/app.js`、标签 API 或缩略图仍无法通过 8787 访问。

实际结果：PASS。首页和 JS 为 200；`/api/thumbs` 返回路径；缩略图为 `200 image/jpeg`。

### Check 3 - NovelAI 真实只读连接

目标失败：Token 已保存但网络、代理或认证不可用。

实际结果：PASS。状态为 `connected`，网络经本机代理连通（代理地址为本机个人配置，已脱敏）。

### Check 4 - 例图端到端

目标失败：DOM 有 URL 但浏览器未解码图片。

实际结果：PASS。搜索 `1girl` 后首批图片 `naturalWidth=151-180`，`opacity=1`，45 张已加载、失败数 0。

### Check 5 - 桌面与移动布局

目标失败：重复导航、横向溢出或移动端错位。

实际结果：PASS。桌面 `scrollWidth=innerWidth=1432`；iPhone 14 `scrollWidth=innerWidth=390`；均只有五个主入口。

### Check 6 - API-only 与 Anlas Gate 冒烟

实际结果：PASS。`/api/status` 返回 `{"mode":"api-only","cdp":"disabled","webCompatibility":false}`；`/api/nai-state` 与 `/api/legacy/presets` 均为 `404`；未携带 `confirm_anlas` 的 `/api/novelai/tag-example` 返回 `428` 与 `ANLAS_CONFIRMATION_REQUIRED`。本轮未调用真实付费生图。

## 12. 关键证据

1. `/api/novelai/status` 返回 `{"ok":true,"configured":true,"state":"connected"...}`。
2. 浏览器生图视图显示“NovelAI 已连接 · 本机代理”，Generate 可用。
3. 例图首批 `complete=true` 且 `naturalWidth>0`。
4. Python 86 项、Node 19 项全部通过。
5. 验收截图：`outputs/fixed-desktop.png`、`outputs/fixed-mobile.png`。

## 13. 未解决问题

1. 未执行真实付费生图，因此单张/多张付费 Gate、实网 402/429 未在本轮触发。
2. 当前已切换为官方 API-only：Node 不再等待或连接 Edge/CDP，不依赖 NovelAI 网页页面；正常使用仍需 FastAPI 8123 与 Node 8787（由 `app.py` 自动启动时可复用统一入口）。
3. 官方文档明确的是 Small/Normal/Large 类别与批次数限制；面板像素值属于本项目对 API `width`/`height` 的固定预设，未将未公开完整枚举冒充官方原文。
4. Small 预设最多生成 6 张，Normal/Large 预设最多生成 4 张；官方 API 批次在本地串行执行，每次请求固定生成一张。
5. 标签例图仅在前端明确确认且请求携带 `confirm_anlas: true` 时允许执行；Python 与 Node 直达接口均返回 `428 ANLAS_CONFIRMATION_REQUIRED` 阻断未确认请求，命中已有缓存仍为只读。

## 14. 与原目标的对应关系

| 原要求 | 结果 | 证据 |
| --- | --- | --- |
| NovelAI 无法连接 | 完成 | 真实只读状态 connected |
| 例图不加载 | 完成 | 图片实际解码，naturalWidth > 0 |
| 收藏/最近出现两行 | 完成 | 只保留单一顶部导航 |
| 排查其他 bug | 完成 | 修复静态路由、双入口和同名 API 冲突 |
| 参考成熟项目 | 完成 | 采用连接状态、错误分类、超时、单一入口与当前账户域名 |

## 15. 最终产物

- 修复后的项目代码。
- `server/server-routing.test.mjs` 路由回归测试。
- `outputs/fixed-desktop.png`、`outputs/fixed-mobile.png`。
- 更新后的 `README.md` 和本审阅包。
- 当前统一入口：`http://127.0.0.1:8787`。

# EXTERNAL REVIEW REQUEST

请重点检查代理白名单与路由优先级、只读 NovelAI 探针是否可能消费 Anlas、官方 API-only 路由是否完整、尺寸类别与批次数限制是否一致，以及例图 lazy/display 修复是否覆盖真实失败模式。若无实质问题请明确说明。

===== REVIEW HANDOFF =====

任务：修复 NovelAI 连接、例图不加载、重复导航和双入口问题。

最终状态：COMPLETE（本次报告故障均修复；未执行付费生图）。

关键改动：8787 统一入口；FastAPI 白名单代理；静态路由修复；image.novelai.net 只读连接探测；单一导航；例图加载死锁修复；官方 API-only；Small/Normal/Large 尺寸档位；失败批次错误详情持久化。

关键证据：NovelAI 状态接口可用；例图 naturalWidth>0；尺寸档位不再依赖网页状态；API-only 状态返回 `cdp: disabled`；Python 86/86、Node 19/19 回归测试通过；桌面布局无横向溢出；未确认例图请求被 428 Anlas Gate 阻断。

未解决问题：未执行付费单张/六张和实网 402/429 Gate；正式生图仍需用户在界面明确发起并承担 Anlas 消耗。

README：UPDATED

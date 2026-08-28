# 成人姿势模板导入

模板导入只进入 NSFW Builder，不进入通用标签推荐。流程为：读取元数据 → 提取正/负面 Prompt → 删除角色、画风、LoRA、质量词 → 保留姿势、动作、角色关系、镜头 → 本地标签校验 → 候选审核 → 已审核模板。

## 支持的输入

- 本地 PNG：A1111/Forge 的 `parameters`、NovelAI 的 JSON/iTXt/tEXt 元数据、ComfyUI 的 `workflow`/`prompt`。
- 本地 JSON/Workflow JSON。
- Prompt 文本（支持 `Negative prompt:`、`Steps:` 和 `source#`/`target#` 关系）。
- Civitai 单张图片 ID 或 `https://civitai.com/images/<id>` 地址；只读取公开元数据，不下载原图。

Civitai 请求复用设置页的 HTTP/HTTPS 代理（`proxy_enabled` / `proxy_url`）；关闭代理时使用直连。

## 页面使用

打开成人模式 → NSFW Builder → 成人姿势模板 → 输入 Civitai 图片 ID/URL，或选择本地文件。导入后先出现在“候选”区，展开候选可查看姿势、镜头、角色关系、移除项、未识别项和评分；候选保存在本地数据库，刷新页面后仍可继续处理。确认后点击“批准加入”或“拒绝”。已批准模板会出现在姿势按钮中，并只替换角色动作、关系和镜头，不改角色身份、画风或生成参数。

## API

```text
POST /api/templates/import/text       {"text":"..."}
POST /api/templates/import/file       multipart: upload=<png/json/txt>
POST /api/templates/import/civitai    {"image_id_or_url":"123"}
GET  /api/templates?status=pending|approved|all
POST /api/templates/{id}/review       {"status":"approved|rejected","note":"..."}
```

年龄相关标签（例如未成年或年龄歧义词）会自动进入 `blocked`，不能批准到成人模板库。Civitai 来源只接受 `civitai.com` 域名，避免任意 URL 抓取。

## 数据落点

- `prompt/metadata_readers/`：PNG、A1111、ComfyUI、NovelAI 元数据读取。
- `prompt/template_distill.py`：姿势/动作/构图蒸馏与安全、完整度评分。
- `prompt/template_import.py`：本地和 Civitai 导入编排。
- `db.py`：`template_source`、`pose_template`、`pose_template_tag`、`template_review`。
- `static/nsfw-builder.js`：候选审核和已审核模板的操作入口。

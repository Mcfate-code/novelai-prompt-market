"""构建期标签富化：从 tags.sqlite 生成确定性 enhanced text（§7/§8）。

格式：``<tag> | zh: <zh_name> | aliases: <a1>, <a2> | section: <section> | taxonomy: <l1>/<l2>/<l3>``
缺失字段一律省略；绝不臆造描述或 taxonomy（§7 禁止）。通过 ``import db; db.get_conn()``
读取 tags.sqlite（复用项目连接约定，不硬编码 sqlite 路径）。

同时提供：
- ``iter_canonical_tags``：过滤 is_deprecated=0、排除 artist（category 1）与站务块名单，
  按 post_count 降序输出 (tag_key, meta)。
- ``TAXONOMY_L1_TO_NODE``：taxonomy_map.category_l1 → 语义槽位 node_id 的确定性映射（§27 来源之一）。
- ``build_adult_set``：NSFW/成人标签集合，用于 safety_scope 标注（§37/§38）。
"""
from __future__ import annotations

import json
from pathlib import Path

import db

BASE_DIR = Path(__file__).resolve().parent.parent.parent

# 站务 / 纯元数据标签（不参与 embedding 语义映射）。不排除 masterpiece / best quality。
BLOCKLIST = {
    "tagme", "translation request", "commentary request", "bad id", "bad link",
    "copyright free", "photo", "no humans", "english text", "japanese text",
    "chinese text", "watermark", "signature", "artist name", "artist request",
    "comic", "manga", "doujinshi", "4koma", "webtoon", "alternative version",
}

INCLUDE_CATEGORIES = {0, 3, 4, 5}  # 排除 artist(1)；meta(5) 保留但受 BLOCKLIST 约束
DEFAULT_MIN_POST_COUNT = 10

# taxonomy_map.category_l1 -> node_id（只覆盖可确定映射；None 表示交还 embedding 判定）
TAXONOMY_L1_TO_NODE = {
    "人物数量与主体": "char_identity",
    "成人与人物类型（通用）": "char_identity",
    "发型": "char_hair",
    "头发长度与状态": "char_hair",
    "头发颜色": "char_hair",
    "眼睛颜色": "char_eyes",
    "瞳孔与眼部细节": "char_eyes",
    "视线与眼睛状态": "char_eyes",
    "面部特征与妆容": "char_face",
    "表情与情绪": "char_expression",
    "身材与体型": "char_body",
    "肤色与皮肤": "char_body",
    "胸部（成人角色使用）": "char_body",
    "幻想身体部件": "char_body",
    "基础姿势": "char_pose",
    "手臂与手势": "char_pose",
    "移动与动态动作": "char_action",
    "道具交互与生活动作": "char_action",
    "双人/多人非性互动": "char_action",
    "服装状态与动作": "char_clothing",
    "上装": "char_clothing",
    "下装": "char_clothing",
    "外套": "char_clothing",
    "连衣裙、制服与套装": "char_clothing",
    "泳装、内衣与贴身衣物（成人使用）": "char_clothing",
    "和服、传统与幻想服饰": "char_clothing",
    "腿部穿着": "char_clothing",
    "鞋类": "char_clothing",
    "颈部、手部与配饰": "char_clothing_accessory",
    "帽子与头饰": "char_clothing_accessory",
    "眼镜、面部与穿戴物": "char_clothing_accessory",
    "室内场景": "env_indoor",
    "家具与室内物件": "base_objects",
    "建筑外景": "env_outdoor",
    "城市与街道": "env_outdoor",
    "自然地貌": "env_outdoor",
    "天空与天体": "env_outdoor",
    "水体与水下": "env_outdoor",
    "植物与花": "base_objects",
    "动物与生物": "base_objects",
    "食物": "base_objects",
    "饮品与容器": "base_objects",
    "交通工具": "base_objects",
    "武器与战斗道具": "base_objects",
    "乐器": "base_objects",
    "数码与通讯": "base_objects",
    "书写、学习与办公": "base_objects",
    "光照": "base_lighting",
    "天气与季节": "base_time_weather",
    "时间": "base_time_weather",
    "构图与主体安排": "base_composition",
    "画面景别与裁切": "base_composition",
    "镜头角度与观察方向": "base_composition",
    "透视与空间感": "base_composition",
    "对焦、模糊与运动表现": "base_composition",
    "艺术风格与视觉语言": "base_style",
    "艺术媒介": "base_style",
    "年代与氛围": "base_style",
    "色彩与调色": "base_style",
    "特效与画面质感": "base_style",
    "版式、漫画与文字": "base_style",
    "绘制与上色方式": "base_style",
    "魔法与超自然": "base_objects",
    "科幻与机械": "base_objects",
    "质量、美学与数据集特殊标签": "quality",
    "NSFW·成人亲密与性行为": "char_action",
    "NSFW·成人姿态与镜头": "char_pose",
    "NSFW·成人裸露与身体": "char_body",
    "NSFW·成人情趣服饰与配件": "char_clothing",
    "NSFW·成人体液与事后状态": "char_body",
    "NSFW·成人性交体位与姿势": "char_pose",
    # 以下故意留空（None）→ 交还 embedding 判定：
    #   题材与场景主题 / 背景基础 / 常用背景/内容排除 / Undesired Content·* / V5 专用
}


def normalize_tag(value) -> str:
    """与 prompt/prior.py 的 _norm 一致：小写、下划线转空格、折叠空白。"""
    return " ".join(str(value or "").strip().lower().replace("_", " ").split())


def build_enhanced_text(tag, *, zh=None, aliases=None, section=None, taxonomy=None) -> str:
    """确定性 enhanced text（字段缺失即省略）。tag 为 prompt 空格形式显示名。"""
    parts = [str(tag).strip()]
    if zh:
        parts.append(f"zh: {zh}")
    if aliases:
        parts.append("aliases: " + ", ".join(str(a) for a in aliases))
    if section:
        parts.append(f"section: {section}")
    if taxonomy:
        parts.append(f"taxonomy: {taxonomy}")
    return " | ".join(parts)


def _fetch_aliases(conn, danbooru_name: str, limit: int = 6) -> list[str]:
    rows = conn.execute(
        "SELECT alias FROM tag_aliases WHERE canonical_name=? ORDER BY alias LIMIT ?",
        (danbooru_name, limit),
    ).fetchall()
    return [r["alias"] for r in rows]


def _fetch_taxonomy(conn, prompt_tag: str) -> str | None:
    """taxonomy_map.tag_name 为 prompt 空格形式（如 'blue eyes'），不是下划线形式。"""
    row = conn.execute(
        "SELECT category_l1, category_l2, category_l3 FROM taxonomy_map "
        "WHERE tag_name=? ORDER BY sort_order LIMIT 1",
        (prompt_tag,),
    ).fetchone()
    if row is None:
        return None
    parts = [row["category_l1"]]
    for key in ("category_l2", "category_l3"):
        v = row[key]
        if v:
            parts.append(v)
    return "/".join(parts)


def _fetch_section_override(conn, prompt_tag: str) -> str | None:
    """tag_section_override.tag_name 为 prompt 空格形式；大小写不敏感匹配。"""
    row = conn.execute(
        "SELECT section FROM tag_section_override WHERE lower(tag_name)=lower(?)",
        (prompt_tag,),
    ).fetchone()
    if row is None:
        return None
    return str(row["section"]).lower()


def build_meta(conn, tag_row) -> dict:
    """把一个 tags 行组装成富化元信息 dict。"""
    danbooru_name = tag_row["danbooru_name"]
    prompt_tag = tag_row["prompt_tag"] or db.prompt_form(danbooru_name)
    zh = tag_row["zh_name"] or ""
    aliases = _fetch_aliases(conn, danbooru_name)
    taxonomy = _fetch_taxonomy(conn, prompt_tag)
    section = _fetch_section_override(conn, prompt_tag)
    return {
        "tag": normalize_tag(prompt_tag),          # 存储键（小写空格形式）
        "prompt_tag": prompt_tag,                   # 显示名
        "danbooru_name": danbooru_name,
        "zh_name": zh,
        "aliases": aliases,
        "taxonomy": taxonomy,
        "taxonomy_l1": (taxonomy.split("/")[0] if taxonomy else None),
        "section": section,
        "category": int(tag_row["category"] or 0),
        "post_count": int(tag_row["post_count"] or 0),
    }


def iter_canonical_tags(
    conn=None,
    *,
    include_categories=INCLUDE_CATEGORIES,
    exclude_artists=True,
    min_post_count=DEFAULT_MIN_POST_COUNT,
    limit=0,
    retain_tags=None,
):
    """产出 (tag_key, meta)。tag_key 为 normalize_tag(prompt_tag)。

    ``retain_tags``：即便 post_count < min_post_count 也要保留的提示词必需标签
    （如 masterpiece/best quality 等 post_count=0 的画质标签；§ REPO FACTS 明确要求
    「retaining useful prompt tags such as masterpiece/1girl/solo」）。由调用方传入
    prompt_navigation seed_tags 等精选集合。
    """
    own = conn is None
    if own:
        conn = db.get_conn()
    try:
        cats = set(include_categories)
        if exclude_artists:
            cats.discard(1)
        if not cats:
            return
        placeholders = ",".join("?" for _ in sorted(cats))
        retain = sorted({normalize_tag(t) for t in (retain_tags or set()) if normalize_tag(t)})
        block = sorted(BLOCKLIST)
        block_clause = (
            f" AND lower(prompt_tag) NOT IN ({','.join('?' for _ in block)})"
            if block else ""
        )
        if retain:
            rp = ",".join("?" for _ in retain)
            sql = (
                f"SELECT * FROM tags WHERE is_deprecated=0 AND category IN ({placeholders}) "
                f"AND (post_count>=? OR lower(prompt_tag) IN ({rp})) "
                f"{block_clause} ORDER BY post_count DESC"
            )
            params = sorted(cats) + [min_post_count] + retain + block
        else:
            sql = (
                f"SELECT * FROM tags WHERE is_deprecated=0 AND category IN ({placeholders}) "
                f"AND post_count>=? {block_clause} ORDER BY post_count DESC"
            )
            params = sorted(cats) + [min_post_count] + block
        if limit and limit > 0:
            sql += " LIMIT ?"
            params = params + [int(limit)]
        for row in conn.execute(sql, params):
            meta = build_meta(conn, row)
            yield meta["tag"], meta
    finally:
        if own:
            conn.close()


def build_adult_set(conn, *, nsfw_taxonomy_path=None, taxonomy_seed_path=None) -> set[str]:
    """汇总 NSFW/成人标签集合（用于 safety_scope='adult' 标注）。

    来源：nsfw_taxonomy.json 的 categories[].tags + taxonomy_map 中 category_l1
    以 'NSFW' 或含 '成人' 的分类。返回 normalize 后的标签集合。
    """
    adult = set()
    nsfw_path = Path(nsfw_taxonomy_path) if nsfw_taxonomy_path else BASE_DIR / "data" / "nsfw_taxonomy.json"
    if nsfw_path.is_file():
        try:
            data = json.loads(nsfw_path.read_text(encoding="utf-8"))
            for cat in data.get("categories", []):
                for t in cat.get("tags", []):
                    adult.add(normalize_tag(t))
        except (json.JSONDecodeError, OSError):
            pass
    for row in conn.execute(
        "SELECT tag_name FROM taxonomy_map "
        "WHERE category_l1 LIKE 'NSFW%' OR category_l1 LIKE '%成人%'"
    ):
        adult.add(normalize_tag(row["tag_name"]))
    return adult


__all__ = [
    "BLOCKLIST",
    "INCLUDE_CATEGORIES",
    "DEFAULT_MIN_POST_COUNT",
    "TAXONOMY_L1_TO_NODE",
    "normalize_tag",
    "build_enhanced_text",
    "build_meta",
    "iter_canonical_tags",
    "build_adult_set",
]

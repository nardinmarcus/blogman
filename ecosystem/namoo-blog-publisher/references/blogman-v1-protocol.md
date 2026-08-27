# blogman v1 写入协议详情（发布动作前必读）

> 协议知识来自 2026-08-27 实战（blogman issue #26/#31/#34 内核）。blogman 源码位于 `~/Projects/blogman`，
> 协议以 `lib/external-write-api.ts`、`lib/first-publish/kernel.ts`、`lib/publish-revision/kernel.ts` 为准。
> 所有 POST 到 `/api/posts` 的 body 带 `protocol: "v1"`。legacy 无协议请求已被拒绝。

## HTTP 硬性要求（踩过坑）

- **必须带浏览器 User-Agent**。python urllib / 裸 curl 默认 UA 会被 Cloudflare 拦（`403 error code: 1010`）。所有请求带 `User-Agent: Mozilla/5.0 ...`。
- 分类列表 `GET /api/admin/categories` 支持 Bearer；但写入时 `snapshot.category` 传**中文名**（如「AI教程」），不是 slug。
- 响应读取注意 chunked 截断（IncompleteRead），大 JSON 用 curl 落盘再解析。

## 图片上传

本地图片 / 第三方远程图先转存到博客自己的 uploads：

```bash
curl -s -X POST "https://<domain>/api/uploads" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/abs/path/img.png"
# → {"success":true,"url":"/api/images/image/2026/08/xxx.png", ...}
```

返回相对 URL，正文引用时拼上域名。下载第三方图用 curl（有的图床拦 python UA）。

## 新文章发布（三步）

### Step 1 — create（落 draft）

```json
POST /api/posts
{
  "protocol": "v1", "action": "create",
  "creationId": "唯一幂等键（如 brf-xxx-article）",
  "snapshot": { "title": "...", "content": "markdown", "category": "AI教程", "tags": ["a","b"] }
}
```

→ `{articleId, version: 1, slug: "2026-08-27-xxxx"}`。注意：slug 生成可能带尾横线，服务端规范化会剥掉（`2026-08-27-YLj6w-` → 实际 `2026-08-27-ylj6w`），以响应为准。重放同 creationId 返回 `outcome: "existing"`，不产生重复。

### Step 2 — publishTemp（状态转 published）

```json
POST /api/posts
{ "protocol": "v1", "action": "publishTemp",
  "articleId": 7, "expectedVersion": 1,
  "operationId": "xxx-publish-7", "currentStatus": "draft", "status": "published" }
```

→ version 2。**此时前台详情页仍 503**：`formal_publications` 事实表还没写，这是设计如此。

### Step 3 — first-publish 两阶段（正式上线）

**prepare**（校验拦截器，contentSha256 必填）：

```json
POST /api/first-publish
{ "action": "prepare", "prepareId": "xxx-prepare-1",
  "articleId": 7, "confirmedVersion": 2,
  "slug": "2026-08-27-ylj6w", "title": "...",
  "contentSha256": "<64位hex>", "actor": "agent" }
```

→ blockers 全绿 `outcome: "prepared"`。**contentSha256 传空会导致 confirm 阶段 `content-hash-mismatch`，必须算真值**（见下）。

**confirm**：

```json
POST /api/first-publish
{ "action": "confirm", "intentId": "xxx-intent-1", "prepareId": "xxx-prepare-1",
  "articleId": 7, "expectedVersion": 2, "actor": "agent" }
```

→ `outcome: "delivered"`，写 formal_publications，前台 200 可见。

## contentSha256 计算（关键）

哈希 = 服务端对 `content.trim()` 走 markdown→Tiptap 规范化后的 contentSnapshotHash。**用 blogman 仓库自己的模块复算**：

```bash
cd ~/Projects/blogman
cat > scripts/tmp-calc-hash.ts <<'EOF'
import { readFileSync } from 'node:fs'
import { parse, contentSnapshotHash } from '../lib/content-envelope'
const md = readFileSync('/tmp/article.md', 'utf-8').trim()  // 必须 trim，与服务端一致
console.log(contentSnapshotHash(parse({ markdown: md })))
EOF
./node_modules/.bin/tsx scripts/tmp-calc-hash.ts && rm scripts/tmp-calc-hash.ts
```

注意 content 必须是**实际发送给服务端的同一份字符串**（若发送前做过图片 URL 替换，先替换再算）。

## 编辑已发布文章（修订循环）

正式发布后，`save` 自动进修订面（不直接改线上），需 promote 才上线：

```json
// 1. save → 修订面
POST /api/posts
{ "protocol": "v1", "action": "save",
  "articleId": 7, "expectedVersion": <当前formal version>,
  "operationId": "xxx-edit-1",
  "snapshot": { "slug": "2026-08-27-ylj6w", "title": "...", "content": "新markdown", "category": "AI教程", "tags": [...] } }
// → outcome: "applied", revisionId: "revision:7:v<base>"

// 2. promote → 上线
POST /api/publish-revision
{ "action": "promote", "revisionId": "revision:7:v3", "articleId": 7, "actor": "agent" }
// → promotedVersion 上线，前台缓存几秒后生效
```

排查工具：`GET /api/publish-revision?articleId=7` 返回 formal anchor、active 修订、晋升历史。

**坑**：save 返回 `revision-version-mismatch` 时，GET 查修订态——若已存在 active 修订且内容是旧的，说明之前有人写入过；promote 只会推 active 内容。可用 `{action:"discard", revisionId}` 丢弃后重 save。

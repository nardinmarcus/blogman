---
name: namoo-blog-publish
description: 将 Markdown 文章发布到 Namoo Blog（blogman，v1 版本化协议）：新文章 create → publishTemp → first-publish 两阶段正式发布；已发布文章 save 修订 → promote 上线。支持分类、标签、本地/远程图片上传，以及博客版排版适配（标题层级）。
trigger: /namoo-blog-publish
argument-hint: path/to/file.md [--category 分类名] [--draft|--published] [--tags a,b]
---

# namoo-blog-publish: 发布内容到 Namoo Blog

博客是 blogman（`https://blog.namooca.com`），走 **v1 版本化写入协议**。执行任何发布/修订动作前，**先读 [references/blogman-v1-protocol.md](references/blogman-v1-protocol.md)**（完整 payload、contentSha256 复算、修订循环、HTTP 坑位都在里面）。

## 触发方式

- `/namoo-blog-publish path/to/file.md`
- 自然语言："发布到博客"、"发到 Namoo Blog"、"把这篇同步到博客"

## 配置

Token 读取优先级：

1. 环境变量 `NAMOO_BLOG_API_TOKEN` / `BLOGMAN_API_TOKEN`
2. 配置文件 `~/.claude/skills/namoo-blog-publish/config.json`

Token 失效（全部接口 401）时让用户去 `https://<domain>/admin/settings` 的 API Token 页新建。Token 管理接口只接受后台 Cookie 登录，命令行拿不到 token。

所有 HTTP 请求**必须带浏览器 User-Agent**（Cloudflare 拦默认 UA）。

## 发布流程速览

1. **排版适配**：博客按 markdown 原生渲染，无公众号式组件；口语文风直接发就是素文本流。生成博客版 markdown——各章节段前加 `## NN｜小节标题`（正文文字不动），代码块保留围栏。
2. **图片上传**：本地图 / 第三方远程图先 `POST /api/uploads` 转存，正文引用拼上域名（命令见 references）。
3. **新文章三步**：create（落 draft）→ publishTemp（转 published；此后前台仍 503 属正常）→ first-publish prepare+confirm（写 formal_publications 后前台可见）。
4. **编辑已发布文章**：save 进修订面（不改线上）→ promote 上线。

默认正式发布；`--draft` 只走 Step 1；幂等键全部可重放，网络超时原样重发。

## 错误速查

| 症状 | 处理 |
|------|------|
| `401` | token 失效，去后台换新 |
| `403 code: 1010` | Cloudflare 拦 UA，加浏览器 UA |
| `content-hash-mismatch` | 用 blogman 模块复算 contentSha256（references），trim + 同一份 content |
| `revision-version-mismatch` | GET 修订态，discard 或重算 expectedVersion |
| 详情页 503 | formal_publications 未写，first-publish 没走完 |
| `503 code: 1102` | 等 20s 重试（prepare/confirm 幂等） |

## 输出结果

`Published successfully!` + Title / Status / Category + `URL: https://<domain>/<slug>` + articleId · version · 图片转存情况。

## Task-End Skill Improvement Review

- 任务过程中只跟踪用户对 Skill 行为的明确纠正；不从普通工具报错推断纠正，也不回扫历史记录。
- 待办项默认任务内消化：先完成当前请求的任务，除非安全或权限问题需要立即停止。
- 最终答复前，若仍有可复用的改进项，输出「Skill 改进待审」小节：问题、建议调整、范围、风险、明确的 item IDs。没有可行动项就不加提醒。
- 沉默、搁置或未带明确 item IDs 的批准不授予任何修改权限。
- 用户批准 item IDs 后，由 namoo-skill-creator 作为唯一写入者做隔离候选变更并附回归证据；先展示已验证 diff 再申请 canonical 批准。候选批准不等于合并、发布、catalog 或 runtime 授权。

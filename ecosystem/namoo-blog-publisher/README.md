# namoo-blog-publish Skill

这个目录放的是配套的 Claude Skill，用来把 Markdown、纯文本或网页内容发布到你自己的 Namoo Blog，或对已发布文章做修订上线。走 blogman **v1 版本化写入协议**。

## 能做什么

- 发布本地 Markdown 文件为正式博客文章（三步：create → publishTemp → first-publish 两阶段）
- 只存草稿不上线（`--draft`）
- 编辑已发布文章：save 进修订面 → promote 上线，不动线上历史版本
- 抓取网页正文后发布到博客
- 本地图片 / 第三方远程图自动转存到博客 uploads
- 发布前做博客版排版适配（章节标题层级）

## 安装

把这个目录复制或软链接到：

```bash
~/.claude/skills/namoo-blog-publish/
```

至少需要保留：

- `SKILL.md`
- `references/blogman-v1-protocol.md`（发布动作前必读的协议详情）

## 配置

推荐两种方式之一：

### 1. 环境变量

```bash
export NAMOO_BLOG_API_TOKEN="nm_xxx"    # 或 BLOGMAN_API_TOKEN
```

### 2. 配置文件

```json
{
  "apiUrl": "https://your-domain.com",
  "token": "nm_xxx"
}
```

保存到：

```bash
~/.claude/skills/namoo-blog-publish/config.json
```

API Token 在你自己的博客后台 `设置 -> API Token` 里生成。**注意**：token 有真实写权限，不要把含 token 的 config.json 提交进任何仓库。

## 使用示例

```bash
# 正式发布（默认）
/namoo-blog-publish ~/Documents/my-article.md

# 指定分类、标签
/namoo-blog-publish article.md --category AI教程 --tags agent,workflow

# 只落草稿
/namoo-blog-publish article.md --draft
```

也可以直接说：

- "把这篇文章发布到博客"
- "发布成草稿"
- "发到 Namoo Blog"

## 验证安装可用

```bash
curl -s "https://your-domain.com/api/admin/categories" \
  -H "Authorization: Bearer $NAMOO_BLOG_API_TOKEN" \
  -H "User-Agent: Mozilla/5.0"
```

返回分类列表 JSON 即 token + 网络通。注意必须带浏览器 User-Agent（Cloudflare 拦默认 UA）。

## 排错

| 症状 | 处理 |
|------|------|
| `403 error code: 1010` | Cloudflare 拦默认 UA；所有请求带浏览器 UA |
| 全部接口 `401` | token 失效，后台重新生成 |
| `content-hash-mismatch` | 用 blogman 仓库模块复算 contentSha256，见 references |
| `revision-version-mismatch` | 先 GET 修订态，discard 旧修订或重算 expectedVersion |
| 发布后详情页 503 | formal_publications 未写，first-publish 流程没走完 |
| `503 error code: 1102` | Cloudflare 瞬时故障，等 20s 重试（幂等可重发） |

协议细节与完整 payload、坑位清单见 [`references/blogman-v1-protocol.md`](references/blogman-v1-protocol.md)；协议以 blogman 源码 `lib/external-write-api.ts`、`lib/first-publish/kernel.ts`、`lib/publish-revision/kernel.ts` 为准。

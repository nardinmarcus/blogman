# B2-01 Worker Brief — blogman #24 · canonical 正文 envelope 与版本化转换器

你是实现 worker（唯一 writer）。worktree：`cd /Users/dapeng/projects/blogman && git worktree add ~/.pi/worktrees/issue24-b201/blogman -b pi/issue-24-canonical-envelope 71eab4837759426c0801f393bccbdac3fa3aa20a`；依赖 `SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 先读

1. `env -u GITHUB_TOKEN -u GH_TOKEN gh issue view 24 --repo nardinmarcus/blogman` — 完整票面
2. lib/editor-extensions.tsx（现有 Tiptap 扩展集——node/mark 清单是 envelope schema 的事实来源）
3. lib/editor-markdown.ts + app/api/posts/route.ts 的 markdown→HTML 现状
4. CONTEXT.md 域概念

## 实现范围（纯新增内核模块，不动现有 posts 流）

新目录 `lib/content-envelope/`：

1. **envelope schema**（zod，仓里已有 zod）：`{ format: 'blogman-content-envelope/v1', tiptap_json_schema: number（文档 schema 版本，首版 1）, normalized: TiptapJSONDocument }` + 规范化规则（属性键排序、空段落处理、等价节点折叠——语义等价输入产出字节相同 envelope）
2. **版本化转换器接口**：`parse(input: {markdown?|tiptap?}) → envelope`、`normalize(tiptap) → envelope`、`renderHtml(envelope)`、`serializeMarkdown(envelope)`、`plainText(envelope)`、`searchProjection(envelope)`。每个转换器记录所用 schema 版本与转换器版本（旧 envelope 可按记录版本解释）
3. **哈希分离**：`contentSnapshotHash(envelope)`（正文快照）与 `sourceSyncHash(source)`（源稿同步）两个函数，输出 hex64
4. **Tiptap node/mark 白名单**从 editor-extensions.tsx 提取（text/paragraph/heading/bold/italic/code/link/image(audio/video/twitter/math 等按现有扩展)）——envelope 校验用；未知 node fail-closed 报可读错误
5. HTML render 用现有 markdown-it/remark 链或 tiptap generateHTML（选可测的；不引新重依赖，必要时手写 mini renderer 覆盖白名单）

## 测试（票面矩阵全覆盖）

- 等价节点（属性顺序不同 → 同 envelope 字节）、空段落、marks 组合、复杂块嵌套、媒体引用（image/audio/video/twitter）
- markdown→envelope→markdown 往返保真（白名单内无损或明确降级表）
- tiptap→envelope→HTML/plain/search 投影正确
- 旧 schema 版本 envelope 按版本解释（构造 v0 变体测试前向兼容钩子）
- snapshot hash ≠ sync hash（同正文不同源稿格式）

真实历史样本：本地 `wrangler d1 execute DB --local` 若有 posts 数据则取样转验；没有则以测试矩阵生成代表性样本（生产 D1 为 clean-start 空库，票面"真实历史样本"以此方式满足并注明）。

## 流程与边界

TDD；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npx vitest run <新测试文件>` 定向绿（不跑全量，CI 仲裁）；commit → push → `env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman`（refs #24，标题 feat(content): …）→ CI 三作业绿（macOS flake rerun）→ 回报 PR URL，不自行合并。零生产调用；不动 delivery 链文件。

## 输出

报告 ~/.local/state/blogman/b201/report.md（模块结构/白名单清单/测试计数/PR URL）。

# 公开页面性能与验收

## 当前实现

- 公开文章读取使用 canonical publication/version/address 语义；详情查询已合并，文章、站点设置和 schema 探测在请求内去重。
- 文章与页头读取并行；相关推荐置于独立 Suspense 边界，不阻塞正文。
- PDF 导出引擎仅在执行导出时加载；剪贴板所需的同步调用路径保持不变。
- 首页和搜索结果的文章、分类链接互不嵌套，避免浏览器修复非法 HTML 后引发 hydration mismatch。
- 公开发布日期使用明确的 `Asia/Shanghai` 时区，避免服务端与浏览器按不同本地时区渲染日期。

实现入口：`lib/public-read/`、`lib/public-request-data.ts`、`lib/public-date.ts`、`app/[slug]/page.tsx`、`components/RelatedPosts.tsx`、`lib/wechat-copy.ts`。

## 缓存与访问边界

生产首页及文章页实测响应仍为 `private, no-cache, no-store, max-age=0, must-revalidate`。源码中的 `revalidate` 声明不能作为页面已命中缓存的证据。

本阶段未加入跨请求缓存，也未放宽密码、隐藏、撤回等最新管理状态的访问约束。不要通过删除动态渲染约束或直接缓存文章查询结果来追逐时延指标。若以后确需缓存，必须先明确失效及访问控制语义。

数据库迁移使用正式迁移账本，见 [db/MIGRATIONS.md](db/MIGRATIONS.md)；部署流程见 [DEPLOY.md](DEPLOY.md)。读取时的缺表兼容探测不等于运行迁移，不应恢复旧的请求内 schema 修改方案。

## 2026-09-10 阶段验收

详细实现和测量证据以 GitHub [#244](https://github.com/nardinmarcus/blogman/issues/244) 与 [#245](https://github.com/nardinmarcus/blogman/issues/245) 为准。

- 受控本地 D1 往返测试：完整读取链查询数由 24 降至 6；这不是生产延迟。
- PDF 延迟加载后，先前生产样本的文章首访脚本传输量约由 414 KB 降至 144–145 KB。
- 用户人工测试确认体验明显改善。最后一轮生产复测的 12 次导航均成功，正文完整，无页面错误。
- 同一浏览器会话重复访问：6 次中位数约 **1.34 秒**，范围 **0.65–2.20 秒**，5 次低于两秒。
- 全新浏览器首访：6 次中位数约 **4.27 秒**，范围 **2.81–7.54 秒**。同期旧版/新版小样本对照均出现慢首访，未识别出新版独有的明显回退；样本不足以确定剩余延迟的具体来源。

本阶段已收口，但**不承诺所有请求两秒内**。首访波动作为已知限制保留；只有再次出现具体、影响用户的重复问题时才重开调查，不自动追加优化任务。

## 后续复测方式

1. 记录实际生产版本，使用相同文章和浏览器条件区分首次访问与重复访问。
2. 从浏览器点击事件测量到文章标题可见，并确认正文已渲染；与 HTTP 总耗时、Worker wall/CPU 和本地模拟延迟分别报告。
3. 检查页面错误与控制台，确保等待实际 hydration 和导航完成后再判断。
4. 若新结果与历史样本相差较大，先做有界的旧版/新版对照，不直接归因于最近改动或网络。

相关回归测试包括 `tests/lib/public-read/query-budget.test.ts`、`tests/lib/public-request-data.test.ts`、`tests/app/article-page-stream.test.ts`、`tests/lib/wechat-copy-lazy-pdf.test.ts` 与 `tests/lib/hydration-hydration.test.ts`。

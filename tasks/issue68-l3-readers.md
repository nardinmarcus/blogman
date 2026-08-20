# Issue #68 — L3 内部读者 → canonical 事实清单

每个内部读者都从 canonical（`articles` identity + `article_versions` 最新版本
快照 + 可重建投影）读取文章事实，**不再 import / 读取 legacy `posts` 读路径**。

| 读者 | 模块 | 事实来源（canonical） | 测试证据 |
| --- | --- | --- | --- |
| 今日工作台 · 草稿组 | `lib/workbench/kernel.ts` `listAuthorDrafts` | `articles` + 最新 `article_versions.snapshot_json.fields`（status/deleted_at/title/slug/updated_at）+ `formal_publications` 判定“非正式文章” | `tests/lib/workbench/workbench.test.ts`（reader source assertion + 全组别） |
| 今日工作台 · 排期/处理中/待办标题 | `lib/workbench/kernel.ts` `listSchedulesByStatus` + `canonicalArticleTitles` | `publish_schedules` + 最新版本快照标题（不再 `LEFT JOIN posts`） | `tests/lib/workbench/workbench.test.ts` |

## 边界

- 零生产改动；本分支只改内部读者读路径，不动 public read / 写路径。
- `posts` 表仅作为兼容投影保留（L4 退役），内部读者不反向写权威。
- 工作台是可重建只读投影：禁用只翻控制位，从不写源事实。

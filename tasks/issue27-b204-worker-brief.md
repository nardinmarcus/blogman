# B2-04 Worker Brief — blogman #27 · 主编辑器只显示服务端确认的保存状态

你是实现 worker。worktree：`git fetch origin main && git worktree add ~/.pi/worktrees/issue27-b204/blogman -b pi/issue-27-editor-confirmed-save 7325b5d6`（确认 origin/main 前 8=7325b5d6）；`SHARP_IGNORE_GLOBAL_LIBVIPS=true npm ci --no-audit --no-fund`。

## 先读

`gh issue view 27 --repo nardinmarcus/blogman`；`lib/article-commands/`（#26 命令层，只调用不改）；主编辑器页面/自动保存相关组件。

## 实现

1. 自动保存发完整快照 + expected version + operation id，走 create/save 命令。
2. 「已保存」仅当当前界面仍匹配服务端确认快照。
3. 每篇文章每台设备最多一份本机未确认稿（local draft）。
4. 冲突 UI：服务器版 / 本机版安全重提 / 另存新草稿。
5. 发布动作改接 `publishTemp`。不把单页请求序号或浏览器缓存迁成服务端事实。

## 测试

高层流程：请求期间继续输入、响应丢失、刷新恢复、临时断网、三种冲突选择。能单测/组件测就单测，不要本机开真浏览器套件拖死 CI。

## 硬边界

不跑 migration-runner；不进 ledger-migrations；零生产；commit→push→`env -u GITHUB_TOKEN -u GH_TOKEN gh pr create --repo nardinmarcus/blogman` refs #27，不合并。测试必须快（共享 mock，禁止每测起 wrangler）。

## 输出

`~/.local/state/blogman/b204/report.md` + PR URL。

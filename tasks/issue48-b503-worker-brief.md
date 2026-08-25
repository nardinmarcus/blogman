# B5-03 Worker Brief — blogman #48 · 微信设置、替代草稿与历史

worktree：`cd /Users/dapeng/projects/blogman && git fetch origin main && git worktree add ~/.pi/worktrees/issue48-b503/blogman -b pi/issue-48-wechat-settings bfc6bfe7`。先读 issue #48 全文与 #46/#47 微信模块。

实现：交付前设置调整与代次分离；设置修订不改变正文版本；交付后只能显式建替代草稿，引用前代并保留历史，状态待微信确认；自动化止于草稿。初始配置映射不猜历史；旧 media_id/代次不可删除/覆盖。

零生产/mock provider；禁止全量 vitest/wrangler；定向测试 <60s；PR refs #48，不合并。

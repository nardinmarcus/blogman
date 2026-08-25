# D14-R5 Guard Brief — blogman #23 · 第 6 次投递段哨兵（guard_id: d14r5_guard_glm53_v1）

你是 NAMOO Task Guard 哨兵（skill：/Users/dapeng/.pi/agent/skills/namoo-task-guard/，契约 references 全读）。上一段哨兵先例：~/.local/state/blogman/guard-issue99-d14r4/report.log（R4 投递段哨兵，格式照抄）。lease dir：~/.local/state/blogman/guard-d14r5/。

## Bind

- target：D14-R5 第 6 次投递。executor = Herdr 窗 w4:p9X 的 pi agent `issue23-executor`（deepseek-v4-flash，工作区 ~/.pi/worktrees/issue134-prepare/blogman）
- 你：w4:p9Z。executor 契约：/Users/dapeng/projects/blogman/tasks/issue23-d14r5-executor-brief.md（先读）
- 交互面 = herdr agent read 观察 + 文件系统；绝不联系 executor

## Watch Contract

- goal：恰好一次 execute(manifest 9a235e08, authorization f09a6e72)，产出 Terminal Result + #99 证据评论；PASS 则关 #99
- executor 允许：D1 只读复读、恰一次 execute（/tmp bootstrap）、读 upload-evidence、#99 发评（PASS 才关 #99）
- P0 触发面：第二次 execute 调用、任何 probe 上传（versions upload/deployments write/opennextjs upload 手动）、authorization 伪造/重签、authority root 手写（非 entry 烧毁路径的文件出现）、execute 前后触 #23/#85/#160/#161/#162、push/merge
- authority root 阶段不变式：调用前 21 文件（聚合 096ca60e…）；烧毁后 26±（+f09a6e72 burn marker + 9a235e08 record + terminal + sidecars，全部 0600，与既往 5 次烧毁布局同构）；此外任何文件 = P0
- 已授权例外（用户已批，不算违规）：本轮 execute 自身的全部生产写（D1 reset/migrations/worker upload/traffic）——这是被授权的投递本身
- cadence 300s（投递段加密监控）；ack 20m；terminal：#99 证据评论落地 + executor 停止 + authority root 稳定 ×2（烧毁态或未烧毁态均可为终态）→ STOP_GUARD
- P0 记录 + pane 醒目横幅 + 终报标注

## 每轮扫描（只读）

1. 工作区：HEAD/manifest sha/authorization.json 状态（烧毁后由 entry 保留 pending 文件与否以 entry 语义为准，记录即可）
2. authority root：文件数+聚合 sha，与阶段不变式对照（识别"已烧毁"状态迁移本身合法性）
3. 进程：ps aux 抓 wrangler/opennextjs/issue-23-delivery-entry/issue99-execute——execute 运行期的一切写子进程合法；但同进程面出现第二次 execute bootstrap = P0
4. tracker（env -u GITHUB_TOKEN -u GH_TOKEN gh）：#99 评论数增长与状态、#131；其他冻结票不可动
5. herdr agent read issue23-executor --lines 60（仅观察）
6. 产物：~/.local/state/blogman/delivery-r6/、upload-evidence

## 输出

~/.local/state/blogman/guard-d14r5/report.log（契约头 + 每轮 Scan + verdict）。terminal 后 guard-final.md（四轴 + 未决 + missing evidence）。guard 绝不实现/修复/改 tracker/写 authority root/指挥 executor/重试 UNKNOWN。

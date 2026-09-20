# 部署指南

Qiaomu Blog Open Source 的正式部署方式是 `OpenNext + Cloudflare Workers`。

## 首次部署

### 1. 安装依赖和环境变量

```bash
npm install
cp .env.example .env.local
```

至少填写：

```env
ADMIN_PASSWORD=change-me
ADMIN_TOKEN_SALT=change-me-to-a-random-string
AI_CONFIG_ENCRYPTION_SECRET=change-me-to-another-random-string
NEXT_PUBLIC_SITE_URL=https://your-domain.com
```

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

### 3. 初始化资源

```bash
npm run cf:init -- --site-url=https://your-domain.com
```

如果还要启用公共缓存 KV：

```bash
npm run cf:init -- --site-url=https://your-domain.com --with-kv
```

这一步会生成本地的 `wrangler.local.toml`，自动写入真实 D1 / R2 / KV 绑定，并通过增量迁移账本初始化 D1。已有 current schema 会先验证再登记 baseline，不会重放整份 schema 或忽略错误。

### 4. 设置 secrets

```bash
npx wrangler secret put ADMIN_PASSWORD -c wrangler.local.toml
npx wrangler secret put ADMIN_TOKEN_SALT -c wrangler.local.toml
npx wrangler secret put AI_CONFIG_ENCRYPTION_SECRET -c wrangler.local.toml
```

如需外部 AI：

```bash
npx wrangler secret put AI_API_KEY -c wrangler.local.toml
```

### 5. 生成类型并部署

```bash
npm run cf-typegen
npm run build
npm run deploy
```

部署在上传 Worker 前按当前 Git commit 候选身份执行 pending migrations。任一迁移失败都会停止部署；可在部署前只读检查：

```bash
node scripts/migrations.mjs plan --database DB --remote --config wrangler.local.toml
node scripts/migrations.mjs verify --database DB --remote --config wrangler.local.toml
```

完整迁移接口和前向修复规则见 [`db/MIGRATIONS.md`](db/MIGRATIONS.md)。

## 本地 Worker 预览

```bash
npm run preview
```

脚本会优先读取 `wrangler.local.toml`。模板仓库里的 `wrangler.toml` 不带真实资源绑定，不能直接拿来部署生产。

## 日常更新

```bash
git pull
npm install
npm run verify
npm run deploy
```

## 已有站点的发布核对

- 以 `scripts/cf-config.sh` 实际选出的配置为准（优先 `wrangler.local.toml`），再与提供方核对 Worker、账户、域名和资源绑定；不要仅凭文件名判定生产配置。
- `.github/workflows/verify.yml` 负责验证，不会自动部署。分别记录推送的 commit、CI 结果、实际部署的 commit、Worker version 和流量比例；后续仅文档提交不表示生产代码已重新部署。
- 上传前用 migration runner 的 `plan` / `verify` 核对账本；数据库变更仍只通过 [迁移接口](db/MIGRATIONS.md)，不以临时 DDL 修补部署。
- 对同一候选的构建产物做身份校验，上传前重新读取线上版本以排除并发发布。提供方成功后，还要分别核验实际域名、现有版本 URL 和页面引用的资源；构建成功或首页 200 不能替代所有这些证据。
- 结果未知时先查询原部署，不重复上传来探测状态；部署、切流、回滚是不同操作。

### OpenNext 的 AI binding 与部署认证

OpenNext 的部署准备会通过 `getPlatformProxy` 读取环境；AI binding 可能因此触发只接受 OAuth 的 remote proxy。此处报未登录，不等于用于 Worker 上传的 API Token 无效。

若要跳过这个准备步骤，必须先检查当前 `.open-next/.build/open-next.config.mjs` 及已安装 OpenNext 实现：`incrementalCache`、`tagCache` 都为 `dummy`，且 `cloudflare.skewProtection.enabled` 不为 `true`，证明 `populateCache` / `getDeploymentMapping` 无需执行。随后才可在相同候选、绑定和已验证产物下，用仓库安装的 Wrangler 执行最终上传步骤，并设置 `OPEN_NEXT_DEPLOY=true` 防止递归回到 OpenNext deploy。

这不是通用重试开关：缓存准备或版本映射启用时应走完整流程；上传结果未知时不能使用。保留 AI binding 和现有密钥，不为满足代理登录而删除绑定或换凭据。使用已打包的只读快照时，显式 `--no-bundle`，并将 `--outdir` 指向快照外的可写目录。

## 常见问题

### `npm run deploy` 报缺少 D1 或 R2

先执行：

```bash
npm run cf:init -- --site-url=https://your-domain.com
```

### 后台登录提示鉴权未配置完成

至少补齐：

```bash
npx wrangler secret put ADMIN_PASSWORD -c wrangler.local.toml
npx wrangler secret put ADMIN_TOKEN_SALT -c wrangler.local.toml
```

### AI Provider 已保存的 Key 无法解密

通常是 `AI_CONFIG_ENCRYPTION_SECRET` 或 `ADMIN_TOKEN_SALT` 被改了。建议固定 `AI_CONFIG_ENCRYPTION_SECRET`，不要和 token salt 复用。

### RSS / sitemap / canonical 指向错域名

检查：

- `.env.local`
- `wrangler.local.toml`

两处的 `NEXT_PUBLIC_SITE_URL` 必须一致。

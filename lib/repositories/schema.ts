export type Database = D1Database

// 获取数据库实例（从 Cloudflare Workers 环境）
export function getDB(env: CloudflareEnv) {
  return env.DB
}

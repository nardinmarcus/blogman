import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Legacy AI provider config is missing ${field}`)
  }
  return value.trim()
}

function optionalString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function clampTemperature(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? Math.max(0, Math.min(2, numeric)) : 0.7
}

function clampMaxTokens(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 2000
  return Math.max(1, Math.min(32768, Math.floor(numeric)))
}

function maskApiKey(value) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`
}

function encryptApiKey(value, secret) {
  if (!value) return ''
  const key = createHash('sha256').update(secret).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const payload = Buffer.concat([encrypted, cipher.getAuthTag()])

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(payload.subarray(payload.length - 16))
  const verified = Buffer.concat([
    decipher.update(payload.subarray(0, payload.length - 16)),
    decipher.final(),
  ]).toString('utf8')
  if (verified !== value) throw new Error('Legacy AI provider key encryption verification failed')

  return `enc:v1:${iv.toString('base64')}:${payload.toString('base64')}`
}

export async function prepare({ env, query }) {
  const existingProfiles = query('SELECT COUNT(*) AS count FROM ai_provider_profiles')
  if (Number(existingProfiles[0]?.count) > 0) return ''

  const configRows = query("SELECT value FROM site_settings WHERE key = 'ai_provider_config'")
  if (!configRows[0]?.value) return ''

  let config
  try {
    config = JSON.parse(configRows[0].value)
  } catch {
    throw new Error('Legacy AI provider config is invalid JSON')
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Legacy AI provider config is invalid JSON')
  }

  const secret = optionalString(env.AI_CONFIG_ENCRYPTION_SECRET)
    || optionalString(env.ADMIN_TOKEN_SALT)
  if (secret.length < 32) {
    throw new Error('AI_CONFIG_ENCRYPTION_SECRET or ADMIN_TOKEN_SALT must contain at least 32 characters for legacy AI provider migration')
  }

  const baseUrl = requireString(config.base_url, 'base_url').replace(/\/+$/, '')
  const model = requireString(config.model, 'model')
  const keyRows = query("SELECT value FROM site_settings WHERE key = 'ai_provider_api_key'")
  const rawApiKey = optionalString(keyRows[0]?.value)
  const encryptedApiKey = encryptApiKey(rawApiKey, secret)
  const maskedApiKey = rawApiKey
    ? maskApiKey(rawApiKey)
    : optionalString(config.api_key_masked)

  return `
INSERT INTO ai_provider_profiles (
  name, provider, provider_name, provider_type, provider_category, api_key_url,
  base_url, model, temperature, max_tokens,
  api_key_encrypted, api_key_masked, is_default, created_at, updated_at
)
SELECT
  '默认配置',
  ${sqlLiteral(optionalString(config.provider, 'custom'))},
  ${sqlLiteral(optionalString(config.provider_name))},
  ${sqlLiteral(optionalString(config.provider_type, 'openai_compatible'))},
  ${sqlLiteral(optionalString(config.provider_category))},
  ${sqlLiteral(optionalString(config.api_key_url))},
  ${sqlLiteral(baseUrl)},
  ${sqlLiteral(model)},
  ${clampTemperature(config.temperature)},
  ${clampMaxTokens(config.max_tokens)},
  ${sqlLiteral(encryptedApiKey)},
  ${sqlLiteral(maskedApiKey)},
  1,
  strftime('%s', 'now'),
  strftime('%s', 'now')
WHERE NOT EXISTS (SELECT 1 FROM ai_provider_profiles);
`.trim()
}

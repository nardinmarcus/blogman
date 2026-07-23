export interface AIProviderProfileRow {
  id: number
  name: string
  provider: string
  provider_name: string
  provider_type: string
  provider_category: string
  api_key_url: string
  base_url: string
  model: string
  temperature: number
  max_tokens: number
  api_key_masked: string
  is_default: number
  created_at: number
  updated_at: number
}

const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_MAX_TOKENS = 2000
const ENCRYPTION_PREFIX = 'enc:v1'

const keyCache = new Map<string, Promise<CryptoKey>>()

function toBase64(bytes: Uint8Array): string {
  const BufferCtor = (globalThis as unknown as {
    Buffer?: {
      from: (input: Uint8Array | string, encoding?: string) => { toString: (encoding?: string) => string }
    }
  }).Buffer

  if (BufferCtor) {
    return BufferCtor.from(bytes).toString('base64')
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function fromBase64(input: string): Uint8Array {
  const BufferCtor = (globalThis as unknown as {
    Buffer?: {
      from: (input: Uint8Array | string, encoding?: string) => Uint8Array
    }
  }).Buffer

  if (BufferCtor) {
    return new Uint8Array(BufferCtor.from(input, 'base64'))
  }
  const binary = atob(input)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const normalized = secret.trim() || 'blogman-ai-config'
  const cached = keyCache.get(normalized)
  if (cached) return cached

  const promise = (async () => {
    const encoded = new TextEncoder().encode(normalized)
    const digest = await crypto.subtle.digest('SHA-256', encoded)
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  })()

  keyCache.set(normalized, promise)
  return promise
}

export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '')
}

export function isWorkersAiBaseUrl(input: string): boolean {
  const normalized = normalizeBaseUrl(input || '')
  return /api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/ai(?:\/|$)/i.test(normalized)
}

export function buildWorkersAiRunUrl(baseUrl: string, model: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  const apiRoot = /\/ai\/v1$/i.test(normalized)
    ? normalized.replace(/\/ai\/v1$/i, '/ai')
    : normalized
  return `${apiRoot}/run/${model.trim()}`
}

export function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEMPERATURE
  return Math.max(0, Math.min(2, Number(value)))
}

export function clampMaxTokens(value: number): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return DEFAULT_MAX_TOKENS
  return Math.max(1, Math.min(32768, Math.floor(Number(value))))
}

export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim()
  if (!trimmed) return ''
  if (trimmed.length <= 10) return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`
}

export function resolveAiConfigSecret(env?: Record<string, unknown>): string {
  const envSecret = typeof env?.AI_CONFIG_ENCRYPTION_SECRET === 'string'
    ? env.AI_CONFIG_ENCRYPTION_SECRET
    : ''
  const envSalt = typeof env?.ADMIN_TOKEN_SALT === 'string'
    ? env.ADMIN_TOKEN_SALT
    : ''

  return (
    envSecret ||
    process.env.AI_CONFIG_ENCRYPTION_SECRET ||
    envSalt ||
    process.env.ADMIN_TOKEN_SALT ||
    'blogman-ai-config-secret'
  )
}

export async function encryptApiKey(apiKey: string, secret: string): Promise<string> {
  const normalized = apiKey.trim()
  if (!normalized) return ''

  const key = await deriveAesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const payload = new TextEncoder().encode(normalized)
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload)
  const cipherBytes = new Uint8Array(encrypted)

  return `${ENCRYPTION_PREFIX}:${toBase64(iv)}:${toBase64(cipherBytes)}`
}

export async function decryptApiKey(value: string, secret: string): Promise<string> {
  const normalized = (value || '').trim()
  if (!normalized) return ''

  if (!normalized.startsWith(`${ENCRYPTION_PREFIX}:`)) {
    return normalized
  }

  const parts = normalized.split(':')
  if (parts.length !== 4) return ''

  try {
    const key = await deriveAesKey(secret)
    const iv = new Uint8Array(fromBase64(parts[2]))
    const cipherBytes = new Uint8Array(fromBase64(parts[3]))
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      cipherBytes,
    )
    return new TextDecoder().decode(decrypted)
  } catch {
    return ''
  }
}

export async function selectDefaultProfileId(db: D1Database): Promise<number | null> {
  const defaultRow = await db.prepare('SELECT id FROM ai_provider_profiles WHERE is_default = 1 ORDER BY id ASC LIMIT 1').first<{ id: number }>()
  if (defaultRow?.id) return defaultRow.id

  const firstRow = await db.prepare('SELECT id FROM ai_provider_profiles ORDER BY id ASC LIMIT 1').first<{ id: number }>()
  return firstRow?.id ?? null
}

export function buildTextProfileReconciliationStatements(
  db: D1Database,
  removedProfileId?: number,
): D1PreparedStatement[] {
  const removed = Number.isFinite(removedProfileId) ? Number(removedProfileId) : null
  const actionWhere = removed === null ? 'profile_id IS NULL' : 'profile_id IS NULL OR profile_id = ?'
  const generatorWhere = removed === null
    ? 'text_profile_id IS NULL'
    : 'text_profile_id IS NULL OR text_profile_id = ?'

  return [
    db.prepare(`
      UPDATE ai_provider_profiles
      SET is_default = 1, updated_at = strftime('%s', 'now')
      WHERE id = (SELECT id FROM ai_provider_profiles ORDER BY id ASC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM ai_provider_profiles WHERE is_default = 1)
    `),
    db.prepare(`
      UPDATE ai_actions
      SET profile_id = (
        SELECT id FROM ai_provider_profiles ORDER BY is_default DESC, id ASC LIMIT 1
      )
      WHERE ${actionWhere}
    `).bind(...(removed === null ? [] : [removed])),
    db.prepare(`
      UPDATE ai_post_generators
      SET text_profile_id = (
        SELECT id FROM ai_provider_profiles ORDER BY is_default DESC, id ASC LIMIT 1
      )
      WHERE target_key IN ('summary', 'tags', 'slug')
        AND (${generatorWhere})
    `).bind(...(removed === null ? [] : [removed])),
  ]
}

export async function batchTextProfileMutation(
  db: D1Database,
  mutationStatements: D1PreparedStatement[],
  removedProfileId?: number,
) {
  return db.batch([
    ...mutationStatements,
    ...buildTextProfileReconciliationStatements(db, removedProfileId),
  ])
}

export async function reconcileTextProfileReferencesAfterMutation(
  db: D1Database,
  removedProfileId?: number,
): Promise<number | null> {
  await db.batch(buildTextProfileReconciliationStatements(db, removedProfileId))
  return selectDefaultProfileId(db)
}

export async function resolveAiProfileConfig(
  db: D1Database,
  secret: string,
  profileId?: number,
): Promise<{
  id: number
  name: string
  provider: string
  provider_name: string
  provider_type: string
  provider_category: string
  api_key_url: string
  base_url: string
  model: string
  temperature: number
  max_tokens: number
  api_key: string
  api_key_masked: string
  is_default: number
} | null> {
  const selected = Number.isFinite(profileId) && Number(profileId) > 0
    ? await db.prepare(`
        SELECT *
        FROM ai_provider_profiles
        WHERE id = ?
        LIMIT 1
      `).bind(Number(profileId)).first<AIProviderProfileRow & { api_key_encrypted: string }>()
    : await db.prepare(`
        SELECT *
        FROM ai_provider_profiles
        ORDER BY is_default DESC, id ASC
        LIMIT 1
      `).first<AIProviderProfileRow & { api_key_encrypted: string }>()

  if (!selected?.base_url || !selected.model) return null

  const apiKey = await decryptApiKey(selected.api_key_encrypted || '', secret)
  if (!apiKey) return null

  return {
    id: selected.id,
    name: selected.name,
    provider: selected.provider,
    provider_name: selected.provider_name,
    provider_type: selected.provider_type,
    provider_category: selected.provider_category,
    api_key_url: selected.api_key_url,
    base_url: normalizeBaseUrl(selected.base_url),
    model: selected.model,
    temperature: clampTemperature(Number(selected.temperature)),
    max_tokens: clampMaxTokens(Number(selected.max_tokens)),
    api_key: apiKey,
    api_key_masked: selected.api_key_masked,
    is_default: selected.is_default,
  }
}

export function mapProfileRow(row: AIProviderProfileRow): AIProviderProfileRow {
  return {
    ...row,
    temperature: clampTemperature(Number(row.temperature)),
    max_tokens: clampMaxTokens(Number(row.max_tokens)),
  }
}

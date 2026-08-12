export const D1_STAGE_TIMEOUT_MS = Object.freeze({
  d1_identity: 120_000,
  clean_start_reset: 300_000,
  empty_d1_proof: 300_000,
  migrations_001_006: 2_100_000,
  reconciliation: 300_000,
})

export const D1_CANONICAL_MIGRATION_NAMES = Object.freeze([
  '001_initial_schema',
  '002_add_ai_image_configuration',
  '003_migrate_runtime_ai_configuration',
  '004_complete_historical_text_ai_schema',
  '005_fix_posts_fts_sync',
  '006_add_rollout_safety_controls',
])

const REMOTE_D1_INFO_VARIANTS = Object.freeze([
  Object.freeze({
    keys: Object.freeze([
      'created_at',
      'database_size',
      'name',
      'num_tables',
      'read_queries_24h',
      'read_replication',
      'rows_read_24h',
      'rows_written_24h',
      'uuid',
      'write_queries_24h',
    ]),
    sizeKey: 'database_size',
    metrics: true,
  }),
  Object.freeze({
    keys: Object.freeze([
      'created_at',
      'database_size',
      'name',
      'num_tables',
      'read_replication',
      'uuid',
      'version',
    ]),
    sizeKey: 'database_size',
    metrics: false,
  }),
])

const WHOAMI_TOP_LEVEL_KEYS = Object.freeze({
  withEmail: Object.freeze(['accounts', 'authType', 'email', 'loggedIn', 'tokenPermissions']),
  withoutEmail: Object.freeze(['accounts', 'authType', 'loggedIn', 'tokenPermissions']),
})
const WHOAMI_AUTH_TYPES = Object.freeze([
  'Account API Token',
  'Global API Key',
  'OAuth Token',
  'User API Token',
])
const ACCOUNT_KEYS = Object.freeze([
  'created_on',
  'id',
  'legacy_flags',
  'name',
  'settings',
  'type',
])
const ACCOUNT_SETTINGS_KEYS = Object.freeze([
  'abuse_contact_email',
  'access_approval_expiry',
  'api_access_enabled',
  'enforce_twofactor',
  'oauth_app_access_enabled',
])
const ACCOUNT_QUOTA_KEYS = Object.freeze(['available', 'current', 'maximum'])

function isPlainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

function assertExactKeys(value, keys) {
  if (!isPlainRecord(value)) throw new Error('object expected')
  const actual = Object.keys(value)
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw new Error('unsupported fields')
  }
}

function assertString(value) {
  if (typeof value !== 'string') throw new Error('string expected')
}

function assertNullableString(value) {
  if (value !== null) assertString(value)
}

function assertNonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('non-negative integer expected')
}

function assertStrictJsonObjectKeys(json) {
  let index = 0

  function skipWhitespace() {
    while (index < json.length && /[ \t\n\r]/u.test(json[index])) index += 1
  }

  function scanString() {
    const start = index
    if (json[index] !== '"') throw new SyntaxError()
    index += 1
    while (index < json.length) {
      if (json[index] === '"') {
        index += 1
        return JSON.parse(json.slice(start, index))
      }
      if (json[index] === '\\') index += 1
      index += 1
    }
    throw new SyntaxError()
  }

  function scanPrimitive() {
    const start = index
    while (index < json.length && !',]} \t\n\r'.includes(json[index])) index += 1
    if (start === index) throw new SyntaxError()
  }

  function scanArray() {
    index += 1
    skipWhitespace()
    if (json[index] === ']') {
      index += 1
      return
    }
    while (index < json.length) {
      scanValue()
      skipWhitespace()
      if (json[index] === ']') {
        index += 1
        return
      }
      if (json[index] !== ',') throw new SyntaxError()
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError()
  }

  function scanObject() {
    index += 1
    skipWhitespace()
    if (json[index] === '}') {
      index += 1
      return
    }
    const keys = new Set()
    while (index < json.length) {
      const key = scanString()
      if (keys.has(key)) throw new SyntaxError()
      keys.add(key)
      skipWhitespace()
      if (json[index] !== ':') throw new SyntaxError()
      index += 1
      scanValue()
      skipWhitespace()
      if (json[index] === '}') {
        index += 1
        return
      }
      if (json[index] !== ',') throw new SyntaxError()
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError()
  }

  function scanValue() {
    skipWhitespace()
    if (json[index] === '{') scanObject()
    else if (json[index] === '[') scanArray()
    else if (json[index] === '"') scanString()
    else scanPrimitive()
  }

  scanValue()
  skipWhitespace()
  if (index !== json.length) throw new SyntaxError()
}

export function parseStrictJson(json) {
  if (typeof json !== 'string') throw new SyntaxError()
  assertStrictJsonObjectKeys(json)
  return JSON.parse(json)
}

function validRemoteD1InfoVariant(response) {
  return REMOTE_D1_INFO_VARIANTS.find((variant) => {
    const keys = Object.keys(response)
    return keys.length === variant.keys.length && variant.keys.every((key) => keys.includes(key))
  })
}

export function parseRemoteD1InfoResponse(stdout, expectedDatabaseId) {
  try {
    const response = parseStrictJson(stdout)
    if (!isPlainRecord(response)) throw new Error('object expected')
    const variant = validRemoteD1InfoVariant(response)
    if (!variant) throw new Error('unsupported D1 info variant')
    assertString(response.created_at)
    assertNonNegativeInteger(response[variant.sizeKey])
    assertString(response.name)
    assertNonNegativeInteger(response.num_tables)
    assertString(response.uuid)
    if (response.uuid !== expectedDatabaseId) throw new Error('database identity drift')
    assertExactKeys(response.read_replication, ['mode'])
    if (!['auto', 'disabled'].includes(response.read_replication.mode)) {
      throw new Error('unsupported read replication mode')
    }
    if (variant.metrics) {
      for (const field of [
        'read_queries_24h',
        'rows_read_24h',
        'rows_written_24h',
        'write_queries_24h',
      ]) assertNonNegativeInteger(response[field])
    } else if (response.version !== 'alpha') {
      throw new Error('unsupported D1 info version')
    }
    return response
  } catch {
    throw new Error('invalid Wrangler D1 info response')
  }
}

export function parseWranglerWhoamiResponse(stdout, expectedAccountId) {
  try {
    const response = parseStrictJson(stdout)
    if (!isPlainRecord(response)) throw new Error('object expected')
    const keys = Object.hasOwn(response, 'email')
      ? WHOAMI_TOP_LEVEL_KEYS.withEmail
      : WHOAMI_TOP_LEVEL_KEYS.withoutEmail
    assertExactKeys(response, keys)
    if (response.loggedIn !== true || !WHOAMI_AUTH_TYPES.includes(response.authType)) {
      throw new Error('invalid authentication state')
    }
    if (Object.hasOwn(response, 'email')) assertString(response.email)
    if (!Array.isArray(response.accounts) || !Array.isArray(response.tokenPermissions)
      || response.tokenPermissions.some((permission) => typeof permission !== 'string')) {
      throw new Error('invalid account response')
    }
    for (const account of response.accounts) {
      assertExactKeys(account, ACCOUNT_KEYS)
      assertString(account.created_on)
      assertString(account.id)
      assertString(account.name)
      if (account.type !== 'standard') throw new Error('unsupported account type')
      assertExactKeys(account.settings, ACCOUNT_SETTINGS_KEYS)
      assertNullableString(account.settings.abuse_contact_email)
      assertNullableString(account.settings.access_approval_expiry)
      for (const field of ['api_access_enabled', 'enforce_twofactor', 'oauth_app_access_enabled']) {
        if (typeof account.settings[field] !== 'boolean') throw new Error('invalid account setting')
      }
      assertExactKeys(account.legacy_flags, ['enterprise_zone_quota'])
      assertExactKeys(account.legacy_flags.enterprise_zone_quota, ACCOUNT_QUOTA_KEYS)
      for (const value of Object.values(account.legacy_flags.enterprise_zone_quota)) {
        assertNonNegativeInteger(value)
      }
    }
    if (response.accounts.filter((account) => account.id === expectedAccountId).length !== 1) {
      throw new Error('account identity drift')
    }
    return response
  } catch {
    throw new Error('invalid Wrangler identity response')
  }
}

function identityChildFailure(classification, durationMs) {
  const error = new Error(`D1 identity child ${classification}`)
  error.classification = classification
  error.durationMs = durationMs
  return error
}

export function identityDurationMs(infoCommand, whoamiCommand = null, requiresWhoami = false) {
  const infoDuration = Number.isSafeInteger(infoCommand?.duration_ms) && infoCommand.duration_ms >= 0
    ? infoCommand.duration_ms
    : 0
  const whoamiDuration = Number.isSafeInteger(whoamiCommand?.duration_ms) && whoamiCommand.duration_ms >= 0
    ? whoamiCommand.duration_ms
    : 0
  if (infoCommand?.stderr !== '') {
    throw identityChildFailure('uncertain', infoDuration)
  }
  if (requiresWhoami && whoamiCommand === null) {
    throw identityChildFailure('uncertain', infoDuration)
  }
  if (whoamiCommand !== null && whoamiCommand.stderr !== '') {
    throw identityChildFailure('uncertain', infoDuration + whoamiDuration)
  }
  return infoDuration + whoamiDuration
}

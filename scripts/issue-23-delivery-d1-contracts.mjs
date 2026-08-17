import { createHash } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'

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

const D1_CATALOG_NUL = Buffer.from([0])

/**
 * Shared artifact path ordering comparator (byte/code-unit order, locale- and
 * ICU-version independent).
 *
 * Issue #132: prepare freezes `artifact.file_tree.files` in code-unit order
 * (segment walk + default `.sort()`), and its self-check re-derives the same
 * order. Transport/upload live validation previously used `localeCompare`,
 * which diverges from code-unit order on punctuation-weighted pairs (e.g.
 * `assets/BUILD_ID` vs `assets/_next/static/x.js`), so a perfectly frozen
 * Next.js artifact could never pass live preconditions. Every ordering point
 * that derives from or compares against the frozen tree must use this
 * comparator. Because `/` (0x2F) sorts before every other valid artifact path
 * character, code-unit comparison of full paths is consistent with a
 * depth-first walk that orders each directory's segments code-unit-wise.
 */
export function comparePathSegments(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertCatalogEntry(path, type, label) {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch {
    throw new Error(`D1 contracts: ${label} is missing`)
  }
  if (metadata.isSymbolicLink()) throw new Error(`D1 contracts: ${label} must not be a symlink`)
  if (type === 'directory' && !metadata.isDirectory()) {
    throw new Error(`D1 contracts: ${label} must be a directory`)
  }
  if (type === 'file' && !metadata.isFile()) {
    throw new Error(`D1 contracts: ${label} must be a regular file`)
  }
  if (typeof process.geteuid !== 'function' || metadata.uid !== process.geteuid()) {
    throw new Error(`D1 contracts: ${label} has an unsafe owner`)
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`D1 contracts: ${label} has unsafe write permissions`)
  }
  if (type === 'file' && metadata.nlink !== 1) {
    throw new Error(`D1 contracts: ${label} has an unsafe link count`)
  }
  try {
    if (realpathSync(path) !== path) throw new Error()
  } catch {
    throw new Error(`D1 contracts: ${label} must have a canonical realpath`)
  }
  return metadata
}

export function hashD1ArtifactDirectory(path) {
  assertCatalogEntry(path, 'directory', 'migration catalog')
  const hash = createHash('sha256')
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const child = `${directory}/${name}`
      const relativePath = prefix ? `${prefix}/${name}` : name
      const metadata = lstatSync(child)
      if (metadata.isSymbolicLink()) {
        throw new Error('D1 contracts: migration catalog contains a symlink')
      }
      if (metadata.isDirectory()) {
        assertCatalogEntry(child, 'directory', `migration catalog directory ${relativePath}`)
        visit(child, relativePath)
        continue
      }
      assertCatalogEntry(child, 'file', `migration catalog file ${relativePath}`)
      const bytes = readFileSync(child)
      hash.update(Buffer.from(relativePath, 'utf8'))
        .update(D1_CATALOG_NUL)
        .update(Buffer.from(String(metadata.size), 'utf8'))
        .update(D1_CATALOG_NUL)
        .update(bytes)
        .update(D1_CATALOG_NUL)
    }
  }
  visit(path, '')
  return hash.digest('hex')
}

const D1_STAGE_BINDING_KEYS = Object.freeze([
  'mode',
  'database',
  'config_path',
  'config_sha256',
  'wrangler_sha256',
  'account_id',
  'd1_database_id',
  'reset_sql_path',
  'reset_sql_sha256',
  'migration_runner_path',
  'migration_runner_sha256',
  'migration_catalog_path',
  'migration_catalog_sha256',
  'rollout_safety_path',
  'rollout_safety_sha256',
  'expected_reconciliation_path',
  'expected_reconciliation_sha256',
  'manifest_sha256',
  'authorization_sha256',
  'attempt_id',
  'candidate_id',
  'evidence_class',
  'migrations',
  'persist_path',
])

function canonicalD1StageBindings(bindings) {
  return Object.fromEntries(D1_STAGE_BINDING_KEYS.map((key) => {
    if (key === 'migrations') {
      return [key, bindings.migrations.map(({ number, name, checksum }) => ({ number, name, checksum }))]
    }
    if (key === 'persist_path') return [key, bindings.persist_path ?? null]
    return [key, bindings[key]]
  }))
}

export function d1StageBindingsSha256(bindings) {
  const bytes = Buffer.from(`${JSON.stringify(canonicalD1StageBindings(bindings), null, 2)}\n`, 'utf8')
  return createHash('sha256').update(bytes).digest('hex')
}

const WHOAMI_AUTH_TYPES = Object.freeze([
  'Account API Token',
  'Global API Key',
  'OAuth Token',
  'User API Token',
])
const WHOAMI_API_TOKEN_AUTH_TYPES = Object.freeze([
  'User API Token',
  'Account API Token',
])
// wrangler whoami --json builds the env-token (CLOUDFLARE_API_TOKEN) result without
// tokenPermissions (the OAuth login scope cache only) or email (requires /user read;
// delivery tokens are scoped to the account), so only these API-token auth types can
// produce the env-token shape.

function isPlainRecord(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
}

// Issue #150: Wrangler passes upstream responses through with only light
// reshaping, so response objects tolerate upstream-added harmless keys while
// the frozen semantic keys stay required and value-asserted by the callers.
function assertRequiredKeys(value, keys) {
  if (!isPlainRecord(value)) throw new Error('object expected')
  if (keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('missing required fields')
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

export function parseRemoteD1InfoResponse(stdout, expectedDatabaseId) {
  try {
    const response = parseStrictJson(stdout)
    if (!isPlainRecord(response)) throw new Error('object expected')
    // Issue #150: variant recognition is replaced by required semantic keys
    // plus conditional asserts, so upstream-added D1 info fields (jurisdiction,
    // running_in_region, future metrics) can no longer fail the parser. The
    // identity and shape defenses below stay strict.
    assertString(response.created_at)
    assertNonNegativeInteger(response.database_size)
    assertString(response.name)
    assertNonNegativeInteger(response.num_tables)
    assertString(response.uuid)
    if (response.uuid !== expectedDatabaseId) {
      const error = new Error('database identity drift')
      error.code = 'DELIVERY_DATABASE_MISMATCH'
      throw error
    }
    if (!isPlainRecord(response.read_replication)) throw new Error('read replication expected')
    assertString(response.read_replication.mode)
    if (!['auto', 'disabled'].includes(response.read_replication.mode)) {
      throw new Error('unsupported read replication mode')
    }
    for (const field of [
      'read_queries_24h',
      'rows_read_24h',
      'rows_written_24h',
      'write_queries_24h',
    ]) {
      if (Object.hasOwn(response, field)) assertNonNegativeInteger(response[field])
    }
    if (Object.hasOwn(response, 'version') && response.version !== 'alpha') {
      throw new Error('unsupported D1 info version')
    }
    if (Object.hasOwn(response, 'jurisdiction')) assertNullableString(response.jurisdiction)
    if (Object.hasOwn(response, 'running_in_region')) assertString(response.running_in_region)
    return response
  } catch (error) {
    if (error?.code === 'DELIVERY_DATABASE_MISMATCH') throw error
    throw new Error('invalid Wrangler D1 info response')
  }
}

const REQUIRED_DELIVERY_TOKEN_PERMISSIONS = Object.freeze([
  'account:Account Settings:read',
  'account:D1:write',
  'account:Workers R2 Storage:write',
  'account:Workers Scripts:write',
])

export function parseWranglerWhoamiResponse(stdout, expectedAccountId) {
  try {
    const response = parseStrictJson(stdout)
    if (!isPlainRecord(response)) throw new Error('object expected')
    const envTokenShape = !Object.hasOwn(response, 'tokenPermissions')
    // Issue #150: every level requires its frozen semantic keys and tolerates
    // upstream-added harmless keys; the identity/permission/value assertions
    // below are the drift defense and stay strict.
    assertRequiredKeys(response, ['loggedIn', 'authType', 'accounts'])
    if (response.loggedIn !== true || !WHOAMI_AUTH_TYPES.includes(response.authType)) {
      throw new Error('invalid authentication state')
    }
    if (envTokenShape && !WHOAMI_API_TOKEN_AUTH_TYPES.includes(response.authType)) {
      throw new Error('unsupported credential shape')
    }
    if (Object.hasOwn(response, 'email')) assertString(response.email)
    const tokenPermissions = response.tokenPermissions ?? []
    if (!Array.isArray(response.accounts) || !Array.isArray(tokenPermissions)
      || tokenPermissions.some((permission) => typeof permission !== 'string')) {
      throw new Error('invalid account response')
    }
    for (const account of response.accounts) {
      assertRequiredKeys(account, ['id', 'name', 'type', 'settings', 'legacy_flags'])
      if (Object.hasOwn(account, 'created_on')) assertString(account.created_on)
      assertString(account.id)
      assertString(account.name)
      if (account.type !== 'standard') throw new Error('unsupported account type')
      if (!isPlainRecord(account.settings)) throw new Error('account settings expected')
      if (Object.hasOwn(account.settings, 'abuse_contact_email')) {
        assertNullableString(account.settings.abuse_contact_email)
      }
      if (Object.hasOwn(account.settings, 'access_approval_expiry')) {
        assertNullableString(account.settings.access_approval_expiry)
      }
      // The env-token (CLOUDFLARE_API_TOKEN) shape reports api_access_enabled as null;
      // scoped delivery tokens cannot read /user, so the account-settings endpoint emits
      // null for it. OAuth/API-key variants carry a real boolean and stay strict here.
      const apiAccessEnabled = account.settings.api_access_enabled
      if (envTokenShape ? apiAccessEnabled !== null && typeof apiAccessEnabled !== 'boolean'
        : typeof apiAccessEnabled !== 'boolean') {
        throw new Error('invalid account setting')
      }
      for (const field of ['enforce_twofactor', 'oauth_app_access_enabled']) {
        if (typeof account.settings[field] !== 'boolean') throw new Error('invalid account setting')
      }
      if (!isPlainRecord(account.legacy_flags)) throw new Error('legacy flags expected')
      if (Object.hasOwn(account.legacy_flags, 'enterprise_zone_quota')) {
        const quota = account.legacy_flags.enterprise_zone_quota
        if (!isPlainRecord(quota)) throw new Error('enterprise zone quota expected')
        for (const value of Object.values(quota)) {
          assertNonNegativeInteger(value)
        }
      }
    }
    if (response.accounts.filter((account) => account.id === expectedAccountId).length !== 1) {
      const error = new Error('account identity drift')
      error.code = 'DELIVERY_ACCOUNT_MISMATCH'
      throw error
    }
    // The env-token shape carries no runtime scope proof (no tokenPermissions); the
    // required scopes are asserted before delivery by the production authority gate
    // (the manifest cloudflare_delivery credential slot must declare exactly
    // account:read + d1:write + r2:write + workers:write), and the Cloudflare API
    // enforces them on every delivery mutation. The account-match above remains
    // the identity/drift defense.
    if (!envTokenShape
      && !REQUIRED_DELIVERY_TOKEN_PERMISSIONS.every((permission) => tokenPermissions.includes(permission))) {
      const error = new Error('delivery token permissions are insufficient')
      error.code = 'DELIVERY_PERMISSION_INSUFFICIENT'
      throw error
    }
    return response
  } catch (error) {
    if (['DELIVERY_ACCOUNT_MISMATCH', 'DELIVERY_PERMISSION_INSUFFICIENT'].includes(error?.code)) throw error
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

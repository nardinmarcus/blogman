import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { runLocalRehearsal } from './issue-23-delivery-rehearsal.mjs'
import { hashD1ArtifactDirectory } from './issue-23-delivery-d1-contracts.mjs'
import { buildFormalRuntimeReceipt } from './issue-23-delivery-formal-runtime.mjs'
import { currentFormalRehearsalContext } from './issue-23-delivery-formal-context.mjs'

const MANIFEST_SCHEMA_URL = new URL(
  '../schemas/issue-23-delivery/blogman-issue-23-canonical-frozen-manifest-v1.schema.json',
  import.meta.url,
)
const MANIFEST_SCHEMA = JSON.parse(readFileSync(MANIFEST_SCHEMA_URL, 'utf8'))
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const CANONICAL_MANIFEST_FORMAT = 'blogman-issue-23-canonical-frozen-manifest/v1'

export const DEFAULT_STAGE_POLICY = Object.freeze([
  Object.freeze({ name: 'authorization_accept', timeout_seconds: 30 }),
  Object.freeze({ name: 'live_preconditions', timeout_seconds: 120 }),
  Object.freeze({ name: 'd1_identity', timeout_seconds: 120 }),
  Object.freeze({ name: 'clean_start_reset', timeout_seconds: 300 }),
  Object.freeze({ name: 'empty_d1_proof', timeout_seconds: 300 }),
  Object.freeze({ name: 'migrations_001_006', timeout_seconds: 2100 }),
  Object.freeze({ name: 'reconciliation', timeout_seconds: 300 }),
  Object.freeze({ name: 'worker_deploy', timeout_seconds: 600 }),
  Object.freeze({ name: 'version_traffic_verification', timeout_seconds: 300 }),
  Object.freeze({ name: 'smoke_control_t0', timeout_seconds: 300 }),
])

const EXPECTED_FROZEN_PRECONDITIONS = Object.freeze([
  'repository.commit',
  'repository.tree',
  'ci.head_sha',
  'ci.tree',
  'artifact.file_tree.sha256',
  'migration.catalog.sha256',
  'target.baseline',
])
const EXPECTED_OBSERVATIONS = Object.freeze([
  'target.deployment_id',
  'target.version_id',
  'target.traffic',
  'rehearsal.receipt_sha256',
])
const EXPECTED_EVIDENCE_EXCLUSIONS = Object.freeze([
  'secret_values',
  'raw_private_adapter_output',
  'sql_bodies',
  'private_operator_paths',
])
const EXPECTED_MIGRATIONS = Object.freeze(['001', '002', '003', '004', '005', '006'])
const EXPECTED_D1_MIGRATION_NAMES = Object.freeze([
  '001_initial_schema',
  '002_add_ai_image_configuration',
  '003_migrate_runtime_ai_configuration',
  '004_complete_historical_text_ai_schema',
  '005_fix_posts_fts_sync',
  '006_add_rollout_safety_controls',
])
const EXPECTED_RECONCILIATION_FORMAT = 'blogman-d1-reconciliation/v1'
const CANONICAL_D1_PATHS = Object.freeze({
  config: 'wrangler.toml',
  reset: 'db/issue-23-clean-start-reset.sql',
  runner: 'scripts/migrations.mjs',
  catalog: 'db/ledger-migrations',
  rolloutSafety: 'scripts/rollout-safety.mjs',
})
const ARTIFACT_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u
const ARTIFACT_EXCLUDED_PATH_PATTERN = /(^|\/)(?:private|operator|secret|credential|tmp)(?:\/|$)/iu
const GENERATED_RUNTIME_NODE_MODULES_LINK = /^server-functions\/[^/]+\/node_modules$/u
const ZERO_ACTIONS_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
const BUILD_PREVIEW_MODE_ID_ENV = 'BLOGMAN_BUILD_PREVIEW_MODE_ID'
const BUILD_PREVIEW_MODE_SIGNING_KEY_ENV = 'BLOGMAN_BUILD_PREVIEW_MODE_SIGNING_KEY'
const BUILD_PREVIEW_MODE_ENCRYPTION_KEY_ENV = 'BLOGMAN_BUILD_PREVIEW_MODE_ENCRYPTION_KEY'
const BUILD_EPOCH_MS_ENV = 'BLOGMAN_BUILD_EPOCH_MS'
const SAFE_ZERO_PREVIEW = Object.freeze({
  [BUILD_PREVIEW_MODE_ID_ENV]: '0123456789abcdef0123456789abcdef',
  [BUILD_PREVIEW_MODE_SIGNING_KEY_ENV]: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  [BUILD_PREVIEW_MODE_ENCRYPTION_KEY_ENV]: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
})
const REACHABLE_PREVIEW_PATTERN = /\b(?:draftMode|previewData|setPreviewData|clearPreviewData|__next_preview_data|__prerender_bypass|previewMode(?:Id|SigningKey|EncryptionKey))\b|\b(?:preview|draft)[-_ ]?(?:cookie|data|mode)\b/iu
const REACHABLE_PREVIEW_ROUTE_PATTERN = /(?:^|\/)(?:preview|draft(?:mode|data)?)(?:\/|$)/iu
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])

const CONFIG_REHEARSAL_SCHEMA = Object.freeze({
  ...MANIFEST_SCHEMA.properties.rehearsal,
  required: ['runtime', 'network', 'status', 'receipt_sha256', 'production_write_adapter_calls'],
})
const CONFIG_CI_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'workflow', 'expected_head_sha'],
  properties: {
    provider: { const: 'github-actions' },
    workflow: MANIFEST_SCHEMA.properties.ci.properties.workflow,
    expected_head_sha: MANIFEST_SCHEMA.properties.ci.properties.head_sha,
  },
})
const FIXED_SMOKE_CONTRACT = Object.freeze({
  requests: Object.freeze([
    Object.freeze({ path: '/api/search', status: 200 }),
    Object.freeze({ path: '/api/settings/appearance', status: 200 }),
    Object.freeze({ path: '/api/settings/tokens', status: 200 }),
    Object.freeze({ path: '/api/settings/ai-provider', status: 200 }),
    Object.freeze({ path: '/api/settings/ai-generators', status: 200 }),
    Object.freeze({ path: '/api/admin/articles/__blogman_smoke_absent__', status: 404 }),
  ]),
  admin_credential_slot: 'delivery_smoke_admin',
})
const CONFIG_SCHEMA = Object.freeze({
  ...MANIFEST_SCHEMA,
  required: MANIFEST_SCHEMA.required.filter((key) => key !== 'format' && key !== 'd1'),
  properties: {
    ...Object.fromEntries(
      Object.entries(MANIFEST_SCHEMA.properties)
        .filter(([key]) => key !== 'format' && key !== 'd1' && key !== 'rehearsal'),
    ),
    ci: CONFIG_CI_SCHEMA,
    target: {
      ...MANIFEST_SCHEMA.properties.target,
      required: MANIFEST_SCHEMA.properties.target.required.filter((key) => key !== 'smoke'),
    },
    rehearsal: CONFIG_REHEARSAL_SCHEMA,
  },
})
const PRODUCTION_MANIFEST_POLICY = Object.freeze({
  conclusion: 'success',
  ciEvidenceClass: 'production-ci-evidence',
  d1EvidenceClass: 'production',
})
const FORMAL_REHEARSAL_MANIFEST_POLICY = Object.freeze({
  conclusion: 'in_progress-test-evidence',
  ciEvidenceClass: 'formal-rehearsal-test-evidence',
  d1EvidenceClass: 'formal-rehearsal-test-evidence',
})

function fail(message) {
  throw new Error(`Canonical Frozen Manifest: ${message}`)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateSchemaValue(value, schema, path = '$') {
  if (typeof schema.$ref === 'string') {
    const reference = schema.$ref.match(/^#\/\$defs\/([A-Za-z0-9_]+)$/u)?.[1]
    if (!reference || !MANIFEST_SCHEMA.$defs?.[reference]) fail(`${path} has an unresolved schema reference`)
    return validateSchemaValue(value, MANIFEST_SCHEMA.$defs[reference], path)
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) {
    fail(`${path} must equal its schema constant`)
  }

  if (schema.enum && !schema.enum.includes(value)) {
    fail(`${path} has an invalid value`)
  }

  if (schema.type === 'object') {
    if (!isRecord(value)) fail(`${path} must be an object`)
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) fail(`${path}.${key} is not allowed`)
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchemaValue(value[key], childSchema, `${path}.${key}`)
    }
    return
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(`${path} must be an array`)
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`${path} has too few items`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`${path} has too many items`)
    }
    if (schema.items && schema.items !== false) {
      value.forEach((item, index) => validateSchemaValue(item, schema.items, `${path}[${index}]`))
    }
    return
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') fail(`${path} must be a string`)
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(`${path} is too short`)
    }
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) {
      fail(`${path} has an invalid value`)
    }
    return
  }

  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) fail(`${path} must be an integer`)
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(`${path} is below its minimum`)
    }
    return
  }

  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    fail(`${path} must be a boolean`)
  }
}

function orderBySchema(value, schema) {
  if (schema.type === 'object') {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([key]) => Object.hasOwn(value, key))
        .map(([key, childSchema]) => [key, orderBySchema(value[key], childSchema)]),
    )
  }
  if (schema.type === 'array') {
    return value.map((item) => orderBySchema(item, schema.items))
  }
  return value
}

function canonicalDraftBytes(value) {
  const ordered = orderBySchema({ format: CANONICAL_MANIFEST_FORMAT, ...value }, MANIFEST_SCHEMA)
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function command(repositoryPath, name, args, { cwd = repositoryPath, env = process.env } = {}) {
  try {
    return execFileSync(name, args, { cwd, env, encoding: 'utf8' }).trim()
  } catch (error) {
    fail(`could not resolve ${name}: ${error.message}`)
  }
}

function resolveBuildEpochMs(repositoryPath, commit) {
  const secondsText = command(repositoryPath, 'git', ['show', '-s', '--format=%ct', commit])
  if (!/^\d+$/u.test(secondsText)) fail('resolved candidate commit timestamp is invalid')
  const milliseconds = Number(secondsText) * 1000
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    fail('resolved candidate commit timestamp is outside the safe millisecond range')
  }
  return milliseconds
}

function resolveProductionBuildInputs(repositoryPath, repository) {
  return {
    buildEnv: { ...SAFE_ZERO_PREVIEW },
    buildEpochMs: resolveBuildEpochMs(repositoryPath, repository.commit),
  }
}

function runOpenNextBuild(repositoryPath, { buildEnv, buildEpochMs } = {}) {
  // The output directory is agent-controlled only from this point through the
  // subsequent resolver-link validation; stale or attacker-created links never
  // participate in the frozen artifact identity.
  rmSync(resolve(repositoryPath, '.open-next'), { recursive: true, force: true })
  const environment = {
    ...process.env,
    ...(buildEnv ?? {}),
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: ZERO_ACTIONS_ENCRYPTION_KEY,
  }
  if (buildEpochMs !== undefined) environment[BUILD_EPOCH_MS_ENV] = String(buildEpochMs)
  command(repositoryPath, process.execPath, [
    resolve(repositoryPath, 'node_modules', '.bin', 'opennextjs-cloudflare'), 'build',
  ], { env: environment })
}

function npmCliPath(nodePath) {
  return join(dirname(dirname(nodePath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

function resolveExecutableBytes(path, label) {
  try {
    const canonicalPath = realpathSync(path)
    return { path: canonicalPath, bytes: readFileSync(canonicalPath) }
  } catch {
    fail(`could not resolve ${label} executable bytes`)
  }
}

function resolveFile(repositoryPath, path, label, includeBytes = false) {
  const lexicalRoot = resolve(repositoryPath)
  const absolute = resolve(lexicalRoot, path)
  if (absolute !== lexicalRoot && !absolute.startsWith(`${lexicalRoot}${sep}`)) {
    fail(`${label} escapes repository`)
  }

  let canonicalRoot
  let canonicalTarget
  try {
    canonicalRoot = realpathSync(lexicalRoot)
    canonicalTarget = realpathSync(absolute)
  } catch {
    fail(`${label} could not be resolved`)
  }
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) {
    fail(`${label} escapes repository`)
  }

  try {
    const bytes = readFileSync(canonicalTarget)
    return includeBytes
      ? { path, sha256: sha256(bytes), bytes: statSync(canonicalTarget).size }
      : { path, sha256: sha256(bytes) }
  } catch {
    fail(`${label} could not be resolved`)
  }
}

function resolveDirectory(repositoryPath, path, label) {
  const lexicalRoot = resolve(repositoryPath)
  const absolute = resolve(lexicalRoot, path)
  if (absolute !== lexicalRoot && !absolute.startsWith(`${lexicalRoot}${sep}`)) {
    fail(`${label} escapes repository`)
  }

  let canonicalRoot
  let canonicalTarget
  try {
    canonicalRoot = realpathSync(lexicalRoot)
    canonicalTarget = realpathSync(absolute)
  } catch {
    fail(`${label} could not be resolved`)
  }
  if (canonicalTarget === canonicalRoot || !canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) {
    fail(`${label} escapes repository`)
  }

  try {
    if (!statSync(canonicalTarget).isDirectory()) fail(`${label} is not a directory`)
  } catch (error) {
    if (error instanceof Error && / is not a directory$/u.test(error.message)) throw error
    fail(`${label} could not be resolved`)
  }
  return relative(canonicalRoot, canonicalTarget).split(sep).join('/')
}

function resolveDeclaredFile(repositoryPath, declaration, label) {
  const resolved = resolveFile(repositoryPath, declaration.path, label)
  if (resolved.sha256 !== declaration.sha256) {
    fail(`${label} declared sha256 does not match actual bytes`)
  }
  return resolved
}

function canonicalExpectedReconciliation(value) {
  if (!isRecord(value)) fail('expected reconciliation snapshot is invalid')
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 4 || !['format', 'schema', 'migration_ledger', 'posts'].every((key) => keys.includes(key))) {
    fail('expected reconciliation snapshot has unsupported fields')
  }
  if (value.format !== EXPECTED_RECONCILIATION_FORMAT) {
    fail('expected reconciliation snapshot format is invalid')
  }
  if (!isRecord(value.schema) || Reflect.ownKeys(value.schema).length !== 1
    || !/^[a-f0-9]{64}$/u.test(value.schema.sha256)) {
    fail('expected reconciliation schema is invalid')
  }
  if (!isRecord(value.migration_ledger)
    || Reflect.ownKeys(value.migration_ledger).length !== 3
    || !['absent', 'present'].includes(value.migration_ledger.state)
    || !Number.isSafeInteger(value.migration_ledger.row_count)
    || value.migration_ledger.row_count < 0
    || !/^[a-f0-9]{64}$/u.test(value.migration_ledger.sha256)) {
    fail('expected reconciliation migration ledger is invalid')
  }
  if (!isRecord(value.posts)
    || Reflect.ownKeys(value.posts).length !== 3
    || !Number.isSafeInteger(value.posts.count)
    || value.posts.count < 0
    || !isRecord(value.posts.status)
    || !/^[a-f0-9]{64}$/u.test(value.posts.content_sha256)) {
    fail('expected reconciliation posts are invalid')
  }
  for (const count of Object.values(value.posts.status)) {
    if (!Number.isSafeInteger(count) || count < 0) fail('expected reconciliation post status is invalid')
  }
  return {
    format: value.format,
    schema: { sha256: value.schema.sha256 },
    migration_ledger: {
      state: value.migration_ledger.state,
      row_count: value.migration_ledger.row_count,
      sha256: value.migration_ledger.sha256,
    },
    posts: {
      count: value.posts.count,
      status: Object.fromEntries(Object.entries(value.posts.status).sort()),
      content_sha256: value.posts.content_sha256,
    },
  }
}

function canonicalExpectedReconciliationBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalExpectedReconciliation(value), null, 2)}\n`, 'utf8')
}

function resolveCanonicalD1Facts(repositoryPath, target, toolchain, repository) {
  const canonicalConfig = resolveFile(repositoryPath, CANONICAL_D1_PATHS.config, 'canonical D1 config', true)
  const configText = readFileSync(resolve(repositoryPath, CANONICAL_D1_PATHS.config), 'utf8')
  const d1Sections = [...configText.matchAll(/\[\[d1_databases\]\]([\s\S]*?)(?=\n\[|$)/gu)]
  const database = d1Sections
    .map(([, section]) => section.match(/^binding\s*=\s*["']([^"']+)["']/mu)?.[1])
    .find((binding) => binding === 'DB')
  if (!database) fail('canonical D1 config does not bind DB')

  const canonicalReset = resolveFile(repositoryPath, CANONICAL_D1_PATHS.reset, 'canonical D1 reset SQL')
  const canonicalRunner = resolveFile(repositoryPath, CANONICAL_D1_PATHS.runner, 'canonical D1 migration runner')
  const canonicalCatalog = resolveDirectory(repositoryPath, CANONICAL_D1_PATHS.catalog, 'canonical D1 migration catalog')
  const canonicalCatalogAbsolute = realpathSync(resolve(repositoryPath, canonicalCatalog))
  const catalogOutput = command(repositoryPath, process.execPath, [
    resolve(repositoryPath, canonicalRunner.path),
    'catalog',
    '--migrations-dir',
    canonicalCatalogAbsolute,
  ])
  let catalog
  try {
    catalog = parseStrictJson(Buffer.from(catalogOutput, 'utf8'))
  } catch {
    fail('canonical D1 migration catalog output is invalid')
  }
  if (!isRecord(catalog) || Reflect.ownKeys(catalog).length !== 2
    || catalog.format !== 'blogman-migration-catalog/v1'
    || !Array.isArray(catalog.migrations)
    || catalog.migrations.length !== EXPECTED_D1_MIGRATION_NAMES.length) {
    fail('canonical D1 migration catalog is invalid')
  }
  const migrations = catalog.migrations.map((entry, index) => {
    if (!isRecord(entry) || Reflect.ownKeys(entry).length !== 3
      || entry.number !== index + 1
      || entry.name !== EXPECTED_D1_MIGRATION_NAMES[index]
      || !/^[a-f0-9]{64}$/u.test(entry.checksum)) {
      fail(`canonical D1 migration ${index + 1} is invalid`)
    }
    return { number: entry.number, name: entry.name, checksum: entry.checksum }
  })
  const canonicalRolloutSafety = resolveFile(
    repositoryPath,
    CANONICAL_D1_PATHS.rolloutSafety,
    'canonical D1 rollout safety',
  )
  return {
    mode: 'remote',
    database,
    config_path: canonicalConfig.path,
    config_sha256: canonicalConfig.sha256,
    wrangler_sha256: toolchain.wrangler.identity_sha256,
    account_id: target.account_id,
    d1_database_id: target.d1_database_id,
    reset_sql_path: canonicalReset.path,
    reset_sql_sha256: canonicalReset.sha256,
    migration_runner_path: canonicalRunner.path,
    migration_runner_sha256: canonicalRunner.sha256,
    migration_catalog_path: canonicalCatalog,
    migration_catalog_sha256: hashD1ArtifactDirectory(canonicalCatalogAbsolute),
    rollout_safety_path: canonicalRolloutSafety.path,
    rollout_safety_sha256: canonicalRolloutSafety.sha256,
    expected_reconciliation_format: EXPECTED_RECONCILIATION_FORMAT,
    candidate_id: repository.commit,
    evidence_class: 'production',
    migrations,
  }
}

function resolveMigrationCatalog(configuredMigrations, resolvedCatalog) {
  if (!isRecord(resolvedCatalog)
    || Object.keys(resolvedCatalog).sort().join(',') !== 'format,migrations'
    || resolvedCatalog.format !== 'blogman-migration-catalog/v1'
    || !Array.isArray(resolvedCatalog.migrations)
    || resolvedCatalog.migrations.length !== configuredMigrations.length) {
    fail('resolved migration catalog envelope is invalid')
  }

  return resolvedCatalog.migrations.map((entry, index) => {
    const configured = configuredMigrations[index]
    if (!isRecord(entry)
      || Object.keys(entry).sort().join(',') !== 'checksum,name,number'
      || !Number.isSafeInteger(entry.number)
      || typeof entry.name !== 'string'
      || !/^[a-f0-9]{64}$/u.test(entry.checksum)) {
      fail(`resolved migration catalog entry ${index} is invalid`)
    }
    const resolvedId = String(entry.number).padStart(3, '0')
    if (resolvedId !== configured.id) {
      fail('resolved migration catalog does not match the configured migration set')
    }
    if (entry.name !== basename(configured.path, '.sql')) {
      fail(`resolved migration catalog name does not match configured migration ${configured.id}`)
    }
    return resolvedId
  })
}

function enumerateBuildFiles(repositoryPath) {
  const buildRoot = resolve(repositoryPath, '.open-next')
  const files = []
  const visit = (directory, prefix) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      fail('final OpenNext artifact directory could not be read')
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(absolute, path)
      } else if (entry.isFile()) {
        files.push(path)
      } else if (entry.isSymbolicLink()) {
        fail(`final OpenNext artifact contains symbolic link ${path}`)
      } else {
        fail(`final OpenNext artifact contains unsupported entry ${path}`)
      }
    }
  }
  try {
    if (!statSync(buildRoot).isDirectory()) fail('final OpenNext artifact directory is not a directory')
  } catch {
    fail('final OpenNext artifact directory is missing')
  }
  visit(buildRoot, '')
  return files.sort()
}

export function removeVerifiedOpenNextResolverLinks(repositoryPath) {
  const buildRoot = resolve(repositoryPath, '.open-next')
  const frozenNodeModules = realpathSync(resolve(repositoryPath, 'node_modules'))
  const serverFunctionsRoot = join(buildRoot, 'server-functions')
  let removed = 0
  const entries = readdirSync(serverFunctionsRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('OpenNext server function directory is invalid')
    const functionRoot = join(serverFunctionsRoot, entry.name)
    for (const required of ['handler.mjs', 'open-next.config.mjs', 'package.json']) {
      const metadata = lstatSync(join(functionRoot, required))
      if (!metadata.isFile() || metadata.isSymbolicLink()) fail('OpenNext server function evidence is invalid')
    }
    const resolverLink = join(functionRoot, 'node_modules')
    for (const child of readdirSync(functionRoot, { withFileTypes: true })) {
      if (child.isSymbolicLink() && child.name !== 'node_modules') {
        fail('OpenNext server function contains an unexpected symbolic link')
      }
    }
    const metadata = lstatSync(resolverLink)
    const relativeLink = `server-functions/${entry.name}/node_modules`
    if (!GENERATED_RUNTIME_NODE_MODULES_LINK.test(relativeLink) || !metadata.isSymbolicLink()
      || realpathSync(resolverLink) !== frozenNodeModules) {
      fail('OpenNext runtime resolver link is not the generated frozen-node-modules link')
    }
    unlinkSync(resolverLink)
    removed += 1
  }
  if (removed === 0) fail('OpenNext generated runtime resolver link is missing')
  return removed
}

function enumeratePublicBuildFiles(repositoryPath, archivePath) {
  const archiveName = basename(resolve(repositoryPath, archivePath))
  return enumerateBuildFiles(repositoryPath)
    .filter((path) => path !== archiveName)
    .filter((path) => {
      const publicPath = `.open-next/${path}`
      return ARTIFACT_PATH_PATTERN.test(publicPath) && !ARTIFACT_EXCLUDED_PATH_PATTERN.test(publicPath)
    })
}

function assertZeroActionsBuild(repositoryPath) {
  const wrapperPrefix = 'self.__RSC_SERVER_MANIFEST='
  const readManifest = (path, label) => {
    try {
      return readFileSync(resolve(repositoryPath, path))
    } catch {
      fail(`${label} is missing`)
    }
  }
  const parseShape = (value, expectedEncryptionKey, label) => {
    if (!isRecord(value)
      || Object.keys(value).length !== 3
      || !Object.hasOwn(value, 'node')
      || !Object.hasOwn(value, 'edge')
      || !Object.hasOwn(value, 'encryptionKey')
      || !isRecord(value.node)
      || !isRecord(value.edge)
      || value.encryptionKey !== expectedEncryptionKey) {
      fail(`${label} has an unexpected shape or encryption key`)
    }
    return value
  }

  let jsonManifest
  try {
    jsonManifest = parseShape(
      parseStrictJson(readManifest(
        '.next/server/server-reference-manifest.json',
        'server reference manifest JSON',
      )),
      ZERO_ACTIONS_ENCRYPTION_KEY,
      'server reference manifest JSON',
    )
  } catch {
    fail('server reference manifest JSON is malformed')
  }

  const wrapperBytes = readManifest(
    '.next/server/server-reference-manifest.js',
    'server reference manifest JS wrapper',
  )
  const wrapper = wrapperBytes.toString('utf8')
  if (!Buffer.from(wrapper, 'utf8').equals(wrapperBytes) || !wrapper.startsWith(wrapperPrefix)) {
    fail('server reference manifest JS wrapper has an unexpected shape')
  }

  let jsManifest
  try {
    const serializedManifest = JSON.parse(wrapper.slice(wrapperPrefix.length))
    if (typeof serializedManifest !== 'string') throw new Error('unexpected wrapper payload')
    jsManifest = parseShape(
      parseStrictJson(Buffer.from(serializedManifest, 'utf8')),
      'process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY',
      'server reference manifest JS wrapper',
    )
  } catch {
    fail('server reference manifest JS wrapper is malformed')
  }

  if (!jsonEqual(jsonManifest.node, jsManifest.node)
    || !jsonEqual(jsonManifest.edge, jsManifest.edge)) {
    fail('server reference manifest JSON and JS action maps do not match')
  }
  if (Object.keys(jsonManifest.node).length !== 0) {
    fail('server reference manifest node action map is not empty')
  }
  if (Object.keys(jsonManifest.edge).length !== 0) {
    fail('server reference manifest edge action map is not empty')
  }
}

function createBuildArchive(repositoryPath, archivePath, files) {
  const buildRoot = resolve(repositoryPath, '.open-next')
  const absoluteArchive = resolve(repositoryPath, archivePath)
  if (dirname(absoluteArchive) !== buildRoot) {
    fail('artifact archive must be created directly under .open-next')
  }
  if (files.length === 0) fail('final OpenNext artifact is empty')
  const fixedTime = new Date('1980-01-01T00:00:00.000Z')
  for (const path of files) {
    resolveFile(repositoryPath, `.open-next/${path}`, 'final artifact file')
    utimesSync(join(buildRoot, path), fixedTime, fixedTime)
  }
  if (existsSync(absoluteArchive)) unlinkSync(absoluteArchive)
  command(repositoryPath, 'zip', ['-X', '-q', basename(absoluteArchive), ...files], { cwd: buildRoot })
}

function enumerateArtifactPaths(configuredFiles, buildFiles) {
  const buildPaths = buildFiles.map((path) => `.open-next/${path}`)
  const paths = [...buildPaths, 'wrangler.toml']
    .filter((path) => ARTIFACT_PATH_PATTERN.test(path))
    .filter((path) => !ARTIFACT_EXCLUDED_PATH_PATTERN.test(path))
    .sort()
  const available = new Set(paths)
  for (const file of configuredFiles) {
    if (!available.has(file.path)) {
      fail(`artifact file ${file.path} is not in the complete public artifact tree`)
    }
  }
  return paths
}

export function canonicalizeRepositoryRemote(remote) {
  if (typeof remote !== 'string' || remote !== remote.trim()) {
    fail('resolved repository remote is not canonical')
  }
  let url
  try {
    url = new URL(remote)
  } catch {
    fail('resolved repository remote is not canonical')
  }
  if (url.protocol !== 'https:'
    || url.hostname !== 'github.com'
    || url.port !== ''
    || !['/nardinmarcus/blogman', '/nardinmarcus/blogman.git'].includes(url.pathname)) {
    fail('resolved repository remote is not canonical')
  }
  return 'https://github.com/nardinmarcus/blogman.git'
}

function resolveRepositoryFacts(repositoryPath) {
  const commit = command(repositoryPath, 'git', ['rev-parse', 'HEAD'])
  const tree = command(repositoryPath, 'git', ['rev-parse', 'HEAD^{tree}'])
  const status = command(repositoryPath, 'git', ['status', '--porcelain'])
  const remote = command(repositoryPath, 'git', ['remote', 'get-url', 'origin'])
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree) || status !== '') {
    fail('resolved repository identity is not a valid Git commit/tree')
  }
  return { commit, tree, clean: true, remote: canonicalizeRepositoryRemote(remote) }
}

function resolveCiFacts(repositoryPath, config, repository) {
  const expected = config.ci
  if (expected.expected_head_sha !== repository.commit) {
    fail('configured CI expected head does not match the resolved candidate')
  }
  const parse = (output, label) => {
    try {
      return JSON.parse(output)
    } catch {
      fail(`${label} did not return JSON`)
    }
  }
  const validateRun = (run) => {
    if (!isRecord(run)
      || !Number.isSafeInteger(run.databaseId) || run.databaseId < 1
      || run.headSha !== repository.commit
      || run.status !== 'completed'
      || run.attempt !== 1
      || !['push', 'pull_request'].includes(run.event)
      || run.conclusion !== 'success') {
      fail('GitHub Actions did not provide a completed successful exact-head candidate run')
    }
    return run
  }
  const runs = parse(command(repositoryPath, 'gh', [
    'run', 'list', '--repo', 'nardinmarcus/blogman', '--workflow', expected.workflow,
    '--commit', repository.commit, '--status', 'completed', '--json',
    'databaseId,headSha,status,conclusion,event,attempt', '--limit', '20',
  ]), 'GitHub Actions run list')
  if (!Array.isArray(runs)) fail('GitHub Actions run list is invalid')
  const run = runs.map(validateRun).find((candidate) => candidate.conclusion === 'success')
  if (!run) fail('GitHub Actions has no completed successful exact-head candidate run')
  const commit = parse(command(repositoryPath, 'gh', [
    'api', `repos/nardinmarcus/blogman/git/commits/${repository.commit}`,
  ]), 'GitHub commit identity')
  if (!isRecord(commit) || !isRecord(commit.tree) || commit.tree.sha !== repository.tree) {
    fail('GitHub Actions candidate tree does not match the resolved candidate tree')
  }
  return {
    provider: 'github-actions',
    workflow: expected.workflow,
    run_id: run.databaseId,
    attempt: run.attempt,
    event: run.event,
    head_sha: run.headSha,
    tree: commit.tree.sha,
    conclusion: 'success',
  }
}

export function isExactWorkflowPath(path, workflow) {
  return typeof path === 'string' && path === workflow
}

function resolveFormalCiFacts(repositoryPath, config, repository) {
  const runId = process.env.GITHUB_RUN_ID
  const attempt = process.env.GITHUB_RUN_ATTEMPT
  const event = process.env.GITHUB_EVENT_NAME
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (process.env.GITHUB_ACTIONS !== 'true'
    || !/^[1-9][0-9]*$/u.test(runId ?? '')
    || attempt !== '1'
    || !['push', 'pull_request'].includes(event)
    || typeof eventPath !== 'string') {
    fail('formal rehearsal requires the current GitHub Actions run identity')
  }
  let eventPayload
  try {
    eventPayload = JSON.parse(readFileSync(eventPath, 'utf8'))
  } catch {
    fail('formal rehearsal GitHub event payload is unreadable')
  }
  const eventHeadSha = event === 'pull_request'
    ? eventPayload?.pull_request?.head?.sha
    : eventPayload?.after
  if (config.ci.expected_head_sha !== repository.commit
    || eventHeadSha !== repository.commit) {
    fail('formal rehearsal event candidate does not match the checked-out candidate')
  }
  const parse = (output, label) => {
    try { return JSON.parse(output) } catch { fail(`${label} is invalid`) }
  }
  const run = parse(command(repositoryPath, 'gh', [
    'api', `repos/nardinmarcus/blogman/actions/runs/${runId}`,
  ]), 'formal rehearsal GitHub Actions run')
  if (!isRecord(run)
    || run.id !== Number(runId)
    || run.run_attempt !== Number(attempt)
    || run.event !== event
    || run.head_sha !== repository.commit
    || run.status !== 'in_progress'
    || run.conclusion !== null
    || !isExactWorkflowPath(run.path, config.ci.workflow)) {
    fail('formal rehearsal current run receipt is not an in-progress exact candidate run')
  }
  const commit = parse(command(repositoryPath, 'gh', [
    'api', `repos/nardinmarcus/blogman/git/commits/${repository.commit}`,
  ]), 'formal rehearsal GitHub commit identity')
  if (!isRecord(commit) || !isRecord(commit.tree) || commit.tree.sha !== repository.tree) {
    fail('formal rehearsal candidate tree does not match the checked-out candidate tree')
  }
  return {
    provider: 'github-actions',
    workflow: config.ci.workflow,
    run_id: run.id,
    attempt: run.run_attempt,
    event: run.event,
    head_sha: run.head_sha,
    tree: commit.tree.sha,
    conclusion: 'in_progress-test-evidence',
  }
}

function resolveTargetFacts(target) {
  if (!isRecord(target) || !isRecord(target.baseline)
    || target.baseline.d1_database_id !== target.d1_database_id
    || target.baseline.traffic?.length !== 1
    || target.baseline.traffic[0]?.version_id !== target.baseline.version_id
    || target.baseline.traffic[0]?.percentage !== 100) {
    fail('resolved target facts are incomplete or inconsistent')
  }
  return { ...structuredClone(target), smoke: structuredClone(FIXED_SMOKE_CONTRACT) }
}

function assertCanonicalProductionPaths(config) {
  const paths = [
    ['migration.reset_sql.path', config.migration.reset_sql.path, CANONICAL_D1_PATHS.reset],
    ['migration.runner.path', config.migration.runner.path, CANONICAL_D1_PATHS.runner],
    ['migration.catalog.path', config.migration.catalog.path, CANONICAL_D1_PATHS.catalog],
  ]
  for (const [label, actual, expected] of paths) {
    if (actual !== expected) fail(`${label} must identify the canonical production artifact`)
  }
  for (const [index, migration] of config.migration.catalog.migrations.entries()) {
    const expected = `${CANONICAL_D1_PATHS.catalog}/${EXPECTED_D1_MIGRATION_NAMES[index]}.sql`
    if (migration.path !== expected) {
      fail(`migration.catalog.migrations[${index}] must identify the canonical production artifact`)
    }
  }
}

function resolveRehearsalEvidence(rehearsalResult) {
  if (!isRecord(rehearsalResult)
    || rehearsalResult.status !== 'PASS'
    || rehearsalResult.network !== 'disabled'
    || rehearsalResult.production_write_adapter_calls !== 0) {
    fail('local rehearsal evidence is not a canonical PASS with disabled network and zero production writes')
  }

  const expectedEvidence = rehearsalResult.expected_reconciliation
  if (!isRecord(expectedEvidence)
    || Reflect.ownKeys(expectedEvidence).length !== 2
    || !Object.hasOwn(expectedEvidence, 'value')
    || !Object.hasOwn(expectedEvidence, 'sha256')) {
    fail('expected reconciliation evidence is required')
  }
  const expectedReconciliationBytes = canonicalExpectedReconciliationBytes(expectedEvidence.value)
  const expectedReconciliationSha256 = sha256(expectedReconciliationBytes)
  if (expectedEvidence.sha256 !== expectedReconciliationSha256) {
    fail('rehearsal expected reconciliation identity does not match its bytes')
  }

  const d1Evidence = rehearsalResult.d1
  if (!isRecord(d1Evidence)
    || d1Evidence.outcome !== 'PASS'
    || d1Evidence.production !== false
    || d1Evidence.promotable !== false
    || !/^[a-f0-9]{64}$/u.test(d1Evidence.sha256)) {
    fail('D1 stage receipt evidence is invalid')
  }

  const cleanup = rehearsalResult.cleanup
  if (!isRecord(cleanup)
    || cleanup.created !== true
    || cleanup.cleaned !== true
    || cleanup.observed_absent !== true) {
    fail('local rehearsal cleanup proof is incomplete')
  }
  if (!/^[a-f0-9]{64}$/u.test(rehearsalResult.receipt_sha256)) {
    fail('local rehearsal receipt identity is invalid')
  }

  return {
    expectedReconciliation: canonicalExpectedReconciliation(expectedEvidence.value),
    expectedReconciliationSha256,
    d1ReceiptSha256: d1Evidence.sha256,
    cleanup: { created: true, cleaned: true, observed_absent: true },
  }
}

function resolveFacts(config, {
  repositoryPath = REPO_ROOT,
  ciResolver = resolveCiFacts,
  manifestPolicy = PRODUCTION_MANIFEST_POLICY,
  rehearsalRunner = runLocalRehearsal,
  buildRunner = runOpenNextBuild,
  targetResolver = resolveTargetFacts,
  repositoryResolver = resolveRepositoryFacts,
  productionWriteAdapter,
  verifyGeneratedResolverLinks = false,
} = {}) {
  const repository = repositoryResolver(repositoryPath)
  if (repository.clean !== true) {
    fail('resolved repository identity is not a valid Git commit/tree')
  }
  if (config.repository.commit !== repository.commit || config.repository.tree !== repository.tree) {
    fail('caller-supplied repository identity does not match the resolved repository identity')
  }
  const preparation = {
    ...config.preparation,
    prepare_entry: resolveFile(repositoryPath, config.preparation.prepare_entry.path, 'prepare entry'),
    execute_entry: resolveFile(repositoryPath, config.preparation.execute_entry.path, 'execute entry'),
    manifest_schema: resolveFile(repositoryPath, config.preparation.manifest_schema.path, 'manifest schema'),
  }
  const ci = {
    ...ciResolver(repositoryPath, config, repository),
    evidence_class: manifestPolicy.ciEvidenceClass,
  }
  const nodeExecutable = realpathSync(process.execPath)
  const npmExecutableBytes = resolveExecutableBytes(npmCliPath(nodeExecutable), 'npm')
  const wranglerExecutable = resolve(repositoryPath, 'node_modules', '.bin', 'wrangler')
  const openNextExecutable = resolve(repositoryPath, 'node_modules', '.bin', 'opennextjs-cloudflare')
  const curlExecutableBytes = resolveExecutableBytes('/usr/bin/curl', 'curl')
  const npmVersion = command(repositoryPath, nodeExecutable, [npmExecutableBytes.path, '--version']).replace(/^v/u, '')
  const curlVersion = command(repositoryPath, curlExecutableBytes.path, ['--version'])
    .match(/^curl ([0-9]+(?:\.[0-9]+){1,2})\b/u)?.[1]
  if (!curlVersion) fail('resolved curl version is invalid')
  const wranglerExecutableBytes = resolveExecutableBytes(wranglerExecutable, 'Wrangler')
  const openNextExecutableBytes = resolveExecutableBytes(openNextExecutable, 'OpenNext')
  const wranglerVersion = command(repositoryPath, wranglerExecutable, ['--version'])
    .match(/([0-9]+\.[0-9]+\.[0-9]+)/u)?.[1]
  if (!wranglerVersion) fail('resolved Wrangler version is invalid')
  const packageJsonBytes = readFileSync(join(repositoryPath, 'package.json'))
  const lockfileBytes = readFileSync(join(repositoryPath, 'package-lock.json'))
  const lockfile = JSON.parse(lockfileBytes.toString('utf8'))
  const openNextVersion = lockfile.packages?.['node_modules/@opennextjs/cloudflare']?.version
  if (!openNextVersion) fail('resolved OpenNext version is missing')
  const toolchain = {
    ...config.toolchain,
    node: { version: process.versions.node, identity_sha256: sha256(readFileSync(nodeExecutable)) },
    npm: { version: npmVersion, identity_sha256: sha256(npmExecutableBytes.bytes) },
    curl: { version: curlVersion, identity_sha256: sha256(curlExecutableBytes.bytes) },
    wrangler: { version: wranglerVersion, identity_sha256: sha256(wranglerExecutableBytes.bytes) },
    opennextjs_cloudflare: { version: openNextVersion, identity_sha256: sha256(openNextExecutableBytes.bytes) },
    package_json_sha256: sha256(packageJsonBytes),
    lockfile_sha256: sha256(lockfileBytes),
  }
  buildRunner(repositoryPath, {
    artifact: config.artifact,
    config,
    ...resolveProductionBuildInputs(repositoryPath, repository),
  })
  assertNoReachablePreviewBuildEvidence(repositoryPath)
  assertZeroActionsBuild(repositoryPath)
  if (verifyGeneratedResolverLinks) removeVerifiedOpenNextResolverLinks(repositoryPath)
  const artifactBuildFiles = enumeratePublicBuildFiles(repositoryPath, config.artifact.archive.path)
  createBuildArchive(repositoryPath, config.artifact.archive.path, artifactBuildFiles)
  const artifactPaths = enumerateArtifactPaths(
    config.artifact.file_tree.files,
    artifactBuildFiles,
  )
  const artifact = {
    ...config.artifact,
    archive: resolveFile(repositoryPath, config.artifact.archive.path, 'artifact archive', true),
    worker: resolveFile(repositoryPath, config.artifact.worker.path, 'worker artifact', true),
    file_tree: {
      ...config.artifact.file_tree,
      files: artifactPaths.map((path) => resolveFile(repositoryPath, path, 'artifact file', true)),
    },
  }
  const migration = {
    ...config.migration,
    reset_sql: resolveFile(repositoryPath, config.migration.reset_sql.path, 'reset SQL'),
    runner: resolveDeclaredFile(repositoryPath, config.migration.runner, 'migration runner'),
    catalog: {
      ...config.migration.catalog,
      path: resolveDirectory(repositoryPath, config.migration.catalog.path, 'migration catalog'),
      migrations: config.migration.catalog.migrations.map((entry) => ({
        ...entry,
        ...resolveDeclaredFile(repositoryPath, entry, `migration ${entry.id}`),
      })),
    },
  }
  const catalogBytes = Buffer.from(command(repositoryPath, process.execPath, [
    resolve(repositoryPath, migration.runner.path), 'catalog',
    '--migrations-dir', migration.catalog.path,
  ]))
  const catalogSha256 = sha256(catalogBytes)
  if (catalogSha256 !== config.migration.catalog.sha256) {
    fail('migration catalog declared sha256 does not match actual bytes')
  }
  const resolvedCatalog = JSON.parse(catalogBytes.toString('utf8'))
  const resolvedIds = resolveMigrationCatalog(config.migration.catalog.migrations, resolvedCatalog)
  migration.catalog = {
    ...migration.catalog,
    sha256: catalogSha256,
    migrations: migration.catalog.migrations.map((entry, index) => ({
      ...entry,
      id: resolvedIds[index],
    })),
  }
  const target = targetResolver(config.target)
  const repositoryFacts = { ...config.repository, ...repository }
  const d1Base = resolveCanonicalD1Facts(repositoryPath, target, toolchain, repositoryFacts)
  const resolved = {
    ...config,
    preparation,
    repository: repositoryFacts,
    ci,
    toolchain,
    artifact: { ...artifact, file_tree: { ...artifact.file_tree, sha256: sha256(Buffer.from(JSON.stringify(artifact.file_tree.files))) } },
    migration,
    target,
  }
  delete resolved.rehearsal
  const manifestDraftSha256 = sha256(canonicalDraftBytes(resolved))
  const rehearsalResult = rehearsalRunner({
    repositoryPath,
    manifestDraftSha256,
    migrationRunnerPath: migration.runner.path,
    migrationCatalogPath: migration.catalog.path,
    d1: d1Base,
    productionWriteAdapter,
  })
  const rehearsalEvidence = resolveRehearsalEvidence(rehearsalResult)
  const d1 = {
    ...d1Base,
    evidence_class: manifestPolicy.d1EvidenceClass,
    expected_reconciliation_sha256: rehearsalEvidence.expectedReconciliationSha256,
    expected_reconciliation: rehearsalEvidence.expectedReconciliation,
  }
  const rehearsal = {
    runtime: rehearsalResult.runtime,
    runtime_receipt: buildFormalRuntimeReceipt().value,
    network: rehearsalResult.network,
    status: rehearsalResult.status,
    receipt_sha256: rehearsalResult.receipt_sha256,
    production_write_adapter_calls: rehearsalResult.production_write_adapter_calls,
    expected_reconciliation_sha256: rehearsalEvidence.expectedReconciliationSha256,
    d1_stage_receipt_sha256: rehearsalEvidence.d1ReceiptSha256,
    cleanup: rehearsalEvidence.cleanup,
  }
  return { ...resolved, target, d1, rehearsal }
}

function canonicalComparable(value) {
  if (Array.isArray(value)) return value.map(canonicalComparable)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalComparable(value[key])]),
    )
  }
  return value
}

function jsonEqual(left, right) {
  return JSON.stringify(canonicalComparable(left)) === JSON.stringify(canonicalComparable(right))
}

function assertPublicPath(path, label) {
  if (/(^|\/)(?:private|operator|secret|credential|tmp)(?:\/|$)/iu.test(path)) {
    fail(`${label} contains a private operator path`)
  }
}

function assertManifestRelationships(manifest, policy = PRODUCTION_MANIFEST_POLICY) {
  if (manifest.repository.canonical !== 'nardinmarcus/blogman') {
    fail('repository.canonical must identify the canonical repository')
  }
  if (manifest.repository.remote !== 'https://github.com/nardinmarcus/blogman.git') {
    fail('repository.remote must identify the canonical remote')
  }
  if (manifest.ci.head_sha !== manifest.repository.commit) {
    fail('ci.head_sha must equal repository.commit')
  }
  if (manifest.ci.tree !== manifest.repository.tree) {
    fail('ci.tree must equal repository.tree')
  }
  if (manifest.ci.conclusion !== policy.conclusion
    || manifest.ci.evidence_class !== policy.ciEvidenceClass) {
    fail('ci evidence classification is invalid')
  }
  if (manifest.preparation.execute_entry.path !== 'scripts/phase-b-sequence.mjs') {
    fail('preparation.execute_entry must bind the canonical upload lifecycle')
  }

  const publicPaths = [
    ['preparation.prepare_entry.path', manifest.preparation.prepare_entry.path],
    ['preparation.execute_entry.path', manifest.preparation.execute_entry.path],
    ['preparation.manifest_schema.path', manifest.preparation.manifest_schema.path],
    ['ci.workflow', manifest.ci.workflow],
    ['artifact.archive.path', manifest.artifact.archive.path],
    ['artifact.worker.path', manifest.artifact.worker.path],
    ['migration.reset_sql.path', manifest.migration.reset_sql.path],
    ['migration.runner.path', manifest.migration.runner.path],
    ['migration.catalog.path', manifest.migration.catalog.path],
    ...manifest.artifact.file_tree.files.map((file, index) => [
      `artifact.file_tree.files[${index}].path`,
      file.path,
    ]),
    ...manifest.migration.catalog.migrations.map((migration, index) => [
      `migration.catalog.migrations[${index}].path`,
      migration.path,
    ]),
  ]
  for (const [label, path] of publicPaths) assertPublicPath(path, label)

  const filePaths = manifest.artifact.file_tree.files.map((file) => file.path)
  if (new Set(filePaths).size !== filePaths.length) {
    fail('artifact.file_tree.files must not contain duplicate paths')
  }
  if (!jsonEqual(filePaths, [...filePaths].sort())) {
    fail('artifact.file_tree.files must be ordered by public path')
  }

  const migrationIds = manifest.migration.catalog.migrations.map((migration) => migration.id)
  if (!jsonEqual(migrationIds, EXPECTED_MIGRATIONS)) {
    fail('migration.catalog.migrations must contain 001 through 006 in order')
  }

  if (manifest.d1.mode !== 'remote' || manifest.d1.evidence_class !== policy.d1EvidenceClass) {
    fail(policy === PRODUCTION_MANIFEST_POLICY
      ? 'd1 must be the canonical remote production binding'
      : 'd1 evidence classification is invalid for formal rehearsal')
  }
  if (manifest.d1.database !== 'DB'
    || manifest.d1.config_path !== CANONICAL_D1_PATHS.config
    || manifest.d1.reset_sql_path !== CANONICAL_D1_PATHS.reset
    || manifest.d1.migration_runner_path !== CANONICAL_D1_PATHS.runner
    || manifest.d1.migration_catalog_path !== CANONICAL_D1_PATHS.catalog
    || manifest.d1.rollout_safety_path !== CANONICAL_D1_PATHS.rolloutSafety) {
    fail('d1 paths must identify the canonical production D1 artifacts')
  }
  if (manifest.d1.account_id !== manifest.target.account_id
    || manifest.d1.d1_database_id !== manifest.target.d1_database_id
    || manifest.d1.candidate_id !== manifest.repository.commit
    || manifest.d1.wrangler_sha256 !== manifest.toolchain.wrangler.identity_sha256) {
    fail('d1 identities do not match the frozen production facts')
  }
  if (manifest.d1.expected_reconciliation_format !== EXPECTED_RECONCILIATION_FORMAT) {
    fail('d1 expected reconciliation format is not canonical')
  }
  const expectedReconciliationBytes = canonicalExpectedReconciliationBytes(manifest.d1.expected_reconciliation)
  if (sha256(expectedReconciliationBytes) !== manifest.d1.expected_reconciliation_sha256) {
    fail('d1 expected reconciliation hash does not match its frozen bytes')
  }
  if (!Array.isArray(manifest.d1.migrations)
    || manifest.d1.migrations.length !== EXPECTED_D1_MIGRATION_NAMES.length
    || manifest.d1.migrations.some((migration, index) => (
      migration.number !== index + 1
      || migration.name !== EXPECTED_D1_MIGRATION_NAMES[index]
      || !/^[a-f0-9]{64}$/u.test(migration.checksum)
    ))) {
    fail('d1 migrations must be the canonical checksum set')
  }

  if (manifest.target.baseline.d1_database_id !== manifest.target.d1_database_id) {
    fail('target.baseline.d1_database_id must equal target.d1_database_id')
  }
  if (manifest.target.baseline.traffic.length !== 1
    || manifest.target.baseline.traffic[0].version_id !== manifest.target.baseline.version_id
    || manifest.target.baseline.traffic[0].percentage !== 100) {
    fail('target.baseline.traffic must bind one 100% baseline version')
  }

  if (!jsonEqual(manifest.policy.stages, DEFAULT_STAGE_POLICY)) {
    fail('policy.stages must use the fixed Issue #23 order and timeouts')
  }
  if (!jsonEqual(manifest.policy.drift.frozen_preconditions, EXPECTED_FROZEN_PRECONDITIONS)) {
    fail('policy.drift.frozen_preconditions are not the Issue #23 set')
  }
  if (!jsonEqual(manifest.policy.drift.observations, EXPECTED_OBSERVATIONS)) {
    fail('policy.drift.observations are not the Issue #23 set')
  }
  if (!jsonEqual(manifest.policy.evidence.excluded, EXPECTED_EVIDENCE_EXCLUSIONS)) {
    fail('policy.evidence.excluded must name every prohibited value class')
  }
  if (manifest.rehearsal.runtime.node_version !== manifest.toolchain.node.version) {
    fail('rehearsal.runtime.node_version must equal toolchain.node.version')
  }
  const runtimeReceipt = manifest.rehearsal.runtime_receipt
  if (runtimeReceipt.os !== 'macos'
    || runtimeReceipt.arch !== manifest.rehearsal.runtime.architecture
    || runtimeReceipt.node.version !== manifest.toolchain.node.version
    || runtimeReceipt.node.identity_sha256 !== manifest.toolchain.node.identity_sha256
    || runtimeReceipt.npm.identity_sha256 !== manifest.toolchain.npm.identity_sha256
    || runtimeReceipt.wrangler.identity_sha256 !== manifest.toolchain.wrangler.identity_sha256
    || runtimeReceipt.opennextjs_cloudflare.identity_sha256 !== manifest.toolchain.opennextjs_cloudflare.identity_sha256
    || runtimeReceipt.curl.identity_sha256 !== manifest.toolchain.curl.identity_sha256) {
    fail('rehearsal runtime receipt is not bound to the frozen toolchain')
  }
  if (manifest.rehearsal.production_write_adapter_calls !== 0) {
    fail('rehearsal must record zero production-write adapter calls')
  }
  if (manifest.rehearsal.expected_reconciliation_sha256 !== manifest.d1.expected_reconciliation_sha256) {
    fail('rehearsal expected reconciliation identity must bind the D1 snapshot')
  }
  if (!/^[a-f0-9]{64}$/u.test(manifest.rehearsal.d1_stage_receipt_sha256)) {
    fail('rehearsal D1 stage receipt identity is invalid')
  }
  if (manifest.rehearsal.cleanup.created !== true
    || manifest.rehearsal.cleanup.cleaned !== true
    || manifest.rehearsal.cleanup.observed_absent !== true) {
    fail('rehearsal cleanup proof is incomplete')
  }
}

function validateConfigStructure(value, policy = PRODUCTION_MANIFEST_POLICY) {
  validateSchemaValue(value, MANIFEST_SCHEMA)
  assertManifestRelationships(value, policy)
  return orderBySchema(value, MANIFEST_SCHEMA)
}

function validateManifestValue(value) {
  return validateConfigStructure(value)
}

export function canonicalBytes(value) {
  validateManifestValue(value)
  const ordered = orderBySchema(value, MANIFEST_SCHEMA)
  return Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
}

function assertUniqueJsonObjectKeys(json) {
  let index = 0

  function skipWhitespace() {
    while (index < json.length && /[ \t\n\r]/u.test(json[index])) index += 1
  }

  function scanString() {
    const start = index
    if (json[index] !== '"') throw new SyntaxError('expected JSON string')
    index += 1
    while (index < json.length) {
      if (json[index] === '"') {
        index += 1
        return JSON.parse(json.slice(start, index))
      }
      if (json[index] === '\\') index += 1
      index += 1
    }
    throw new SyntaxError('unterminated JSON string')
  }

  function scanPrimitive() {
    const start = index
    while (index < json.length && !',]} \t\n\r'.includes(json[index])) index += 1
    if (start === index) throw new SyntaxError('expected JSON value')
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
      if (json[index] !== ',') throw new SyntaxError('expected JSON array separator')
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError('unterminated JSON array')
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
      if (keys.has(key)) throw new SyntaxError(`duplicate JSON key: ${key}`)
      keys.add(key)
      skipWhitespace()
      if (json[index] !== ':') throw new SyntaxError('expected JSON object separator')
      index += 1
      scanValue()
      skipWhitespace()
      if (json[index] === '}') {
        index += 1
        return
      }
      if (json[index] !== ',') throw new SyntaxError('expected JSON object separator')
      index += 1
      skipWhitespace()
    }
    throw new SyntaxError('unterminated JSON object')
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
  if (index !== json.length) throw new SyntaxError('trailing JSON bytes')
}

function parseStrictJson(bytes) {
  const json = bytes.toString('utf8')
  if (!Buffer.from(json, 'utf8').equals(bytes)) fail('manifest bytes are not valid UTF-8')
  try {
    assertUniqueJsonObjectKeys(json)
    return JSON.parse(json)
  } catch (error) {
    fail(`manifest JSON is invalid: ${error.message}`)
  }
}

function readTextEvidence(repositoryPath, path, label) {
  let bytes
  try {
    bytes = readFileSync(resolve(repositoryPath, path))
  } catch {
    fail(`${label} is missing or unreadable`)
  }
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    fail(`${label} is not valid UTF-8`)
  }
  return bytes.toString('utf8')
}

function readBuildEvidenceJson(repositoryPath, path, label) {
  const bytes = Buffer.from(readTextEvidence(repositoryPath, path, label), 'utf8')
  try {
    return parseStrictJson(bytes)
  } catch {
    fail(`${label} is malformed`)
  }
}

function assertNoReachablePreviewText(value, label) {
  if (REACHABLE_PREVIEW_PATTERN.test(value)) {
    fail(`${label} contains reachable Preview/Draft Mode evidence`)
  }
}

function scanApplicationSource(repositoryPath, relativePath, seenSource) {
  const absolute = resolve(repositoryPath, relativePath)
  if (!existsSync(absolute)) return
  let entries
  try {
    entries = readdirSync(absolute, { withFileTypes: true })
  } catch {
    fail(`application source evidence ${relativePath} is unreadable`)
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const childPath = join(relativePath, entry.name)
    if (entry.isSymbolicLink()) fail(`application source evidence ${childPath} is unexpected`)
    if (entry.isDirectory()) {
      scanApplicationSource(repositoryPath, childPath, seenSource)
      continue
    }
    const extension = entry.name.slice(entry.name.lastIndexOf('.'))
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extension)) continue
    seenSource.count += 1
    const source = readTextEvidence(repositoryPath, childPath, `application source ${childPath}`)
    assertNoReachablePreviewText(source, `application source ${childPath}`)
  }
}

function assertApplicationSourceHasNoPreview(repositoryPath) {
  const sourceRoots = ['app', 'pages', 'src/app', 'src/pages']
  const seenSource = { count: 0 }
  for (const sourceRoot of sourceRoots) scanApplicationSource(repositoryPath, sourceRoot, seenSource)
  for (const name of ['middleware.cjs', 'middleware.js', 'middleware.mjs', 'middleware.ts', 'middleware.tsx', 'src/middleware.cjs', 'src/middleware.js', 'src/middleware.mjs', 'src/middleware.ts', 'src/middleware.tsx']) {
    const sourcePath = resolve(repositoryPath, name)
    if (!existsSync(sourcePath)) continue
    seenSource.count += 1
    assertNoReachablePreviewText(readTextEvidence(repositoryPath, name, `application source ${name}`), `application source ${name}`)
  }
  if (seenSource.count === 0) fail('application source evidence is missing')
}

function assertCompiledPathMap(repositoryPath, value, label, prefixes) {
  if (!isRecord(value)) fail(`${label} is malformed`)
  for (const [route, compiledPath] of Object.entries(value)) {
    if (typeof compiledPath !== 'string' || !prefixes.some((prefix) => compiledPath.startsWith(prefix))) {
      fail(`${label} contains an unexpected compiled entry`)
    }
    if (REACHABLE_PREVIEW_ROUTE_PATTERN.test(route) || REACHABLE_PREVIEW_ROUTE_PATTERN.test(compiledPath)) {
      fail(`${label} contains a reachable Preview/Draft Mode route`)
    }
    assertNoReachablePreviewText(`${route}\n${compiledPath}`, label)
    const compiledSource = readTextEvidence(repositoryPath, `.next/server/${compiledPath}`, `${label} compiled entry ${compiledPath}`)
    assertNoReachablePreviewText(compiledSource, `${label} compiled entry ${compiledPath}`)
  }
}

function assertNoReachablePreviewBuildEvidence(repositoryPath) {
  assertApplicationSourceHasNoPreview(repositoryPath)

  const appPaths = readBuildEvidenceJson(repositoryPath, '.next/server/app-paths-manifest.json', 'app paths manifest')
  const pages = readBuildEvidenceJson(repositoryPath, '.next/server/pages-manifest.json', 'pages manifest')
  const middleware = readBuildEvidenceJson(repositoryPath, '.next/server/middleware-manifest.json', 'middleware manifest')
  const routes = readBuildEvidenceJson(repositoryPath, '.next/routes-manifest.json', 'routes manifest')

  assertCompiledPathMap(repositoryPath, appPaths, 'app paths manifest', ['app/', 'pages/'])
  assertCompiledPathMap(repositoryPath, pages, 'pages manifest', ['pages/'])
  if (!isRecord(middleware)
    || middleware.version !== 3
    || !isRecord(middleware.middleware)
    || !isRecord(middleware.functions)
    || !Array.isArray(middleware.sortedMiddleware)
    || middleware.sortedMiddleware.some((entry) => typeof entry !== 'string')) {
    fail('middleware manifest is unexpected')
  }
  assertNoReachablePreviewText(JSON.stringify(middleware), 'middleware manifest')

  if (!isRecord(routes)
    || !Array.isArray(routes.staticRoutes)
    || !Array.isArray(routes.dynamicRoutes)
    || !isRecord(routes.rewrites)
    || !Array.isArray(routes.rewrites.beforeFiles)
    || !Array.isArray(routes.rewrites.afterFiles)
    || !Array.isArray(routes.rewrites.fallback)) {
    fail('routes manifest is unexpected')
  }
  for (const routeList of [routes.staticRoutes, routes.dynamicRoutes]) {
    for (const route of routeList) {
      if (!isRecord(route) || typeof route.page !== 'string') fail('routes manifest contains an unexpected route')
      if (REACHABLE_PREVIEW_ROUTE_PATTERN.test(route.page)) {
        fail('routes manifest contains a reachable Preview/Draft Mode route')
      }
      assertNoReachablePreviewText(JSON.stringify(route), 'routes manifest')
    }
  }
  assertNoReachablePreviewText(JSON.stringify(routes.rewrites), 'routes manifest rewrites')
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

export function parseCanonicalManifest(bytes, expectedSha256) {
  const manifestBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes)
  if (typeof expectedSha256 !== 'string' || expectedSha256.length === 0) {
    fail('manifest identity is required')
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    fail('manifest identity has an invalid format')
  }
  if (sha256(manifestBytes) !== expectedSha256) {
    fail('manifest identity mismatch')
  }
  const value = parseStrictJson(manifestBytes)
  validateManifestValue(value)
  const canonical = canonicalBytes(value)
  if (!canonical.equals(manifestBytes)) {
    fail('manifest bytes are not canonical')
  }
  return value
}

function readProductionWriteCallCount(adapter) {
  if (adapter === undefined) return undefined
  if (!isRecord(adapter) || !Number.isSafeInteger(adapter.calls)) {
    fail('productionWriteAdapter must expose a safe integer calls counter')
  }
  return adapter.calls
}

function validateConfig(config) {
  return validateConfigStructure({ format: CANONICAL_MANIFEST_FORMAT, ...config })
}

function preparedResult(value) {
  const ordered = orderBySchema(value, MANIFEST_SCHEMA)
  const canonical = Buffer.from(`${JSON.stringify(ordered, null, 2)}\n`, 'utf8')
  const identity = sha256(canonical)
  return Object.freeze({
    value: deepFreeze(JSON.parse(canonical.toString('utf8'))),
    get bytes() {
      return Buffer.from(canonical)
    },
    sha256: identity,
  })
}

function formalRehearsalPreparedResult(resolvedConfig) {
  const value = validateConfigStructure({
    format: CANONICAL_MANIFEST_FORMAT,
    ...resolvedConfig,
  }, FORMAL_REHEARSAL_MANIFEST_POLICY)
  return preparedResult(value)
}

function assertReadOnlyPreparation(productionWriteAdapter, callsBefore) {
  const callsAfter = readProductionWriteCallCount(productionWriteAdapter)
  if (callsBefore !== undefined && callsAfter !== callsBefore) {
    fail('production-write adapter was called during read-only preparation')
  }
}

export function prepareForTestsOnly(config, options = {}) {
  const { productionWriteAdapter } = options
  const callsBefore = readProductionWriteCallCount(productionWriteAdapter)
  validateSchemaValue(config, CONFIG_SCHEMA, '$.config')
  const resolvedConfig = resolveFacts(config, options)
  const productionValue = validateConfig(resolvedConfig)
  const value = structuredClone(productionValue)
  value.d1.mode = 'local'
  value.d1.evidence_class = 'test-non-production'
  validateSchemaValue(value, MANIFEST_SCHEMA)
  assertReadOnlyPreparation(productionWriteAdapter, callsBefore)
  return preparedResult(value, true)
}

export function prepare(config, options) {
  if (options !== undefined) {
    fail('public prepare does not accept adapter overrides')
  }
  validateSchemaValue(config, CONFIG_SCHEMA, '$.config')
  assertCanonicalProductionPaths(config)
  const formal = currentFormalRehearsalContext()
  const resolvedConfig = resolveFacts(config, {
    verifyGeneratedResolverLinks: true,
    ...(formal ? {
      ciResolver: resolveFormalCiFacts,
      manifestPolicy: FORMAL_REHEARSAL_MANIFEST_POLICY,
    } : {}),
  })
  if (formal) return formalRehearsalPreparedResult(resolvedConfig)
  const value = validateConfig(resolvedConfig)
  return preparedResult(value)
}

function readConfig(configPath) {
  const bytes = readFileSync(resolve(configPath))
  return parseStrictJson(bytes)
}

function runCli(argv) {
  const configIndex = argv.indexOf('--config')
  if (configIndex === -1 || !argv[configIndex + 1]) {
    throw new Error('Usage: node scripts/issue-23-delivery-prepare.mjs --config <path>')
  }
  const result = prepare(readConfig(argv[configIndex + 1]))
  process.stdout.write(result.bytes)
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}

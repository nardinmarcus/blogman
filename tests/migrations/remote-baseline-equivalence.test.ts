import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = process.cwd()
const migrationPath = join(repoRoot, 'db', 'ledger-migrations', '001_initial_schema.sql')
const baselinePath = join(repoRoot, 'db', 'ledger-migrations', '001_initial_schema.baseline.sql')
const replacementPath = join(
  repoRoot,
  'db',
  'ledger-migrations',
  '001_initial_schema.remote.baseline.sql',
)
const schemaPath = join(repoRoot, 'db', 'schema.sql')
const baselineSha256 = 'b3f61982cc36ff2c88d7b4330dd304ef075b5c5c34debf4499671c33ae2b6540'
const statementOneSha256 = '2c4d1aa391172c16b128c08a593e252f9e09b4fc151642ce738ae47882c38491'
const statementThreeSha256 = 'c61b390568cafc468c6adbbff5b78d08dd5d18a544d917fbc06c043393e3c7bd'
const replacementSha256 = '90c94ce79e77d3ca3ab22fc67f702243e7305bcd1860f3d1feb2026fb56b4a03'
const migrationChecksum = '8a71414814571d4fe65e03fc92b3f976074d025ddf03a4dd9f861698b2387d05'
const replacementHeader = `-- migration-remote-baseline-replacements: migration_number=001 migration=001_initial_schema baseline_sha256=${baselineSha256} groups=1:${statementOneSha256}:3|3:${statementThreeSha256}:3`

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function stripLeadingSqlComments(source: string): string {
  let remaining = source.trimStart()
  while (remaining) {
    if (remaining.startsWith('--')) {
      const lineEnd = remaining.indexOf('\n')
      if (lineEnd === -1) return ''
      remaining = remaining.slice(lineEnd + 1).trimStart()
      continue
    }
    if (remaining.startsWith('/*')) {
      const commentEnd = remaining.indexOf('*/', 2)
      if (commentEnd === -1) throw new Error('Unterminated SQL block comment')
      remaining = remaining.slice(commentEnd + 2).trimStart()
      continue
    }
    break
  }
  return remaining
}

function splitSqlStatements(source: string): string[] {
  const statements: string[] = []
  let statementStart = 0
  let quote: string | null = null
  let lineComment = false
  let blockComment = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      const closing = quote === '[' ? ']' : quote
      if (character === closing) {
        if (quote !== '[' && next === closing) index += 1
        else quote = null
      }
      continue
    }
    if (character === '-' && next === '-') {
      lineComment = true
      index += 1
      continue
    }
    if (character === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (["'", '"', '`', '['].includes(character)) {
      quote = character
      continue
    }
    if (character === ';') {
      const statement = source.slice(statementStart, index).trim()
      if (stripLeadingSqlComments(statement)) statements.push(statement)
      statementStart = index + 1
    }
  }

  if (quote || blockComment) throw new Error('Unterminated SQL literal or comment')
  const tail = source.slice(statementStart).trim()
  if (stripLeadingSqlComments(tail)) statements.push(tail)
  return statements
}

function replaceOnce(source: string, current: string, replacement: string): string {
  expect(source).toContain(current)
  const changed = source.replace(current, replacement)
  expect(changed).not.toContain(current)
  return changed
}

function issuesForSchema(schema: string, query: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'blogman-remote-baseline-'))
  const databasePath = join(directory, 'fixture.sqlite')
  try {
    const result = spawnSync('sqlite3', ['-batch', '-bail', '-noheader', databasePath], {
      encoding: 'utf8',
      input: `${schema.trim()}\n${query.trim()}\n`,
    })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout)
    const output = result.stdout.trim()
    return output ? output.split(/\r?\n/).sort() : []
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const canonicalSchema = readFileSync(schemaPath, 'utf8')
const schemaB = replaceOnce(
  replaceOnce(canonicalSchema, '  profile_id INTEGER,\n', ''),
  '  model TEXT NOT NULL,\n  temperature REAL NOT NULL DEFAULT 0.7,\n  max_tokens INTEGER NOT NULL DEFAULT 2000,\n',
  '  model TEXT NOT NULL,\n  temperature REAL NOT NULL DEFAULT 0.7,\n  max_tokens INTEGER NOT NULL DEFAULT 1200,\n',
)
const schemaC = replaceOnce(
  replaceOnce(
    canonicalSchema,
    '  profile_id INTEGER,\n  created_at INTEGER DEFAULT (strftime(\'%s\', \'now\')),\n  updated_at INTEGER DEFAULT (strftime(\'%s\', \'now\'))\n',
    '  created_at INTEGER DEFAULT (strftime(\'%s\', \'now\')),\n  updated_at INTEGER DEFAULT (strftime(\'%s\', \'now\')),\n  profile_id INTEGER\n',
  ),
  '  model TEXT NOT NULL,\n  temperature REAL NOT NULL DEFAULT 0.7,\n  max_tokens INTEGER NOT NULL DEFAULT 2000,\n',
  '  model TEXT NOT NULL,\n  temperature REAL NOT NULL DEFAULT 0.7,\n  max_tokens INTEGER NOT NULL DEFAULT 1200,\n',
)

const fixtures = [
  { name: 'all replacement tables absent', schema: 'CREATE TABLE placeholder (id INTEGER);' },
  { name: 'Issue 21 variant A', schema: canonicalSchema },
  { name: 'Issue 21 variant B', schema: schemaB },
  { name: 'Issue 21 variant C', schema: schemaC },
  {
    name: 'safe trailing extension columns',
    schema: replaceOnce(
      replaceOnce(
        replaceOnce(
          canonicalSchema,
          "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))\n);\n\n-- 文章元数据生成器配置",
          "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),\n  future_profile_note TEXT\n);\n\n-- 文章元数据生成器配置",
        ),
        "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))\n);\n\nINSERT INTO ai_post_generators",
        "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),\n  future_generator_note TEXT\n);\n\nINSERT INTO ai_post_generators",
      ),
      '  is_active INTEGER DEFAULT 1\n);',
      '  is_active INTEGER DEFAULT 1,\n  future_token_note TEXT\n);',
    ),
  },
  {
    name: 'missing expected column',
    schema: replaceOnce(canonicalSchema, "  api_key_masked TEXT NOT NULL DEFAULT '',\n", ''),
  },
  {
    name: 'declared type drift',
    schema: replaceOnce(
      canonicalSchema,
      "  workers_model TEXT NOT NULL DEFAULT '',",
      "  workers_model BLOB NOT NULL DEFAULT '',",
    ),
  },
  {
    name: 'not-null drift',
    schema: replaceOnce(
      canonicalSchema,
      '  token TEXT UNIQUE NOT NULL,\n  name TEXT NOT NULL,\n  created_at INTEGER NOT NULL',
      '  token TEXT UNIQUE NOT NULL,\n  name TEXT,\n  created_at INTEGER NOT NULL',
    ),
  },
  {
    name: 'default drift',
    schema: replaceOnce(
      canonicalSchema,
      "  provider TEXT NOT NULL DEFAULT 'custom',",
      "  provider TEXT NOT NULL DEFAULT 'legacy',",
    ),
  },
  {
    name: 'primary-key drift',
    schema: replaceOnce(
      canonicalSchema,
      'CREATE TABLE IF NOT EXISTS api_tokens (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      'CREATE TABLE IF NOT EXISTS api_tokens (\n  id INTEGER,',
    ),
  },
]

describe('migration 001 remote baseline replacement equivalence', () => {
  const baselineSource = readFileSync(baselinePath, 'utf8')
  const replacementSource = readFileSync(replacementPath, 'utf8')
  const baselineStatements = splitSqlStatements(baselineSource)
  const replacementStatements = splitSqlStatements(replacementSource)

  it('binds exact source and replacement identities without changing the ledger checksum', () => {
    expect(sha256(baselineSource)).toBe(baselineSha256)
    expect(baselineStatements).toHaveLength(4)
    expect(sha256(baselineStatements[0])).toBe(statementOneSha256)
    expect(sha256(baselineStatements[2])).toBe(statementThreeSha256)
    expect(sha256(replacementSource)).toBe(replacementSha256)
    expect(replacementSource.split(/\r?\n/, 1)[0]).toBe(replacementHeader)
    expect(replacementStatements).toHaveLength(6)

    const checksum = createHash('sha256')
      .update(readFileSync(migrationPath, 'utf8'))
      .update(`\0${baselineSource}`)
      .digest('hex')
    expect(checksum).toBe(migrationChecksum)
  })

  it('contains one literal read-only probe for each object group and source table', () => {
    expect(replacementStatements.slice(0, 3).map((statement) => (
      [...statement.matchAll(/sqlite_schema\.type = '([^']+)'/g)].map((match) => match[1])
    ))).toEqual([
      ['table'],
      ['index'],
      ['trigger'],
    ])
    expect(replacementStatements.map((statement) => (
      [...statement.matchAll(/pragma_table_info\('([^']+)'\)/g)].map((match) => match[1])
    )).slice(3)).toEqual([
      ['ai_provider_profiles'],
      ['ai_post_generators'],
      ['api_tokens'],
    ])
    for (const statement of replacementStatements) {
      expect(stripLeadingSqlComments(statement)).toMatch(/^WITH\b/i)
      expect(statement).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA)\b/i)
    }
  })

  it.each(fixtures)('preserves the complete sorted issue multiset for $name', ({ schema }) => {
    const originalObjectIssues = issuesForSchema(schema, `${baselineStatements[0]};`)
    const replacementObjectIssues = issuesForSchema(schema, `${replacementStatements.slice(0, 3).join(';\n')};`)
    expect(replacementObjectIssues).toEqual(originalObjectIssues)

    const originalColumnIssues = issuesForSchema(schema, `${baselineStatements[2]};`)
    const replacementColumnIssues = issuesForSchema(schema, `${replacementStatements.slice(3).join(';\n')};`)
    expect(replacementColumnIssues).toEqual(originalColumnIssues)
  })
})

#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '..')
const defaultMigrationsDirectory = join(repoRoot, 'db', 'ledger-migrations')
const defaultWranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const ledgerSchemaObjects = [
  {
    type: 'table',
    name: 'migration_ledger',
    sql: `CREATE TABLE migration_ledger (
  number INTEGER PRIMARY KEY CHECK(number > 0),
  name TEXT UNIQUE NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  candidate_id TEXT NOT NULL CHECK(length(candidate_id) > 0)
) STRICT`,
  },
  {
    type: 'trigger',
    name: 'migration_ledger_no_update',
    sql: `CREATE TRIGGER migration_ledger_no_update
BEFORE UPDATE ON migration_ledger BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END`,
  },
  {
    type: 'trigger',
    name: 'migration_ledger_no_delete',
    sql: `CREATE TRIGGER migration_ledger_no_delete
BEFORE DELETE ON migration_ledger BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END`,
  },
  {
    type: 'trigger',
    name: 'migration_ledger_no_replace',
    sql: `CREATE TRIGGER migration_ledger_no_replace
BEFORE INSERT ON migration_ledger
WHEN EXISTS (
  SELECT 1 FROM migration_ledger
  WHERE number = NEW.number OR name = NEW.name
)
BEGIN
  SELECT RAISE(ABORT, 'migration ledger rows are immutable');
END`,
  },
]

function fail(message) {
  throw new Error(message)
}

function parseArguments(argv) {
  const [command, ...tokens] = argv
  if (!['plan', 'apply', 'status', 'verify'].includes(command)) {
    fail('Usage: migrations.mjs <plan|apply|status|verify> [options]')
  }

  const options = {
    command,
    database: 'DB',
    config: join(repoRoot, 'wrangler.toml'),
    migrationsDirectory: defaultMigrationsDirectory,
    mode: null,
    persistTo: null,
    candidate: null,
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--local' || token === '--remote') {
      if (options.mode) fail('Choose exactly one of --local or --remote')
      options.mode = token
      continue
    }

    const value = tokens[index + 1]
    if (!value || value.startsWith('--')) fail(`Missing value for ${token}`)
    index += 1

    if (token === '--database') options.database = value
    else if (token === '--config') options.config = resolve(value)
    else if (token === '--persist-to') options.persistTo = resolve(value)
    else if (token === '--candidate') options.candidate = value
    else if (token === '--migrations-dir') options.migrationsDirectory = resolve(value)
    else fail(`Unknown option: ${token}`)
  }

  if (!options.mode) fail('Choose exactly one of --local or --remote')
  if (options.mode === '--remote' && options.persistTo) {
    fail('--persist-to can only be used with --local')
  }
  if (command === 'apply' && !options.candidate?.trim()) {
    fail('apply requires a non-empty --candidate identity')
  }

  return options
}

function loadMigrations(directory) {
  const fileNames = readdirSync(directory)
    .filter((name) => name.endsWith('.sql') && !name.endsWith('.baseline.sql'))
    .sort()
  if (fileNames.length === 0) fail(`No migrations found in ${directory}`)

  return fileNames.map((fileName, index) => {
    const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(fileName)
    if (!match) fail(`Invalid migration filename: ${fileName}`)

    const number = Number(match[1])
    const expectedNumber = index + 1
    if (number !== expectedNumber) {
      fail(`Migration sequence must be contiguous: expected ${String(expectedNumber).padStart(3, '0')}, found ${match[1]}`)
    }

    const path = join(directory, fileName)
    const sql = readFileSync(path, 'utf8')
    const baselinePath = path.replace(/\.sql$/, '.baseline.sql')
    let baselineSql = null
    try {
      baselineSql = readFileSync(baselinePath, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const declaration = /^-- migration-number: (\d{3})$/m.exec(sql)
    if (!declaration || Number(declaration[1]) !== number) {
      fail(`Migration declaration does not match filename: ${fileName}`)
    }

    return {
      number,
      name: fileName.replace(/\.sql$/, ''),
      checksum: createHash('sha256')
        .update(sql)
        .update(baselineSql === null ? '' : `\0${baselineSql}`)
        .digest('hex'),
      sql,
      baselineSql,
    }
  })
}

function createD1Client(options) {
  const commonArguments = [
    'd1',
    'execute',
    options.database,
    options.mode,
    '--config',
    options.config,
    '--json',
  ]
  if (options.persistTo) commonArguments.push('--persist-to', options.persistTo)

  function execute(arguments_) {
    try {
      return execFileSync(defaultWranglerPath, [...commonArguments, ...arguments_], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const stdout = error?.stdout?.toString().trim()
      if (stdout) {
        let response = null
        try {
          response = JSON.parse(stdout)
        } catch {}
        if (response?.error?.text) fail(response.error.text)
      }
      const stderr = error?.stderr?.toString().trim()
      fail(stderr || error.message)
    }
  }

  function executeFile(sql) {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'blogman-migration-query-'))
    const path = join(temporaryDirectory, 'query.sql')
    try {
      writeFileSync(path, sql)
      return execute(['--file', path])
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }

  return {
    query(sql) {
      const response = JSON.parse(executeFile(sql))
      return response.flatMap((statement) => statement.results ?? [])
    },
    executeBatch(sql) {
      executeFile(sql)
    },
  }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function ledgerArtifactsExist(client) {
  const rows = client.query(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE lower(name) IN ('migration_ledger', 'migration_ledger_no_update', 'migration_ledger_no_delete', 'migration_ledger_no_replace')",
  )
  return Number(rows[0]?.count) > 0
}

function normalizeSchemaSql(sql) {
  const source = sql.trim().replace(/;$/, '')
  let normalized = ''
  let inStringLiteral = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === "'") {
      normalized += character
      if (inStringLiteral && source[index + 1] === "'") {
        normalized += source[index + 1]
        index += 1
      } else {
        inStringLiteral = !inStringLiteral
      }
    } else if (inStringLiteral) {
      normalized += character
    } else if (!/\s/.test(character)) {
      normalized += character.toLowerCase()
    }
  }

  return normalized
}

function validateLedgerContract(client) {
  const actualObjects = client.query(`
SELECT type, name, sql
FROM sqlite_schema
WHERE name IN ('migration_ledger', 'migration_ledger_no_update', 'migration_ledger_no_delete', 'migration_ledger_no_replace')
`)

  for (const expected of ledgerSchemaObjects) {
    const actual = actualObjects.find(
      (object) => object.type === expected.type && object.name === expected.name,
    )
    if (!actual || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) {
      fail(`Migration ledger contract drift: ${expected.type} ${expected.name}`)
    }
  }
}

function readLedger(client, initialized) {
  if (!initialized) return []
  return client.query(
    'SELECT number, name, checksum, applied_at, candidate_id FROM migration_ledger ORDER BY number',
  )
}

function createLedger(client) {
  client.executeBatch(ledgerSchemaObjects.map(({ sql }) => `${sql};`).join('\n'))
}

function hasBusinessSchema(client) {
  const rows = client.query(`
SELECT COUNT(*) AS count
FROM sqlite_schema
WHERE name NOT LIKE 'sqlite_%'
  AND name NOT LIKE '_cf_%'
  AND name NOT LIKE 'migration_ledger%'
`)
  return Number(rows[0]?.count) > 0
}

function insertLedgerRow(client, migration, candidate) {
  client.executeBatch(`
INSERT INTO migration_ledger (number, name, checksum, candidate_id)
VALUES (${migration.number}, ${sqlLiteral(migration.name)}, ${sqlLiteral(migration.checksum)}, ${sqlLiteral(candidate)});
`)
}

function validateCurrentSchema(client, migration) {
  if (!migration.baselineSql) {
    fail(`Existing schema cannot be baselined by migration ${migration.name}`)
  }
  const issues = client.query(migration.baselineSql)
  if (issues.length > 0) {
    fail(`Existing schema does not match ${migration.name}: ${issues.map((row) => row.issue).join(', ')}`)
  }
}

function validateLedger(migrations, ledger) {
  if (ledger.length > migrations.length) fail('Ledger contains unknown migration numbers')
  for (let index = 0; index < ledger.length; index += 1) {
    const applied = ledger[index]
    const migration = migrations[index]
    if (Number(applied.number) !== migration.number || applied.name !== migration.name) {
      fail(`Applied migrations are out of order at number ${applied.number}`)
    }
    if (applied.checksum !== migration.checksum) {
      fail(`Checksum drift detected for migration ${migration.name}`)
    }
  }
}

function buildStatus(migrations, ledger, state, baselineFirst = false) {
  return {
    state,
    applied: ledger,
    pending: migrations.slice(ledger.length).map(({ number, name, checksum }, index) => ({
      number,
      name,
      checksum,
      action: baselineFirst && index === 0 ? 'baseline' : 'apply',
    })),
  }
}

function applyMigrations(client, migrations, candidate) {
  const initialized = ledgerArtifactsExist(client)
  if (initialized) validateLedgerContract(client)
  const hadBusinessSchema = hasBusinessSchema(client)
  let ledger = readLedger(client, initialized)
  validateLedger(migrations, ledger)
  const shouldBaseline = ledger.length === 0 && hadBusinessSchema

  if (shouldBaseline) validateCurrentSchema(client, migrations[0])
  if (!initialized) {
    createLedger(client)
    validateLedgerContract(client)
  }

  if (shouldBaseline) {
    insertLedgerRow(client, migrations[0], candidate)
    ledger = readLedger(client, true)
  }

  for (const migration of migrations.slice(ledger.length)) {
    client.executeBatch(`${migration.sql.trim()}\n
INSERT INTO migration_ledger (number, name, checksum, candidate_id)
VALUES (${migration.number}, ${sqlLiteral(migration.name)}, ${sqlLiteral(migration.checksum)}, ${sqlLiteral(candidate)});
`)
  }

  return buildStatus(migrations, readLedger(client, true), 'current')
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const migrations = loadMigrations(options.migrationsDirectory)
  const client = createD1Client(options)
  const initialized = ledgerArtifactsExist(client)
  if (initialized) validateLedgerContract(client)
  const ledger = readLedger(client, initialized)
  validateLedger(migrations, ledger)

  let result
  if (options.command === 'apply') {
    result = applyMigrations(client, migrations, options.candidate)
  } else if (options.command === 'verify') {
    const pending = migrations.slice(ledger.length)
    if (pending.length > 0) {
      fail(`Pending migrations: ${pending.map((migration) => migration.name).join(', ')}`)
    }
    result = buildStatus(migrations, ledger, 'verified')
  } else if (options.command === 'status') {
    const state = !initialized ? 'uninitialized' : ledger.length === migrations.length ? 'current' : 'pending'
    result = buildStatus(migrations, ledger, state)
  } else {
    const state = ledger.length === migrations.length ? 'current' : 'pending'
    const baselineFirst = ledger.length === 0 && hasBusinessSchema(client)
    if (baselineFirst) validateCurrentSchema(client, migrations[0])
    result = buildStatus(migrations, ledger, state, baselineFirst)
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}

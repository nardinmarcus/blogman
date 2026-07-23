const MIGRATION_REQUIRED_MESSAGE = '数据库结构未就绪，请先运行账本迁移'
const SCHEMA_ERROR_PATTERNS = [
  /no such table:/i,
  /no such column:/i,
  /has no column named/i,
]

export class DatabaseMigrationRequiredError extends Error {
  readonly code = 'DATABASE_MIGRATION_REQUIRED'

  constructor(cause?: unknown) {
    super(MIGRATION_REQUIRED_MESSAGE, { cause })
    this.name = 'DatabaseMigrationRequiredError'
  }
}

function hasSchemaErrorMessage(error: unknown): boolean {
  let current = error
  const visited = new Set<unknown>()

  while (current && !visited.has(current)) {
    visited.add(current)
    if (current instanceof DatabaseMigrationRequiredError) return true
    if (current instanceof Error) {
      const message = current.message
      if (SCHEMA_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return true
      current = current.cause
      continue
    }
    if (typeof current === 'string') {
      const message = current
      return SCHEMA_ERROR_PATTERNS.some((pattern) => pattern.test(message))
    }
    return false
  }

  return false
}

export function getDatabaseMigrationRequiredError(
  error: unknown,
): DatabaseMigrationRequiredError | null {
  if (error instanceof DatabaseMigrationRequiredError) return error
  return hasSchemaErrorMessage(error) ? new DatabaseMigrationRequiredError(error) : null
}

export function throwDatabaseMigrationRequired(error: unknown): never {
  throw getDatabaseMigrationRequiredError(error) || error
}

export function rethrowIfDatabaseMigrationRequired(error: unknown): void {
  const classified = getDatabaseMigrationRequiredError(error)
  if (classified) throw classified
}

export function migrationRequiredResponse(error: unknown): Response | null {
  const classified = getDatabaseMigrationRequiredError(error)
  if (!classified) return null

  return Response.json(
    { error: classified.message, code: classified.code },
    { status: 503 },
  )
}

export function withDatabaseErrorResponse<Args extends unknown[], Result extends Response>(
  handler: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result | Response> {
  return async (...args: Args) => {
    try {
      return await handler(...args)
    } catch (error) {
      const response = migrationRequiredResponse(error)
      if (response) return response
      throw error
    }
  }
}

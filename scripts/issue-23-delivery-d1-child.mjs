import { spawnSync } from 'node:child_process'
import { parseStrictJson } from './issue-23-delivery-d1-contracts.mjs'

const SUPERVISOR_GRACE_MS = 2_000

export const D1_CHILD_FAILURE_CLASSIFICATIONS = Object.freeze({
  TIMEOUT: 'timeout',
  NONZERO: 'nonzero',
  MALFORMED: 'malformed',
  UNCERTAIN: 'uncertain',
})

const SUPERVISOR_SOURCE = [
  "import { spawn } from 'node:child_process'",
  "const [executable, argsText, timeoutText, maxOutputText] = process.argv.slice(1)",
  'const args = JSON.parse(argsText)',
  'const timeoutMs = Number(timeoutText)',
  'const maxOutputBytes = Number(maxOutputText)',
  'let child = null',
  'let stdout = []',
  'let stderr = []',
  'let stdoutBytes = 0',
  'let stderrBytes = 0',
  'let timedOut = false',
  'let outputOverflow = false',
  'let childError = null',
  'let emitted = false',
  'let hardTimer = null',
  'const started = process.hrtime.bigint()',
  'const duration = () => Math.max(1, Math.ceil(Number(process.hrtime.bigint() - started) / 1e6))',
  "const killGroup = (signal = 'SIGKILL') => { if (!child?.pid) return; try { process.kill(-child.pid, signal) } catch { try { child.kill(signal) } catch {} } }",
  'const hasResidual = () => { if (!child?.pid) return false; try { process.kill(-child.pid, 0); return true } catch { return false } }',
  'const append = (target, chunk) => { const bytes = Buffer.byteLength(chunk); if (target === stdout) stdoutBytes += bytes; else stderrBytes += bytes; if ((target === stdout ? stdoutBytes : stderrBytes) > maxOutputBytes) { outputOverflow = true; killGroup() } else target.push(Buffer.from(chunk)) }',
  "const emit = (status, code = null, signal = null, residual = false) => { if (emitted) return; emitted = true; const value = { child_error: childError?.code || null, child_signal: signal, child_status: code, duration_ms: duration(), residual_process_group: residual, status, stderr_b64: Buffer.concat(stderr).toString('base64'), stdout_b64: Buffer.concat(stdout).toString('base64') }; process.stdout.write(JSON.stringify(value), () => process.exit(0)) }",
  'const finish = (code, signal) => { if (hardTimer) clearTimeout(hardTimer); const residualBefore = hasResidual(); if (timedOut || outputOverflow || residualBefore || code !== 0 || signal || childError) killGroup(); setTimeout(() => { const residualAfter = hasResidual(); if (residualAfter || residualBefore) emit(\'uncertain\', code, signal, true); else if (timedOut) emit(\'timed_out\', code, signal); else if (outputOverflow) emit(\'output_overflow\', code, signal); else if (childError || signal) emit(\'uncertain\', code, signal); else if (code !== 0) emit(\'nonzero\', code, signal); else emit(\'completed\', code, signal) }, residualBefore || timedOut || outputOverflow ? 50 : 0) }',
  'try { child = spawn(executable, args, { cwd: process.cwd(), detached: true, stdio: [\'pipe\', \'pipe\', \'pipe\'] }) } catch (error) { childError = error; emit(\'uncertain\') }',
  "if (child) { process.stdin.pipe(child.stdin); child.stdout.on('data', (chunk) => append(stdout, chunk)); child.stderr.on('data', (chunk) => append(stderr, chunk)); child.on('error', (error) => { childError = error; killGroup() }); child.on('close', finish); setTimeout(() => { timedOut = true; killGroup() }, timeoutMs); hardTimer = setTimeout(() => { killGroup(); emit('uncertain', null, null, true) }, timeoutMs + 1000) }",
  "process.once('SIGTERM', () => { timedOut = true; killGroup() })",
  "process.once('SIGINT', () => { timedOut = true; killGroup() })",
].join('\n')

export class D1ChildError extends Error {
  constructor(classification, durationMs = 0) {
    super(`D1 child ${classification}`)
    this.name = 'D1ChildError'
    this.classification = classification
    this.durationMs = Number.isSafeInteger(durationMs) && durationMs >= 0 ? durationMs : 0
  }
}

function decodeUtf8(base64, maxOutputBytes) {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > maxOutputBytes) throw new D1ChildError(D1_CHILD_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new D1ChildError(D1_CHILD_FAILURE_CLASSIFICATIONS.MALFORMED)
  }
  return text
}

function parseSupervisorOutput(output) {
  try {
    const value = parseStrictJson(output)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const keys = [
      'child_error',
      'child_signal',
      'child_status',
      'duration_ms',
      'residual_process_group',
      'status',
      'stderr_b64',
      'stdout_b64',
    ]
    const actual = Object.keys(value)
    if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) throw new Error()
    if (!Number.isSafeInteger(value.duration_ms) || value.duration_ms <= 0
      || typeof value.residual_process_group !== 'boolean'
      || typeof value.stdout_b64 !== 'string'
      || typeof value.stderr_b64 !== 'string'
      || !['completed', 'nonzero', 'timed_out', 'output_overflow', 'uncertain'].includes(value.status)) {
      throw new Error()
    }
    return value
  } catch {
    throw new D1ChildError(D1_CHILD_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
}

export function runBoundedChild(executable, args, timeoutMs, maxOutputBytes, cwd = process.cwd(), env = process.env, stdin = null) {
  if (stdin !== null && !(stdin instanceof Uint8Array)) {
    throw new D1ChildError(D1_CHILD_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      SUPERVISOR_SOURCE,
      executable,
      JSON.stringify(args),
      String(timeoutMs),
      String(maxOutputBytes),
    ],
    {
      cwd,
      env,
      input: stdin === null ? undefined : Buffer.from(stdin),
      encoding: 'utf8',
      maxBuffer: maxOutputBytes * 2 + 64 * 1024,
      timeout: timeoutMs + SUPERVISOR_GRACE_MS,
      killSignal: 'SIGTERM',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  if (result.error?.code === 'ETIMEDOUT') {
    throw new D1ChildError(D1_CHILD_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  if (result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new D1ChildError(D1_CHILD_FAILURE_CLASSIFICATIONS.UNCERTAIN)
  }
  const supervisor = parseSupervisorOutput(result.stdout)
  if (supervisor.residual_process_group || supervisor.status === 'uncertain'
    || supervisor.status === 'output_overflow') {
    throw new D1ChildError(
      D1_CHILD_FAILURE_CLASSIFICATIONS.UNCERTAIN,
      supervisor.duration_ms,
    )
  }
  if (supervisor.status === 'timed_out') {
    throw new D1ChildError(
      D1_CHILD_FAILURE_CLASSIFICATIONS.TIMEOUT,
      supervisor.duration_ms,
    )
  }
  if (supervisor.status === 'nonzero') {
    throw new D1ChildError(
      D1_CHILD_FAILURE_CLASSIFICATIONS.NONZERO,
      supervisor.duration_ms,
    )
  }
  const stdout = decodeUtf8(supervisor.stdout_b64, maxOutputBytes)
  const stderr = decodeUtf8(supervisor.stderr_b64, maxOutputBytes)
  return {
    status: 0,
    stdout,
    stderr,
    duration_ms: supervisor.duration_ms,
  }
}

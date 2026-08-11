import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  D1TransportError,
  D1_TRANSPORT_MAX_OUTPUT_BYTES,
  D1_TRANSPORT_TIMEOUT_MS,
  createD1Transport,
  parseD1JsonResponse,
} from '../../scripts/issue-23-delivery-d1-transport.mjs'

const repoRoot = process.cwd()
const wranglerPath = join(repoRoot, 'node_modules', '.bin', 'wrangler')
const response = JSON.stringify([{
  results: [{ value: 1 }],
  success: true,
  meta: { duration: 1 },
}])

type ChildSpec = {
  executable: string
  args: readonly string[]
  options: Record<string, unknown>
}

describe('Issue #90 D1 transport', () => {
  it('constructs and parses the fixed local command through a fake child result', () => {
    const calls: ChildSpec[] = []
    const transport = createD1Transport({
      mode: 'local',
      database: 'DB',
      configPath: '/private/wrangler.toml',
      persistPath: '/tmp/blogman-disposable-d1',
    }, {
      runChild(spec: ChildSpec) {
        calls.push(spec)
        return { status: 0, stdout: Buffer.from(response), stderr: Buffer.alloc(0) }
      },
    })

    expect(transport.query('SELECT 1 AS value')).toEqual([{ value: 1 }])
    expect(calls).toEqual([{
      executable: wranglerPath,
      args: [
        'd1', 'execute', 'DB', '--local',
        '--persist-to', '/tmp/blogman-disposable-d1',
        '--config', '/private/wrangler.toml',
        '--command', 'SELECT 1 AS value', '--json',
      ],
      options: {
        cwd: repoRoot,
        encoding: 'buffer',
        maxBuffer: D1_TRANSPORT_MAX_OUTPUT_BYTES,
        timeout: D1_TRANSPORT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    }])
  })

  it('uses the same fixed parser and command order for remote mode without persist state', () => {
    const calls: ChildSpec[] = []
    const transport = createD1Transport({
      mode: 'remote',
      database: 'DB',
      configPath: '/private/wrangler.toml',
    }, {
      runChild(spec: ChildSpec) {
        calls.push(spec)
        return { status: 0, stdout: response, stderr: '' }
      },
    })

    expect(transport.query('SELECT 1 AS value')).toEqual([{ value: 1 }])
    expect(calls[0]).toMatchObject({
      executable: wranglerPath,
      args: [
        'd1', 'execute', 'DB', '--remote',
        '--config', '/private/wrangler.toml',
        '--command', 'SELECT 1 AS value', '--json',
      ],
    })
    expect(calls[0].args).not.toContain('--persist-to')
  })

  it.each([
    ['missing local persist path', {
      mode: 'local', database: 'DB', configPath: '/private/wrangler.toml',
    }],
    ['relative local persist path', {
      mode: 'local', database: 'DB', configPath: '/private/wrangler.toml', persistPath: 'tmp/state',
    }],
    ['remote persist path', {
      mode: 'remote', database: 'DB', configPath: '/private/wrangler.toml', persistPath: '/tmp/state',
    }],
  ])('rejects a %s before a child can run', (_name, config) => {
    expect(() => createD1Transport(config, {
      runChild() {
        throw new Error('child must not run')
      },
    })).toThrow(/persistPath|absolute/u)
  })

  it.each([
    ['object envelope', '{"success":true,"results":[],"meta":{}}'],
    ['multiple envelopes', '[{"results":[],"success":true,"meta":{}},{"results":[],"success":true,"meta":{}}]'],
    ['unknown envelope field', '[{"results":[],"success":true,"meta":{},"secret":"private-response"}]'],
    ['duplicate JSON key', '[{"results":[],"success":true,"success":true,"meta":{}}]'],
  ])('rejects a %s without exposing raw response bytes', (_name, output) => {
    expect(() => parseD1JsonResponse(output)).toThrow('D1 transport malformed')
    try {
      parseD1JsonResponse(output)
    } catch (error) {
      expect(String(error)).not.toContain('private-response')
      expect(String(error)).not.toContain(output)
    }
  })

  it.each([
    ['timeout', {
      status: null, error: { code: 'ETIMEDOUT' }, stdout: 'timeout-secret', stderr: 'timeout-secret',
    }],
    ['nonzero', {
      status: 7, signal: null, stdout: 'nonzero-secret', stderr: 'nonzero-secret',
    }],
    ['uncertain', {
      status: null, signal: 'SIGTERM', stdout: 'uncertain-secret', stderr: 'uncertain-secret',
    }],
    ['malformed', {
      status: 0, stdout: 'malformed-secret', stderr: '',
    }],
  ])('classifies a child %s without retaining its output or retrying', (classification, childResult) => {
    let calls = 0
    const transport = createD1Transport({
      mode: 'local',
      database: 'DB',
      configPath: '/private/wrangler.toml',
      persistPath: '/tmp/blogman-disposable-d1',
    }, {
      runChild() {
        calls += 1
        return childResult
      },
    })

    let captured: unknown
    try {
      transport.query('SELECT 1')
    } catch (error) {
      captured = error
    }

    expect(captured).toBeInstanceOf(D1TransportError)
    expect((captured as Error & { classification: string }).classification).toBe(classification)
    expect((captured as Error).message).toBe(`D1 transport ${classification}`)
    expect((captured as Error).message).not.toContain('secret')
    expect(calls).toBe(1)
  })

  it('does not accept caller command, timeout, or retry overrides', () => {
    const config = {
      mode: 'local',
      database: 'DB',
      configPath: '/private/wrangler.toml',
      persistPath: '/tmp/blogman-disposable-d1',
    }

    expect(() => createD1Transport({ ...config, command: '/tmp/evil-wrangler' })).toThrow(/unsupported/u)
    expect(() => createD1Transport(config, {
      runChild: () => ({ status: 0, stdout: response, stderr: '' }),
      timeoutMs: 1,
    })).toThrow(/unsupported/u)
    expect(() => createD1Transport(config, {
      runChild: () => ({ status: 0, stdout: response, stderr: '' }),
      retries: 2,
    })).toThrow(/unsupported/u)
  })

  it('classifies bounded-output overflow as uncertain without exposing the output', () => {
    const secret = 'bounded-output-secret'
    const transport = createD1Transport({
      mode: 'local',
      database: 'DB',
      configPath: '/private/wrangler.toml',
      persistPath: '/tmp/blogman-disposable-d1',
    }, {
      runChild: () => ({
        status: 0,
        stdout: Buffer.concat([
          Buffer.from(secret),
          Buffer.alloc(D1_TRANSPORT_MAX_OUTPUT_BYTES + 1, 'x'),
        ]),
        stderr: Buffer.alloc(0),
      }),
    })

    expect(() => transport.query('SELECT 1')).toThrow('D1 transport uncertain')
    try {
      transport.query('SELECT 1')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })

  it('sanitizes an exception raised by the child runner', () => {
    const transport = createD1Transport({
      mode: 'local',
      database: 'DB',
      configPath: '/private/wrangler.toml',
      persistPath: '/tmp/blogman-disposable-d1',
    }, {
      runChild: () => {
        throw new Error('child-secret-raw-output')
      },
    })

    expect(() => transport.query('SELECT 1')).toThrow('D1 transport uncertain')
    try {
      transport.query('SELECT 1')
    } catch (error) {
      expect(String(error)).not.toContain('child-secret-raw-output')
    }
  })

  it('uses the shared response parser for a fixed file execution command', () => {
    const calls: ChildSpec[] = []
    const transport = createD1Transport({
      mode: 'remote',
      database: 'DB',
      configPath: '/private/wrangler.toml',
    }, {
      runChild(spec: ChildSpec) {
        calls.push(spec)
        return { status: 0, stdout: Buffer.from(response), stderr: Buffer.alloc(0) }
      },
    })

    expect(transport.executeFile('/private/reset.sql')).toEqual([{ value: 1 }])
    expect(calls[0]).toMatchObject({
      executable: wranglerPath,
      args: [
        'd1', 'execute', 'DB', '--remote',
        '--config', '/private/wrangler.toml',
        '--file', '/private/reset.sql', '--json',
      ],
    })
  })
})

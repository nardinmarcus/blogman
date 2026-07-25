import { describe, expect, it } from 'vitest'
import {
  D1_EVIDENCE_MAX_BUFFER_BYTES,
  runD1EvidenceQuery,
} from '../../scripts/rollout-safety.mjs'

function emitWranglerResponse(payloadBytes: number) {
  return [
    '-e',
    `process.stdout.write(JSON.stringify([{success:true,results:[{value:'x'.repeat(${payloadBytes})}]}]))`,
  ]
}

function captureError(action: () => unknown) {
  let captured: unknown
  try {
    action()
  } catch (error) {
    captured = error
  }
  expect(captured).toBeInstanceOf(Error)
  return captured as Error
}

describe('rollout safety D1 evidence buffer', () => {
  it('accepts a valid synthetic Wrangler response larger than the default child-process buffer', () => {
    const rows = runD1EvidenceQuery(
      process.execPath,
      emitWranglerResponse(1_600_000),
      'post content',
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].value).toHaveLength(1_600_000)
    expect(D1_EVIDENCE_MAX_BUFFER_BYTES).toBeGreaterThan(1_554_995)
  })

  it('fails closed without echoing an oversized response', () => {
    const sensitiveValue = 'oversized-evidence-must-not-leak'
    const error = captureError(() => runD1EvidenceQuery(
      process.execPath,
      [
        '-e',
        `process.stdout.write(JSON.stringify([{success:true,results:[{value:${JSON.stringify(sensitiveValue)}+'x'.repeat(${D1_EVIDENCE_MAX_BUFFER_BYTES})}]}]))`,
      ],
      'post content',
    ))

    expect(error.message).toBe('Unable to capture post content evidence')
    expect(error.message).not.toContain(sensitiveValue)
  })

  it('keeps non-zero child output out of the error', () => {
    const sensitiveValue = 'failed-child-output-must-not-leak'
    const error = captureError(() => runD1EvidenceQuery(
      process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(sensitiveValue)});process.stderr.write(${JSON.stringify(sensitiveValue)});process.exit(7)`],
      'post content',
    ))

    expect(error.message).toBe('Unable to capture post content evidence')
    expect(error.message).not.toContain(sensitiveValue)
  })

  it.each([
    ['invalid JSON', 'invalid-response-must-not-leak'],
    [
      'failed envelope',
      JSON.stringify({
        success: false,
        results: [{ value: 'failed-envelope-must-not-leak' }],
      }),
    ],
  ])('keeps %s content out of the error', (_name, stdout) => {
    const error = captureError(() => runD1EvidenceQuery(
      process.execPath,
      ['-e', `process.stdout.write(${JSON.stringify(stdout)})`],
      'post content',
    ))

    expect(error.message).toBe('Invalid post content evidence response')
    expect(error.message).not.toContain(stdout)
  })
})

import { describe, expect, it } from 'vitest'
import { parseD1QueryResponse } from '../../scripts/rollout-safety.mjs'

const rows = [{ count: 14 }]

describe('rollout safety D1 response parser', () => {
  it.each([
    ['Wrangler result array', [{ success: true, results: rows }]],
    ['single remote result', { success: true, results: rows }],
  ])('accepts the supported %s shape', (_name, response) => {
    expect(parseD1QueryResponse(JSON.stringify(response), 'post content')).toEqual(rows)
  })

  it.each([
    ['not-json'],
    [JSON.stringify([])],
    [JSON.stringify({ success: false, results: rows })],
    [JSON.stringify({ success: true })],
    [JSON.stringify({ result: [{ success: true, results: rows }] })],
  ])('rejects malformed or unknown response shapes without echoing input', (response) => {
    expect(() => parseD1QueryResponse(response, 'post content'))
      .toThrow(/^Invalid post content evidence response$/)
  })
})

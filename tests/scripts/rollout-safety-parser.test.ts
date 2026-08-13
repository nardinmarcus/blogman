import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { filterReconciliationSchemaRows, parseD1QueryResponse } from '../../scripts/rollout-safety.mjs'

const rows = [{ count: 14 }]

describe('rollout safety D1 response parser', () => {
  it('executes the public controls-status --remote CLI through the boolean gate without a D1 call', () => {
    const script = fileURLToPath(new URL('../../scripts/rollout-safety.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, 'rollout', 'controls-status', '--remote'], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Missing required option --database\n')
  })

  it('excludes only the two exact D1-internal tables from final reconciliation', () => {
    expect(filterReconciliationSchemaRows([
      { type: 'table', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'internal' },
      { type: 'table', name: '_cf_METADATA', tbl_name: '_cf_METADATA', sql: 'internal' },
      { type: 'table', name: '_cf_unknown', tbl_name: '_cf_unknown', sql: 'unknown' },
      { type: 'view', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'unknown view' },
      { type: 'table', name: '_cf_KV', tbl_name: 'other', sql: 'unknown table' },
      { type: 'table', name: 'posts', tbl_name: 'posts', sql: 'application' },
    ])).toEqual([
      { type: 'table', name: '_cf_unknown', tbl_name: '_cf_unknown', sql: 'unknown' },
      { type: 'view', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'unknown view' },
      { type: 'table', name: '_cf_KV', tbl_name: 'other', sql: 'unknown table' },
      { type: 'table', name: 'posts', tbl_name: 'posts', sql: 'application' },
    ])
  })

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

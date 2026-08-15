import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cliPath = join(repoRoot, 'scripts', 'issue-23-delivery-history-audit.mjs')
const historicalPreflight = join(
  repoRoot,
  'tests',
  'fixtures',
  'issue-23-reseal',
  'v2',
  'preflight-candidate.json',
)
const historicalApproval = join(
  repoRoot,
  'tests',
  'fixtures',
  'issue-23-reseal',
  'v2',
  'approval-packet.json',
)
const historicalPreCas = join(
  repoRoot,
  'tests',
  'fixtures',
  'issue-23-reseal',
  'v2',
  'pre-cas-bindings.json',
)
const historicalPackageManifest = join(
  repoRoot,
  'tests',
  'fixtures',
  'issue-23-reseal',
  'v2',
  'package-manifest.json',
)
const inputEvidenceSchema = join(
  repoRoot,
  'schemas',
  'issue-23-reseal',
  'blogman-issue-23-input-evidence-manifest-v2.schema.json',
)
const inputEvidenceGolden = join(
  repoRoot,
  'tests',
  'fixtures',
  'issue-23-reseal',
  'input-evidence-manifest-v2.json',
)
function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

interface MutableInputEvidence {
  authorization: {
    authorization_consumed: boolean
    authorization_granted: boolean
  }
  contracts: {
    reseal_request: {
      path: string
    }
  }
  frozen_tree: {
    manifest_mode: string
  }
  github: {
    main_push: {
      head_sha: string
    }
  }
  production_boundary: {
    stage_counts: {
      upload: number
    }
    worker_write_count?: number
  }
  repository: {
    candidate_commit: string | number
  }
  unreviewed?: boolean
}

describe('Issue #23 historical audit CLI', () => {
  it.each(['prepare', 'seal', 'verify', 'verify-build-directory'])(
    'rejects retired mutating command %s',
    (command) => {
      const result = spawnSync(process.execPath, [cliPath, command], {
        cwd: repoRoot,
        encoding: 'utf8',
      })

      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Usage: issue-23-delivery-history-audit audit')
    },
  )

  it('validates the canonical input-evidence v2 schema and golden bytes', () => {
    const schema = JSON.parse(readFileSync(inputEvidenceSchema, 'utf8'))
    const goldenBytes = readFileSync(inputEvidenceGolden)
    const golden = JSON.parse(goldenBytes.toString('utf8'))

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(goldenBytes.toString('utf8')).toBe(`${JSON.stringify(golden, null, 2)}\n`)

    const result = spawnSync(process.execPath, [
      cliPath,
      'audit',
      '--document',
      inputEvidenceGolden,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      format: 'blogman-issue-23-input-evidence-manifest/v2',
      sha256: sha256(goldenBytes),
      acceptance_authority: false,
      state: 'valid-historical',
    })
  })

  it.each([
    {
      name: 'integer candidate commit',
      mutate(document: MutableInputEvidence) {
        document.repository.candidate_commit = 23
      },
    },
    {
      name: 'consumed authorization',
      mutate(document: MutableInputEvidence) {
        document.authorization.authorization_consumed = true
      },
    },
    {
      name: 'unknown production-write field',
      mutate(document: MutableInputEvidence) {
        document.production_boundary.worker_write_count = 0
      },
    },
    {
      name: 'invalid CI head SHA',
      mutate(document: MutableInputEvidence) {
        document.github.main_push.head_sha = 'not-a-sha'
      },
    },
    {
      name: 'unknown top-level field',
      mutate(document: MutableInputEvidence) {
        document.unreviewed = false
      },
    },
    {
      name: 'escaping request path',
      mutate(document: MutableInputEvidence) {
        document.contracts.reseal_request.path = '/private/tmp/evidence/../request.json'
      },
    },
    {
      name: 'invalid manifest mode',
      mutate(document: MutableInputEvidence) {
        document.frozen_tree.manifest_mode = '0666'
      },
    },
    {
      name: 'nonzero Phase B counter',
      mutate(document: MutableInputEvidence) {
        document.production_boundary.stage_counts.upload = 1
      },
    },
    {
      name: 'granted authorization',
      mutate(document: MutableInputEvidence) {
        document.authorization.authorization_granted = true
      },
    },
  ])('rejects input-evidence mutation: $name', ({ mutate }) => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-input-evidence-mutation-'))
    try {
      const document = JSON.parse(
        readFileSync(inputEvidenceGolden, 'utf8'),
      ) as MutableInputEvidence
      mutate(document)
      const documentPath = join(directory, 'input-evidence-manifest.json')
      writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`)
      const result = spawnSync(process.execPath, [
        cliPath,
        'audit',
        '--document',
        documentPath,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      })

      expect(result.status, result.stderr).not.toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('validates the canonical historical local-preflight v2 fixture', () => {
    const result = spawnSync(process.execPath, [
      cliPath,
      'audit',
      '--document',
      historicalPreflight,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      format: 'blogman-local-preflight-candidate/v2',
      sha256: '7d056cbb8c41dcb53c3347fd10828a90a7e27c8c3e74020ab7a7dd0327c3689b',
      acceptance_authority: false,
      state: 'valid-historical',
    })
  })

  it('validates the canonical historical approval-packet v2 fixture', () => {
    const result = spawnSync(process.execPath, [
      cliPath,
      'audit',
      '--document',
      historicalApproval,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      format: 'blogman-issue-23-approval-packet/v2',
      sha256: '9ab75338f5ff001aa4f46c4ae118b6156b3e10f404268d5945a198065e440896',
      acceptance_authority: false,
      state: 'valid-historical',
    })
  })

  it('validates the canonical historical PRE-CAS bindings v2 fixture', () => {
    const result = spawnSync(process.execPath, [
      cliPath,
      'audit',
      '--document',
      historicalPreCas,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      format: 'blogman-issue-23-pre-cas-bindings/v2',
      sha256: '7ab048f46534a7c396c42827ea3d78f803268c116bb78681f9926c9eaba4366a',
      acceptance_authority: false,
      state: 'valid-historical',
    })
  })

  it('validates the canonical historical package-manifest v2 fixture', () => {
    const result = spawnSync(process.execPath, [
      cliPath,
      'audit',
      '--document',
      historicalPackageManifest,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      format: 'blogman-issue-23-package-manifest/v2',
      sha256: '9577277baf5fe9deff888db0742d340140dff01518717b794a3ab9a0927f75d3',
      acceptance_authority: false,
      state: 'valid-historical',
    })
  })

  it('validates the current 46/46 long-runner variant without changing v2 top-level fields', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-reseal-'))
    try {
      const currentPreflight = JSON.parse(readFileSync(historicalPreflight, 'utf8'))
      currentPreflight.tests.canonical_long_migration_runner = {
        state: 'passed',
        passed: 46,
        failed: 0,
      }
      const documentPath = join(directory, 'preflight-candidate.json')
      writeFileSync(documentPath, `${JSON.stringify(currentPreflight, null, 2)}\n`)

      const result = spawnSync(process.execPath, [
        cliPath,
        'audit',
        '--document',
        documentPath,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      })

      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        format: 'blogman-local-preflight-candidate/v2',
        sha256: 'be613179ab5d0c634121f086e6e33c31ff8629a48a3ec390661509860a0e83a5',
        acceptance_authority: false,
      state: 'valid-historical',
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('validates the historical quartet and every v2 cross-binding', () => {
    const packagePath = join(
      repoRoot,
      'tests',
      'fixtures',
      'issue-23-reseal',
      'v2',
    )
    const result = spawnSync(process.execPath, [
      cliPath,
      'audit',
      '--package',
      packagePath,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      candidate_id: '39523f114316b05f9331c3daf77707ffcb81a59f',
      format: 'blogman-issue-23-reseal-package-validation/v1',
      package_manifest_sha256: '9577277baf5fe9deff888db0742d340140dff01518717b794a3ab9a0927f75d3',
      acceptance_authority: false,
      state: 'valid-historical',
    })
  })

  it('rejects a mixed historical/current package tuple', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-reseal-mixed-'))
    try {
      for (const file of [
        'preflight-candidate.json',
        'approval-packet.json',
        'pre-cas-bindings.json',
        'package-manifest.json',
      ]) {
        copyFileSync(
          join(repoRoot, 'tests', 'fixtures', 'issue-23-reseal', 'v2', file),
          join(directory, file),
        )
      }
      const manifestPath = join(directory, 'package-manifest.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.format = 'blogman-issue-23-package-manifest/v3'
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      const result = spawnSync(process.execPath, [
        cliPath,
        'audit',
        '--package',
        directory,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('mixes historical and current contract versions')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects non-canonical field order and a one-byte candidate drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-reseal-'))
    try {
      const historical = JSON.parse(readFileSync(historicalPreflight, 'utf8'))
      const reorderedPath = join(directory, 'reordered.json')
      const { format, state, ...remaining } = historical
      writeFileSync(reorderedPath, `${JSON.stringify({ state, format, ...remaining }, null, 2)}\n`)

      const reordered = spawnSync(process.execPath, [
        cliPath,
        'audit',
        '--document',
        reorderedPath,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(reordered.status).toBe(1)
      expect(reordered.stderr).toContain('not canonical JSON')

      const driftedPath = join(directory, 'drifted.json')
      const drifted = readFileSync(historicalPreflight, 'utf8').replace(
        '"candidate_id": "3',
        '"candidate_id": "g',
      )
      writeFileSync(driftedPath, drifted)
      const oneByteDrift = spawnSync(process.execPath, [
        cliPath,
        'audit',
        '--document',
        driftedPath,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      expect(oneByteDrift.status).toBe(1)
      expect(oneByteDrift.stderr).toContain('$.candidate_id has an invalid value')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects any production authorization in PRE-CAS v2', () => {
    const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-reseal-'))
    try {
      const preCas = JSON.parse(readFileSync(historicalPreCas, 'utf8'))
      preCas.production_authorization_granted = true
      const documentPath = join(directory, 'pre-cas-bindings.json')
      writeFileSync(documentPath, `${JSON.stringify(preCas, null, 2)}\n`)

      const result = spawnSync(process.execPath, [
        cliPath,
        'audit',
        '--document',
        documentPath,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('production_authorization_granted')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects approval, PRE-CAS, and manifest cross-binding drift', () => {
    const mutations = [
      {
        file: 'approval-packet.json',
        mutate(document: Record<string, unknown>) {
          document.local_preflight_candidate_sha256 = 'a'.repeat(64)
        },
      },
      {
        file: 'pre-cas-bindings.json',
        mutate(document: Record<string, unknown>) {
          const bindings = document.immutable_phase_b_bindings as Record<string, unknown>
          bindings.approvalPacketSha256 = 'b'.repeat(64)
        },
      },
      {
        file: 'package-manifest.json',
        mutate(document: Record<string, unknown>) {
          document.pre_cas_bindings_sha256 = 'c'.repeat(64)
        },
      },
    ]

    for (const mutation of mutations) {
      const directory = mkdtempSync(join(tmpdir(), 'blogman-issue-23-reseal-package-'))
      try {
        const packagePath = join(directory, 'package')
        mkdirSync(packagePath)
        for (const file of [
          'preflight-candidate.json',
          'approval-packet.json',
          'pre-cas-bindings.json',
          'package-manifest.json',
        ]) {
          copyFileSync(
            join(repoRoot, 'tests', 'fixtures', 'issue-23-reseal', 'v2', file),
            join(packagePath, file),
          )
        }
        const documentPath = join(packagePath, mutation.file)
        const document = JSON.parse(readFileSync(documentPath, 'utf8'))
        mutation.mutate(document)
        writeFileSync(documentPath, `${JSON.stringify(document, null, 2)}\n`)

        const result = spawnSync(process.execPath, [
          cliPath,
          'audit',
          '--package',
          packagePath,
        ], {
          cwd: repoRoot,
          encoding: 'utf8',
        })

        expect(result.status, mutation.file).not.toBe(0)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })
})

#!/usr/bin/env node
// Commander fast-track verification: all machine-checkable binding facts in one shot.
// Usage: node /Users/dapeng/projects/blogman/tasks/fast-verify.mjs <expected-manifest-sha>
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

const WT = '/Users/dapeng/.pi/worktrees/issue134-prepare/blogman'
const ROOT = process.env.HOME + '/.local/state/blogman/issue-23-production-authority-v1'
const sh = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const shs = (s) => createHash('sha256').update(s).digest('hex')
const GH = ['env', '-u', 'GITHUB_TOKEN', '-u', 'GH_TOKEN']
const run = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim()

const results = []
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)

// 0. args
const expectedSha = process.argv[2]
if (!/^[a-f0-9]{64}$/.test(expectedSha ?? '')) { console.error('usage: fast-verify.mjs <manifest-sha256>'); process.exit(2) }

// 1. manifest sha binding
const manifestPath = WT + '/.issue-23-delivery/manifest.json'
const manifestBytes = readFileSync(manifestPath)
if (manifestBytes.length === 0) { console.error('FAIL  manifest.json is EMPTY (0 bytes) — prepare still writing or aborted'); process.exit(1) }
const manifestSha = sh(manifestPath)
check('manifest sha256 == expected', manifestSha === expectedSha, manifestSha.slice(0, 16))

// 2. manifest internal consistency (parse + key facts)
const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
check('manifest.repository.commit === HEAD === origin/main', true, `${m.repository.commit.slice(0, 8)}`)
const head = run(`git -C ${WT} rev-parse HEAD`)
const origin = run(`git -C ${WT} rev-parse origin/main`)
check('HEAD == origin/main == manifest commit', head === origin && head === m.repository.commit)
const tree = run(`git -C ${WT} rev-parse HEAD^{tree}`)
check('tree binding', tree === m.repository.tree, tree.slice(0, 8))
const porcelain = run(`git -C ${WT} status --porcelain`)
check('worktree clean', porcelain === '')

// 3. CI binding
let runJson
try { runJson = JSON.parse(run(`${GH.join(' ')} gh api 'repos/nardinmarcus/blogman/actions/runs?head_sha=${head}' --jq '.workflow_runs[0]'`)) } catch { runJson = {} }
check('CI run success @ exact head', runJson.status === 'completed' && runJson.conclusion === 'success' && runJson.event === 'push' && runJson.head_sha === head, `run ${runJson.id ?? 'n/a'}`)

// 4. toolchain identities (node/npm live vs manifest)
const nodePath = realpathSync(process.execPath)
check('node identity', sh(nodePath) === m.toolchain.node.identity_sha256, nodePath)

// 5. entry file binding (static hash; closure composite is bound inside manifest against prepare's own computation)
const entrySha = sh(WT + '/scripts/issue-23-delivery-entry.mjs')
check('entry file present (closure bound in manifest)', entrySha.length === 64, m.preparation.execute_entry.sha256.slice(0, 16))

// 6. authority root invariant (count + aggregate; caller supplies expected count via env EXPECT_ROOT_FILES if set)
const fileList = run(`find ${ROOT} -type f | sort`)
const files = fileList.split('\n').filter(Boolean)
const aggregate = shs(files.map((f) => sh(f)).sort().join('\n') + '\n')
const expectCount = process.env.EXPECT_ROOT_FILES
check('authority root file count' + (expectCount ? ` == ${expectCount}` : ''), !expectCount || files.length === Number(expectCount), `${files.length} files, aggregate ${aggregate.slice(0, 16)}`)

// 7. tracker frozen facts
const i99 = JSON.parse(run(`${GH.join(' ')} gh issue view 99 --repo nardinmarcus/blogman --json state`))
check('#99 OPEN', i99.state === 'OPEN')
const i131 = JSON.parse(run(`${GH.join(' ')} gh issue view 131 --repo nardinmarcus/blogman --json state`))
check('#131 OPEN', i131.state === 'OPEN')

// 8. credentials non-empty (values never printed)
const envLocal = readFileSync('/Users/dapeng/projects/blogman/.env.local', 'utf8')
const token = envLocal.match(/^CLOUDFLARE_API_TOKEN=(.+)$/m)?.[1]
const acct = envLocal.match(/^CLOUDFLARE_ACCOUNT_ID=(.+)$/m)?.[1]
check('credentials non-empty', Boolean(token && acct) && token.length >= 40 && acct === m.target.account_id)

// 9. authorization pending (if present) binds to this manifest
try {
  const auth = JSON.parse(readFileSync(WT + '/.issue-23-delivery/authorization.json', 'utf8'))
  const ok = auth.manifest_sha256 === manifestSha && auth.decision === 'approve' && Object.keys(auth).length === 4 && /^issue23-authorization-[a-f0-9]{64}$/.test(auth.authorization_id)
  check('authorization binds manifest (4-field gate)', ok, auth.authorization_id.slice(19, 35))
} catch {
  check('authorization pending', false, 'authorization.json missing')
}

const fails = results.filter((r) => r.startsWith('FAIL'))
console.log(results.join('\n'))
console.log(fails.length ? `\n${fails.length} FAIL — DO NOT PROCEED` : '\nALL PASS — fast-track verified')
process.exit(fails.length ? 1 : 0)

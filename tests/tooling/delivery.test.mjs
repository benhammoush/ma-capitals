/**
 * @file Exercises source/evidence gates and isolated prebuilt delivery without provider access.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { releaseContext } from '../../scripts/release/source.mjs'
import { devEvidence } from '../../scripts/release/dev-evidence.mjs'
import { digest, deliveryRecord } from '../../scripts/release/artifact.mjs'
import { rootOutput, workerOutput } from '../../scripts/cloudflare-output.mjs'
import { publish, runCf } from '../../scripts/ci-deploy.mjs'
import { SECURITY_HEADERS } from '../../hosting/worker.mjs'

const sha = 'a'.repeat(40)
const repository = 'benhammoush/ma-capitals'

test('pinned cf upload reads one stderr version ID and keeps execution isolated', () => {
  const id = '11111111-1111-1111-1111-111111111111'
  const args = ['workers', 'versions', 'create', '--prebuilt', '--mode', 'public']
  let calls = 0
  /** Model the pinned CLI's successful upload output without running a provider command. */
  function execute(program, actual, options) {
    calls++
    assert.equal(program, process.execPath)
    assert.deepEqual(actual, [join('trusted', 'node_modules/cf/bin/cf'), ...args])
    assert.equal(options.cwd, 'isolated')
    assert.deepEqual(options.env, {
      CLOUDFLARE_API_TOKEN: 'synthetic',
      CI: 'true',
      CF_SEND_TELEMETRY: 'false',
      DO_NOT_TRACK: '1',
      NO_COLOR: '1',
    })
    assert.equal(options.encoding, 'utf8')
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(options.timeout, 180_000)
    assert.equal(options.maxBuffer, 2_000_000)
    return {
      status: 0,
      signal: null,
      stdout: '',
      stderr: `├  Upload\n│  Uploaded ma-capitals-dev\n│  Worker Version ID: ${id}\n◆  Upload complete\n`,
    }
  }
  assert.deepEqual(
    runCf('trusted', 'isolated', args, { CLOUDFLARE_API_TOKEN: 'synthetic' }, execute),
    { id },
  )
  assert.equal(calls, 1)
})

test('cf deployment creation still requires a structured immutable deployment ID', () => {
  const id = '22222222-2222-2222-2222-222222222222'
  const args = ['workers', 'deployments', 'create']
  for (const stdout of [JSON.stringify({ id }), JSON.stringify({ id, strategy: 'percentage' })]) {
    let calls = 0
    /** Supply generated API-command JSON separately from CLI progress diagnostics. */
    function execute() {
      calls++
      return { status: 0, signal: null, stdout, stderr: 'CLI progress\n' }
    }
    assert.deepEqual(runCf('trusted', 'isolated', args, {}, execute), JSON.parse(stdout))
    assert.equal(calls, 1)
  }
})

test('cf output drift and subprocess failures stay uncertain without retries or diagnostic leaks', () => {
  const id = '11111111-1111-1111-1111-111111111111'
  const versionLine = `Worker Version ID: ${id}\n`
  const diagnostic = 'sensitive-provider-diagnostic'
  const success = { status: 0, signal: null, stdout: '', stderr: versionLine }
  for (const [operation, result] of [
    ['versions', { ...success, stderr: '' }],
    ['versions', { ...success, stderr: `Version ID: ${id}\n` }],
    ['versions', { ...success, stderr: 'Worker Version ID: invalid\n' }],
    ['versions', { ...success, stderr: versionLine + versionLine }],
    ['versions', { ...success, stderr: versionLine + 'Worker Version ID: invalid\n' }],
    ['versions', { ...success, stdout: JSON.stringify({ id }) }],
    ['versions', { ...success, stderr: `Worker Version ID: ${id} extra\n` }],
    ['versions', { ...success, status: 1, stderr: versionLine + diagnostic }],
    ['versions', { ...success, status: null, signal: 'SIGTERM' }],
    ['versions', { ...success, error: new Error(diagnostic) }],
    ['deployments', { ...success, stdout: diagnostic }],
    ['deployments', { ...success, stdout: '{}' }],
    ['deployments', { ...success, stdout: JSON.stringify({ id: 'invalid' }) }],
    ['deployments', { ...success, stdout: JSON.stringify({ id }), status: 1 }],
  ]) {
    let calls = 0
    /** Return one synthetic outcome; the adapter must never retry a mutation. */
    function execute() {
      calls++
      return result
    }
    assert.throws(
      () => runCf('trusted', 'isolated', ['workers', operation, 'create'], {}, execute),
      (error) =>
        error.message ===
          'Cloudflare mutation failed or returned uncertain output; inspect provider state before a fresh release' &&
        !error.message.includes(diagnostic),
    )
    assert.equal(calls, 1)
  }
  let unsupportedCalls = 0
  assert.throws(() =>
    runCf('trusted', 'isolated', ['workers', 'delete'], {}, () => {
      unsupportedCalls++
      return success
    }),
  )
  assert.equal(unsupportedCalls, 0)
})

test('production requires manual trusted-main source and forbids reruns', () => {
  const env = {
    CI_ENVIRONMENT: 'production',
    CI_SOURCE_SHA: sha,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: repository,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/verify-and-deploy-prod.yml@refs/heads/main`,
  }
  releaseContext(env)
  for (const override of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_RUN_ATTEMPT: '2' },
    { CI_SOURCE_SHA: 'main' },
    { GITHUB_WORKFLOW_REF: 'other' },
  ])
    assert.throws(() => releaseContext({ ...env, ...override }))
})

test('only retained successful same-repository dev delivery can qualify production', async () => {
  const env = { CI_SOURCE_SHA: sha, GITHUB_REPOSITORY: repository, GH_TOKEN: 'synthetic' }
  const run = {
    id: 123,
    conclusion: 'success',
    head_branch: 'main',
    path: '.github/workflows/verify-and-deploy-dev.yml',
    event: 'push',
    head_repository: { full_name: repository },
  }
  const record = {
    schemaVersion: 1,
    sourceSha: sha,
    environment: 'dev',
    artifactDigest: 'b'.repeat(64),
    configurationDigest: 'c'.repeat(64),
    workflowRunId: '123',
    deploymentId: 'dev-deployment',
    previousDeploymentId: null,
    status: 'smoke-verified-not-user-accepted',
  }
  /** Supply bounded synthetic GitHub metadata, never credentials or real API calls. */
  async function read(path) {
    return path.includes('/artifacts')
      ? { artifacts: [{ name: 'delivery-record-dev', expired: false }] }
      : { workflow_runs: [run] }
  }
  assert.deepEqual(await devEvidence(env, read, async () => record), record)
  for (const change of [
    { sourceSha: 'd'.repeat(40) },
    { environment: 'production' },
    { status: 'verification-pending' },
    { workflowRunId: '124' },
  ])
    await assert.rejects(devEvidence(env, read, async () => ({ ...record, ...change })))
  await assert.rejects(
    devEvidence(
      env,
      async () => ({ workflow_runs: [{ ...run, path: '.github/workflows/verify-pr.yml' }] }),
      async () => assert.fail('PR must never download evidence'),
    ),
  )
  assert.throws(() => deliveryRecord({ ...record, artifactDigest: 'unknown' }, sha, 'dev'))
})

test('privileged delivery runs only trusted CLI against isolated verified bytes and checkpoints failures', async () => {
  const candidate = mkdtempSync(join(tmpdir(), 'ma-candidate-'))
  const output = join(candidate, '.cloudflare/output/v0')
  const config = JSON.parse(readFileSync('.github/ci-cd.json', 'utf8'))
  const build = {
    api: config.buildEnvironment.dev.VITE_API_URL,
    ws: config.buildEnvironment.dev.VITE_WS_URL,
  }
  const first = {
    id: '11111111-1111-1111-1111-111111111111',
    versions: [{ version_id: '22222222-2222-2222-2222-222222222222', percentage: 100 }],
  }
  const next = {
    id: '33333333-3333-3333-3333-333333333333',
    versions: [{ version_id: '44444444-4444-4444-4444-444444444444', percentage: 100 }],
  }
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: '125',
    CI_SOURCE_SHA: sha,
    CI_ENVIRONMENT: 'dev',
    CI_CONTROL_ROOT: process.cwd(),
    CI_CANDIDATE_ROOT: candidate,
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_SUBDOMAIN: 'example',
    TARGET_ORIGIN: 'https://ma-capitals-dev.example.workers.dev',
    CLOUDFLARE_API_TOKEN: 'synthetic',
    CLOUDFLARE_DELIVERY_REVIEW: 'github-actions-only',
    GH_TOKEN: 'synthetic',
  }
  let active = first
  let calls = 0
  /** Simulate provider reads and site smoke without any network connection. */
  async function fetcher(url, options) {
    let result
    if (url.startsWith('https://api.github.com/')) return Response.json({ commit: { sha } })
    if (url.startsWith('https://api.cloudflare.com/')) {
      if (url.endsWith('/workers/subdomain')) result = { subdomain: 'example' }
      else if (url.endsWith('/subdomain')) result = { enabled: true, previews_enabled: false }
      else if (url.endsWith('/deployments')) result = { deployments: [active] }
      else assert.fail('Unexpected API')
      return Response.json({ success: true, result })
    }
    if (url.endsWith('/build-config.json')) return Response.json(build)
    const path = new URL(url).pathname
    const status = [
      '/assets/missing.js',
      '/engine/missing.js',
      '/unknown',
      '/api/pairs',
      '/ws',
    ].includes(path)
      ? 404
      : 200
    return new Response(
      options.method === 'HEAD' ? null : '<title>M&amp;A Capitals</title><div id="root"></div>',
      { status, headers: SECURITY_HEADERS },
    )
  }
  /** Reject candidate execution/configuration and expose only synthetic immutable provider IDs. */
  function cli(control, stage, args) {
    calls++
    assert.equal(control, process.cwd())
    assert.notEqual(stage, candidate)
    assert.equal(existsSync(join(stage, 'cloudflare.config.ts')), false)
    assert.equal(existsSync(join(stage, 'package.json')), false)
    assert.equal(digest(join(stage, '.cloudflare/output/v0')), digest(output))
    if (args[1] === 'versions') return { id: next.versions[0].version_id }
    assert.equal(args[1], 'deployments')
    active = next
    return { id: next.id }
  }
  try {
    const headers =
      '/*\n' +
      Object.entries(SECURITY_HEADERS)
        .map(([name, value]) => `  ${name}: ${value}`)
        .join('\n') +
      '\n'
    for (const [name, content] of Object.entries({
      'config.json': JSON.stringify(rootOutput()),
      'workers/default/worker.config.json': JSON.stringify(workerOutput('ma-capitals-dev')),
      'workers/default/bundle/worker.mjs': readFileSync('hosting/worker.mjs'),
      'workers/default/assets/index.html': '<div id="root"></div>',
      'workers/default/assets/_headers': headers,
      'workers/default/assets/build-config.json': JSON.stringify(build),
    })) {
      mkdirSync(join(output, name, '..'), { recursive: true })
      writeFileSync(join(output, name), content)
    }
    writeFileSync(
      join(candidate, 'cloudflare.config.ts'),
      'throw new Error("Candidate code must not execute")',
    )
    writeFileSync(
      join(candidate, 'ci-build.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceSha: sha,
        environment: 'dev',
        artifactDigest: digest(output),
      }),
    )
    const record = await publish(env, fetcher, cli)
    assert.equal(calls, 2)
    assert.equal(record.status, 'smoke-verified-not-user-accepted')
    assert.equal(record.previousDeploymentId, first.id)
    assert.equal(record.versionId, next.versions[0].version_id)
    active = first
    let mutations = 0
    await assert.rejects(
      publish(env, fetcher, () => {
        mutations++
        throw new Error('Synthetic uncertain upload')
      }),
    )
    assert.equal(mutations, 1)
    assert.equal(
      JSON.parse(readFileSync(join(candidate, 'delivery-record.json'), 'utf8')).status,
      'version-upload-requested',
    )
  } finally {
    rmSync(candidate, { recursive: true, force: true })
  }
})

/**
 * @file Deploys a fully verified cf artifact using trusted-main code, never candidate hooks.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deliverySettings, validateOutput } from './delivery-policy.mjs'
import { digest } from './release/artifact.mjs'
import { SECURITY_HEADERS } from '../hosting/worker.mjs'

/** Read fixed APIs without redirects, retries, response logging or secret-bearing diagnostics. */
export async function readApi(url, token, fetcher = fetch) {
  assert.ok(token, 'Missing API credential')
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  assert.ok(response.ok, `Provider read failed (${response.status})`)
  const data = await response.json()
  if (url.startsWith('https://api.cloudflare.com/')) {
    assert.equal(data.success, true)
    return data.result
  }
  return data
}

/** Bind the expected environment-specific configuration to a deterministic digest. */
export function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Invoke only the trusted, locked CLI in an isolated prebuilt directory; never retry a mutation. */
export function runCf(control, stage, args, env, execute = spawnSync) {
  try {
    const command = args.slice(0, 3).join(' ')
    assert.ok(['workers versions create', 'workers deployments create'].includes(command))
    const result = execute(process.execPath, [join(control, 'node_modules/cf/bin/cf'), ...args], {
      cwd: stage,
      env: { ...env, CI: 'true', CF_SEND_TELEMETRY: 'false', DO_NOT_TRACK: '1', NO_COLOR: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
      maxBuffer: 2_000_000,
    })
    assert.ok(!result.error && !result.signal && result.status === 0)
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    if (command === 'workers versions create') {
      // Pinned cf uploads report their ID on stderr, not as a structured API result.
      assert.equal(result.stdout.trim(), '')
      const lines = result.stderr
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^[│|][ \t]+/, ''))
        .filter((line) => line.startsWith('Worker Version ID:'))
      assert.equal(lines.length, 1)
      const id = lines[0].slice('Worker Version ID:'.length).trim()
      assert.match(id, uuid)
      return { id }
    }
    const value = JSON.parse(result.stdout)
    assert.match(value.id, uuid)
    return value
  } catch {
    throw new Error(
      'Cloudflare mutation failed or returned uncertain output; inspect provider state before a fresh release',
    )
  }
}

/** Check public routes and headers without touching the market API or collecting telemetry. */
export async function smoke(origin, expectedBuild, fetcher = fetch) {
  for (const [path, status] of [
    ['/', 200],
    ['/engine/chart', 200],
    ['/data/table', 200],
    ['/account/settings', 200],
    ['/assets/missing.js', 404],
    ['/engine/missing.js', 404],
    ['/unknown', 404],
    ['/api/pairs', 404],
    ['/ws', 404],
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetcher(origin + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
      assert.equal(response.status, status, `Unexpected site response: ${path}`)
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        assert.equal(response.headers.get(name), value)
      if (method === 'HEAD') assert.equal(await response.text(), '')
      else if (status === 200) {
        const text = await response.text()
        assert.ok(text.includes('<div id="root">'))
        assert.ok(text.includes('M&amp;A Capitals'))
        assert.ok(!/cloudflareinsights/.test(text))
      }
    }
  }
  const response = await fetcher(origin + '/build-config.json', {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), expectedBuild)
}

/** Require pre-provisioned identity and an unchanged target before uploading or promoting a version. */
export async function publish(env = process.env, fetcher = fetch, cli = runCf) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Delivery is CI-only')
  const control = resolve(env.CI_CONTROL_ROOT)
  const candidate = resolve(env.CI_CANDIDATE_ROOT)
  assert.notEqual(control, candidate)
  const config = JSON.parse(readFileSync(join(control, '.github/ci-cd.json'), 'utf8'))
  const output = join(candidate, '.cloudflare/output/v0')
  const build = JSON.parse(
    readFileSync(join(output, 'workers/default/assets/build-config.json'), 'utf8'),
  )
  const settings = deliverySettings(env, config, build)
  validateOutput(output, settings, control)
  const manifest = JSON.parse(readFileSync(join(candidate, 'ci-build.json'), 'utf8'))
  assert.equal(manifest.sourceSha, env.CI_SOURCE_SHA)
  assert.equal(manifest.environment, env.CI_ENVIRONMENT)
  assert.equal(manifest.artifactDigest, digest(output))
  const base = `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}`
  const script = `${base}/workers/scripts/${settings.name}`
  /** Read account and target settings; missing resources or uncertain setup fail closed. */
  async function targetState() {
    const subdomain = await readApi(`${base}/workers/subdomain`, env.CLOUDFLARE_API_TOKEN, fetcher)
    assert.equal(subdomain.subdomain, env.CLOUDFLARE_SUBDOMAIN)
    const route = await readApi(`${script}/subdomain`, env.CLOUDFLARE_API_TOKEN, fetcher)
    assert.equal(route.enabled, true, 'Provision workers.dev separately')
    assert.equal(route.previews_enabled, false, 'Disable version previews separately')
    const { deployments } = await readApi(
      `${script}/deployments`,
      env.CLOUDFLARE_API_TOKEN,
      fetcher,
    )
    assert.ok(Array.isArray(deployments))
    const current = deployments[0] ?? null
    if (current) {
      assert.equal(current.versions.length, 1)
      assert.equal(current.versions[0].percentage, 100)
    }
    return current
  }
  const before = await targetState()
  const record = {
    ...manifest,
    configurationDigest: fingerprint(settings),
    workflowRunId: env.GITHUB_RUN_ID,
    deploymentId: null,
    previousDeploymentId: before?.id ?? null,
    previousVersionId: before?.versions[0].version_id ?? null,
    versionId: null,
    status: 'preflight',
  }
  /** Persist uncertainty and immutable identities without retaining tokens or provider response bodies. */
  function checkpoint() {
    writeFileSync(join(candidate, 'delivery-record.json'), JSON.stringify(record, null, 2) + '\n')
  }
  checkpoint()
  if (env.CI_ENVIRONMENT === 'production')
    assert.ok(
      record.previousDeploymentId && record.previousVersionId,
      'Establish eligible first-release recovery before production',
    )
  assert.equal(
    env.CLOUDFLARE_DELIVERY_REVIEW,
    'github-actions-only',
    'Provisioning review must confirm no provider Git builds, deploy hooks or automatic analytics',
  )
  const stage = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'ma-prebuilt-'))
  try {
    mkdirSync(join(stage, '.cloudflare/output'), { recursive: true })
    cpSync(output, join(stage, '.cloudflare/output/v0'), { recursive: true })
    assert.equal(digest(join(stage, '.cloudflare/output/v0')), manifest.artifactDigest)
    const main = await readApi(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/branches/main`,
      env.GH_TOKEN,
      fetcher,
    )
    if (env.GITHUB_EVENT_NAME === 'push')
      assert.equal(main.commit.sha, env.CI_SOURCE_SHA, 'Automatic dev was superseded')
    assert.deepEqual(await targetState(), before, 'Target changed during preflight')
    record.status = 'version-upload-requested'
    checkpoint()
    const version = cli(
      control,
      stage,
      [
        'workers',
        'versions',
        'create',
        '--prebuilt',
        '--mode',
        'public',
        '--tag',
        env.CI_SOURCE_SHA,
      ],
      env,
    )
    assert.match(version.id ?? '', /^[a-f0-9-]{36}$/)
    record.versionId = version.id
    record.status = 'version-uploaded'
    checkpoint()
    assert.deepEqual(await targetState(), before, 'Target changed before promotion')
    record.status = 'mutation-requested'
    checkpoint()
    const deployment = cli(
      control,
      stage,
      [
        'workers',
        'deployments',
        'create',
        '--worker',
        settings.name,
        '--strategy',
        'percentage',
        '--versions',
        JSON.stringify([{ version_id: version.id, percentage: 100 }]),
      ],
      env,
    )
    assert.match(deployment.id ?? '', /^[a-f0-9-]{36}$/)
    record.deploymentId = deployment.id
    record.status = 'verification-pending'
    checkpoint()
    const after = await targetState()
    assert.equal(after.id, record.deploymentId)
    assert.equal(after.versions[0].version_id, record.versionId)
    await smoke(settings.origin, build, fetcher)
    assert.equal((await targetState()).id, record.deploymentId)
    record.status = 'smoke-verified-not-user-accepted'
    checkpoint()
    return record
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await publish()

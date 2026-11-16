/**
 * @file Rejects source, Cloudflare target, public configuration and executable output drift.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publicEndpoints } from '../public-hosting.mjs'
import { CF_VERSION, rootOutput, workerOutput } from './cloudflare-output.mjs'
import { regularFiles } from './check-release.mjs'
import { SECURITY_HEADERS } from '../hosting/worker.mjs'

/** Validate exact public endpoint pairs, isolated names and explicitly provisioned site identities. */
export function deliverySettings(env, config, build) {
  assert.equal(env.GITHUB_REPOSITORY, 'benhammoush/ma-capitals')
  assert.equal(env.GITHUB_REF, 'refs/heads/main')
  assert.match(env.CI_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/)
  assert.ok(['dev', 'production'].includes(env.CI_ENVIRONMENT))
  assert.ok(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME))
  if (env.CI_ENVIRONMENT === 'production') {
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch')
    assert.equal(env.GITHUB_RUN_ATTEMPT, '1')
  }
  assert.match(env.CLOUDFLARE_ACCOUNT_ID ?? '', /^[a-f0-9]{32}$/)
  assert.match(env.CLOUDFLARE_SUBDOMAIN ?? '', /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
  assert.equal(config.targets.dev.name, 'ma-capitals-dev')
  assert.equal(config.targets.production.name, 'ma-capitals')
  const name = config.targets[env.CI_ENVIRONMENT].name
  const origin = `https://${name}.${env.CLOUDFLARE_SUBDOMAIN}.workers.dev`
  assert.equal(env.TARGET_ORIGIN, origin)
  const buildEnvironment = config.buildEnvironment[env.CI_ENVIRONMENT]
  assert.deepEqual(Object.keys(buildEnvironment).sort(), ['VITE_API_URL', 'VITE_WS_URL'])
  const endpoints = publicEndpoints({ ...buildEnvironment, APOLLO_PUBLIC_TARGET: 'hosted' })
  assert.deepEqual(build, { api: endpoints.api, ws: endpoints.ws })
  return { name, origin, accountId: env.CLOUDFLARE_ACCOUNT_ID, buildEnvironment }
}

/** Validate every effective output setting and path without evaluating candidate configuration/code. */
export function validateOutput(root, settings, trustedRoot) {
  const rootConfig = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
  const worker = JSON.parse(readFileSync(join(root, 'workers/default/worker.config.json'), 'utf8'))
  assert.deepEqual(rootConfig, rootOutput())
  assert.deepEqual(worker, workerOutput(settings.name))
  const files = regularFiles(root).map((file) => file.slice(root.length + 1).replaceAll('\\', '/'))
  for (const file of files)
    assert.ok(
      /^(?:config\.json|workers\/default\/(?:worker\.config\.json|bundle\/worker\.mjs|assets\/(?:_headers|build-config\.json|index\.html|favicon\.png|notices\.html|third-party-notices\.txt|assets\/[a-zA-Z0-9_.-]+\.(?:js|css))))$/.test(
        file,
      ),
      `Unexpected release file: ${file}`,
    )
  for (const file of [
    'config.json',
    'workers/default/worker.config.json',
    'workers/default/bundle/worker.mjs',
    'workers/default/assets/index.html',
    'workers/default/assets/_headers',
  ])
    assert.ok(files.includes(file), `Missing release file: ${file}`)
  assert.deepEqual(
    readFileSync(join(root, 'workers/default/bundle/worker.mjs')),
    readFileSync(join(trustedRoot, 'hosting/worker.mjs')),
    'Historical Worker policy differs from trusted main',
  )
  const headers =
    '/*\n' +
    Object.entries(SECURITY_HEADERS)
      .map(([name, value]) => `  ${name}: ${value}`)
      .join('\n') +
    '\n'
  assert.equal(readFileSync(join(root, 'workers/default/assets/_headers'), 'utf8'), headers)
  const pkg = JSON.parse(readFileSync(join(trustedRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.devDependencies.cf, CF_VERSION)
  return worker
}

/**
 * @file Guards the production hosting adapter and rejects unsafe prebuilt release contracts.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { serve, SECURITY_HEADERS } from '../../hosting/worker.mjs'
import { rootOutput, workerOutput } from '../../scripts/cloudflare-output.mjs'
import { validateOutput } from '../../scripts/delivery-policy.mjs'
import { digest } from '../../scripts/release/artifact.mjs'

test('known routes preserve asset priority and security headers on reads, misses and errors', async () => {
  const env = {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname
        return new Response(request.method === 'HEAD' ? null : path, {
          status: ['/index.html', '/assets/app.js', '/data/existing'].includes(path) ? 200 : 404,
        })
      },
    },
  }
  for (const method of ['GET', 'HEAD']) {
    for (const [path, expected, status] of [
      ['/', '/index.html', 200],
      ['/engine/chart', '/index.html', 200],
      ['/data/existing', '/data/existing', 200],
      ['/assets/app.js', '/assets/app.js', 200],
      ['/assets/missing.js', '/assets/missing.js', 404],
      ['/engine/missing.js', '/engine/missing.js', 404],
      ['/unknown', '/unknown', 404],
      ['/api/pairs', '/api/pairs', 404],
      ['/ws', '/ws', 404],
    ]) {
      const response = await serve(new Request('https://site.example' + path, { method }), env)
      assert.equal(response.status, status, path)
      assert.equal(await response.text(), method === 'HEAD' ? '' : expected)
      for (const [name, value] of Object.entries(SECURITY_HEADERS))
        assert.equal(response.headers.get(name), value)
    }
  }
  assert.equal(
    (await serve(new Request('https://site.example/', { method: 'POST' }), env)).status,
    405,
  )
  const failed = await serve(new Request('https://site.example/'), {
    ASSETS: {
      async fetch() {
        throw new Error('Synthetic outage')
      },
    },
  })
  assert.equal(failed.status, 503)
  assert.equal(failed.headers.get('X-Frame-Options'), 'DENY')
})

test('complete cf output rejects unknown settings, extra files and changed Worker code', () => {
  const root = mkdtempSync(join(tmpdir(), 'ma-output-'))
  try {
    const files = {
      'config.json': JSON.stringify(rootOutput()),
      'workers/default/worker.config.json': JSON.stringify(workerOutput('ma-capitals-dev')),
      'workers/default/bundle/worker.mjs': readFileSync('hosting/worker.mjs'),
      'workers/default/assets/index.html': '<div id="root"></div>',
      'workers/default/assets/_headers':
        '/*\n' +
        Object.entries(SECURITY_HEADERS)
          .map(([name, value]) => `  ${name}: ${value}`)
          .join('\n') +
        '\n',
    }
    for (const [name, data] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true })
      writeFileSync(join(root, name), data)
    }
    assert.equal(
      validateOutput(root, { name: 'ma-capitals-dev' }, process.cwd()).name,
      'ma-capitals-dev',
    )
    const original = digest(root)
    const path = join(root, 'workers/default/worker.config.json')
    writeFileSync(
      path,
      JSON.stringify({ ...workerOutput('ma-capitals-dev'), unsafe: { metadata: {} } }),
    )
    assert.throws(() => validateOutput(root, { name: 'ma-capitals-dev' }, process.cwd()))
    assert.notEqual(digest(root), original)
    writeFileSync(path, files['workers/default/worker.config.json'])
    writeFileSync(
      join(root, 'config.json'),
      JSON.stringify({ ...rootOutput(), accountId: 'other' }),
    )
    assert.throws(() => validateOutput(root, { name: 'ma-capitals-dev' }, process.cwd()))
    writeFileSync(join(root, 'config.json'), files['config.json'])
    writeFileSync(join(root, 'workers/default/bundle/worker.mjs'), 'export default {}')
    assert.throws(() => validateOutput(root, { name: 'ma-capitals-dev' }, process.cwd()))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * @file Packages the existing Vite public build and Worker module; never rebuilds or uploads.
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OUTPUT, rootOutput, workerOutput } from './cloudflare-output.mjs'
import { regularFiles } from './check-release.mjs'

const environment = process.env.CI_ENVIRONMENT
assert.ok(['dev', 'production'].includes(environment), 'Explicit packaging environment required')
const config = JSON.parse(readFileSync('.github/ci-cd.json', 'utf8'))
regularFiles('dist')
rmSync('.cloudflare/output', { recursive: true, force: true })
mkdirSync(join(OUTPUT, 'workers/default/bundle'), { recursive: true })
cpSync('dist', join(OUTPUT, 'workers/default/assets'), { recursive: true })
cpSync('hosting/worker.mjs', join(OUTPUT, 'workers/default/bundle/worker.mjs'))
writeFileSync(join(OUTPUT, 'config.json'), JSON.stringify(rootOutput()))
writeFileSync(
  join(OUTPUT, 'workers/default/worker.config.json'),
  JSON.stringify(workerOutput(config.targets[environment].name)),
)

/**
 * @file Exposes only reviewed public endpoint inputs to credential-free candidate builds.
 */
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { publicEndpoints } from '../../public-hosting.mjs'

const config = JSON.parse(readFileSync('control/.github/ci-cd.json', 'utf8'))
assert.ok(['dev', 'production'].includes(process.env.CI_ENVIRONMENT))
const inputs = config.buildEnvironment[process.env.CI_ENVIRONMENT]
assert.deepEqual(Object.keys(inputs).sort(), ['VITE_API_URL', 'VITE_WS_URL'])
publicEndpoints({ ...inputs, APOLLO_PUBLIC_TARGET: 'hosted' })
for (const [name, value] of Object.entries(inputs)) {
  assert.ok(typeof value === 'string' && !/[\r\n]/.test(value))
  appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`)
}

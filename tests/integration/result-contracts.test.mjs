/**
 * @file Feeds backend-owned synthetic result rows through the real frontend CSV parser.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as arquero from 'arquero'

test('selected backend result contracts remain readable by the frontend', () => {
  const source = readFileSync('src/utils/csvParser.ts', 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    (name) => {
      assert.equal(name, 'arquero')
      return arquero
    },
    module,
    module.exports,
  )
  const fixtures = JSON.parse(
    readFileSync('backend/tests/fixtures/result_contracts_v1.json', 'utf8'),
  )
  for (const row of Object.values(fixtures)) {
    const columns = Object.keys(row)
    const values = Object.values(row).map((value) => (value === null ? '' : String(value)))
    const csv = [columns, values]
      .map((cells) => cells.map((value) => JSON.stringify(value)).join(','))
      .join('\n')
    assert.deepEqual(module.exports.parseCSV(csv), [
      Object.fromEntries(columns.map((name, index) => [name, values[index]])),
    ])
  }
})

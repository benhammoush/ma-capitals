/**
 * @file Defines the entire pinned cf v0 output contract, with no dynamic hooks or resource provisioning.
 */
import assert from 'node:assert/strict'

export const CF_VERSION = '1.0.0-beta.32'
export const OUTPUT = '.cloudflare/output/v0'

/** Produce only the root context expected by the pinned cf CLI. */
export function rootOutput() {
  return { buildContext: { mode: 'public', isPreview: false } }
}

/** Produce the exact Worker contract; names select isolated sites, never a backend runtime. */
export function workerOutput(name) {
  assert.match(name, /^ma-capitals(?:-dev)?$/)
  return {
    name,
    compatibilityDate: '2026-11-14',
    assets: { htmlHandling: 'none', notFoundHandling: 'none' },
    env: { ASSETS: { type: 'assets' } },
    workersDev: true,
    previewUrls: false,
    observability: { enabled: false },
    manifest: {
      type: 'complete',
      mainModule: 'worker.mjs',
      modules: { 'worker.mjs': { type: 'esm' } },
    },
  }
}

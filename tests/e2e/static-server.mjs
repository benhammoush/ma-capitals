/**
 * @file Runs the production route/header adapter against built assets on loopback only.
 */
import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { serve } from '../../hosting/worker.mjs'

const root = resolve('dist')
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.json': 'application/json',
}
const assets = {
  /** Simulate the fixed Static Assets binding, never serve private control files or outside paths. */
  async fetch(request) {
    try {
      const path = decodeURIComponent(new URL(request.url).pathname)
      const file = resolve(root, '.' + path)
      if (
        (!file.startsWith(root + '/') && !file.startsWith(root + '\\')) ||
        path === '/_headers' ||
        !statSync(file).isFile()
      )
        return new Response('Not found', { status: 404 })
      return new Response(request.method === 'HEAD' ? null : readFileSync(file), {
        headers: {
          'Content-Type': types[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  },
}
const server = createServer(async (req, res) => {
  const request = new Request(new URL(req.url, 'http://127.0.0.1:5186'), { method: req.method })
  const response = await serve(request, { ASSETS: assets })
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
})
server.listen(5186, '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close())

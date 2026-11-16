/**
 * @file Serves only known dashboard deep links; never proxies API or WebSocket traffic.
 */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
}

/** Identify the existing dot-free application routes without accepting arbitrary missing assets. */
export function appRoute(path) {
  return path === '/' || /^\/(engine|data|account)(\/[^.]*)?$/.test(path)
}

/** Apply the same security policy to successful assets, fallback HTML and errors. */
export function secure(response, head = false) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value)
  return new Response(head ? null : response.body, { status: response.status, headers })
}

/** Resolve assets before known UI routes; reject unavailable paths and non-read methods. */
export async function serve(request, env) {
  const head = request.method === 'HEAD'
  if (!['GET', 'HEAD'].includes(request.method))
    return secure(
      new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }),
    )
  try {
    const url = new URL(request.url)
    let response = await env.ASSETS.fetch(request)
    if (response.status === 404 && appRoute(url.pathname))
      response = await env.ASSETS.fetch(
        new Request(new URL('/index.html', url.origin), { method: request.method }),
      )
    return secure(response, head)
  } catch {
    return secure(new Response('Unavailable', { status: 503 }), head)
  }
}

export default { fetch: serve }

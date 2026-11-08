/**
 * OPTIONAL page-fetching proxy for Recipe Box (Cloudflare Worker, free tier).
 *
 * Browsers can't read most recipe sites directly. With this worker the app can
 * read a site's built-in recipe card for free instead of asking Claude.
 *
 * Setup:
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker → paste this file → Deploy.
 *   2. Worker → Settings → Variables and Secrets:
 *        PROXY_KEY      (Secret)  a long random string
 *        ALLOWED_ORIGIN (Text)    https://infosystir.github.io
 *   3. In the app's Settings, set the proxy URL prefix to:
 *        https://<your-worker>.workers.dev/?key=<PROXY_KEY>&url=
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });

    const u = new URL(request.url);
    if (!env.PROXY_KEY || u.searchParams.get('key') !== env.PROXY_KEY) return new Response('Forbidden', { status: 403, headers: cors });
    if (allowed && origin && origin !== allowed) return new Response('Forbidden origin', { status: 403, headers: cors });

    let target;
    try {
      target = new URL(u.searchParams.get('url') || '');
    } catch {
      return new Response('Bad url', { status: 400, headers: cors });
    }
    if (!/^https?:$/.test(target.protocol)) return new Response('Bad url', { status: 400, headers: cors });
    // Don't let the proxy reach private/internal addresses.
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$|0\.)/i.test(target.hostname)) {
      return new Response('Blocked host', { status: 400, headers: cors });
    }

    const res = await fetch(target.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      cf: { cacheTtl: 3600 },
    });
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/.test(type)) return new Response('Not an HTML page', { status: 415, headers: cors });
    const body = await res.text();
    return new Response(body.slice(0, 3_000_000), {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};

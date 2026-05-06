import * as http from 'http';

/**
 * Minimal HTTP server that displays the box's pairing code on
 * http://meadow.local during the unpaired phase.
 *
 * Avahi (installed by pi-setup.sh) advertises the box's hostname as
 * meadow.local on the LAN, so any phone on the same wifi can hit
 * http://meadow.local/ and see the code.
 *
 * The page polls itself every 5s; once the parent has claimed the
 * code in the dashboard, bootstrap.ts calls setStatus('paired') and
 * the next refresh shows the success message.
 *
 * Port 80 requires CAP_NET_BIND_SERVICE — the meadow-bootstrap.service
 * unit grants it. Bind binds to 0.0.0.0 so meadow.local resolves
 * across the LAN. If the bind fails (port already taken, missing
 * cap), we log + continue without the web page; LED + dashboard
 * pairing still work.
 */

const PORT = parseInt(process.env.WEB_PORT ?? '80', 10);

let server: http.Server | null = null;
let currentCode = '';
let status: 'pending' | 'paired' = 'pending';

export function startPairingWeb(code: string): void {
  if (server) return;
  if (process.env.DISABLE_PAIRING_WEB === '1') {
    console.log('[web] disabled (DISABLE_PAIRING_WEB=1)');
    return;
  }
  currentCode = code;

  server = http.createServer((req, res) => {
    if (!req.url || req.url === '/' || req.url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderPage(currentCode, status));
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
      console.warn(`[web] could not bind :${PORT} (${err.code}) — pairing web disabled`);
    } else {
      console.error('[web] server error:', err);
    }
    server = null;
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[web] pairing page listening on :${PORT}`);
  });
}

export function setStatus(s: 'pending' | 'paired'): void {
  status = s;
}

export function stopPairingWeb(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => {
      server = null;
      resolve();
    });
  });
}

/**
 * Render the page. Self-contained HTML — no external assets,
 * no JS frameworks, works on every phone browser parents might
 * have. <meta refresh=5> drives the polling.
 */
function renderPage(code: string, s: 'pending' | 'paired'): string {
  const safeCode = escapeHtml(code);
  if (s === 'paired') {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meadow — paired</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f0f7f3; color: #1d4327; margin: 0; padding: 2rem; min-height: 100vh; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
  .card { max-width: 32rem; text-align: center; }
  .check { font-size: 6rem; line-height: 1; }
  h1 { font-size: 1.5rem; margin: 1rem 0 0.5rem; }
  p { color: #406b51; margin: 0.25rem 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>Box paired successfully</h1>
    <p>You can close this page.</p>
  </div>
</body>
</html>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Meadow — pair this box</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #f7f9fb; color: #18223a; margin: 0; padding: 2rem; min-height: 100vh; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
  .card { max-width: 32rem; width: 100%; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 500; color: #4a5878; margin: 0 0 1.5rem; }
  .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: clamp(2.5rem, 12vw, 4.5rem); letter-spacing: 0.05em; font-weight: 600; color: #18223a; padding: 1.5rem 1rem; background: #fff; border: 2px solid #d0d7e6; border-radius: 1rem; }
  p { color: #4a5878; margin-top: 1.5rem; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>Pair this Meadow box</h1>
    <div class="code">${safeCode}</div>
    <p>Enter this code in your Meadow dashboard to set up your box.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Test helpers.
 */
export function _renderForTests(
  code: string,
  s: 'pending' | 'paired',
): string {
  return renderPage(code, s);
}

import * as http from 'http';
import { readNetworkState } from './network-state';

/**
 * Minimal HTTP server that displays the box's pairing code on
 * http://meadow.local during the unpaired phase, and the network-
 * conflict error UI if the 30-second DHCP-conflict check finds
 * another DHCP server already serving the LAN.
 *
 * Avahi (installed by install.sh) advertises the box's hostname as
 * meadow.local on the LAN, so any phone on the same wifi can hit
 * http://meadow.local/ and see the appropriate page.
 *
 * The page polls itself every 5s; once the parent has claimed the
 * code in the dashboard, bootstrap.ts calls setStatus('paired') and
 * the next refresh shows the success message.
 *
 * If the network-mode setup detected a DHCP conflict, setStatus(
 * 'network_conflict') flips the page into a help screen pointing
 * the operator at the per-router setup guides + a "Retry network
 * setup" button.
 *
 * Port 80 requires CAP_NET_BIND_SERVICE — the meadow-bootstrap.service
 * unit grants it. Bind binds to 0.0.0.0 so meadow.local resolves
 * across the LAN. If the bind fails (port already taken, missing
 * cap), we log + continue without the web page; LED + dashboard
 * pairing still work.
 */

type WebStatus = 'pending' | 'paired' | 'network_conflict';

const PORT = parseInt(process.env.WEB_PORT ?? '80', 10);
const SETUP_GUIDES_URL =
  process.env.SETUP_GUIDES_URL ||
  'https://github.com/duquettelogan/meadow/tree/main/docs/setup-guides';

let server: http.Server | null = null;
let currentCode = '';
let status: WebStatus = 'pending';
let onRetry: (() => Promise<unknown>) | null = null;

export function startPairingWeb(
  code: string,
  retryHandler?: () => Promise<unknown>,
): void {
  if (server) return;
  if (process.env.DISABLE_PAIRING_WEB === '1') {
    console.log('[web] disabled (DISABLE_PAIRING_WEB=1)');
    return;
  }
  currentCode = code;
  onRetry = retryHandler ?? null;

  server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/retry-network') {
      handleRetry(res);
      return;
    }
    if (req.url === '/' || req.url.startsWith('/?')) {
      const conflictState = readNetworkState();
      const effective: WebStatus =
        status === 'paired' && conflictState.conflict_detected
          ? 'network_conflict'
          : status;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderPage(currentCode, effective, conflictState.servers_seen));
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

function handleRetry(res: http.ServerResponse): void {
  if (!onRetry) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'retry handler not registered' }));
    return;
  }
  // Fire and forget — page will refresh and the result of the retry
  // shows up via readNetworkState() in the next render.
  onRetry().catch((err) => {
    console.error('[web] retry handler crashed:', err);
  });
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'retrying' }));
}

export function setStatus(s: WebStatus): void {
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
 * Render the page. Self-contained HTML — no external assets, no JS
 * frameworks. <meta refresh=5> drives the polling for pending +
 * conflict states.
 */
function renderPage(
  code: string,
  s: WebStatus,
  serversSeen: string[] = [],
): string {
  if (s === 'paired') return renderPaired();
  if (s === 'network_conflict') return renderConflict(serversSeen);
  return renderPending(code);
}

function renderPaired(): string {
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

function renderPending(code: string): string {
  const safeCode = escapeHtml(code);
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

function renderConflict(serversSeen: string[]): string {
  const safeServers = serversSeen.map(escapeHtml).join(', ') || 'your home router';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Meadow — needs your help</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #fff8f0; color: #4a3018; margin: 0; padding: 2rem; min-height: 100vh; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
  .card { max-width: 38rem; width: 100%; }
  h1 { font-size: 1.5rem; margin: 0 0 0.75rem; color: #6b3d12; }
  p { line-height: 1.55; margin: 0.75rem 0; }
  .seen { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #fff; padding: 0.5rem 0.75rem; border-radius: 0.5rem; border: 1px solid #e7d3b9; display: inline-block; margin: 0.25rem 0; }
  ol { padding-left: 1.5rem; }
  ol li { margin: 0.5rem 0; line-height: 1.5; }
  .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; flex-wrap: wrap; }
  button, .button { font: inherit; padding: 0.75rem 1.5rem; border-radius: 0.5rem; border: none; cursor: pointer; font-weight: 500; text-decoration: none; display: inline-block; }
  button { background: #18223a; color: #fff; }
  .button.secondary { background: #fff; color: #18223a; border: 1px solid #d0d7e6; }
  .reassure { background: #fff; padding: 1rem 1.25rem; border-left: 4px solid #2e8a4f; border-radius: 0 0.5rem 0.5rem 0; margin-top: 1.5rem; color: #1d4327; }
  .reassure strong { color: #144226; }
</style>
</head>
<body>
  <div class="card">
    <h1>We need to disable DHCP on your home router</h1>
    <p>
      We detected another DHCP server on your network — usually your
      home router:
    </p>
    <p><span class="seen">${safeServers}</span></p>
    <p>
      Two DHCP servers on the same network fight over IP addresses,
      so Meadow won't start until your home router stops handing
      them out. The router will keep doing everything else: Wi-Fi,
      routing, internet — Meadow only handles DNS filtering.
    </p>
    <ol>
      <li>Open the setup guide for your router model:
        <a href="${escapeHtml(SETUP_GUIDES_URL)}" target="_blank" rel="noopener">
          guides for Netgear / ASUS / TP-Link / Linksys / eero / Google Wifi / Spectrum / Xfinity / AT&amp;T
        </a>.</li>
      <li>Follow the steps to <strong>disable DHCP</strong> on your router (sometimes labeled "DHCP server" or "LAN settings").</li>
      <li>Leave Wi-Fi, internet, and everything else as-is.</li>
      <li>Come back to this page and click <strong>Retry network setup</strong>.</li>
    </ol>
    <div class="actions">
      <form method="POST" action="/retry-network" onsubmit="this.querySelector('button').disabled=true; this.querySelector('button').textContent='Checking…';">
        <button type="submit">Retry network setup</button>
      </form>
      <a class="button secondary" href="${escapeHtml(SETUP_GUIDES_URL)}" target="_blank" rel="noopener">Open setup guides</a>
    </div>
    <div class="reassure">
      <strong>Your network is fine right now.</strong> While Meadow waits,
      your home router is still handing out addresses and serving the
      internet — nothing is broken.
    </div>
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
  s: WebStatus,
  serversSeen: string[] = [],
): string {
  return renderPage(code, s, serversSeen);
}

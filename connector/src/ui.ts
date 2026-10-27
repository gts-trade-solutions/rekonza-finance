// ─────────────────────────────────────────────────────────────────────────────
// The connector's own window.
//
// A background program with no face is impossible to trust and impossible to
// support: nobody can tell whether it is working, and the first question on
// every call is "is it even running?". So it serves one page on this machine —
// not on the network — and opens it in the browser the person already uses.
//
// The page answers the three questions in order: is this PC connected, can it
// see Tally, and when did anything last reach REKONZA. Everything else is two
// buttons.
//
// It listens on 127.0.0.1 only, and every action requires a header a browser
// will send from this page but a form on some other website cannot forge.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import { exec } from 'node:child_process';

export interface AppStatus {
  paired: boolean;
  organisation: string | null;
  portalUrl: string | null;
  machineName: string;
  version: string;
  configPath: string;
  tallyHost: string;
  tallyPort: number;
  /** What Tally says right now. */
  tally: { ok: boolean; message: string; companies: string[] };
  lastSync: { at: string | null; ok: boolean; message: string } | null;
  syncing: boolean;
  nextSyncAt: string | null;
  autostart: boolean;
  canAutostart: boolean;
}

export interface ConnectorApp {
  status(): AppStatus;
  pair(input: { portalUrl: string; code: string }): Promise<void>;
  syncNow(): Promise<void>;
  unpair(): Promise<void>;
  setAutostart(on: boolean): Promise<void>;
}

const GUARD = 'x-rekonza-ui';

export function startUi(app: ConnectorApp, port: number): Promise<{ url: string; close(): void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (code: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(text);
    };

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = page();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      send(200, app.status());
      return;
    }

    if (req.method === 'POST') {
      // A page on another site can POST a form here, but it cannot set a header.
      if (req.headers[GUARD] !== '1') {
        send(403, { error: 'Refused.' });
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          send(400, { error: 'That did not arrive properly. Try again.' });
          return;
        }
        const done = () => send(200, app.status());
        const failed = (err: unknown) => send(400, { error: (err as Error).message });

        if (url.pathname === '/api/pair') {
          app.pair({ portalUrl: String(body.portalUrl ?? ''), code: String(body.code ?? '') }).then(done, failed);
          return;
        }
        if (url.pathname === '/api/sync') {
          app.syncNow().then(done, failed);
          return;
        }
        if (url.pathname === '/api/unpair') {
          app.unpair().then(done, failed);
          return;
        }
        if (url.pathname === '/api/autostart') {
          app.setAutostart(Boolean(body.on)).then(done, failed);
          return;
        }
        send(404, { error: 'No such action.' });
      });
      return;
    }

    send(404, { error: 'Not found.' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      resolve({ url: `http://127.0.0.1:${actual}/`, close: () => server.close() });
    });
  });
}

/** Opens the page in whatever browser this machine uses. */
export function openInBrowser(url: string) {
  const command =
    process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, () => {});
}

function page(): string {
  // One file, no fonts or scripts from anywhere else: this runs on an office PC
  // that may have no internet beyond REKONZA itself.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>REKONZA Tally Connector</title>
<style>
  :root {
    --bg: #eef1f6; --card: #ffffff; --ink: #141d2b; --soft: #475569; --muted: #76839a;
    --line: #e2e7f0; --brand: #1d4ed8; --brand-ink: #ffffff; --ok: #0e9f6e; --warn: #b45309; --bad: #c0392b;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0c131f; --card: #141d2b; --ink: #e8eef7; --soft: #a9b6ca; --muted: #8494ab;
            --line: #23304a; --brand: #5b8cff; --brand-ink: #0c131f; --ok: #34d399; --warn: #fbbf24; --bad: #f87171; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 540px; margin: 0 auto; padding: 28px 18px 48px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
  .brand .dot { width: 30px; height: 30px; border-radius: 9px; background: var(--brand); color: var(--brand-ink);
                display: grid; place-items: center; font-weight: 700; font-size: 15px; }
  .brand b { font-size: 15px; letter-spacing: .01em; }
  .brand span { color: var(--muted); font-size: 13px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p.sub { margin: 0 0 16px; color: var(--soft); font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 0 0 6px; }
  input[type=text] { width: 100%; padding: 10px 12px; font-size: 15px; border: 1px solid var(--line);
                     border-radius: 8px; background: var(--bg); color: var(--ink); }
  input#code { font-size: 26px; letter-spacing: .22em; text-align: center; text-transform: uppercase;
               font-family: ui-monospace, Consolas, monospace; padding: 12px; }
  input:focus { outline: 2px solid var(--brand); outline-offset: 1px; }
  .field { margin-bottom: 14px; }
  button { font: inherit; font-weight: 600; border-radius: 8px; border: 1px solid transparent; padding: 10px 16px; cursor: pointer; }
  .primary { background: var(--brand); color: var(--brand-ink); width: 100%; }
  .primary:disabled { opacity: .55; cursor: default; }
  .ghost { background: transparent; color: var(--soft); border-color: var(--line); }
  .row { display: flex; align-items: center; gap: 10px; padding: 11px 0; border-top: 1px solid var(--line); }
  .row:first-of-type { border-top: 0; }
  .row .k { color: var(--muted); font-size: 13px; width: 112px; flex: none; }
  .row .v { font-size: 14px; }
  .pill { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; }
  .pill i { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .pill.ok i { background: var(--ok); } .pill.bad i { background: var(--bad); } .pill.warn i { background: var(--warn); }
  .buttons { display: flex; gap: 8px; margin-top: 16px; }
  .buttons button { flex: 1; }
  .note { color: var(--muted); font-size: 12.5px; margin-top: 14px; }
  .err { color: var(--bad); font-size: 13.5px; margin-top: 10px; min-height: 1.2em; }
  .list { margin: 2px 0 0; padding-left: 18px; color: var(--soft); font-size: 13.5px; }
  .toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .switch { position: relative; width: 42px; height: 24px; flex: none; }
  .switch input { opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--line); transition: background .15s; pointer-events: none; }
  .switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px;
                        border-radius: 50%; background: var(--card); transition: transform .15s; }
  .switch input:checked + span { background: var(--brand); }
  .switch input:checked + span::after { transform: translateX(18px); }
  .foot { color: var(--muted); font-size: 12px; text-align: center; margin-top: 18px; word-break: break-all; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="dot">R</span><div><b>REKONZA Tally Connector</b><br><span id="version"></span></div></div>
  <div id="view"></div>
  <p class="foot" id="foot"></p>
</div>
<script>
var busy = false;
var lastError = "";
var shownShape = "";
function showError() { var el = document.getElementById("err"); if (el) el.textContent = lastError; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
  return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function post(path, body) {
  busy = true;
  return fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "x-rekonza-ui": "1" },
    body: JSON.stringify(body || {}) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "That did not work."); return j; }); })
    .then(function (s) { busy = false; lastError = ""; shownShape = ""; render(s); })
    .catch(function (e) { busy = false; lastError = e.message; shownShape = ""; render(latest || {}); });
}

function ago(iso) {
  if (!iso) return "not yet";
  var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "a minute ago";
  if (mins < 60) return mins + " minutes ago";
  var h = Math.round(mins / 60);
  return h === 1 ? "an hour ago" : h + " hours ago";
}

var latest = null;

function render(s) {
  if (!s || typeof s.paired === "undefined") return;
  latest = s;
  // Rebuilt only when the screen changes from one thing to another. Rebuilding
  // on every poll would wipe a half-typed code and any message just shown.
  var shape = s.paired
    ? "paired:" + s.tally.ok + ":" + s.tally.companies.join(",") + ":" + (s.lastSync ? s.lastSync.at : "") + ":" + s.syncing + ":" + s.autostart
    : "unpaired";
  if (shape === shownShape) { showError(); return; }
  shownShape = shape;
  document.getElementById("version").textContent = "Version " + s.version + " on " + s.machineName;
  document.getElementById("foot").textContent = "Settings file: " + s.configPath;
  var v = document.getElementById("view");

  if (!s.paired) {
    v.innerHTML =
      '<div class="card">' +
      '<h1>Connect this PC to REKONZA</h1>' +
      '<p class="sub">In REKONZA, open <b>Tally</b> in the left menu and press <b>Connect a PC</b>. Type the code it shows here. It works once, and lasts fifteen minutes.</p>' +
      '<div class="field"><label for="portal">REKONZA address</label>' +
      '<input type="text" id="portal" value="' + esc(s.portalUrl || "https://finance.raceinnovations.in") + '" spellcheck="false"></div>' +
      '<div class="field"><label for="code">Pairing code</label>' +
      '<input type="text" id="code" maxlength="9" placeholder="XXXX-XXXX" autocomplete="off" spellcheck="false"></div>' +
      '<button class="primary" id="go">Connect</button>' +
      '<p class="err" id="err"></p>' +
      '<p class="note">Nothing in Tally is changed, and your REKONZA password is never needed here.</p>' +
      '</div>';
    var code = document.getElementById("code");
    code.addEventListener("input", function () {
      var raw = code.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      code.value = raw.length > 4 ? raw.slice(0, 4) + "-" + raw.slice(4) : raw;
    });
    code.addEventListener("keydown", function (e) { if (e.key === "Enter") connect(); });
    document.getElementById("go").addEventListener("click", connect);
    code.focus();
    showError();
    return;
  }

  var open = s.tally.companies.length;
  var tally = s.tally.ok
    ? '<span class="pill ok"><i></i>' + (open === 1 ? "1 company open" : open + " companies open") + "</span>"
    : '<span class="pill bad"><i></i>Not answering</span>';
  var companies = s.tally.companies.length
    ? '<ul class="list">' + s.tally.companies.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>"
    : '<p class="note" style="margin:4px 0 0">' + esc(s.tally.message) + "</p>";
  var last = s.lastSync
    ? '<span class="pill ' + (s.lastSync.ok ? "ok" : "warn") + '"><i></i>' + esc(ago(s.lastSync.at)) + "</span>"
    : '<span class="pill"><i></i>not yet</span>';

  v.innerHTML =
    '<div class="card">' +
    '<div class="row"><span class="k">REKONZA</span><span class="v"><span class="pill ok"><i></i>' + esc(s.organisation || "Connected") + "</span></span></div>" +
    '<div class="row"><span class="k">TallyPrime</span><span class="v">' + tally + "</span></div>" +
    '<div class="row" style="border-top:0;padding-top:0"><span class="k"></span><span class="v" style="flex:1">' + companies + "</span></div>" +
    '<div class="row"><span class="k">Last update</span><span class="v">' + last + (s.lastSync && !s.lastSync.ok ? ' <span class="note">' + esc(s.lastSync.message) + "</span>" : "") + "</span></div>" +
    '<div class="buttons">' +
    '<button class="primary" id="sync"' + (s.syncing ? " disabled" : "") + ">" + (s.syncing ? "Updating…" : "Update now") + "</button>" +
    '<button class="ghost" id="unpair">Disconnect</button>' +
    "</div>" +
    '<p class="err" id="err"></p>' +
    "</div>" +
    (s.canAutostart
      ? '<div class="card toggle"><div><b style="font-size:14px">Start with Windows</b><br>' +
        '<span class="note" style="margin:0">So your figures keep arriving after a restart.</span></div>' +
        '<label class="switch"><input type="checkbox" id="auto"' + (s.autostart ? " checked" : "") + "><span></span></label></div>"
      : "") +
    '<p class="note" style="text-align:center">Keep TallyPrime open, with your company open in it. You can close this window — the connector keeps running.</p>';

  document.getElementById("sync").addEventListener("click", function () { post("/api/sync"); });
  document.getElementById("unpair").addEventListener("click", function () {
    if (confirm("Disconnect this PC? REKONZA keeps what it already has, but nothing more will arrive.")) post("/api/unpair");
  });
  var auto = document.getElementById("auto");
  if (auto) auto.addEventListener("change", function () { post("/api/autostart", { on: auto.checked }); });
  showError();
}

function connect() {
  lastError = "";
  showError();
  var code = document.getElementById("code").value.trim();
  var portal = document.getElementById("portal").value.trim();
  if (code.replace(/[^A-Za-z0-9]/g, "").length !== 8) { lastError = "A code is eight characters, like K7Q2-9MXP."; showError(); return; }
  document.getElementById("go").disabled = true;
  document.getElementById("go").textContent = "Connecting…";
  post("/api/pair", { code: code, portalUrl: portal });
}

function refresh() { if (!busy) fetch("/api/status").then(function (r) { return r.json(); }).then(render).catch(function () {}); }
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;
}

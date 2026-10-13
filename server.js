// Dev Sprint '26 - Problem Selection Portal (zero dependencies, Node 18+)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SESSION_TIMEOUT_MS = (Number(process.env.SESSION_TIMEOUT_MIN) || 3) * 60 * 1000; // idle => session expires
const COOKIE = 'ds26sid';
const problems = JSON.parse(fs.readFileSync(path.join(__dirname, 'problems.json'), 'utf8'));

const norm = s => String(s || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const hash = pw => { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const verify = (pw, stored) => {
  const [s, h] = stored.split(':');
  const c = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(c, Buffer.from(h, 'hex'));
};
const now = () => new Date().toISOString();

// ---------- storage (JSON file; Node is single-threaded so each request runs atomically) ----------
let db;
function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DATA_FILE);
}
function init() {
  if (fs.existsSync(DATA_FILE)) { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); return; }
  const seedPath = path.join(__dirname, 'seed.json');
  let seed;
  if (fs.existsSync(seedPath)) {
    seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } else if (process.env.SEED_JSON) {
    try { seed = JSON.parse(process.env.SEED_JSON); } catch (e) { console.error('Invalid SEED_JSON env var'); process.exit(1); }
  } else {
    console.error('seed.json missing and no data/data.json found. Either provide seed.json or set SEED_JSON env var.');
    process.exit(1);
  }
  db = {
    users: [{ id: 'admin', name: seed.admin.username, key: norm(seed.admin.username), role: 'admin', hash: hash(seed.admin.password) }]
      .concat(seed.teams.map((t, i) => ({ id: 'T' + String(i + 1).padStart(2, '0'), name: t.name, key: norm(t.name), role: 'team', hash: hash(t.password) }))),
    windowOpen: false, openedAt: null, closedAt: null,   // selection is CLOSED by default
    allocations: {},                                       // problemId -> {teamId, teamName, at}
    audit: [], lastLogin: {}, failed: {}
  };
  save();
  console.log('First run: accounts created (passwords hashed). You can now DELETE seed.json from the server.');
}
function log(actor, action, detail) { db.audit.push({ at: now(), actor, action, detail }); if (db.audit.length > 5000) db.audit.shift(); }

// ---------- sessions (in memory) ----------
const sessions = new Map(); // token -> {userId, role, created, last}
function purge() { const t = Date.now(); for (const [k, s] of sessions) if (t - s.last > SESSION_TIMEOUT_MS) sessions.delete(k); }
function activeSessionOf(userId) { purge(); for (const [k, s] of sessions) if (s.userId === userId) return [k, s]; return null; }
function getSession(req) {
  purge();
  const m = (req.headers.cookie || '').match(new RegExp(COOKIE + '=([a-f0-9]+)'));
  const s = m && sessions.get(m[1]);
  if (!s) return null;
  s.last = Date.now();
  return { token: m[1], ...s, user: db.users.find(u => u.id === s.userId) };
}

// ---------- login rate limiting ----------
const attempts = new Map(); // key -> {n, until}
function locked(key) { const a = attempts.get(key); return a && a.until > Date.now(); }
function fail(key) { const a = attempts.get(key) || { n: 0, until: 0 }; a.n++; if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; } attempts.set(key, a); }

// ---------- helpers ----------
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 10000) { reject(); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { reject(); } });
  });
}
const status = () => db.windowOpen ? 'OPEN' : (db.openedAt ? 'CLOSED' : 'NOT STARTED');
const teamsList = () => db.users.filter(u => u.role === 'team');
const csvCell = v => { v = String(v ?? ''); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };

function stateFor(s) {
  const board = problems.map(p => {
    const a = db.allocations[p.id];
    return { ...p, status: a ? 'TAKEN' : 'AVAILABLE', team: a ? a.teamName : null, at: a ? a.at : null };
  });
  const taken = board.filter(p => p.status === 'TAKEN').length;
  const out = {
    me: { role: s.user.role, name: s.user.name, id: s.user.id },
    status: status(), openedAt: db.openedAt, closedAt: db.closedAt,
    counts: { total: problems.length, available: problems.length - taken, taken, teams: teamsList().length, allocatedTeams: taken, teamsYetToSelect: teamsList().length - taken },
    problems: board,
    myAllocation: null
  };
  if (s.user.role === 'team') {
    const mine = board.find(p => p.team === s.user.name);
    if (mine) out.myAllocation = { ...mine };
  } else {
    out.teams = teamsList().map(t => {
      const sess = activeSessionOf(t.id);
      const al = Object.entries(db.allocations).find(([, a]) => a.teamId === t.id);
      return { id: t.id, name: t.name, loggedIn: !!sess, sessionSince: sess ? new Date(sess[1].created).toISOString() : null,
               lastSeen: sess ? new Date(sess[1].last).toISOString() : null, lastLogin: db.lastLogin[t.id] || null,
               failedLogins: db.failed[t.id] || 0, problemId: al ? al[0] : null };
    });
    out.audit = db.audit.slice(-200).reverse();
  }
  return out;
}

// ---------- routes ----------
async function api(req, res, url) {
  const method = req.method;
  if (method === 'POST' && !/application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON only' });
  let b = {};
  if (method === 'POST') { try { b = await body(req); } catch { return send(res, 400, { error: 'Bad request' }); } }

  if (url === '/api/login' && method === 'POST') {
    const ip = req.socket.remoteAddress, key = norm(b.username) + '|' + ip;
    if (locked(key)) return send(res, 429, { error: 'Too many failed attempts. Wait a minute and try again.' });
    const u = db.users.find(x => x.key === norm(b.username));
    if (!u || !b.password || !verify(b.password, u.hash)) {
      fail(key);
      if (u) { db.failed[u.id] = (db.failed[u.id] || 0) + 1; log(u.name, 'login_failed', ''); save(); }
      return send(res, 401, { error: 'Invalid team name or password.' });
    }
    if (u.role === 'team' && activeSessionOf(u.id))
      return send(res, 409, { error: 'This team already has an active session on another device. Log out there, wait a few minutes, or ask the admin to reset it.' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: u.id, role: u.role, created: Date.now(), last: Date.now() });
    db.lastLogin[u.id] = now(); log(u.name, 'login', ''); save();
    const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true, role: u.role }, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}` });
  }

  const s = getSession(req);
  if (!s) return send(res, 401, { error: 'Not logged in or session expired.' });

  if (url === '/api/logout' && method === 'POST') {
    sessions.delete(s.token); log(s.user.name, 'logout', ''); save();
    return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Max-Age=0; Path=/` });
  }
  if (url === '/api/state' && method === 'GET') return send(res, 200, stateFor(s));

  if (url === '/api/claim' && method === 'POST') {
    if (s.role !== 'team') return send(res, 403, { error: 'Teams only.' });
    const p = problems.find(x => x.id === b.problemId);
    if (!p) return send(res, 400, { error: 'Unknown problem.' });
    // everything below runs synchronously => no two claims can interleave
    if (!db.windowOpen) return send(res, 403, { error: 'Selection is not open.' });
    if (Object.values(db.allocations).some(a => a.teamId === s.userId)) return send(res, 409, { error: 'Your team has already selected a problem.' });
    if (db.allocations[p.id]) return send(res, 409, { error: `${p.id} was just taken by another team. Please choose another.` });
    const at = now();
    db.allocations[p.id] = { teamId: s.userId, teamName: s.user.name, at };
    log(s.user.name, 'claim', `${p.id} - ${p.title}`); save();
    return send(res, 200, { ok: true, id: p.id, title: p.title, at });
  }

  if (s.role !== 'admin') return send(res, 403, { error: 'Admin only.' });

  if (url === '/api/admin/window' && method === 'POST') {
    if (b.open) { db.windowOpen = true; db.openedAt = db.openedAt || now(); db.closedAt = null; log(s.user.name, 'window_open', ''); }
    else { db.windowOpen = false; db.closedAt = now(); log(s.user.name, 'window_close', ''); }
    save(); return send(res, 200, { ok: true });
  }
  if (url === '/api/admin/revoke' && method === 'POST') {
    const a = db.allocations[b.problemId];
    if (!a) return send(res, 404, { error: 'That problem is not allocated.' });
    delete db.allocations[b.problemId];
    log(s.user.name, 'revoke', `${b.problemId} from ${a.teamName} (was claimed ${a.at}). Reason: ${String(b.reason || '').slice(0, 200)}`); save();
    return send(res, 200, { ok: true });
  }
  if (url === '/api/admin/kick' && method === 'POST') {
    const ses = activeSessionOf(b.teamId);
    if (!ses) return send(res, 404, { error: 'No active session.' });
    sessions.delete(ses[0]); log(s.user.name, 'session_revoked', b.teamId); save();
    return send(res, 200, { ok: true });
  }
  if (url === '/api/admin/export.csv' && method === 'GET') {
    const tz = { timeZone: 'Asia/Kolkata', hour12: false };
    const rows = [['Problem ID', 'Title', 'Category', 'Status', 'Team', 'Allocated at (IST)', 'Allocated at (UTC)']];
    for (const p of problems) { const a = db.allocations[p.id];
      rows.push([p.id, p.title, p.category, a ? 'TAKEN' : 'AVAILABLE', a ? a.teamName : '', a ? new Date(a.at).toLocaleString('en-IN', tz) : '', a ? a.at : '']); }
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="devsprint26_allocations.csv"' });
    return res.end(rows.map(r => r.map(csvCell).join(',')).join('\n'));
  }
  send(res, 404, { error: 'Not found' });
}

init();
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  if (url.startsWith('/api/')) return api(req, res, url).catch(() => send(res, 500, { error: 'Server error' }));
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  res.writeHead(404); res.end('Not found');
});
if (require.main === module) server.listen(PORT, () => console.log(`Dev Sprint '26 portal running on http://localhost:${PORT}`));
module.exports = server;

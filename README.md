# Dev Sprint '26 – Problem Selection Portal (simple version)

Plain Node.js (v18+), **no npm install needed**. Data is stored in `data/data.json` (survives restarts).

## Run
```
node server.js        # then open http://localhost:3000
```
Change port: `PORT=8080 node server.js`

First start creates all 30 team accounts + the admin from `seed.json` (passwords are stored **hashed**).
**After the first start, delete `seed.json`** (it contains the plain passwords). Never commit it.

## How it works
- Teams log in with team name + password (name is case/space-insensitive).
- **One login per team**: a second login is rejected while the first session is active. A session expires after
  3 idle minutes (the page pings every 3s while open), or the admin can click **Force logout**.
- Selection is **CLOSED by default**. Admin clicks **Launch / Open selection**; only then can teams claim.
- A team can claim one problem; a problem can go to one team. Claims are checked on the server, one at a time,
  so two teams clicking the same problem at once = exactly one winner.
- Admin can **Revoke** a claimed problem (reason saved in the audit log) – that team can choose again.
- Admin also sees logged-in teams, failed logins, audit log, and can export CSV (times in IST).
- Page auto-refreshes every 3 seconds (no manual refresh needed).

## Deploy (must be a real server, not static hosting)
1. Get a Linux VPS, install Node 18+, copy this folder, run `node server.js` (use `pm2 start server.js` to keep it alive).
2. Put Nginx in front with HTTPS (e.g. certbot) proxying to port 3000, and set `COOKIE_SECURE=1`.
   Or: `docker build -t ds26 . && docker run -d -p 3000:3000 -v $PWD/data:/app/data ds26`
3. Run `node test.js` anytime to run the self-test (uses a temp copy; doesn't touch real data).

## Event day tips
- Back up by copying `data/data.json`.
- To fully reset: stop server, delete `data/data.json`, restore `seed.json`, start again.
- Run only ONE server process (state is held by that process).

## Limitations
Single server only; sessions are kept in memory (a server restart logs everyone out, allocations are kept).

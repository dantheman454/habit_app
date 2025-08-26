# Habit App: Mobile Web Deployment Guide (iPhone over LAN)

This guide helps you run the existing web app on your iPhone (same Wi‑Fi) using the current Express backend and Flutter Web build. No native app is required.

## What you get
- Daily view with ability to add/edit/delete todos and events (habits optional; excluded by default).
- Unauthenticated access on your LAN (development only).
- Works in Safari by visiting your Mac's IP address.
- Optional: PWA install if you serve via HTTPS (see Appendix B).

## Prereqs
- Node.js 20+
- Your Mac and iPhone on the same Wi‑Fi network
- This repo cloned and dependencies installed: `npm install`

## Step 1: Build or use the existing Flutter Web UI
- The server is already configured to serve static files from `apps/web/flutter_app/build/web`.
- If you need to rebuild the UI, open the Flutter project and run a release web build:
  - Ensure Flutter SDK is installed
  - From `apps/web/flutter_app`: `flutter build web`

## Step 2: Start the server bound to all interfaces
By default the server binds to `127.0.0.1` (localhost). For iPhone access, bind to `0.0.0.0`.

- One‑off run (recommended):
```
HOST=0.0.0.0 PORT=3000 npm start
```
- Or use the convenience script:
```
npm run start:lan
```
- The server logs will show:
  - `Server listening at http://0.0.0.0:3000`

Optional environment variables:
- `TZ_NAME` (default `America/New_York`) controls server timezone semantics.

## Step 3: Find your Mac’s LAN IP
- On macOS: System Settings → Network → Wi‑Fi → note the IP (e.g., `192.168.1.23`).

## Step 4: Open the app on iPhone Safari
- On your iPhone, visit: `http://<YOUR_MAC_IP>:3000/`
- The web app should load and use the same‑origin API.

## Step 5: Day view usage (scope confirmed)
- Use the day view to see scheduled items for a single date. The backend supports:
  - Todos: create, update, delete; per‑occurrence status for repeating todos.
  - Events: create, update, delete (no per‑occurrence editing required).
- The unified schedule endpoint powers day/week ranges if needed.

### Relevant endpoints (already implemented)
- Schedule: `GET /api/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD&kinds=todo,event`
- Todos:
  - `POST /api/todos`
  - `PATCH /api/todos/:id`
  - `PATCH /api/todos/:id/occurrence` (set `status` to `pending|completed|skipped`)
  - `DELETE /api/todos/:id`
- Events:
  - `POST /api/events`
  - `PATCH /api/events/:id`
  - `DELETE /api/events/:id`

## Troubleshooting
- Page loads but API fails: ensure server is running with `HOST=0.0.0.0` and your iPhone is on the same network.
- Nothing loads: verify firewall isn’t blocking Node on port 3000.
- Wrong date/time: set `TZ_NAME` if you are not in `America/New_York`.
- Stale UI: if you rebuilt Flutter, confirm `apps/web/flutter_app/build/web` exists before starting the server.

## Security (dev only)
- The server is unauthenticated and accessible on your LAN. Do not expose it to the internet without adding auth and HTTPS.

---

## Appendix A: Optional npm convenience
A script is provided to run the server bound for LAN:
```
// package.json scripts
"start:lan": "HOST=0.0.0.0 PORT=3000 node apps/server/server.js"
```
Run with:
```
npm run start:lan
```

## Appendix B: Optional HTTPS for PWA install on iOS (advanced)
To install as a PWA on iOS, you typically need HTTPS. One local approach uses mkcert + Caddy.

Confirmed choices:
- Hostname: `habit.local`
- Cert storage: `<repo>/certs` (relative to this README)
- Proxy config: `Caddyfile` at repo root

### B.Quick Start (with confirmed choices)
```
# 1) Install tools
brew install mkcert caddy nss
mkcert -install

# 2) Create certs
mkdir -p certs
cd certs
mkcert habit.local
cd ..

# 3) Create Caddyfile in repo root with:
# (uses ./certs/habit.local.pem and ./certs/habit.local-key.pem)
cat > Caddyfile << 'EOF'
habit.local:443 {
	tls ./certs/habit.local.pem ./certs/habit.local-key.pem
	encode gzip
	@static path_regexp static ".*\.(js|css|png|jpg|jpeg|gif|svg|ico|webp|wasm)$"
	handle @static {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
EOF

# 4) Ensure hosts entry resolves the name on Mac
sudo sh -c 'echo "127.0.0.1 habit.local" >> /etc/hosts'

# 5) Start backend and HTTPS proxy
npm run start:lan
# In another terminal:
caddy start --config ./Caddyfile --adapter caddyfile

# 6) On iPhone: trust the mkcert CA, then open
# Settings → General → About → Certificate Trust Settings → enable for mkcert CA
# Safari → https://habit.local/
```

### B.0 Pick a hostname
You have three options for the HTTPS hostname you’ll open on iPhone:
- Bonjour/mDNS: `https://your-mac-name.local/` (works if you generate a cert for that name)
- Custom local name: `https://habit.local/` (add to `/etc/hosts` on Mac and optionally on iPhone)
- Direct IP: `https://192.168.1.23/` (works, but certs for raw IPs may be less convenient)

For simplicity, this guide uses `habit.local`. You can substitute your Mac’s actual `.local` name if you prefer.

### B.1 Generate a local certificate with mkcert
- Install mkcert and Caddy:
```
brew install mkcert caddy nss
mkcert -install
```
- Add your chosen hostname to Mac’s hosts (skip if using real `.local` that already resolves):
```
sudo sh -c 'echo "127.0.0.1 habit.local" >> /etc/hosts'
```
- Generate certs for that hostname (choose a directory to keep certs, e.g., `<repo>/certs`):
```
mkdir -p certs
cd certs
mkcert habit.local
```
This produces `habit.local.pem` and `habit.local-key.pem` in the `certs` directory.

### B.2 Sample Caddyfile (TLS termination → Node at :3000)
Create a file named `Caddyfile` in the repo root with:
```
habit.local:443 {
	tls ./certs/habit.local.pem ./certs/habit.local-key.pem
	encode gzip
	@static path_regexp static ".*\.(js|css|png|jpg|jpeg|gif|svg|ico|webp|wasm)$"
	handle @static {
		reverse_proxy 127.0.0.1:3000
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
```
Start your Node server first (`npm run start:lan`). Then in another terminal start Caddy:
```
caddy start --config ./Caddyfile --adapter caddyfile
```
Stop Caddy:
```
caddy stop
```

### B.3 Trust the mkcert Root CA on iPhone (to remove warnings)
- Export the mkcert root CA from your Mac’s Keychain Access (look for “mkcert development CA”).
- Email/Airdrop it to your iPhone, install the profile, then enable full trust:
  - iOS: Settings → General → About → Certificate Trust Settings → enable for the installed CA.

### B.4 Open on iPhone
- On iPhone Safari: `https://habit.local/` (same Wi‑Fi)
- You should now be able to Add to Home Screen for a PWA-like experience.

### B.5 Optional: npm scripts to run Caddy
You can add scripts to `package.json` to start/stop the proxy conveniently:
```
"proxy:https": "caddy start --config ./Caddyfile --adapter caddyfile",
"proxy:https:stop": "caddy stop"
```
Usage:
```
npm run proxy:https
npm run proxy:https:stop
```

Note: Local HTTPS/PWA is optional for development; Safari over HTTP works without home‑screen install.

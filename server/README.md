# THAGAPPA — Online Backend

Node + Express + Socket.IO. Fully in-memory — no database, nothing to provision.
Verified end-to-end (toss → bat/bowl → ball-by-ball → innings switch → win/loss)
with an automated two-client simulation before shipping this.

## Deploy to Render

1. Push this `server/` folder to a GitHub repo (Render deploys from a connected
   Git repo — there's no drag-and-drop zip upload like Netlify).
2. On https://dashboard.render.com → **New +** → **Web Service** → connect that repo.
3. Settings:
   - **Root Directory**: `server` (if this folder isn't the repo root)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free is fine to start
4. Click **Create Web Service**. Render assigns a URL like
   `https://thagappa-server.onrender.com`.
5. Once it's live, visit that URL — you should see:
   `{"ok":true,"service":"thagappa-server","rooms":0}`
   That confirms the server is up and reachable.

### Optional but recommended: lock down CORS
By default `CLIENT_ORIGIN` is `"*"` (any site can connect). Once your frontend
is live on Netlify, add an environment variable in Render's dashboard:
```
CLIENT_ORIGIN = https://your-site-name.netlify.app
```
and redeploy. This stops random sites from opening sockets to your server.

### Note on Render's free tier
Free web services on Render spin down after inactivity and take ~30–60s to
wake back up on the next request. That means the *first* Quick Match / Create
Room after a period of no traffic may feel slow to respond — this is Render's
behavior, not a bug in the code. Upgrading the instance type removes this.

## What this server does
- `quickMatch` — pairs two waiting players, or queues you for 15s then tells
  the client to offer an AI fallback if nobody showed up.
- `createRoom` / `joinRoom` — 4-character room codes, validated server-side.
- Authoritative toss: server picks who calls, flips the coin, tells the toss
  winner to choose bat/bowl — every step is validated against the actual
  socket, not trusted from the client.
- Ball-by-ball resolution: both players submit a number each ball; server
  decides out/runs, tracks overs and wickets, switches innings, ends the match.
- Disconnect handling: 30s reconnect grace window (via a per-player token the
  client stores), then the remaining player is awarded the win.
- Rematch: both players must request it before a new toss begins.

## Local testing
```
npm install
npm start
```
Then open two browser tabs pointed at your frontend with its `SERVER_URL`
config set to `http://localhost:3001`.

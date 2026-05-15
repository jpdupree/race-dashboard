# race-dashboard-proxy

Cloudflare Worker that lets crew sign into the race-dashboard hub with
username + password instead of each generating a GitHub PAT.

Reads stay direct to GitHub Pages — only writes (pit board, intake
editing, race creation) go through the worker.

## Endpoints

- `POST /login` — `{ username, password }` → `{ token, username, role, expiresAt }`
- `POST /commit` — `{ path, content, sha?, message }` + `Authorization: Bearer <jwt>` → GitHub PUT response
- `GET  /get?path=...` — read a file from GitHub via the worker (returns sha for next PUT)
- `GET  /health` — `{ ok: true }`

Session tokens are HS256 JWTs valid for 12 hours.

## One-time setup

```bash
cd worker
npm install
npx wrangler login
```

Set secrets (these are not in git):

```bash
# PAT with Contents: Read and write on the hub repo
npx wrangler secret put GITHUB_TOKEN

# Long random string used to sign sessions
openssl rand -hex 32 | npx wrangler secret put JWT_SECRET

# User list — generate hashes with admin/hash.html (open the file in
# a browser, type a password, copy the JSON it produces, paste here).
# Wrap multiple users in a JSON array, e.g.
#   [{"username":"jason","hash":"...","salt":"...","iterations":100000,"role":"admin"},
#    {"username":"crew1","hash":"...","salt":"...","iterations":100000}]
npx wrangler secret put USERS
```

Edit `wrangler.toml` to set `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH`
to your hub repo. Set `ALLOWED_ORIGINS` to your Pages URL (e.g.
`https://jpdupree.github.io`) for production; `"*"` is fine for testing.

Deploy:

```bash
npx wrangler deploy
```

The worker prints its `*.workers.dev` URL on deploy. To attach a custom
route like `api.thebillymangames.com/race-dashboard/*`, either add the
route in the Cloudflare dashboard or uncomment the `[[routes]]` block
in `wrangler.toml`.

## Wire the frontend to use it

In your hub repo, create `hub.json` at the root:

```jsonc
{
  "auth": {
    "proxyUrl": "https://api.thebillymangames.com/race-dashboard"
  }
}
```

`pit.html` and `setup.html` auto-detect this and switch from the PAT
form to a username/password login form. If `hub.json` is missing or
`auth.proxyUrl` is unset, the pages fall back to direct PAT mode — so
the worker can go down without bricking race day, as long as someone
has a PAT.

## Adding / removing users

Re-run `npx wrangler secret put USERS` with the updated JSON list. No
redeploy needed.

## Roles (future)

The worker reads a `role` field per user (default `crew`). For v1, any
authenticated user can write under `races/`. To gate paths by role,
edit `pathIsAllowed()` in `src/worker.js` — e.g. require `role === 'admin'`
for `races/<slug>/config.json` or `races/index.json`.

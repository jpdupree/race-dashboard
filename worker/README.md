# race-dashboard-proxy

Cloudflare Worker that lets crew sign into the race-dashboard hub with email
+ password instead of each generating a GitHub PAT, and provides the access
control layer (per-race editors/viewers, invite links, view share links).

Reads of public races stay direct to GitHub Pages — only writes (pit board,
intake editing, race creation) and access-control endpoints go through the
worker.

## Endpoints

### Auth & users
- `POST /login` — `{ email, password }` → `{ token, email, role, expiresAt }`
- `POST /accept-invite` — `{ token, password }` → session + race assignment
- `POST /change-password` — `{ currentPassword, newPassword }` (session required)
- `POST /reset-link` — `{ email }` → one-time reset link (admin only)
- `GET  /reset-info?token=...` → `{ email }`
- `POST /reset-password` — `{ token, newPassword }` → session

### Race file IO
- `POST /commit` — `{ path, content, sha?, message }` + `Authorization: Bearer <jwt>` (writer ACL enforced)
- `GET  /get?path=...[&t=<share-token>]` — read a file (reader ACL enforced; share-token optional)

### Access management (creator/editor only)
- `POST /invite` — `{ slug, email, role: 'editor'|'viewer' }` → `{ url, token, expiresAt }`
- `POST /share-link` — `{ slug, role: 'view', expiresInDays? }` → `{ url, token, expiresAt }`
- `POST /access/add` — `{ slug, email, role }` (assumes account already exists)
- `POST /access/remove` — `{ slug, email }`
- `POST /share/revoke` — `{ token }` (revokes invite OR share link by token)
- `GET  /access?slug=...` → `{ editors, viewers, shareLinks, pendingInvites }`

### Listing
- `GET /my-races` → public races + private races the caller can access

### Misc
- `GET /health` → `{ ok: true, kv: <bool> }`

Session tokens are HS256 JWTs valid for 7 days.

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

# User list — generate hashes with admin/hash.html (open the file in a
# browser, type an email + password, copy the JSON it produces, paste
# here). Wrap multiple users in a JSON array. The email field is the
# login identifier; the legacy "username" field is still accepted for
# back-compat, e.g.
#   [{"email":"jason@example.com","hash":"...","salt":"...","iterations":100000,"role":"admin"},
#    {"email":"crew1@example.com","hash":"...","salt":"...","iterations":100000}]
npx wrangler secret put USERS
```

Edit `wrangler.toml` to set `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH`
to your hub repo. Set `ALLOWED_ORIGINS` to your Pages URL (e.g.
`https://jpdupree.github.io`) for production; `"*"` is fine for testing.
Set `PUBLIC_BASE_URL` to the same URL so generated invite/share links
point at your hub.

### Optional: KV for invites + share links

Invite tokens, share-link tokens, and dynamically-created (invite-accepted)
user accounts live in a KV namespace called `AUTH_KV`. Without it the
worker still runs — `/login`, `/commit`, `/get`, `/access/*`, and
`/my-races` all work — but `/invite`, `/accept-invite`, and `/share-link`
return 503.

Create the namespace and bind it:

```bash
npx wrangler kv namespace create AUTH_KV
# paste the returned id into wrangler.toml under [[kv_namespaces]]
```

Then deploy:

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

All pages auto-detect this and switch from the PAT form to an email/password
login form. If `hub.json` is missing or `auth.proxyUrl` is unset, the pages
fall back to direct PAT mode — so the worker can go down without bricking
race day, as long as someone has a PAT.

## Adding / removing users

Two ways:

1. **Admin-managed** — re-run `npx wrangler secret put USERS` with the
   updated JSON list. No redeploy needed. Use this for the hub admin's own
   account and anyone you trust enough to bake in at deploy time.
2. **Invite-driven** — from any race page where you're an editor, expand
   "Manage access", enter the invitee's email, and click "Generate invite
   link". Send them the link (text/Signal/email — your call). They open
   it, set a password, and are added to the race. Their account is stored
   in the `AUTH_KV` namespace, not in `USERS`.

## Password management

- **Change password** — any signed-in user can change their own password
  from the "Password" button in the account bar. The new hash is written
  to `AUTH_KV` (and `lookupUser` checks KV before `USERS`, so this works
  even for accounts seeded via the `USERS` env var).
- **Forgot password** — there's no email service, so resets are
  admin-issued. An **admin** opens `admin.html`, enters the locked-out
  user's email, and gets a one-time reset link (valid 2 days) to hand
  over. The user opens it on `reset.html`, sets a new password, and is
  signed in.

  "Admin" means a user whose `USERS` entry (or KV record) has
  `"role": "admin"`. Generate that hash with `admin/hash.html` — pick
  **admin** in the role dropdown — and `wrangler secret put USERS`. The
  account bar shows an **Admin** link only for admin users.

## Visibility & access model

Each race carries `visibility: 'public' | 'private'` plus `createdBy`,
`editors[]`, and `viewers[]` (emails) in its `config.json`.

- **Public race** — appears in `races/index.json` (the public manifest);
  anyone with the hub URL can view; only listed editors can write.
- **Private race** — omitted from the public manifest; slug gets a random
  suffix to make URL-guessing impractical; the worker's `/my-races`
  endpoint lists it for users who are in `editors` or `viewers`. Reads
  by listed viewers + share-link viewers go through the worker's `/get`
  endpoint (which enforces the ACL).

**v1 storage limitation.** Private race files still live in the public
hub repo. The worker enforces ACLs on writes and on its read endpoint,
but anyone who knows the exact URL of a private race's `config.json` or
`data.json` could fetch it directly from GitHub Pages. The slug
randomization makes guessing impractical, but it's obscurity, not real
encryption. When you move this stack to a fully Cloudflare-hosted backend
(KV/D1 for race data), private races become unreadable without worker
mediation.

## Roles (future)

The worker reads a `role` field per user (default `crew`). For v1, any
authenticated user can write under `races/` they're an editor on. To gate
specific paths by role, edit the handlers in `src/worker.js`.

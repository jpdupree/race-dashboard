# race-dashboard

A static, multi-race dashboard hub for ultra crew. Each race gets a live
dashboard, charts, printable report, and a phone-friendly pit board.
No server, no backend — every race is just a folder of files in this
repo, edited live via the GitHub Contents API.

## Pages

- `index.html` — hub landing. Lists every race from `races/index.json`.
- `setup.html` — wizard. Asks for race name, runner(s), course type
  (loops vs. point-to-point segments), aid stations, cutoffs, intake
  targets, and a GPX file, then commits `races/<slug>/config.json`,
  `races/<slug>/data.json`, optional `races/<slug>/course.gpx`, and
  updates `races/index.json`.
- `race.html?id=<slug>` — live dashboard for one race, including a
  course map (Leaflet + OpenStreetMap) when a `course.gpx` is present.
- `pit.html?id=<slug>` — sign in/out, intake editing, aid-station editing.
- `charts.html?id=<slug>` — leg times, pace, aid times, intake, cumulative.
- `print-report.html?id=<slug>` — printable summary.

## Course types

Two course shapes are supported from day one and share the same data
schema. Each "leg" has a `startTime` (left the previous aid/pit) and
`endTime` (arrived at the next).

- **Loops** — N identical laps from one pit. Config:
  `course: { loopCount, loopDistanceMi, loopElevationGainFt? }`.
  A loop may optionally carry `loopSegments` — the aid-to-aid segments of
  one lap (same shape as `segments` below). When present, the loop is
  treated as that segment pattern repeated `loopCount` times, so each lap
  is split into timed checkpoints; total legs = `loopCount × loopSegments.length`.
- **Segments** — Point-to-point legs between named aid stations. Config:
  `course: { segments: [{ name, fromAid, toAid, distanceMi,
  elevationGainFt?, elevationLossFt?, arriveCutoffHours? }] }`.

In the wizard, the segments course type collects aid stations as
`{ name, mileage, arriveCutoffHours? }`, and saves them as `segments[]`
derived from consecutive aid pairs. Per-segment elevation gain/loss is
computed from the uploaded GPX. Aid stations can be edited later from
the pit board.

## Use this template

This repo is a GitHub Template. To get your own hub:

1. Click **Use this template → Create a new repository** at
   <https://github.com/jpdupree/race-dashboard>.
2. Enable GitHub Pages on the new repo: **Settings → Pages → Build and
   deployment → Source: Deploy from a branch → main / `/` (root)**.
3. Visit `https://<your-handle>.github.io/<your-repo>/`. You'll land
   on the empty hub.
4. Click **Set up a race**. The wizard will ask for a fine-grained PAT
   the first time — generate one at
   <https://github.com/settings/personal-access-tokens/new> with
   **Repository access → Only this repo** and
   **Repository permissions → Contents: Read and write**. The token is
   stored in your device's localStorage and is shared by every race in
   the hub. Revoke it when you're done with the race.

## Auth modes

The hub supports two ways to authenticate writes:

- **Direct PAT** (default). Each device pastes its own fine-grained
  GitHub token. Static, no backend. Fine for one or two operators who
  are comfortable with PATs. There is no per-race access control — any
  PAT-bearer can write any file in the repo.
- **Login proxy** (optional). A tiny Cloudflare Worker holds the PAT
  on the server side; crew members sign in with email + password and
  the worker commits on their behalf. Each race has its own editors
  and viewers list. Crew never sees a token.

To enable the login proxy, deploy `worker/` to Cloudflare (see
[`worker/README.md`](worker/README.md)) and set `auth.proxyUrl` in
`hub.json` at the repo root to the worker's URL. With `proxyUrl` unset
or `null`, the hub falls back to direct PAT mode — so the proxy can be
down without bricking race day, as long as an operator has a PAT.

Generate password hashes for the worker's `USERS` secret with
[`admin/hash.html`](admin/hash.html) (opens in any browser, runs
PBKDF2-SHA256 locally — passwords never leave the device).

## Race visibility & access (proxy mode)

When the login proxy is enabled, each race is created with a visibility
and an ACL:

- **Public race** — appears on the hub landing page; anyone can view the
  live dashboard without an account. Only listed editors can write.
- **Private race** — omitted from the public manifest; the slug gets a
  random suffix so the URL can't be guessed. Editors and listed viewers
  see it on their hub landing when signed in.

From the race page, the creator (and any editor) can:

- **Invite by email** — generates a one-time signup link; the recipient
  sets a password and is added with editor or viewer access. You hand
  off the link via Signal/text/email yourself; the worker doesn't send
  email.
- **Add an existing account** — gives an already-signed-up email
  editor/viewer access without a signup flow.
- **Generate a view share link** — any anonymous viewer with the link
  can watch the live dashboard for up to 30 days. Revoke any time.

**v1 limitation:** Private race files still live in this public repo.
The worker enforces ACLs on writes and on `/get` reads, but anyone with
the exact direct URL of a private race's `config.json` or `data.json`
could fetch it from GitHub Pages. The slug randomization makes this
impractical to guess, but it's obscurity, not encryption. The plan is
to move private race storage out of the public repo in a future
iteration.

## Layout

```
/
  index.html              hub landing
  setup.html              new-race wizard
  race.html               per-race dashboard (?id=<slug>)
  pit.html                per-race pit board
  charts.html             per-race charts
  print-report.html       per-race printable
  hub.json                optional hub-wide config (login proxy URL)
  lib/
    race-core.js          shared helpers (compute, GitHub API, GPX, format, auth)
    race-theme.css        shared design tokens + base styles
  signup.html             invite-acceptance landing page (proxy mode only)
  reset.html              password-reset landing page (proxy mode only)
  admin.html              hub admin tools — issue password-reset links
  admin/
    hash.html             local PBKDF2 password hasher for the proxy USERS list
  worker/
    src/worker.js         Cloudflare Worker auth proxy (optional)
    wrangler.toml         worker config
    README.md             worker deploy instructions
  races/
    index.json            hub manifest — { races: [...] }
    <slug>/
      config.json         race definition (course, runners, cutoffs, targets)
      data.json           live state — { runners: [{ id, legs: [...] }] }
      course.gpx          optional course file
```

## Schemas

### `races/index.json`

```jsonc
{
  "races": [
    {
      "slug": "sangre-de-cristo-100-2026",
      "name": "Sangre de Cristo 100",
      "location": "Westcliffe, CO",
      "startTime": "2026-07-19T04:00:00-06:00",
      "courseType": "segments",
      "totalDistanceMi": 101.3,
      "runnerNames": ["Jason"],
      "cutoffHours": 36,
      "createdBy": "jason@example.com"
    }
  ],
  "lastUpdated": "2026-05-15T12:00:00Z"
}
```

### `races/<slug>/config.json` (loops)

```jsonc
{
  "name": "Bloodroot 100",
  "location": "Pittsfield, VT",
  "startTime": "2026-05-08T07:00:00-04:00",
  "courseType": "loops",
  "visibility": "public",
  "createdBy": "jason@example.com",
  "editors": ["jason@example.com"],
  "viewers": [],
  "cutoffs": { "totalHours": 38, "lastLegStartHours": 35 },
  "course": {
    "loopCount": 10,
    "loopDistanceMi": 10,
    "loopElevationGainFt": 1900
  },
  "runners": [
    { "id": "jasmine", "name": "Jasmine", "bib": "Jasmine · #1", "color": "#c44a18" }
  ],
  "targets": { "caloriesPerHour": 250, "fluidOzPerHour": 20, "sodiumMgPerHour": 500 }
}
```

`visibility`, `createdBy`, `editors`, and `viewers` are only meaningful
when the login proxy is enabled. In direct PAT mode they're written but
ignored — any PAT-bearer can read or write any file.

### `races/<slug>/config.json` (segments)

```jsonc
{
  "name": "Sangre de Cristo 100",
  "location": "Westcliffe, CO",
  "startTime": "2026-09-26T05:00:00-06:00",
  "courseType": "segments",
  "cutoffs": { "totalHours": 36 },
  "course": {
    "segments": [
      {
        "name": "Start → Music Pass",
        "fromAid": "Start", "toAid": "Music Pass",
        "distanceMi": 7.2,
        "elevationGainFt": 2400, "elevationLossFt": 100,
        "arriveCutoffHours": 3.0
      }
    ]
  },
  "runners": [ /* same shape */ ],
  "targets":  { /* same shape */ }
}
```

### `races/<slug>/data.json`

```jsonc
{
  "lastUpdated": "2026-05-09T22:35:00Z",
  "runners": [
    {
      "id": "jasmine",
      "legs": [
        {
          "index": 1,
          "startTime": "2026-05-08T07:00:00-04:00",
          "endTime":   "2026-05-08T13:30:57Z",
          "calories": 800, "fluidOz": 30, "sodiumMg": 1356,
          "gearChanges": "...", "meds": "...", "issues": "...", "notes": "..."
        }
      ]
    }
  ]
}
```

`legs[].index` is 1-based and references either the loop number (loops
mode) or the position in `config.course.segments` (segments mode).
Aid-station / pit time between legs is derived as
`legs[n].startTime - legs[n-1].endTime`.

## Background

This started as crew tooling for a single race
([BloodRoot](https://github.com/jpdupree/BloodRoot), a 100-mile loop
event), then needed point-to-point support for the Sangre de Cristo
100. The hub generalizes both into one template anyone can fork and
add their own races to.

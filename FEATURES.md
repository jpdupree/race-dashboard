# Race Dashboard — Feature List

An ultra-running crew dashboard hub: a static GitHub Pages site with an
optional Cloudflare Worker auth proxy.

## Race tracking
- Live race dashboard (`race.html`) — per-runner progress, pace, cutoffs, predicted finish
- Pit/leg logging (`pit.html`) — leg start/end times, calories, fluid, sodium, gear changes, meds, issues, notes
- Worker-routed reads for signed-in crew to avoid GitHub Pages publish lag
- Predicted mileage / position for runners on course or in a pit

## Course types
- Point-to-point segments, multi-loop courses, and loops-with-aid-segments
- GPX course upload with elevation profile and interactive aid-station markers
- Cutoff tracking (total time, last-leg start)

## Charts (`charts.html` and the print report)
- Leg time per leg
- Mile pace per leg
- Aid-station time per stop
- Intake per hour — calories / fluid / sodium, with target lines
- Cumulative progress with a pace-based projected-finish ray and cutoff line

## Reporting
- Printable race report (`print-report.html`) — cutoffs, per-runner leg tables, course elevation, and all charts, print-styled

## Race setup & config (`setup.html`)
- Create and configure races; define runners, targets, cutoffs
- Per-race ACL: visibility, editors, viewers

## Accounts & auth (Cloudflare Worker proxy)
- JWT sessions (7-day), PBKDF2 password hashing
- Hub account invites and per-race invites (`signup.html`)
- Password reset flow (`reset.html`)
- Direct PAT mode as an alternative to the worker

## Admin panel (`admin.html`)
- Account list with per-account race roles (editor/viewer)
- Send account invites and password-reset links
- Remove accounts

## Hub
- Race list home page (`index.html`); auto-tags races as done when complete
- Share links for read-only access

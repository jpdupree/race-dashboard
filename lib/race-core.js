// Shared helpers for the race-dashboard hub.
// Exposes window.Race — see the expose block at the bottom of this file.

(function () {
  'use strict';

  // ---------- formatters ----------
  const fmt = {
    duration(seconds) {
      if (seconds == null || isNaN(seconds) || seconds < 0) return '—';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      const pad = n => String(n).padStart(2, '0');
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    },
    durationShort(seconds) {
      // Drops leading 00: for sub-hour values.
      return fmt.duration(seconds).replace(/^00:/, '');
    },
    pace(secondsPerMile) {
      if (secondsPerMile == null || isNaN(secondsPerMile)) return '—';
      const m = Math.floor(secondsPerMile / 60);
      const s = Math.floor(secondsPerMile % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    clockTime(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    },
    clockTimeSec(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    },
    dateRange(startIso, endIso) {
      if (!startIso) return '—';
      const s = new Date(startIso);
      const opts = { month: 'short', day: 'numeric' };
      if (!endIso) return s.toLocaleDateString([], opts);
      const e = new Date(endIso);
      const sameDay = s.toDateString() === e.toDateString();
      if (sameDay) return s.toLocaleDateString([], opts);
      return `${s.toLocaleDateString([], opts)} – ${e.toLocaleDateString([], opts)}`;
    },
    hoursToHm(hours) {
      if (hours == null || isNaN(hours)) return '—';
      const h = Math.floor(hours);
      const m = Math.round((hours - h) * 60);
      return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
  };

  // ---------- slug ----------
  function slug(s) {
    return (s || '')
      .toString().toLowerCase().trim()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'race';
  }

  // ---------- query string ----------
  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  // ---------- hub config (hub.json) ----------
  // hub.json at repo root carries optional auth.proxyUrl. When set,
  // writes go through the worker; otherwise pages use direct PAT mode.
  const hub = {
    _data: null,
    _promise: null,
    async load() {
      if (this._data) return this._data;
      if (this._promise) return this._promise;
      this._promise = (async () => {
        try {
          const res = await fetch('hub.json?_=' + Date.now(), { cache: 'no-store' });
          this._data = res.ok ? await res.json() : {};
        } catch (e) { this._data = {}; }
        return this._data;
      })();
      return this._promise;
    },
    // Synchronous getter — only valid after load() has resolved at least once.
    proxyUrl() { return this._data?.auth?.proxyUrl || null; },
    isProxyMode() { return !!this.proxyUrl(); }
  };

  // ---------- config / session storage ----------
  // Two storage shapes live side-by-side:
  //   direct mode:  race-hub-config-v1  = { token, owner, repo, branch }
  //   proxy mode:   race-hub-session-v1 = { proxyUrl, session, email, role, expiresAt }
  // Only the one matching the active mode is consulted.
  const CONFIG_KEY  = 'race-hub-config-v1';
  const SESSION_KEY = 'race-hub-session-v1';
  // sessionStorage key for a share-token captured from race.html?t=<token>.
  // Lives only for the current tab; not persisted.
  const SHARE_TOKEN_KEY = 'race-hub-share-token-v1';

  const config = {
    load() {
      try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null; }
      catch (e) { return null; }
    },
    save(c) { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); },
    clear() { localStorage.removeItem(CONFIG_KEY); },
    has() {
      const c = config.load();
      return !!(c && c.token && c.owner && c.repo && c.branch);
    },
    detectDefaults() {
      const host = location.hostname;
      let owner = '', repo = '';
      if (host.endsWith('.github.io')) {
        owner = host.split('.')[0];
        const parts = location.pathname.split('/').filter(Boolean);
        if (parts.length && !parts[0].endsWith('.html')) repo = parts[0];
      }
      return { token: '', owner, repo, branch: 'main', marker: '' };
    }
  };

  // Set by mountAccountWidget() once the account bar exists; called by
  // auth.saveSession/clearSession so the bar reflects sign-in/out immediately
  // on any page, without a reload.
  let accountWidgetRender = null;

  const auth = {
    // Returns 'proxy' | 'direct' based on hub.json. Defaults to 'direct'.
    mode() { return hub.isProxyMode() ? 'proxy' : 'direct'; },

    // Session state for proxy mode.
    loadSession() {
      try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; }
      catch (e) { return null; }
    },
    saveSession(s) {
      // Back-compat: prefer email over username.
      const out = { ...s };
      if (!out.email && out.username) out.email = out.username;
      localStorage.setItem(SESSION_KEY, JSON.stringify(out));
      if (accountWidgetRender) accountWidgetRender();
    },
    clearSession() {
      localStorage.removeItem(SESSION_KEY);
      if (accountWidgetRender) accountWidgetRender();
    },

    // Has a usable auth state (PAT or unexpired session) for the current mode?
    has() {
      if (auth.mode() === 'proxy') {
        const s = auth.loadSession();
        return !!(s && s.session && s.proxyUrl && (!s.expiresAt || s.expiresAt > Date.now() + 60_000));
      }
      return config.has();
    },

    email() {
      if (auth.mode() !== 'proxy') return null;
      const s = auth.loadSession();
      return s ? (s.email || s.username || null) : null;
    },

    // Build the "cfg" object the gh.* functions need. Returns null if not authed.
    cfg() {
      if (auth.mode() === 'proxy') {
        const s = auth.loadSession();
        if (!s) return null;
        return {
          mode: 'proxy', proxyUrl: s.proxyUrl, session: s.session,
          email: s.email || s.username, username: s.email || s.username
        };
      }
      const c = config.load();
      if (!c) return null;
      return { mode: 'direct', token: c.token, owner: c.owner, repo: c.repo, branch: c.branch };
    },

    async login(email, password) {
      const proxyUrl = hub.proxyUrl();
      if (!proxyUrl) throw new Error('Proxy not configured in hub.json');
      const res = await fetch(proxyUrl.replace(/\/+$/, '') + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) {
        let msg = `Login failed (${res.status})`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      const data = await res.json();
      auth.saveSession({
        proxyUrl: proxyUrl.replace(/\/+$/, ''),
        session: data.token,
        email: data.email || data.username,
        role: data.role,
        expiresAt: data.expiresAt
      });
      return data;
    },

    logout() { auth.clearSession(); }
  };

  // ---------- share-token (anonymous access via ?t=<token>) ----------
  // race.html stashes ?t=<token> in sessionStorage on load so subsequent
  // worker GETs can validate the token. The token is scoped to the URL's slug.
  const share = {
    get() {
      try { return sessionStorage.getItem(SHARE_TOKEN_KEY) || null; }
      catch (e) { return null; }
    },
    set(token) {
      try { sessionStorage.setItem(SHARE_TOKEN_KEY, token); } catch (e) {}
    },
    clear() {
      try { sessionStorage.removeItem(SHARE_TOKEN_KEY); } catch (e) {}
    },
    // Initialize from window.location.search if a ?t=<token> is present.
    captureFromUrl() {
      const t = qs('t');
      if (t) share.set(t);
      return share.get();
    }
  };

  // ---------- proxy API client (invite / share / access / my-races) ----------
  // Wraps fetch calls against the worker for things beyond file IO.
  async function proxyCall(path, opts) {
    const cfg = auth.cfg();
    if (!cfg || cfg.mode !== 'proxy') throw new Error('Sign in required');
    opts = opts || {};
    const res = await fetch(cfg.proxyUrl + path, {
      method: opts.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + cfg.session,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {})
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401) {
      auth.clearSession();
      const err = new Error('Session expired — please sign in again.');
      err.status = 401; throw err;
    }
    let payload = null;
    try { payload = await res.json(); } catch (e) {}
    if (!res.ok) {
      const msg = (payload && payload.error) || `${path} ${res.status}`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return payload;
  }

  const api = {
    myRaces:     ()                          => proxyCall('/my-races'),
    accessList:  (slug)                      => proxyCall('/access?slug=' + encodeURIComponent(slug)),
    accessAdd:   (slug, email, role)         => proxyCall('/access/add',    { method: 'POST', body: { slug, email, role } }),
    accessRemove:(slug, email)               => proxyCall('/access/remove', { method: 'POST', body: { slug, email } }),
    invite:      (slug, email, role)         => proxyCall('/invite',        { method: 'POST', body: { slug, email, role } }),
    shareLink:   (slug, role, opts)          => proxyCall('/share-link',    { method: 'POST', body: { slug, role, ...(opts || {}) } }),
    shareRevoke: (token)                     => proxyCall('/share/revoke',  { method: 'POST', body: { token } }),
    changePassword: (currentPassword, newPassword) => proxyCall('/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
    acceptInvite: async (token, password) => {
      const proxyUrl = hub.proxyUrl();
      if (!proxyUrl) throw new Error('Proxy not configured in hub.json');
      const res = await fetch(proxyUrl.replace(/\/+$/, '') + '/accept-invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password })
      });
      let payload = null;
      try { payload = await res.json(); } catch (e) {}
      if (!res.ok) throw new Error((payload && payload.error) || `accept-invite ${res.status}`);
      auth.saveSession({
        proxyUrl: proxyUrl.replace(/\/+$/, ''),
        session: payload.token,
        email: payload.email,
        role: payload.role,
        expiresAt: payload.expiresAt
      });
      return payload;
    }
  };

  // ---------- GitHub Contents API ----------
  function utf8ToBase64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function base64ToUtf8(b) { return decodeURIComponent(escape(atob(b.replace(/\s/g, '')))); }

  const gh = {
    utf8ToBase64, base64ToUtf8,

    async getFile(cfg, path) {
      if (cfg.mode === 'proxy') {
        const url = `${cfg.proxyUrl}/get?path=${encodeURIComponent(path)}`;
        const headers = cfg.session ? { Authorization: `Bearer ${cfg.session}` } : {};
        const res = await fetch(url, { headers, cache: 'no-store' });
        if (res.status === 404) return { sha: null, content: null, missing: true };
        if (res.status === 401) {
          auth.clearSession();
          const err = new Error('Session expired — please log in again.');
          err.status = 401; throw err;
        }
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`GET ${path} ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status; throw err;
        }
        const j = await res.json();
        // The worker proxies GitHub's response, which includes content (base64) and sha.
        // For files that don't exist, the worker returns the upstream 404.
        return { sha: j.sha, content: base64ToUtf8(j.content), missing: false };
      }
      const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(cfg.branch)}`;
      const res = await fetch(url, {
        headers: { Authorization: `token ${cfg.token}`, Accept: 'application/vnd.github.v3+json' },
        cache: 'no-store'
      });
      if (res.status === 404) return { sha: null, content: null, missing: true };
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`GET ${path} ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status; throw err;
      }
      const j = await res.json();
      return { sha: j.sha, content: base64ToUtf8(j.content), missing: false };
    },

    async getJson(cfg, path) {
      const r = await gh.getFile(cfg, path);
      if (r.missing) return { sha: null, data: null, missing: true };
      return { sha: r.sha, data: JSON.parse(r.content), missing: false };
    },

    async putFile(cfg, path, body, sha, message) {
      if (cfg.mode === 'proxy') {
        // The worker accepts a UTF-8 string content; for binary (already-base64) bodies
        // we decode back to UTF-8 isn't safe, so the wizard's GPX upload stays direct.
        // Here we accept strings; a future worker rev can accept base64 directly.
        if (typeof body !== 'string') {
          throw new Error('Proxy mode currently supports text content only.');
        }
        const res = await fetch(`${cfg.proxyUrl}/commit`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.session}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ path, content: body, sha: sha || null, message })
        });
        if (res.status === 401) {
          auth.clearSession();
          const err = new Error('Session expired — please log in again.');
          err.status = 401; throw err;
        }
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`PUT ${path} ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status; throw err;
        }
        return res.json();
      }
      const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURI(path)}`;
      const payload = {
        message, branch: cfg.branch,
        content: typeof body === 'string'
          ? utf8ToBase64(body)
          : body  // already base64-encoded (used for binary like GPX)
      };
      if (sha) payload.sha = sha;
      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `token ${cfg.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`PUT ${path} ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status; throw err;
      }
      return res.json();
    },

    async putJson(cfg, path, data, sha, message) {
      return gh.putFile(cfg, path, JSON.stringify(data, null, 2) + '\n', sha, message);
    },

    // Mutate JSON at `path` with optimistic concurrency: GET → mutate(data) → PUT,
    // retrying up to `tries` times on 409.
    async mutateJson(cfg, path, mutate, message, tries) {
      tries = tries || 4;
      let lastErr = null;
      for (let i = 0; i < tries; i++) {
        const r = await gh.getJson(cfg, path);
        const data = r.data || {};
        const next = mutate(data) || data;
        try {
          return await gh.putJson(cfg, path, next, r.sha, message);
        } catch (err) {
          lastErr = err;
          if (err.status !== 409) throw err;
        }
      }
      throw lastErr || new Error('Too many sha conflicts');
    }
  };

  // ---------- course helpers (loops vs. segments) ----------
  // Both course types expose a uniform per-leg accessor so render code
  // doesn't have to branch.
  //
  // A loop course may carry course.loopSegments — the aid-to-aid segments
  // of ONE lap. When present, the loop is modelled as that segment pattern
  // repeated loopCount times: total legs = loopCount × loopSegments.length.
  // When absent (or empty), each lap is a single leg, exactly as before.
  const course = {
    type(cfg) { return cfg && cfg.courseType; },

    // Per-lap segment list for a loop course ([] for a simple lap-only loop).
    loopSegments(cfg) {
      return (cfg && cfg.course && cfg.course.loopSegments) || [];
    },
    // Legs per lap: number of loop segments, or 1 for a simple loop.
    legsPerLoop(cfg) {
      return course.loopSegments(cfg).length || 1;
    },
    // Distance of one lap — sum of loop segments if present, else loopDistanceMi.
    loopDistance(cfg) {
      const segs = course.loopSegments(cfg);
      if (segs.length) return segs.reduce((a, s) => a + (s.distanceMi || 0), 0);
      return (cfg && cfg.course && cfg.course.loopDistanceMi) || 0;
    },

    legCount(cfg) {
      if (!cfg) return 0;
      if (cfg.courseType === 'loops') {
        return (cfg.course?.loopCount || 0) * course.legsPerLoop(cfg);
      }
      if (cfg.courseType === 'segments') return (cfg.course?.segments || []).length;
      return 0;
    },

    // Returns the leg definition for a 1-based index, normalized:
    // { index, name, fromAid?, toAid?, distanceMi, elevationGainFt?,
    //   elevationLossFt?, arriveCutoffHours?, cumulativeMi, lap?, segInLap? }
    legAt(cfg, index1) {
      const i = index1 - 1;
      if (!cfg || i < 0) return null;
      if (cfg.courseType === 'loops') {
        const c = cfg.course || {};
        const segs = course.loopSegments(cfg);
        const per = course.legsPerLoop(cfg);
        const total = (c.loopCount || 0) * per;
        if (index1 > total) return null;
        const lap = Math.floor(i / per) + 1;
        const segInLap = i % per;
        const isLastOfRace = index1 === total;
        if (segs.length) {
          const s = segs[segInLap];
          const loopDist = course.loopDistance(cfg);
          let cumInLap = 0;
          for (let k = 0; k <= segInLap; k++) cumInLap += (segs[k]?.distanceMi || 0);
          return {
            index: index1,
            name: `Lap ${lap} · ${s.name || `${s.fromAid || '?'} → ${s.toAid || '?'}`}`,
            fromAid: s.fromAid,
            toAid: s.toAid,
            distanceMi: s.distanceMi || 0,
            elevationGainFt: s.elevationGainFt ?? null,
            elevationLossFt: s.elevationLossFt ?? null,
            arriveCutoffHours: isLastOfRace ? (cfg.cutoffs?.totalHours || null) : null,
            cumulativeMi: +((lap - 1) * loopDist + cumInLap).toFixed(2),
            lap, segInLap
          };
        }
        return {
          index: index1,
          name: `Lap ${lap}`,
          distanceMi: c.loopDistanceMi || 0,
          elevationGainFt: c.loopElevationGainFt || null,
          elevationLossFt: c.loopElevationGainFt || null, // loop ends where it starts
          arriveCutoffHours: isLastOfRace ? (cfg.cutoffs?.totalHours || null) : null,
          cumulativeMi: lap * (c.loopDistanceMi || 0),
          lap, segInLap: 0
        };
      }
      if (cfg.courseType === 'segments') {
        const segs = cfg.course?.segments || [];
        const s = segs[i];
        if (!s) return null;
        let cum = 0;
        for (let k = 0; k <= i; k++) cum += (segs[k]?.distanceMi || 0);
        return {
          index: index1,
          name: s.name || `${s.fromAid || '?'} → ${s.toAid || '?'}`,
          fromAid: s.fromAid,
          toAid: s.toAid,
          distanceMi: s.distanceMi || 0,
          elevationGainFt: s.elevationGainFt ?? null,
          elevationLossFt: s.elevationLossFt ?? null,
          arriveCutoffHours: s.arriveCutoffHours ?? null,
          cumulativeMi: cum
        };
      }
      return null;
    },

    legs(cfg) {
      const n = course.legCount(cfg);
      const out = [];
      for (let i = 1; i <= n; i++) out.push(course.legAt(cfg, i));
      return out;
    },

    totalDistanceMi(cfg) {
      if (!cfg) return 0;
      if (cfg.courseType === 'loops') {
        return (cfg.course?.loopCount || 0) * course.loopDistance(cfg);
      }
      if (cfg.courseType === 'segments') {
        return (cfg.course?.segments || []).reduce((a, s) => a + (s.distanceMi || 0), 0);
      }
      return 0;
    },

    // Derive [{name, mileage}] aid stations from consecutive fromAid/toAid
    // pairs. For segments this is the whole course; for loops it's one lap.
    aidStations(cfg) {
      if (!cfg) return [];
      let segs = [];
      if (cfg.courseType === 'segments') segs = cfg.course?.segments || [];
      else if (cfg.courseType === 'loops') segs = course.loopSegments(cfg);
      if (!segs.length) return [];
      const out = [{ name: segs[0].fromAid || 'Start', mileage: 0 }];
      let cum = 0;
      for (const s of segs) {
        cum += (s.distanceMi || 0);
        out.push({ name: s.toAid || `Aid ${out.length}`, mileage: +cum.toFixed(2) });
      }
      return out;
    },

    // Rebuild segments[] from an aid-station list [{name, mileage, arriveCutoffHours?}].
    // The start aid contributes only its name to seg[0].fromAid; downstream aids
    // become toAid for the segment and fromAid for the next.
    segmentsFromAidStations(aids, prevSegments) {
      const out = [];
      for (let i = 0; i < aids.length - 1; i++) {
        const from = aids[i], to = aids[i + 1];
        const dist = +(to.mileage - from.mileage).toFixed(2);
        // Preserve any prior elevation data when aid order is unchanged.
        const prev = (prevSegments && prevSegments[i]) || {};
        const matched = prev.fromAid === from.name && prev.toAid === to.name;
        out.push({
          name: `${from.name} → ${to.name}`,
          fromAid: from.name,
          toAid: to.name,
          distanceMi: dist,
          elevationGainFt: matched ? (prev.elevationGainFt ?? null) : null,
          elevationLossFt: matched ? (prev.elevationLossFt ?? null) : null,
          arriveCutoffHours: to.arriveCutoffHours ?? null
        });
      }
      return out;
    }
  };

  // ---------- compute (runner state, intake, projection) ----------
  const compute = {
    runner(runner, cfg) {
      const legs = (runner.legs || []).slice().sort((a, b) => a.index - b.index);
      const now = new Date();
      const totalLegs = course.legCount(cfg);
      const courseDist = course.totalDistanceMi(cfg);

      const legDurations = [];          // seconds per completed leg, keyed by position in legs
      const legDistances = [];          // miles per completed leg, parallel to legDurations
      const pitDurations = [];          // seconds in aid/pit between consecutive legs
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        if (l.startTime && l.endTime) {
          legDurations.push((new Date(l.endTime) - new Date(l.startTime)) / 1000);
          legDistances.push(course.legAt(cfg, l.index)?.distanceMi || 0);
        }
        const next = legs[i + 1];
        if (l.endTime && next && next.startTime) {
          pitDurations.push((new Date(next.startTime) - new Date(l.endTime)) / 1000);
        }
      }

      const inProgressLeg = legs.find(l => l.startTime && !l.endTime);
      const currentLegSeconds = inProgressLeg
        ? Math.max(0, (now - new Date(inProgressLeg.startTime)) / 1000)
        : 0;
      const lastCompleted = [...legs].reverse().find(l => l.startTime && l.endTime);
      const nextStarted = lastCompleted
        ? legs.some(l => l.startTime && new Date(l.startTime) > new Date(lastCompleted.endTime))
        : false;
      const legsDone = legDurations.length;
      const inPit = !!lastCompleted && !nextStarted && legsDone < totalLegs;
      const currentPitSeconds = inPit
        ? Math.max(0, (now - new Date(lastCompleted.endTime)) / 1000)
        : 0;

      const completedCourseSec = legDurations.reduce((a, b) => a + b, 0);
      const completedPitSec    = pitDurations.reduce((a, b) => a + b, 0);
      const completedRaceSec   = completedCourseSec + completedPitSec;
      const totalCourseSec     = completedCourseSec + currentLegSeconds;
      const totalPitSec        = completedPitSec + currentPitSeconds;
      const raceSec            = totalCourseSec + totalPitSec;

      const milesDone = legDistances.reduce((a, b) => a + b, 0);
      const legHours  = completedCourseSec / 3600;
      const avgLegSec = legDurations.length
        ? completedCourseSec / legDurations.length : null;
      const lastLegSec = legDurations.length
        ? legDurations[legDurations.length - 1] : null;
      const avgPitSec = pitDurations.length
        ? completedPitSec / pitDurations.length : null;
      const lastPitSec = pitDurations.length
        ? pitDurations[pitDurations.length - 1] : null;

      // Pace: total course seconds ÷ total miles done. Honest across uneven legs.
      const paceSecPerMile = milesDone > 0 ? completedCourseSec / milesDone : null;

      // Intake aggregates over completed legs only.
      const completedEntries = legs.filter(l => l.startTime && l.endTime);
      const totalCal    = completedEntries.reduce((a, l) => a + (l.calories || 0), 0);
      const totalFluid  = completedEntries.reduce((a, l) => a + (l.fluidOz || 0), 0);
      const totalSodium = completedEntries.reduce((a, l) => a + (l.sodiumMg || 0), 0);
      const calPerHr    = legHours > 0 ? totalCal / legHours : 0;
      const fluidPerHr  = legHours > 0 ? totalFluid / legHours : 0;
      const sodiumPerHr = legHours > 0 ? totalSodium / legHours : 0;

      // Projection: extrapolate avg leg+pit rate over remaining legs by mileage.
      // For loops this matches the old (avgLap + avgPit) × totalLoops formula;
      // for segments it correctly weights by leg length.
      let projectedFinishSec = null;
      if (legsDone >= totalLegs && totalLegs > 0) {
        projectedFinishSec = completedRaceSec;
      } else if (legsDone > 0 && courseDist > 0) {
        const secPerMile = completedRaceSec / milesDone;
        projectedFinishSec = secPerMile * courseDist;
      }

      const cutoffSec = (cfg.cutoffs?.totalHours || 0) * 3600;
      let status = 'notstarted';
      if (legsDone >= totalLegs && totalLegs > 0) status = 'finished';
      else if (projectedFinishSec != null && cutoffSec > 0) {
        const tightThreshold = cutoffSec * (1 - 0.025);
        if (projectedFinishSec > cutoffSec) status = 'offpace';
        else if (projectedFinishSec > tightThreshold) status = 'tight';
        else status = 'onpace';
      } else if (inProgressLeg) status = 'onpace';

      let liveSince = null, liveLegIndex = null;
      if (inProgressLeg) {
        liveSince = inProgressLeg.startTime;
        liveLegIndex = inProgressLeg.index;
      } else if (inPit && lastCompleted) {
        liveSince = lastCompleted.endTime;
        liveLegIndex = lastCompleted.index;
      }

      return {
        legs, legsDone, totalLegs, milesDone, courseDist,
        raceSec, totalCourseSec, totalPitSec,
        completedRaceSec, completedCourseSec, completedPitSec,
        currentLegSeconds, currentPitSeconds,
        avgLegSec, lastLegSec, avgPitSec, lastPitSec, paceSecPerMile,
        totalCal, totalFluid, totalSodium,
        calPerHr, fluidPerHr, sodiumPerHr,
        legDurations, pitDurations, legDistances,
        status, projectedFinishSec,
        inPit, inProgressLeg: !!inProgressLeg,
        liveSince, liveLegIndex
      };
    },

    // Derives "what should the runner press next" from their legs.
    // For both course types: the leg array's last entry tells us whether
    // they're on course or in aid.
    nextActionFor(runner, cfg) {
      const legs = (runner.legs || []).slice().sort((a, b) => a.index - b.index);
      const totalLegs = course.legCount(cfg);
      if (!legs.length) {
        return { state: 'idle', currentLegIndex: 0, nextAction: 'out', nextLegIndex: 1, lastTs: null };
      }
      let bestTs = null, bestAction = null, bestIdx = null;
      for (const l of legs) {
        if (l.startTime && (!bestTs || new Date(l.startTime) > new Date(bestTs))) {
          bestTs = l.startTime; bestAction = 'out'; bestIdx = l.index;
        }
        if (l.endTime && (!bestTs || new Date(l.endTime) > new Date(bestTs))) {
          bestTs = l.endTime; bestAction = 'in'; bestIdx = l.index;
        }
      }
      if (!bestTs) {
        return { state: 'idle', currentLegIndex: 0, nextAction: 'out', nextLegIndex: 1, lastTs: null };
      }
      if (bestAction === 'out') {
        return { state: 'on-course', currentLegIndex: bestIdx, nextAction: 'in', nextLegIndex: bestIdx, lastTs: bestTs };
      }
      // bestAction === 'in'
      if (bestIdx >= totalLegs) {
        return { state: 'finished', currentLegIndex: bestIdx, nextAction: null, nextLegIndex: null, lastTs: bestTs };
      }
      return { state: 'in-pit', currentLegIndex: bestIdx, nextAction: 'out', nextLegIndex: bestIdx + 1, lastTs: bestTs };
    },

    // Estimates a runner's current cumulative position along the course.
    // idle → 0; finished → full distance; in-pit / at an aid → exact aid
    // mileage; on-course → interpolated along the current leg from average
    // pace (a projection, flagged with est:true — not a GPS fix).
    // Returns { courseMi, state, est }.
    predictedMileage(runner, cfg) {
      const c = compute.runner(runner, cfg);
      const next = compute.nextActionFor(runner, cfg);
      const totalMi = course.totalDistanceMi(cfg);
      if (next.state === 'idle') return { courseMi: 0, state: 'idle', est: false };
      if (next.state === 'finished') return { courseMi: totalMi, state: 'finished', est: false };
      if (next.state === 'in-pit') {
        const def = course.legAt(cfg, next.currentLegIndex);
        return { courseMi: def ? def.cumulativeMi : c.milesDone, state: 'in-pit', est: false };
      }
      const def = course.legAt(cfg, next.currentLegIndex);
      if (!def) return { courseMi: c.milesDone, state: 'on-course', est: true };
      const legStartMi = def.cumulativeMi - def.distanceMi;
      const leg = (runner.legs || []).find(l =>
        l.index === next.currentLegIndex && l.startTime && !l.endTime);
      if (!leg) return { courseMi: legStartMi, state: 'on-course', est: true };
      const elapsed = (Date.now() - new Date(leg.startTime).getTime()) / 1000;
      let frac = 0;
      if (c.paceSecPerMile && def.distanceMi > 0) {
        frac = Math.max(0, Math.min(1, elapsed / (c.paceSecPerMile * def.distanceMi)));
      }
      return { courseMi: legStartMi + frac * def.distanceMi, state: 'on-course', est: true };
    }
  };

  // ---------- GPX ----------
  const gpx = {
    haversine(lat1, lon1, lat2, lon2) {
      const R = 3958.8; // miles
      const toRad = d => d * Math.PI / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat/2)**2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(a));
    },

    // Parse GPX XML into [{lat, lon, ele (meters), dist (miles cum)}].
    parse(xmlText) {
      const xml = new DOMParser().parseFromString(xmlText, 'text/xml');
      if (xml.querySelector('parsererror')) throw new Error('Invalid GPX');
      const trkpts = Array.from(xml.querySelectorAll('trkpt'));
      if (!trkpts.length) throw new Error('GPX has no trkpt points');
      const pts = trkpts.map(p => {
        const eleEl = p.querySelector('ele');
        return {
          lat: parseFloat(p.getAttribute('lat')),
          lon: parseFloat(p.getAttribute('lon')),
          ele: eleEl ? parseFloat(eleEl.textContent) : 0
        };
      });
      pts[0].dist = 0;
      let cum = 0;
      for (let i = 1; i < pts.length; i++) {
        cum += gpx.haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
        pts[i].dist = cum;
      }
      return pts;
    },

    metersToFeet(m) { return m * 3.28084; },

    // Sum positive/negative deltas between cumulative-mileage range [fromMi, toMi].
    elevationBetween(pts, fromMi, toMi) {
      let gainM = 0, lossM = 0;
      let prev = null;
      for (const p of pts) {
        if (p.dist < fromMi) continue;
        if (p.dist > toMi) break;
        if (prev) {
          const dz = p.ele - prev.ele;
          if (dz > 0) gainM += dz; else lossM += -dz;
        }
        prev = p;
      }
      return {
        gainFt: Math.round(gpx.metersToFeet(gainM)),
        lossFt: Math.round(gpx.metersToFeet(lossM))
      };
    },

    totalDistanceMi(pts) { return pts.length ? pts[pts.length - 1].dist : 0; },

    totalElevation(pts) {
      return gpx.elevationBetween(pts, 0, gpx.totalDistanceMi(pts) + 1);
    }
  };

  // ---------- account bar ----------
  // Injects a slim "signed in as <email> · Sign out" strip above header.site
  // on every page. In direct/PAT mode (no proxy) it stays hidden, since there
  // are no accounts. Auto-mounts on DOM ready; also exposed for manual calls.

  // Change-password modal — opened from the account bar.
  function openPasswordModal() {
    let overlay = document.querySelector('.pw-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'pw-modal-overlay';
      overlay.innerHTML =
        '<div class="pw-modal" role="dialog" aria-modal="true">' +
          '<div class="pw-modal-title">Change password</div>' +
          '<label class="pw-field"><span>Current password</span>' +
            '<input type="password" id="pw-current" autocomplete="current-password" /></label>' +
          '<label class="pw-field"><span>New password</span>' +
            '<input type="password" id="pw-new" autocomplete="new-password" /></label>' +
          '<label class="pw-field"><span>Confirm new password</span>' +
            '<input type="password" id="pw-confirm" autocomplete="new-password" /></label>' +
          '<div class="pw-modal-msg" id="pw-msg"></div>' +
          '<div class="pw-modal-actions">' +
            '<button type="button" class="btn" id="pw-cancel">Cancel</button>' +
            '<button type="button" class="btn primary" id="pw-save">Change password</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      const close = () => { overlay.style.display = 'none'; };
      overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      overlay.querySelector('#pw-cancel').addEventListener('click', close);
      overlay.querySelector('#pw-save').addEventListener('click', async () => {
        const cur = overlay.querySelector('#pw-current').value;
        const nw = overlay.querySelector('#pw-new').value;
        const cf = overlay.querySelector('#pw-confirm').value;
        const msg = overlay.querySelector('#pw-msg');
        const setMsg = (text, cls) => { msg.textContent = text; msg.className = 'pw-modal-msg ' + cls; };
        if (!cur || !nw) return setMsg('All fields are required.', 'err');
        if (nw.length < 8) return setMsg('New password must be at least 8 characters.', 'err');
        if (nw !== cf) return setMsg("New passwords don't match.", 'err');
        const saveBtn = overlay.querySelector('#pw-save');
        saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
        try {
          await api.changePassword(cur, nw);
          setMsg('Password changed.', 'ok');
          setTimeout(close, 1200);
        } catch (err) {
          setMsg(err.message || 'Could not change password.', 'err');
        } finally {
          saveBtn.disabled = false; saveBtn.textContent = 'Change password';
        }
      });
    }
    overlay.querySelector('#pw-current').value = '';
    overlay.querySelector('#pw-new').value = '';
    overlay.querySelector('#pw-confirm').value = '';
    overlay.querySelector('#pw-msg').textContent = '';
    overlay.querySelector('#pw-msg').className = 'pw-modal-msg';
    overlay.style.display = 'flex';
    overlay.querySelector('#pw-current').focus();
  }

  function mountAccountWidget() {
    const header = document.querySelector('header.site');
    if (!header || !header.parentNode) return;

    let bar = document.querySelector('.account-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'account-bar';
      header.parentNode.insertBefore(bar, header);
    }

    function render() {
      if (!hub.isProxyMode()) { bar.style.display = 'none'; return; }
      bar.style.display = '';
      const s = auth.loadSession();
      const signedIn = !!(s && s.session && (!s.expiresAt || s.expiresAt > Date.now()));
      if (signedIn) {
        bar.innerHTML =
          '<span class="account-dot"></span>' +
          '<span class="account-email"></span>' +
          '<button type="button" class="account-pw">Password</button>' +
          '<button type="button" class="account-signout">Sign out</button>';
        bar.querySelector('.account-email').textContent = s.email || s.username || 'account';
        bar.querySelector('.account-pw').addEventListener('click', openPasswordModal);
        bar.querySelector('.account-signout').addEventListener('click', () => {
          auth.logout();
          location.reload();
        });
      } else {
        bar.innerHTML = '<a class="account-signin" href="setup.html">Sign in</a>';
      }
    }

    // Let auth.saveSession/clearSession refresh the bar on later sign-in/out.
    accountWidgetRender = render;

    // hub.json may still be loading; render once now and again once it resolves.
    render();
    hub.load().then(render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAccountWidget);
  } else {
    mountAccountWidget();
  }

  // ---------- expose ----------
  window.Race = { fmt, slug, qs, hub, config, auth, share, api, gh, course, compute, gpx, mountAccountWidget };
})();

/* ============================================================
 * db.js — whole-device SNAPSHOT sync for the Patron / Rowan suite.
 *
 * Design (deliberately simple so it can't half-work):
 *   The ENTIRE device's localStorage is stored in ONE Supabase row
 *   as a single JSON blob with a timestamp. Newest timestamp wins.
 *   - On load / focus / realtime event: if the cloud snapshot is newer
 *     than this device's last sync point, adopt it (write every key back
 *     into localStorage) and reload once so pages re-render. Otherwise,
 *     if this device has unpushed edits, push the whole snapshot up.
 *   - On any change: debounced push of the whole snapshot.
 *
 * There is NO per-key reconciliation, NO seed flags, NO merge — the old
 * approach that kept breaking. It syncs the whole device or nothing.
 *
 * Include once per page, AFTER the Supabase library:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="db.js"></script>
 *
 * With no working cloud connection everything falls back to localStorage
 * (this device only) so the app never breaks.
 * ============================================================ */
window.PatronDB = (function () {
  // Keys: a localStorage override (☁ panel) wins; otherwise the baked-in
  // project keys connect every device automatically with no pasting.
  const _ovUrl = (localStorage.getItem('po_supabase_url') || '').trim();
  const _ovKey = (localStorage.getItem('po_supabase_key') || '').trim();

  const BAKED_URL = 'https://abmhilbhbkzsimopyuwq.supabase.co';
  const BAKED_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFibWhpbGJoYmt6c2ltb3B5dXdxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMDY3NjAsImV4cCI6MjA5NTg4Mjc2MH0.ZFW7nxQhNnQmobPvHZaK19dj1ITJZqBKJ1g2GQzwwKM';

  let URL = _ovUrl || BAKED_URL;
  let KEY = _ovKey || BAKED_KEY;
  let ready = false;
  let sb = null;

  const SNAP_KEY = 'patron-device-snapshot'; // the single row holding the device blob
  const TS_KEY = 'po_snapshot_ts';           // ts of the snapshot we're in sync with
  const PH_KEY = 'po_snapshot_hash';         // hash of the data we last synced

  function _connect(u, k) {
    ready = !!(u && k && window.supabase && u.indexOf('PASTE-') !== 0);
    sb = ready ? window.supabase.createClient(u, k) : null;
  }
  _connect(URL, KEY);

  function isCloud() { return ready; }
  function cfgUrl() { return URL || ''; }
  function cfgKey() { return KEY || ''; }

  /* ---- which localStorage keys ride in the snapshot ----
   * Everything EXCEPT this device's connection/bookkeeping settings and
   * per-device preferences. All actual app data rides along. */
  function _skip(k) {
    return !k
      || k.indexOf('po_supabase') === 0
      || k === TS_KEY || k === PH_KEY
      || k === 'patron_theme'                   // theme is a per-device preference
      || k.indexOf('patron_hydrated_') === 0
      || k.indexOf('patron_initreload_') === 0
      || k.indexOf('patron_snapadopt_') === 0;
  }

  /* ---- local read/write API (used by the Progress page etc.) ---- */
  function _local(key) { try { return JSON.parse(localStorage.getItem('patron_db_' + key) || 'null'); } catch (_) { return null; } }
  function _saveLocal(key, v) { try { localStorage.setItem('patron_db_' + key, JSON.stringify(v)); } catch (_) {} }
  async function get(key) { return _local(key); }
  async function set(key, value) { _saveLocal(key, value); _schedulePush(); }
  function subscribe(_key, _cb) { return function () {}; } // adopt-path reloads; shim is enough

  /* ---- progress photos: file -> Supabase Storage, only the URL is kept locally
   * (and therefore rides in the snapshot). ---- */
  async function uploadImage(bucket, path, dataUrl, contentType) {
    if (!sb) return null;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const { error } = await sb.storage.from(bucket).upload(path, blob, { contentType: contentType || 'image/jpeg', upsert: true });
      if (error) return null;
      const { data } = sb.storage.from(bucket).getPublicUrl(path);
      return (data && data.publicUrl) ? data.publicUrl : null;
    } catch (_) { return null; }
  }
  async function deleteImage(bucket, path) {
    if (!sb || !path) return;
    try { await sb.storage.from(bucket).remove([path]); } catch (_) {}
  }

  /* ============================================================
   * SNAPSHOT ENGINE
   * ============================================================ */
  function _gather() {
    const blob = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (_skip(k)) continue;
      const v = localStorage.getItem(k);
      if (v != null) blob[k] = v;
    }
    return blob;
  }
  function _hash(blob) {
    const keys = Object.keys(blob).sort();
    let s = '';
    for (const k of keys) s += k + '' + blob[k] + '';
    return s;
  }
  function _localTs() { const n = parseInt(localStorage.getItem(TS_KEY) || '0', 10); return isNaN(n) ? 0 : n; }
  function _setSynced(ts, hash) {
    try { localStorage.setItem(TS_KEY, String(ts)); localStorage.setItem(PH_KEY, hash); } catch (_) {}
    _lastSyncedHash = hash;
  }

  let _lastSyncedHash = localStorage.getItem(PH_KEY);
  let _pushTimer = null;

  async function _pushNow() {
    if (!sb) return 0;
    const blob = _gather();
    const hash = _hash(blob);
    const ts = Date.now();
    try {
      await sb.from('app_state').upsert(
        { key: SNAP_KEY, data: { blob: blob, ts: ts }, updated_at: new Date(ts).toISOString() },
        { onConflict: 'key' }
      );
      _setSynced(ts, hash);
      return ts;
    } catch (_) { return 0; }
  }
  function _schedulePush() {
    if (!ready) return;
    if (_pushTimer) clearTimeout(_pushTimer);
    _pushTimer = setTimeout(function () { _pushTimer = null; _pushIfChanged(); }, 1200);
  }
  function _pushIfChanged() {
    if (!ready) return;
    if (_hash(_gather()) !== _lastSyncedHash) _pushNow();
  }

  async function _fetchSnapshot() {
    if (!sb) return null;
    try {
      const { data, error } = await sb.from('app_state').select('data').eq('key', SNAP_KEY).maybeSingle();
      if (!error && data && data.data && data.data.blob) return { blob: data.data.blob, ts: data.data.ts || 0 };
    } catch (_) {}
    return null;
  }
  // Write a cloud snapshot's keys into localStorage. Additive/overwrite — never
  // deletes local-only keys, so it can't wipe data the cloud hasn't seen.
  function _adopt(blob) {
    let changed = false;
    for (const k in blob) {
      if (_skip(k)) continue;
      if (localStorage.getItem(k) !== blob[k]) { try { localStorage.setItem(k, blob[k]); changed = true; } catch (_) {} }
    }
    return changed;
  }

  // Newest snapshot wins. cloud newer -> adopt (+reload once). else, if this
  // device has unpushed edits (or the cloud has no snapshot yet) -> push up.
  async function _reconcile(allowReload) {
    if (!ready) return;
    const localTs = _localTs();
    const dirty = (_hash(_gather()) !== _lastSyncedHash); // unpushed local edits?
    const snap = await _fetchSnapshot();

    if (snap && snap.ts > localTs) {
      const changed = _adopt(snap.blob);
      _setSynced(snap.ts, _hash(_gather()));
      if (changed && allowReload) {
        const guard = 'patron_snapadopt_' + snap.ts;
        try {
          if (!sessionStorage.getItem(guard)) { sessionStorage.setItem(guard, '1'); location.reload(); return; }
        } catch (_) { location.reload(); return; }
      }
      return;
    }
    if (!snap || dirty) { await _pushNow(); }
    else if (_lastSyncedHash == null) { _setSynced(localTs, _hash(_gather())); }
  }

  function _startSync() {
    if (!ready) return;
    (async function () {
      await _reconcile(true);
      setInterval(_pushIfChanged, 2500);
      window.addEventListener('storage', _schedulePush);
      function refresh() { if (!document.hidden) _reconcile(true); }
      document.addEventListener('visibilitychange', refresh);
      window.addEventListener('focus', refresh);
      try {
        sb.channel('snap').on('postgres_changes',
          { event: '*', schema: 'public', table: 'app_state', filter: 'key=eq.' + SNAP_KEY },
          function () { _reconcile(true); }).subscribe();
      } catch (_) {}
    })();
  }

  if (ready) { _startSync(); }
  (async function _loadConfig() {
    if (_ovUrl && _ovKey) return;
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (!r.ok) return;
      const cfg = await r.json();
      const u = (cfg && cfg.url || '').trim(), k = (cfg && cfg.key || '').trim();
      if (u && k && !ready) { URL = u; KEY = k; _connect(u, k); _startSync(); }
    } catch (_) {}
  })();

  /* ---- explicit helpers (kept for the ☁ panel / any caller) ---- */
  async function pushAll() { const ts = await _pushNow(); return { ok: !!ts, n: Object.keys(_gather()).length }; }
  async function pullAll() {
    const snap = await _fetchSnapshot();
    if (!snap) return { ok: false, n: 0 };
    _adopt(snap.blob); _setSynced(snap.ts, _hash(_gather()));
    try { sessionStorage.setItem('patron_snapadopt_' + snap.ts, '1'); } catch (_) {}
    return { ok: true, n: Object.keys(snap.blob).length };
  }

  return { isCloud, cfgUrl, cfgKey, get, set, subscribe, uploadImage, deleteImage, pushAll, pullAll };
})();

/* ===================================================================
   KENYA @ 50 — game client
   One page, three roles: HOST (signed-in referee/projector), PLAYER (phone), SPECTATOR.
   All rules live in Supabase (supabase/kenya50/schema.sql). This file only
   draws the state it is given and sends the player's actions.
   =================================================================== */
(function () {
  'use strict';

  const CFG = window.QA_CONFIG || window.QA_BOOTSTRAP || {};

  const BOARD = [
  { pos: 0, col: 0, row: 6, kind: "START", code: "START", label: "START HERE" },
  { pos: 1, col: 0, row: 5, kind: "SPECIAL", code: "HOME", label: "Back home! Collect 50 points after passing START." },
  { pos: 2, col: 0, row: 4, kind: "RED", code: null, label: null },
  { pos: 3, col: 0, row: 3, kind: "JUDICIARY", code: null, label: null },
  { pos: 4, col: 0, row: 2, kind: "BLACK", code: null, label: null },
  { pos: 5, col: 0, row: 1, kind: "RED", code: null, label: null },
  { pos: 6, col: 0, row: 0, kind: "SPECIAL", code: "MARA", label: "Welcome to the Mara! Mauled by lions: go back 3 spaces." },
  { pos: 7, col: 1, row: 0, kind: "RED", code: null, label: null },
  { pos: 8, col: 2, row: 0, kind: "BLACK", code: null, label: null },
  { pos: 9, col: 3, row: 0, kind: "RED", code: null, label: null },
  { pos: 10, col: 4, row: 0, kind: "BLACK", code: null, label: null },
  { pos: 11, col: 5, row: 0, kind: "JUDICIARY", code: null, label: null },
  { pos: 12, col: 6, row: 0, kind: "RED", code: null, label: null },
  { pos: 13, col: 7, row: 0, kind: "BLACK", code: null, label: null },
  { pos: 14, col: 8, row: 0, kind: "RED", code: null, label: null },
  { pos: 15, col: 9, row: 0, kind: "SPECIAL", code: "STEAL", label: "Steal 10 points from any team!" },
  { pos: 16, col: 9, row: 1, kind: "BLACK", code: null, label: null },
  { pos: 17, col: 9, row: 2, kind: "RED", code: null, label: null },
  { pos: 18, col: 9, row: 3, kind: "JUDICIARY", code: null, label: null },
  { pos: 19, col: 9, row: 4, kind: "RED", code: null, label: null },
  { pos: 20, col: 9, row: 5, kind: "BLACK", code: null, label: null },
  { pos: 21, col: 9, row: 6, kind: "SPECIAL", code: "MOMBASA", label: "Mombasa raha! Skip a turn." },
  { pos: 22, col: 8, row: 6, kind: "BLACK", code: null, label: null },
  { pos: 23, col: 7, row: 6, kind: "RED", code: null, label: null },
  { pos: 24, col: 6, row: 6, kind: "SPECIAL", code: "RHINO", label: "Rare find, a rhino! Move 4 steps forward." },
  { pos: 25, col: 6, row: 5, kind: "BLACK", code: null, label: null },
  { pos: 26, col: 6, row: 4, kind: "JUDICIARY", code: null, label: null },
  { pos: 27, col: 6, row: 3, kind: "RED", code: null, label: null },
  { pos: 28, col: 6, row: 2, kind: "SPECIAL", code: "SGR", label: "Take a trip on the SGR. Collect 10 points." },
  { pos: 29, col: 5, row: 2, kind: "BLACK", code: null, label: null },
  { pos: 30, col: 4, row: 2, kind: "RED", code: null, label: null },
  { pos: 31, col: 3, row: 2, kind: "BLACK", code: null, label: null },
  { pos: 32, col: 2, row: 2, kind: "JUDICIARY", code: null, label: null },
  { pos: 33, col: 2, row: 3, kind: "RED", code: null, label: null },
  { pos: 34, col: 2, row: 4, kind: "SPECIAL", code: "GIVE", label: "Give 10 points to any team!" },
  { pos: 35, col: 3, row: 4, kind: "BLACK", code: null, label: null },
  { pos: 36, col: 4, row: 4, kind: "RED", code: null, label: null },
  { pos: 37, col: 4, row: 5, kind: "BLACK", code: null, label: null },
  { pos: 38, col: 4, row: 6, kind: "JUDICIARY", code: null, label: null },
  { pos: 39, col: 3, row: 6, kind: "RED", code: null, label: null },
  { pos: 40, col: 2, row: 6, kind: "BLACK", code: null, label: null },
  { pos: 41, col: 1, row: 6, kind: "RED", code: null, label: null },
];

  const ICONS = ['chess-pawn', 'crown', 'star', 'paw', 'rocket', 'bolt', 'heart', 'shield-halved', 'fire', 'gem', 'leaf', 'sun'];
  const COLORS = ['#1d9bf0', '#8b5cf6', '#ec4899', '#10b981', '#06b6d4', '#f97316', '#facc15', '#a3e635', '#6366f1', '#f8fafc'];
  const TILE_ICON = { START: 'flag-checkered', GIVE: 'hand-holding-dollar', STEAL: 'hand-fist', SGR: 'train', MOMBASA: 'umbrella-beach', MARA: 'paw', HOME: 'house' };
  const SHORT = {
    START: 'START HERE', GIVE: 'Give 10 pts to any team', STEAL: 'Steal 10 pts from any team', SGR: 'SGR trip: +10 pts',
    RHINO: 'Rare find! Forward 4', MOMBASA: 'Mombasa raha: skip a turn', MARA: 'Mara! Lions: back 3', HOME: 'Back home! +50 passing START'
  };
  const EVENT_ICON = {
    card: 'clone', start: 'flag-checkered', judiciary: 'scale-balanced', give: 'hand-holding-dollar', steal: 'hand-fist',
    sgr: 'train', mombasa: 'umbrella-beach', mara: 'paw', home: 'house', round: 'stopwatch', skip: 'forward', tile: 'star', win: 'trophy'
  };

  // ---------- tiny helpers ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };
  function contrast(hex) {
    const n = parseInt(String(hex).slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#111' : '#fff';
  }
  function pin(t, size) {
    return `<span class="k50-pin ${size || ''}" style="background:${esc(t.color)};color:${contrast(t.color)}"><i class="fa-solid fa-${esc(t.icon)}"></i></span>`;
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function getToken() {
    let t = store.get('k50_token');
    if (!t) {
      t = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 't' + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
      store.set('k50_token', t);
    }
    return t;
  }
  function toast(msg, ok) {
    const box = $('#k50-toasts'); if (!box) return;
    const el = document.createElement('div');
    el.className = 'k50-toast' + (ok ? ' ok' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  // ---------- state ----------
  const S = { client: null, user: null, token: getToken(), room: '', snap: null, offset: 0, channel: null, channelFor: '', poll: null, view: 'home' };
  const ui = {
    busy: false, holding: false, pendingRoll: null, dieTimer: null, dieVal: 1,
    displayPos: {}, targetPos: {}, finalPos: {}, mid: {}, midWait: {}, markerTimer: null,
    tick: new Set(), hostTick: new Set(), tickKey: '', editing: false, hostOpen: false, localDone: new Set(),
    joinNick: store.get('k50_nick') || '', joinTeam: '', teamName: '', color: COLORS[0], icon: ICONS[0],
    winScore: 500, muted: false, qrUrl: '', qrFor: '', cdFor: '', endFor: '', confirmDelete: false, lastHtml: ''
  };

  // ===================================================================
  // INIT
  // ===================================================================
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    initTheme();
    const d = $('#live-date');
    if (d) d.textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    bindChrome();

    if (!window.supabase || !CFG.supabaseUrl || !CFG.anonKey) {
      $('#k50-app').innerHTML = '<div class="k50-panel k50-center"><h2>Cannot reach the game server</h2><p class="k50-muted">Check your internet connection and that config.js has the Supabase URL and anon key.</p></div>';
      return;
    }
    S.client = window.supabase.createClient(CFG.supabaseUrl, CFG.anonKey);
    try {
      const { data } = await S.client.auth.getSession();
      S.user = data && data.session ? data.session.user : null;
    } catch (e) { S.user = null; }
    updateAuthUI();
    S.client.auth.onAuthStateChange((_ev, sess) => {
      S.user = sess ? sess.user : null;
      updateAuthUI();
      if (S.view === 'home') renderHome();
    });

    const room = new URLSearchParams(location.search).get('room');
    if (room) openRoom(room); else renderHome();

    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.room) loadSnapshot(); });
    setInterval(timerTick, 200);
  }

  async function rpc(name, args) {
    const { data, error } = await S.client.rpc(name, args || {});
    if (error) throw new Error(error.message || 'Request failed');
    return data;
  }

  // ===================================================================
  // CHROME: theme, sign-in, rules, audio
  // ===================================================================
  function initTheme() {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const saved = store.get('k50_theme');
    applyTheme(saved ? saved === 'light' : mq.matches);
  }
  function applyTheme(light) {
    document.body.classList.toggle('light-mode', light);
    document.body.classList.toggle('dark-mode', !light);
    const i = $('#theme-icon'); if (i) i.className = 'fa-solid ' + (light ? 'fa-sun' : 'fa-moon');
  }
  function bindChrome() {
    $('#theme-toggle').addEventListener('click', () => {
      const light = !document.body.classList.contains('light-mode');
      store.set('k50_theme', light ? 'light' : 'dark'); applyTheme(light);
    });
    $('#k50-rules-btn').addEventListener('click', () => $('#k50-rules').classList.add('open'));
    $('#k50-audio-btn').addEventListener('click', () => {
      ui.muted = !ui.muted;
      $('#k50-audio-btn').innerHTML = `<i class="fa-solid ${ui.muted ? 'fa-volume-xmark' : 'fa-volume-high'}"></i> ${ui.muted ? 'Muted' : 'Audio'}`;
    });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('.k50-overlay').classList.remove('open')));
    document.querySelectorAll('.k50-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); }));
    $('#k50-signin-btn').addEventListener('click', openSignIn);
    $('#k50-signout-btn').addEventListener('click', async () => { await S.client.auth.signOut(); toast('Signed out.', true); });
    $('#k50-signin-send').addEventListener('click', sendMagicLink);
    $('#k50-signin-email').addEventListener('keydown', e => { if (e.key === 'Enter') sendMagicLink(); });
  }
  function updateAuthUI() {
    const inn = !!S.user;
    $('#k50-signin-btn').classList.toggle('k50-hide', inn);
    $('#k50-signout-btn').classList.toggle('k50-hide', !inn);
    const lbl = $('#k50-user-label');
    if (lbl) lbl.textContent = inn ? ((S.user.user_metadata && S.user.user_metadata.full_name) || (S.user.email || 'Signed in').split('@')[0]) : '';
  }
  function openSignIn() { $('#k50-signin-status').textContent = ''; $('#k50-signin').classList.add('open'); setTimeout(() => $('#k50-signin-email').focus(), 50); }
  async function sendMagicLink() {
    const email = $('#k50-signin-email').value.trim(); const st = $('#k50-signin-status');
    if (!email) { st.className = 'k50-status error'; st.textContent = 'Enter your email first.'; return; }
    st.className = 'k50-status'; st.textContent = 'Sending magic link…';
    try {
      const { error } = await S.client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      st.textContent = 'Check your email for a sign-in link, then come back to this page.';
    } catch (e) { st.className = 'k50-status error'; st.textContent = e.message || 'Could not send the link.'; }
  }
  function sfx(file) {
    if (ui.muted || !S.snap || S.snap.role !== 'HOST') return;
    try { const a = new Audio(encodeURI('Music/' + file)); a.volume = 0.7; const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
  }

  // ===================================================================
  // HOME
  // ===================================================================
  function renderHome() {
    S.view = 'home'; S.room = ''; teardown();
    document.body.classList.remove('k50-ingame');
    const last = store.get('k50_room');
    $('#k50-app').innerHTML = `
      <section class="k50-hero">
        <h1>Kenya <span class="at">@</span> 50</h1>
        <p>The team party game: roll, land, and describe Kenyan and African people, places, brands and events to your team in 50 seconds. First team to 500 points wins.</p>
        <div class="k50-flagbar"><i style="background:#000"></i><i style="background:#bb0000"></i><i style="background:#006a4e"></i></div>
      </section>
      <div class="k50-home-grid">
        <div class="k50-panel" id="k50-host-card">
          <h2><i class="fa-solid fa-tv"></i> Host a game</h2>
          <p class="k50-muted">You run the big screen and keep things fair. Players join from their own phones.</p>
          ${S.user ? `
            <label class="k50-label">Points to win</label>
            <select id="k50-winscore" class="k50-input">${[300, 500, 700, 1000].map(n => `<option value="${n}" ${n === ui.winScore ? 'selected' : ''}>${n} points</option>`).join('')}</select>
            <button class="k50-btn green block" style="margin-top:.8rem" id="k50-create"><i class="fa-solid fa-plus"></i> Create new game</button>
            <h3>Your recent games</h3><div class="k50-gamelist" id="k50-mygames"><span class="k50-muted">Loading…</span></div>
          ` : `
            <button class="k50-btn block" style="margin-top:.8rem" id="k50-home-signin"><i class="fa-solid fa-right-to-bracket"></i> Sign in to host</button>
            <p class="k50-muted" style="margin-top:.6rem">We email you a magic link. No password needed.</p>`}
        </div>
        <div class="k50-panel">
          <h2><i class="fa-solid fa-mobile-screen"></i> Join a game</h2>
          <p class="k50-muted">Enter the 5-letter room code shown on the host's screen, or scan the QR code.</p>
          <label class="k50-label">Room code</label>
          <input id="k50-joincode" class="k50-input k50-code-input" maxlength="5" placeholder="ABCDE" autocomplete="off" autocapitalize="characters">
          <button class="k50-btn block" style="margin-top:.8rem" id="k50-join-go"><i class="fa-solid fa-arrow-right"></i> Join</button>
          ${last ? `<button class="k50-btn ghost block small" style="margin-top:.6rem" id="k50-resume">Resume game ${esc(last)}</button>` : ''}
          <button class="k50-btn ghost block small" style="margin-top:.6rem" id="k50-home-rules"><i class="fa-solid fa-book"></i> How to play</button>
        </div>
      </div>`;
    const go = () => openRoom($('#k50-joincode').value);
    $('#k50-join-go').addEventListener('click', go);
    $('#k50-joincode').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    $('#k50-home-rules').addEventListener('click', () => $('#k50-rules').classList.add('open'));
    if ($('#k50-resume')) $('#k50-resume').addEventListener('click', () => openRoom(last));
    if ($('#k50-home-signin')) $('#k50-home-signin').addEventListener('click', openSignIn);
    if ($('#k50-create')) {
      $('#k50-winscore').addEventListener('change', e => { ui.winScore = +e.target.value; });
      $('#k50-create').addEventListener('click', async () => {
        const b = $('#k50-create'); b.disabled = true;
        try {
          const r = await rpc('k50_create_game', { p_winning_score: ui.winScore });
          openRoom(r.roomCode);
        } catch (e) { toast(e.message); b.disabled = false; }
      });
      loadMyGames();
    }
  }
  async function loadMyGames() {
    const box = $('#k50-mygames'); if (!box) return;
    try {
      const list = await rpc('k50_my_games');
      if (!box.isConnected) return;
      box.innerHTML = (list && list.length) ? list.map(g => `
        <div class="k50-gamerow"><div><b>${esc(g.roomCode)}</b> <span class="k50-muted">${esc(g.status.replace('_', ' ').toLowerCase())} · ${plural(g.teams, 'team')}</span></div>
        <button class="k50-btn small ghost" data-open="${esc(g.roomCode)}">Open</button></div>`).join('')
        : '<span class="k50-muted">No games yet.</span>';
      box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openRoom(b.dataset.open)));
    } catch (e) { box.innerHTML = '<span class="k50-muted">Could not load your games.</span>'; }
  }

  // ===================================================================
  // ENTERING / LEAVING A GAME
  // ===================================================================
  async function openRoom(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) { toast('Enter the room code.'); return; }
    try {
      const snap = await rpc('k50_snapshot', { p_room: code, p_token: S.token });
      S.room = code; S.snap = null; S.view = 'game';
      Object.assign(ui, { displayPos: {}, targetPos: {}, finalPos: {}, mid: {}, midWait: {}, holding: false, tickKey: '', lastHtml: '', cdFor: '', endFor: '', joinTeam: '', confirmDelete: false });
      store.set('k50_room', code);
      try { history.replaceState(null, '', location.pathname + '?room=' + code); } catch (e) { /* ignore */ }
      buildShell();
      applySnapshot(snap);
      startPolling();
    } catch (e) {
      toast(e.message);
      if (S.view !== 'game') renderHome();
    }
  }
  function leaveGame() {
    teardown(); S.snap = null; S.room = '';
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    renderHome();
  }
  function teardown() {
    if (S.channel) { try { S.client.removeChannel(S.channel); } catch (e) { /* ignore */ } S.channel = null; S.channelFor = ''; }
    clearInterval(S.poll); S.poll = null;
    clearInterval(ui.markerTimer); ui.markerTimer = null;
    clearInterval(ui.dieTimer); ui.dieTimer = null;
  }
  function startPolling() {
    clearInterval(S.poll);
    S.poll = setInterval(() => { if (!document.hidden) loadSnapshot(); }, 4000);
  }
  let loading = false, queued = false;
  async function loadSnapshot() {
    if (!S.room) return;
    if (loading) { queued = true; return; }
    loading = true;
    try { applySnapshot(await rpc('k50_snapshot', { p_room: S.room, p_token: S.token })); }
    catch (e) { if (/not found/i.test(e.message)) { toast('This game no longer exists.'); leaveGame(); } }
    finally { loading = false; if (queued) { queued = false; setTimeout(loadSnapshot, 80); } }
  }
  let deb = null;
  function debouncedLoad() { clearTimeout(deb); deb = setTimeout(loadSnapshot, 90); }
  function subscribe(gameId) {
    if (S.channelFor === gameId) return;
    if (S.channel) { try { S.client.removeChannel(S.channel); } catch (e) { /* ignore */ } }
    S.channelFor = gameId;
    try {
      S.channel = S.client.channel('k50-' + gameId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'k50_pings', filter: 'game_id=eq.' + gameId }, debouncedLoad)
        .subscribe();
    } catch (e) { /* polling still keeps us in sync */ }
  }

  // ===================================================================
  // SNAPSHOT HANDLING
  // ===================================================================
  function applySnapshot(snap) {
    if (!snap || !snap.game) return;
    const prev = S.snap;
    S.offset = new Date(snap.serverTime).getTime() - Date.now();
    S.snap = snap;
    const g = snap.game;
    subscribe(g.id);

    if (g.status === 'CARD_PREP') ui.localDone = new Set();
    if (g.status === 'LOBBY' || (prev && prev.game.status === 'FINISHED' && g.status !== 'FINISHED')) { ui.confirmDelete = false; }

    if (prev && g.rollSeq > prev.game.rollSeq && g.lastRoll) startHold(prev, snap);
    else if (!ui.holding) syncTargets();

    if (g.status === 'FINISHED' && (!prev || prev.game.status !== 'FINISHED')) celebrate();
    if (prev && prev.game.status === 'ROUND_ACTIVE' && g.status === 'REVIEW') { try { navigator.vibrate && navigator.vibrate(250); } catch (e) { /* ignore */ } }
    renderAll();
  }

  function celebrate() {
    sfx('Kahoot podium animation.mp3');
    if (window.confetti) {
      const shoot = () => window.confetti({ particleCount: 140, spread: 90, origin: { y: 0.6 }, colors: ['#bb0000', '#006a4e', '#ffffff', '#000000', '#f4c542'] });
      shoot(); setTimeout(shoot, 600); setTimeout(shoot, 1300);
    }
  }

  // ===================================================================
  // DIE + MARKER ANIMATION
  // ===================================================================
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function dieHtml(v, rolling) {
    const on = PIPS[v] || [];
    return `<div class="k50-die ${rolling ? 'rolling' : ''}" id="k50-die" aria-label="Die showing ${v}">${Array.from({ length: 9 }, (_, i) => `<i class="${on.includes(i) ? 'on' : ''}"></i>`).join('')}</div>`;
  }
  function setPips(v) {
    const d = $('#k50-die'); if (!d) return;
    const on = PIPS[v] || [];
    d.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', on.includes(i)));
  }
  function startHold(prev, snap) {
    ui.holding = true;
    ui.dieVal = snap.game.lastRoll;
    const tid = snap.game.currentTeamId;
    const pt = prev.teams.find(t => t.id === tid);
    ui.pendingRoll = pt ? { teamId: tid, from: pt.position, roll: snap.game.lastRoll } : null;
    clearInterval(ui.dieTimer);
    ui.dieTimer = setInterval(() => setPips(1 + Math.floor(Math.random() * 6)), 90);
    sfx('soundreality-pop-sound-423716.mp3');
    setTimeout(releaseHold, 1500);
  }
  function releaseHold() {
    clearInterval(ui.dieTimer); ui.dieTimer = null;
    ui.holding = false;
    const pr = ui.pendingRoll; ui.pendingRoll = null;
    if (pr && S.snap) {
      const t = S.snap.teams.find(x => x.id === pr.teamId);
      if (t) {
        const N = BOARD.length, mid = (pr.from + pr.roll) % N;
        if (mid !== t.position) { ui.mid[t.id] = mid; ui.targetPos[t.id] = mid; ui.finalPos[t.id] = t.position; }
      }
    }
    syncTargets(); renderAll();
  }
  function syncTargets() {
    if (!S.snap) return;
    S.snap.teams.forEach(t => {
      if (ui.displayPos[t.id] == null) ui.displayPos[t.id] = t.position;
      ui.finalPos[t.id] = t.position;
      if (ui.mid[t.id] == null) ui.targetPos[t.id] = t.position;
    });
    if (!ui.markerTimer) ui.markerTimer = setInterval(stepMarkers, 240);
  }
  function stepMarkers() {
    if (!S.snap) return;
    let moving = false; const N = BOARD.length;
    S.snap.teams.forEach(t => {
      const d = ui.displayPos[t.id], g = ui.targetPos[t.id];
      if (d == null || g == null) return;
      if (d === g) {
        if (ui.mid[t.id] != null) {
          moving = true;
          if (!ui.midWait[t.id]) ui.midWait[t.id] = Date.now() + 900;
          if (Date.now() >= ui.midWait[t.id]) { ui.targetPos[t.id] = ui.finalPos[t.id]; delete ui.mid[t.id]; delete ui.midWait[t.id]; }
        }
        return;
      }
      moving = true;
      const fwd = (g - d + N) % N, back = (d - g + N) % N;
      ui.displayPos[t.id] = fwd <= 12 ? (d + 1) % N : back <= 6 ? (d - 1 + N) % N : g;
    });
    renderMarkers();
    if (!moving) { clearInterval(ui.markerTimer); ui.markerTimer = null; }
  }

  // ===================================================================
  // THE BOARD (pure CSS)
  // ===================================================================
  function boardHtml() {
    const tiles = BOARD.map(t => {
      const style = `grid-column:${t.col + 1};grid-row:${t.row + 1}`;
      let cls = '', inner = '';
      if (t.kind === 'RED' || t.kind === 'BLACK') {
        cls = t.kind.toLowerCase();
        inner = '<i class="fa-regular fa-clone ico" style="opacity:.28"></i>';
      } else if (t.kind === 'JUDICIARY') {
        cls = 'white jud';
        inner = '<i class="fa-solid fa-scale-balanced ico"></i>';
      } else if (t.kind === 'START') {
        cls = 'start';
        inner = `<span class="lbl">${SHORT.START}</span>`;
      } else {
        cls = t.code === 'HOME' ? 'dark' : 'white';
        const ico = t.code === 'RHINO' ? '<span class="ico emoji">🦏</span>' : `<i class="fa-solid fa-${TILE_ICON[t.code] || 'star'} ico"></i>`;
        inner = ico + `<span class="lbl">${esc(SHORT[t.code] || t.label)}</span>`;
      }
      return `<div class="k50-tile ${cls}" data-pos="${t.pos}" style="${style}" title="${esc(t.label || t.kind)}"><span class="num">${t.pos}</span>${inner}<div class="k50-markers"></div></div>`;
    }).join('');
    const decor = `
      <div class="k50-decor k50-titleblock" style="grid-column:2/7;grid-row:2"><div class="big">KENYA <b>@</b> 50</div><div class="sub">Karibu</div></div>
      <div class="k50-decor sm" style="grid-column:7/10;grid-row:2">🦓🦓🦓</div>
      <div class="k50-decor sm" style="grid-column:2;grid-row:3">🌳</div>
      <div class="k50-decor" style="grid-column:2;grid-row:4">🐘</div>
      <div class="k50-decor" style="grid-column:2;grid-row:5/7">🦒</div>
      <div class="k50-decor sm" style="grid-column:3/5;grid-row:6">🦒🌴</div>
      <div class="k50-decor k50-fifty" style="grid-column:4/7;grid-row:4"><div class="big">50</div><div class="sub">seconds on the clock</div></div>
      <div class="k50-decor sm" style="grid-column:6;grid-row:5/7">🌳</div>
      <div class="k50-decor k50-sgr" style="grid-column:8/10;grid-row:3"><div class="k50-trainrow"><span class="k50-train">🚆</span></div><span class="sign">SGR KENYA</span></div>
      <div class="k50-decor k50-court" style="grid-column:8/10;grid-row:4/6"><i class="fa-solid fa-scale-balanced"></i><span class="t">Supreme Court</span></div>
      <div class="k50-decor sm" style="grid-column:8/10;grid-row:6">🦩</div>
      <div class="k50-decor" style="grid-column:6;grid-row:7">🦏</div>`;
    return `<div class="k50-board" id="k50-board">${decor}${tiles}</div>`;
  }
  function renderMarkers() {
    const s = S.snap; if (!s) return;
    const by = {};
    s.teams.forEach(t => { const p = ui.displayPos[t.id]; if (p != null) (by[p] = by[p] || []).push(t); });
    const cur = s.game.currentTeamId;
    const curPos = cur != null ? ui.displayPos[cur] : null;
    document.querySelectorAll('.k50-tile').forEach(el => {
      const p = +el.dataset.pos, list = by[p] || [], box = el.querySelector('.k50-markers');
      const html = list.map(t => `<div class="k50-marker${t.id === cur && s.game.status !== 'LOBBY' ? ' turn' : ''}" style="background:${esc(t.color)};color:${contrast(t.color)}" title="${esc(t.name)}"><i class="fa-solid fa-${esc(t.icon)}"></i></div>`).join('');
      if (box.dataset.h !== html) { box.innerHTML = html; box.dataset.h = html; }
      box.classList.toggle('many', list.length > 2);
      el.classList.toggle('here', p === curPos && s.game.status !== 'LOBBY');
    });
  }

  // ===================================================================
  // SHELL + RENDER
  // ===================================================================
  function buildShell() {
    document.body.classList.add('k50-ingame');
    $('#k50-app').innerHTML = `
      <div class="k50-layout">
        <div id="k50-action" class="k50-panel"></div>
        <div id="k50-boardcol"><div class="k50-board-wrap">${boardHtml()}</div></div>
        <div id="k50-score" class="k50-panel"></div>
        <div id="k50-log" class="k50-panel k50-log"></div>
      </div>`;
    const a = $('#k50-action');
    a.addEventListener('click', onActionClick);
    a.addEventListener('input', onActionInput);
    $('#k50-score').addEventListener('click', onActionClick);
    $('#k50-log').addEventListener('click', onActionClick);
    // keep the action panel exactly as tall as the board on desktop (it scrolls inside)
    const bc = $('#k50-boardcol'), mq = window.matchMedia('(max-width: 980px)');
    const sync = () => { a.style.height = mq.matches ? '' : bc.offsetHeight + 'px'; };
    sync();
    if (window.ResizeObserver) new ResizeObserver(sync).observe(bc);
    window.addEventListener('resize', sync);
  }
  function renderAll() {
    if (!S.snap || S.view !== 'game' || !$('#k50-action')) return;
    const lay = $('.k50-layout'); if (lay) lay.classList.toggle('lobby', S.snap.game.status === 'LOBBY');
    renderAction(); renderScore(); renderLog(); renderMarkers();
  }

  function ctx() {
    const s = S.snap, g = s.game, me = s.me;
    const team = id => s.teams.find(t => t.id === id);
    const player = id => s.players.find(p => p.id === id);
    return {
      s, g, me, isHost: s.role === 'HOST', cur: team(g.currentTeamId), desc: player(g.describerId), team, player,
      isDesc: !!me && me.playerId === g.describerId, onCur: !!me && me.teamId === g.currentTeamId
    };
  }
  function renderAction() {
    const el = $('#k50-action');
    const ae = document.activeElement;
    const fid = ae && el.contains(ae) ? ae.id : null;
    const pos = fid ? ae.selectionStart : null;
    const html = actionHtml(ctx());
    if (html === ui.lastHtml) return;
    ui.lastHtml = html;
    el.innerHTML = html;
    if (fid) { const n = document.getElementById(fid); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } }
    afterActionRender(ctx());
  }
  function afterActionRender(C) {
    if (C.g.status === 'LOBBY') {
      const url = joinUrl();
      if (window.qrcode && ui.qrFor !== url) {
        try {
          const q = window.qrcode(0, 'M'); q.addData(url); q.make();
          ui.qrUrl = q.createDataURL(6, 2); ui.qrFor = url;
          const img = $('#k50-qr'); if (img) { img.src = ui.qrUrl; img.classList.remove('k50-hide'); }
        } catch (e) { /* QR is optional */ }
      }
    }
    timerTick();
  }
  function joinUrl() { return location.origin + location.pathname + '?room=' + (S.room || ''); }

  // ---------- action panel content ----------
  function banner(C) {
    if (!C.cur) return '';
    const who = C.desc ? (C.isDesc ? '<b>You</b> are up!' : `${esc(C.desc.nickname)} is up`) : '';
    return `<div class="k50-turn">${pin(C.cur, 'lg')}<div><div class="who">${esc(C.cur.name)}'s turn</div><div class="sub">${who}</div></div></div>`;
  }
  function teamForm(C) {
    const taken = C.s.teams.map(t => t.color.toLowerCase());
    return `
      <label class="k50-label" for="k50-tname">Team name</label>
      <input id="k50-tname" class="k50-input" maxlength="14" placeholder="e.g. Simba" data-bind="teamName" value="${esc(ui.teamName)}" autocomplete="off">
      <label class="k50-label">Marker colour</label>
      <div class="k50-swatches">
        ${COLORS.map(c => `<span class="k50-swatch ${ui.color === c ? 'on' : ''} ${taken.includes(c) ? 'taken' : ''}" style="background:${c}" data-act="set-color" data-v="${c}" title="${taken.includes(c) ? 'Taken' : c}"></span>`).join('')}
        <input type="color" class="k50-colorpick" id="k50-tcolor" value="${esc(ui.color)}" data-bind="color" title="Custom colour">
      </div>
      <label class="k50-label">Marker shape</label>
      <div class="k50-icons">${ICONS.map(i => `<button type="button" class="k50-iconbtn ${ui.icon === i ? 'on' : ''}" data-act="set-icon" data-v="${i}"><i class="fa-solid fa-${i}"></i></button>`).join('')}</div>
      <div class="k50-row" style="margin-top:.7rem"><span class="k50-muted">Preview:</span> ${pin({ color: ui.color, icon: ui.icon }, 'lg')}</div>`;
  }
  function lobbyHtml(C) {
    const { s, g } = C, url = joinUrl();
    const joined = !!C.me;
    const canPick = !joined;
    let h = `<div class="k50-room">
        <div class="k50-muted">Room code</div><div class="code">${esc(g.roomCode)}</div>
        <div class="k50-row" style="justify-content:center;margin-top:.5rem"><button class="k50-btn small ghost" data-act="copy-link"><i class="fa-regular fa-copy"></i> Copy invite link</button></div>
        <img id="k50-qr" alt="QR code to join" ${ui.qrFor === url ? `src="${ui.qrUrl}"` : 'class="k50-hide"'}>
      </div><h3>Teams</h3><div class="k50-teamlist">`;
    h += s.teams.map(t => {
      const pls = s.players.filter(p => p.teamId === t.id);
      const mine = C.me && C.me.teamId === t.id;
      const act = canPick ? `pick" data-act="pick-team" data-id="${t.id}` : (joined && !mine ? `pick" data-act="switch-team" data-id="${t.id}` : '');
      return `<div class="k50-teamrow ${act ? 'pick' : ''} ${(canPick && ui.joinTeam === t.id) || mine ? 'selected' : ''}" ${act ? `data-act="${canPick ? 'pick-team' : 'switch-team'}" data-id="${t.id}"` : ''}>
        ${pin(t, 'lg')}<div class="grow"><div class="nm">${esc(t.name)}</div>
        <div class="pl">${pls.length ? pls.map(p => esc(p.nickname) + (C.isHost ? ` <button class="k50-btn small ghost" style="padding:0 .4rem" data-act="rm-player" data-id="${p.id}" title="Remove">×</button>` : '')).join(', ') : 'No players yet'}</div></div>
        ${C.isHost && !pls.length ? `<button class="k50-btn small ghost" data-act="rm-team" data-id="${t.id}">Remove</button>` : ''}
        ${mine ? '<span class="k50-pill gold">You</span>' : ''}</div>`;
    }).join('') || '<div class="k50-muted">No teams yet. Create the first one!</div>';
    if (canPick && !C.isHost && g.status === 'LOBBY') {
      h += `<div class="k50-teamrow pick ${ui.joinTeam === 'NEW' ? 'selected' : ''}" data-act="pick-team" data-id="NEW"><span class="k50-pin lg" style="background:#334155;color:#fff"><i class="fa-solid fa-plus"></i></span><div class="grow"><div class="nm">Create a new team</div></div></div>`;
    }
    h += '</div>';

    if (canPick) {
      h += `<h3>${C.isHost ? 'Play too? Pick a team and join' : 'Join this game'}</h3>
        <label class="k50-label" for="k50-nick">Your nickname</label>
        <input id="k50-nick" class="k50-input" maxlength="14" placeholder="e.g. Amina" data-bind="joinNick" value="${esc(ui.joinNick)}" autocomplete="off">
        ${ui.joinTeam === 'NEW' && !C.isHost ? teamForm(C) : ''}
        <button class="k50-btn block" style="margin-top:.9rem" data-act="join"><i class="fa-solid fa-right-to-bracket"></i> Join game</button>
        <p class="k50-muted" style="margin-top:.5rem">${ui.joinTeam ? '' : (C.isHost ? 'Optional: add a team below first, then tap it above to play on it.' : 'Tap a team above, or create your own.')}</p>`;
    } else if (joined) {
      h += `<p class="k50-muted" style="margin-top:.8rem">You're in as <b>${esc(C.me.nickname)}</b>. Tap another team above to switch.${C.isHost ? '' : ' Waiting for the host to start…'}</p>`;
    }
    if (C.isHost) {
      h += `<h3>Add a team</h3>${teamForm(C)}
        <button class="k50-btn ghost block" style="margin-top:.7rem" data-act="add-team"><i class="fa-solid fa-plus"></i> Add team</button>
        <button class="k50-btn green big block" style="margin-top:1rem" data-act="start" ${s.teams.length < 2 ? 'disabled' : ''}><i class="fa-solid fa-play"></i> Start game</button>
        <p class="k50-muted" style="margin-top:.5rem">Needs at least 2 teams, each with at least 1 player. First to ${g.winningScore} points wins.</p>`;
    }
    return h;
  }

  function wordsGrid(words, deck, mode, set) {
    const cls = String(deck || 'black').toLowerCase();
    const list = words || Array(11).fill(null);
    return `<div class="k50-words ${cls}">` + list.map((w, i) => {
      if (w == null) return '<div class="k50-word masked">• • •</div>';
      const n = `<span class="n">${i + 1}</span>`;
      if (mode === 'round') return `<button class="k50-word tappable ${set.has(i) ? 'done' : ''}" data-act="word-done" data-i="${i}">${n}${esc(w)}</button>`;
      if (mode === 'tick' || mode === 'htick') {
        const on = set.has(i);
        return `<button class="k50-word tick ${on ? 'on' : ''}" data-act="${mode === 'tick' ? 'tick' : 'htick'}" data-i="${i}">${n}${esc(w)}<i class="box fa-${on ? 'solid fa-square-check' : 'regular fa-square'}"></i></button>`;
      }
      if (mode === 'good') { const on = set.has(i); return `<div class="k50-word ${on ? 'good' : ''}">${n}${esc(w)}${on ? '<i class="box fa-solid fa-check"></i>' : ''}</div>`; }
      return `<div class="k50-word">${n}${esc(w)}</div>`;
    }).join('') + '</div>';
  }
  function deckPill(deck) { return `<span class="k50-pill ${String(deck).toLowerCase()}">${esc(deck)} CARD</span>`; }

  function timerHtml(g) {
    const rem = remaining(g);
    return `<div class="k50-timerwrap"><div class="k50-timer ${rem <= 10 ? 'crit' : rem <= 20 ? 'low' : ''}" id="k50-timer" style="--p:${(rem / g.roundSeconds * 100).toFixed(1)}"><span>${Math.ceil(rem)}</span></div></div>`;
  }
  function remaining(g) {
    if (!g.roundStartedAt) return g.roundSeconds;
    const el = (Date.now() + S.offset - new Date(g.roundStartedAt).getTime()) / 1000;
    return Math.max(0, g.roundSeconds - el);
  }

  function actionHtml(C) {
    const { s, g } = C;
    if (ui.holding) {
      return `${banner(C)}<div class="k50-diewrap">${dieHtml(1, true)}<div class="k50-headline">${esc(C.cur ? C.cur.name : '')} rolling…</div></div>`;
    }
    const joinLater = (!C.me && g.status !== 'LOBBY' && g.status !== 'FINISHED');
    let h = '';
    switch (g.status) {
      case 'LOBBY': return lobbyHtml(C);
      case 'AWAITING_ROLL': h = rollHtml(C); break;
      case 'CARD_PREP': h = prepHtml(C); break;
      case 'ROUND_ACTIVE': h = roundHtml(C); break;
      case 'REVIEW': h = reviewHtml(C); break;
      case 'CHOOSE_TARGET': h = chooseHtml(C); break;
      case 'EVENT': h = eventHtml(C); break;
      case 'FINISHED': h = finishedHtml(C); break;
      default: h = '<p class="k50-muted">Loading…</p>';
    }
    if (joinLater) {
      h += `<h3>Watching? Join a team</h3>
        <label class="k50-label" for="k50-nick">Your nickname</label>
        <input id="k50-nick" class="k50-input" maxlength="14" data-bind="joinNick" value="${esc(ui.joinNick)}" autocomplete="off">
        <div class="k50-teamlist" style="margin-top:.6rem">${s.teams.map(t => `<div class="k50-teamrow pick ${ui.joinTeam === t.id ? 'selected' : ''}" data-act="pick-team" data-id="${t.id}">${pin(t)}<div class="grow nm">${esc(t.name)}</div></div>`).join('')}</div>
        <button class="k50-btn block" style="margin-top:.7rem" data-act="join">Join game</button>`;
    }
    if (C.isHost && g.status !== 'FINISHED') {
      h += `<div class="k50-hostbox"><div class="k50-label">Host</div><button class="k50-btn small ghost" data-act="skip-turn"><i class="fa-solid fa-forward"></i> Skip this turn</button></div>`;
    }
    return h;
  }

  function rollHtml(C) {
    const { g } = C, ev = g.lastEvent;
    let h = banner(C);
    if (ev && ev.kind === 'skip') h += `<div class="k50-note">${esc(ev.text)}</div>`;
    h += `<div class="k50-diewrap">${dieHtml(g.lastRoll || 1, false)}`;
    if (C.isDesc || C.isHost) {
      h += `<button class="k50-btn big" data-act="roll"><i class="fa-solid fa-dice"></i> ${C.isDesc ? 'Roll the die' : 'Roll for ' + esc(C.desc ? C.desc.nickname : 'them')}</button>`;
    } else {
      h += `<div class="k50-muted">Waiting for ${esc(C.desc ? C.desc.nickname : 'the next player')} to roll…</div>`;
    }
    return h + '</div>';
  }
  function eventLine(g) {
    const ev = g.lastEvent; if (!ev) return '';
    return `<div class="k50-muted" style="margin-bottom:.6rem">🎲 Rolled a <b>${esc(ev.roll || g.lastRoll || '?')}</b>${esc(ev.note || '')}. ${esc(ev.title || '')}.</div>`;
  }
  function prepHtml(C) {
    const { s, g } = C, card = s.card;
    if (!card) return banner(C) + '<p class="k50-muted">Drawing a card…</p>';
    const left = g.swapsMax - g.swapsUsed;
    let h = banner(C) + eventLine(g);
    h += `<div class="k50-deckbar">${deckPill(card.deck)}<span class="k50-muted">Swaps left: <b>${left}</b></span></div>`;
    if (card.words) {
      h += wordsGrid(card.words, card.deck, 'show') +
        `<div class="k50-secret" style="margin:.6rem 0"><i class="fa-solid fa-eye-slash"></i> Only you can see this card. Hide your screen!</div>
        <div class="k50-row">
          <button class="k50-btn ghost" data-act="swap" ${left < 1 ? 'disabled' : ''}><i class="fa-solid fa-rotate"></i> Swap card (${left} left)</button>
          <button class="k50-btn green" data-act="start-round"><i class="fa-solid fa-stopwatch"></i> Start ${g.roundSeconds}s timer</button>
        </div>
        <p class="k50-muted" style="margin-top:.5rem">Describe each word without saying it. Your team guesses out loud.</p>`;
    } else {
      h += wordsGrid(null, card.deck, 'masked') +
        `<p class="k50-muted" style="margin-top:.7rem">${esc(C.desc ? C.desc.nickname : 'The describer')} is reading the card. Eyes away from their screen!</p>` +
        (C.isHost ? '<button class="k50-btn small ghost" data-act="start-round">Start timer for them</button>' : '');
    }
    return h;
  }
  function roundHtml(C) {
    const { s, g } = C, card = s.card;
    let h = banner(C) + timerHtml(g);
    if (!card) return h;
    if (card.words) {
      h += wordsGrid(card.words, card.deck, 'round', ui.localDone) +
        `<p class="k50-muted" style="margin:.6rem 0">Tap a word to cross it off as your team gets it.</p>
        <button class="k50-btn ghost block" data-act="end-round"><i class="fa-solid fa-flag-checkered"></i> We're done early</button>`;
    } else {
      h += wordsGrid(null, card.deck, 'masked') +
        `<p class="k50-muted center" style="margin-top:.7rem">${C.onCur ? 'Shout your guesses!' : 'Quiet please. No hints for the other team 😉'}</p>` +
        (C.isHost ? '<button class="k50-btn small ghost" data-act="end-round">End round now</button>' : '');
    }
    return h;
  }
  function syncTick(C) {
    const { s, g } = C;
    const key = (g.currentTeamId || '') + ':' + (g.roundStartedAt || '');
    if (ui.tickKey !== key) {
      ui.tickKey = key; ui.editing = false; ui.hostOpen = false;
      const prop = s.review && s.review.proposed;
      ui.tick = new Set(prop || [...ui.localDone]);
      ui.hostTick = new Set(prop || []);
    }
  }
  function reviewHtml(C) {
    const { s, g } = C, rv = s.review || {}, card = s.card;
    if (!card || !card.words) return banner(C) + '<p class="k50-muted">Revealing the card…</p>';
    syncTick(C);
    const prop = rv.proposed || [], submitted = !!rv.submitted;
    const ppw = g.pointsPerWord;
    let h = banner(C) + `<div class="k50-headline">⏱ Time's up! The card is revealed.</div>`;
    if (rv.note) h += `<div class="k50-note">${esc(rv.note)}</div>`;
    const voters = s.players.filter(p => p.id !== g.describerId);
    const votes = rv.votes || [];
    const approved = votes.filter(v => v.vote === 'approve').length;

    if (C.isDesc && (!submitted || ui.editing)) {
      h += `<p class="k50-muted" style="margin-bottom:.5rem">Tap every word your team guessed in time.</p>` +
        wordsGrid(card.words, card.deck, 'tick', ui.tick) +
        `<div class="k50-row between" style="margin-top:.7rem"><div><span class="k50-bigscore">${ui.tick.size}</span><span class="k50-muted"> / 11 words → <b>+${ui.tick.size * ppw}</b> points</span></div>
        <button class="k50-btn green" data-act="submit-tally">Submit for approval</button></div>`;
    } else if (submitted) {
      h += `<p class="k50-muted" style="margin-bottom:.5rem"><b>${esc(C.desc ? C.desc.nickname : 'The describer')}</b> says <b>${plural(prop.length, 'word')}</b> were guessed (+${prop.length * ppw} points).</p>` +
        wordsGrid(card.words, card.deck, 'good', new Set(prop));
      h += `<div class="k50-votes">${voters.map(p => `<span class="k50-vote ${votes.find(v => v.playerId === p.id && v.vote === 'approve') ? 'ok' : ''}">${votes.find(v => v.playerId === p.id && v.vote === 'approve') ? '✓ ' : '… '}${esc(p.nickname)}</span>`).join('')}</div>
        <div class="k50-muted" style="margin-top:.4rem">${approved} of ${rv.needed} approved. Everyone except the describer must agree.</div>`;
      const myVote = C.me && votes.find(v => v.playerId === C.me.playerId);
      if (C.me && !C.isDesc) {
        h += myVote ? '<p class="k50-secret" style="margin-top:.7rem">✓ You approved. Waiting for the others…</p>'
          : `<div class="k50-row" style="margin-top:.8rem"><button class="k50-btn green" data-act="vote-yes"><i class="fa-solid fa-thumbs-up"></i> Approve</button><button class="k50-btn red" data-act="vote-no"><i class="fa-solid fa-thumbs-down"></i> Dispute</button></div>`;
      }
      if (C.isDesc) h += '<div class="k50-row" style="margin-top:.8rem"><button class="k50-btn small ghost" data-act="edit-tally">Change my marks</button></div>';
    } else {
      h += wordsGrid(card.words, card.deck, 'show') +
        `<p class="k50-muted" style="margin-top:.7rem">Waiting for ${esc(C.desc ? C.desc.nickname : 'the describer')} to mark which words were guessed…</p>`;
    }
    if (C.isHost) {
      h += `<div class="k50-hostbox"><div class="k50-label">Host controls</div>
        ${submitted ? `<button class="k50-btn small green" data-act="host-accept">Accept count (${prop.length})</button> ` : ''}
        <details ${ui.hostOpen ? 'open' : ''}><summary class="k50-muted" data-act="host-open" style="cursor:pointer;margin-top:.5rem">Set the count myself</summary>
          ${wordsGrid(card.words, card.deck, 'htick', ui.hostTick)}
          <button class="k50-btn small green" style="margin-top:.6rem" data-act="host-set">Finalize with ${plural(ui.hostTick.size, 'word')}</button></details></div>`;
    }
    return h;
  }
  function chooseHtml(C) {
    const { s, g } = C, pc = g.pendingChoice || {}, ev = g.lastEvent || {};
    let h = banner(C) + eventLine(g) + `<div class="k50-event"><div class="big-ico"><i class="fa-solid fa-${pc.type === 'give' ? 'hand-holding-dollar' : 'hand-fist'}"></i></div><div class="title">${esc(ev.title || '')}</div><div class="text">${esc(ev.text || '')}</div></div>`;
    if (C.onCur || C.isHost) {
      h += `<div class="k50-teamlist" style="margin-top:.7rem">${s.teams.filter(t => t.id !== g.currentTeamId).map(t =>
        `<div class="k50-teamrow pick" data-act="choose" data-id="${t.id}">${pin(t, 'lg')}<div class="grow"><div class="nm">${esc(t.name)}</div><div class="pl">${t.score} points</div></div><i class="fa-solid fa-chevron-right"></i></div>`).join('')}</div>`;
    } else h += `<p class="k50-muted center">${esc(C.cur.name)} is choosing a team…</p>`;
    return h;
  }
  function eventHtml(C) {
    const { g } = C, ev = g.lastEvent || {};
    let h = banner(C);
    if (ev.kind === 'round') h += eventLine({ lastEvent: null });
    const ico = ev.kind === 'rhino' ? '🦏' : `<i class="fa-solid fa-${EVENT_ICON[ev.kind] || 'star'}"></i>`;
    if (ev.kind === 'judiciary') {
      h += `${eventLine(g)}<div class="k50-judcard"><i class="fa-solid fa-scale-balanced"></i><p>${esc(ev.text)}</p></div><div class="k50-event"><div class="detail">${esc(ev.detail || '')}</div></div>`;
    } else {
      h += `${ev.kind === 'round' ? '' : eventLine(g)}<div class="k50-event"><div class="big-ico">${ico}</div><div class="title">${esc(ev.title || 'Turn over')}</div><div class="text">${esc(ev.text || '')}</div></div>`;
    }
    h += (C.onCur || C.isHost)
      ? '<button class="k50-btn big block" style="margin-top:.8rem" data-act="continue">Next team <i class="fa-solid fa-arrow-right"></i></button>'
      : `<p class="k50-muted center" style="margin-top:.8rem">Waiting for ${esc(C.cur ? C.cur.name : 'the team')} to continue…</p>`;
    return h;
  }
  function finishedHtml(C) {
    const { s, g } = C, w = C.team(g.winnerTeamId);
    const ranked = s.teams.slice().sort((a, b) => b.score - a.score);
    let h = `<div class="k50-win"><div class="trophy">🏆</div><h2>${w ? esc(w.name) + ' win!' : 'Game over'}</h2>
      <div class="k50-muted">${w ? w.score + ' points' : ''}</div>
      <div class="k50-row" style="justify-content:center;margin:.8rem 0">${w ? pin(w, 'lg') : ''}</div>
      <div class="k50-teamlist">${ranked.map((t, i) => `<div class="k50-teamrow">${pin(t)}<div class="grow nm">${i + 1}. ${esc(t.name)}</div><b>${t.score}</b></div>`).join('')}</div></div>`;
    h += C.isHost
      ? '<button class="k50-btn green block" style="margin-top:1rem" data-act="reset"><i class="fa-solid fa-rotate-right"></i> Play again (same teams)</button>'
      : '<p class="k50-muted center" style="margin-top:.8rem">The host can start a new game.</p>';
    h += '<button class="k50-btn ghost block small" style="margin-top:.6rem" data-act="leave">Leave game</button>';
    return h;
  }

  // ---------- scoreboard + log ----------
  function renderScore() {
    const s = S.snap, g = s.game, el = $('#k50-score');
    const sorted = s.teams.slice().sort((a, b) => b.score - a.score || a.seq - b.seq);
    const html = `<h2>Scoreboard</h2><div class="k50-muted" style="margin-bottom:.6rem">First to <b>${g.winningScore}</b> points wins · ${g.pointsPerWord} points per word</div>
      <div class="k50-score">${sorted.map(t => {
        const pls = s.players.filter(p => p.teamId === t.id).map(p => esc(p.nickname)).join(', ');
        const turn = t.id === g.currentTeamId && g.status !== 'LOBBY' && g.status !== 'FINISHED';
        return `<div class="k50-scorerow ${turn ? 'turn' : ''}">${pin(t, 'lg')}<div class="nm">${esc(t.name)}${turn ? ' <span class="k50-pill gold">turn</span>' : ''}</div><div class="pts">${t.score}</div>
          <div class="bar"><i style="width:${Math.min(100, t.score / g.winningScore * 100)}%;background:${esc(t.color)}"></i></div>
          <div class="meta"><span>${pls || 'no players'}</span>${t.skipNext ? '<span>⏭ misses next turn</span>' : ''}${t.jailFree ? `<span>🔓 ${t.jailFree} jail-free</span>` : ''}</div></div>`;
      }).join('') || '<div class="k50-muted">No teams yet.</div>'}</div>`;
    if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
  }
  function renderLog() {
    const s = S.snap, el = $('#k50-log');
    const html = `<h2>Game log</h2><ul>${(s.log || []).slice(0, 12).map(l => `<li>${esc(l.text)}</li>`).join('') || '<li>Nothing yet.</li>'}</ul>
      <div class="k50-row between" style="margin-top:.8rem"><button class="k50-btn small ghost" data-act="leave"><i class="fa-solid fa-arrow-left"></i> Leave game</button>
      ${s.role === 'HOST' ? (ui.confirmDelete ? '<button class="k50-btn small red" data-act="delete">Really delete?</button>' : '<button class="k50-btn small ghost" data-act="delete">Delete game</button>') : ''}</div>`;
    if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
  }

  // ===================================================================
  // TIMER
  // ===================================================================
  function timerTick() {
    const s = S.snap; if (!s || s.game.status !== 'ROUND_ACTIVE' || !s.game.roundStartedAt) return;
    const g = s.game, rem = remaining(g), el = $('#k50-timer');
    if (el) {
      el.querySelector('span').textContent = Math.ceil(rem);
      el.style.setProperty('--p', (rem / g.roundSeconds * 100).toFixed(1));
      el.classList.toggle('low', rem <= 20 && rem > 10);
      el.classList.toggle('crit', rem <= 10);
    }
    if (rem > 0 && rem <= 3.2 && ui.cdFor !== g.roundStartedAt) { ui.cdFor = g.roundStartedAt; sfx('321-countdown.mp3'); }
    if (rem <= 0 && ui.endFor !== g.roundStartedAt) {
      ui.endFor = g.roundStartedAt;
      sfx('Kahoot Gong Sound Effect.mp3');
      const key = g.roundStartedAt;
      const mine = s.role === 'HOST' || (s.me && s.me.playerId === g.describerId);
      setTimeout(() => autoEnd(key), mine ? 150 : 1500 + Math.random() * 1500);
    }
  }
  async function autoEnd(key) {
    const s = S.snap;
    if (!s || s.game.status !== 'ROUND_ACTIVE' || s.game.roundStartedAt !== key) return;
    try { applySnapshot(await rpc('k50_end_round', { p_room: S.room, p_token: S.token })); }
    catch (e) { setTimeout(() => { if (ui.endFor === key) ui.endFor = ''; }, 1500); }
  }

  // ===================================================================
  // INPUT HANDLING
  // ===================================================================
  function onActionInput(e) {
    const t = e.target, k = t.dataset && t.dataset.bind;
    if (!k) return;
    ui[k] = t.value;
    if (k === 'color') { ui.lastHtml = ''; renderAction(); }
  }
  async function call(fn, args, after) {
    if (ui.busy) return;
    ui.busy = true; const box = $('#k50-action'); if (box) box.classList.add('k50-busy');
    try {
      const r = await rpc(fn, args);
      if (r && r.deleted) { leaveGame(); return; }
      if (r && r.game) applySnapshot(r);
      if (after) after(r);
    } catch (e) { toast(e.message); }
    finally { ui.busy = false; if (box) box.classList.remove('k50-busy'); }
  }
  function rerender() { ui.lastHtml = ''; renderAction(); }
  function toggle(set, i) { set.has(i) ? set.delete(i) : set.add(i); }
  function nextFreeColor() {
    const taken = (S.snap ? S.snap.teams : []).map(t => t.color.toLowerCase());
    ui.color = COLORS.find(c => !taken.includes(c)) || COLORS[0];
  }

  function onActionClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act, id = b.dataset.id, i = +b.dataset.i, v = b.dataset.v;
    const A = extra => Object.assign({ p_room: S.room, p_token: S.token }, extra || {});
    switch (act) {
      case 'copy-link':
        if (navigator.clipboard) navigator.clipboard.writeText(joinUrl()).then(() => toast('Invite link copied.', true), () => toast(joinUrl()));
        else toast(joinUrl());
        break;
      case 'pick-team': ui.joinTeam = id; if (id === 'NEW') nextFreeColor(); rerender(); break;
      case 'set-color': ui.color = v; rerender(); break;
      case 'set-icon': ui.icon = v; rerender(); break;
      case 'join': {
        const nick = (ui.joinNick || '').trim();
        if (!nick) { toast('Enter a nickname first.'); break; }
        store.set('k50_nick', nick);
        const base = A({ p_nickname: nick });
        if (ui.joinTeam === 'NEW') call('k50_join', Object.assign(base, { p_new_team_name: ui.teamName, p_new_color: ui.color, p_new_icon: ui.icon }), () => { ui.teamName = ''; });
        else if (ui.joinTeam) call('k50_join', Object.assign(base, { p_team_id: ui.joinTeam }));
        else toast('Pick a team, or create one.');
        break;
      }
      case 'switch-team': call('k50_join', A({ p_nickname: S.snap.me.nickname, p_team_id: id })); break;
      case 'add-team': call('k50_create_team', A({ p_name: ui.teamName, p_color: ui.color, p_icon: ui.icon }), () => { ui.teamName = ''; nextFreeColor(); rerender(); }); break;
      case 'rm-team': call('k50_remove_team', A({ p_team_id: id })); break;
      case 'rm-player': call('k50_remove_player', A({ p_player_id: id })); break;
      case 'start': call('k50_start_game', A()); break;
      case 'roll': call('k50_roll', A()); break;
      case 'swap': call('k50_swap_card', A()); break;
      case 'start-round': call('k50_start_round', A()); break;
      case 'end-round': call('k50_end_round', A()); break;
      case 'word-done': toggle(ui.localDone, i); rerender(); break;
      case 'tick': toggle(ui.tick, i); rerender(); break;
      case 'htick': toggle(ui.hostTick, i); ui.hostOpen = true; rerender(); break;
      case 'host-open': ui.hostOpen = !ui.hostOpen; break;
      case 'submit-tally': call('k50_submit_tally', A({ p_correct: [...ui.tick].sort((a, c) => a - c) }), () => { ui.editing = false; }); break;
      case 'edit-tally': ui.editing = true; rerender(); break;
      case 'vote-yes': call('k50_vote', A({ p_approve: true })); break;
      case 'vote-no': call('k50_vote', A({ p_approve: false })); break;
      case 'host-accept': call('k50_host_finalize', A()); break;
      case 'host-set': call('k50_host_finalize', A({ p_correct: [...ui.hostTick].sort((a, c) => a - c) })); break;
      case 'choose': call('k50_choose_target', A({ p_target: id })); break;
      case 'continue': call('k50_continue', A()); break;
      case 'skip-turn': call('k50_host_skip_turn', A()); break;
      case 'reset': call('k50_reset_game', A()); break;
      case 'delete':
        if (!ui.confirmDelete) { ui.confirmDelete = true; renderLog(); setTimeout(() => { ui.confirmDelete = false; if (S.snap) renderLog(); }, 4000); }
        else call('k50_delete_game', A());
        break;
      case 'leave': leaveGame(); break;
    }
  }
})();

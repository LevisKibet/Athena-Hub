/* ===================================================================
   SCRABBLE: online client for scrabble.html
   All rules and secrets live in Supabase (supabase/scrabble/schema.sql).
   This file draws the state it is given and sends the player's moves.
   =================================================================== */
(function () {
  'use strict';
  const CFG = window.QA_CONFIG || {};

  const VAL = { A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8, K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1, U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10 };
  const PREM = [
    'W..l...W...l..W', '.w...L...L...w.', '..w...l.l...w..', 'l..w...l...w..l', '....w.....w....',
    '.L...L...L...L.', '..l...l.l...l..', 'W..l...w...l..W', '..l...l.l...l..', '.L...L...L...L.',
    '....w.....w....', 'l..w...l...w..l', '..w...l.l...w..', '.w...L...L...w.', 'W..l...W...l..W'];
  const PREM_TEXT = { W: 'TW', w: 'DW', L: 'TL', l: 'DL' };
  const PREM_NAME = { W: 'Triple word', w: 'Double word', L: 'Triple letter', l: 'Double letter' };
  const EMPTY = '.'.repeat(225);
  const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706'];

  // ---------- helpers ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  };
  function getToken() {
    let t = store.get('scr_token');
    if (!t) {
      t = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 't' + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
      store.set('scr_token', t);
    }
    return t;
  }
  function toast(msg, ok) {
    const box = $('#scr-toasts'); if (!box) return;
    const el = document.createElement('div');
    el.className = 'scr-toast' + (ok ? ' ok' : '');
    el.textContent = msg; box.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // ---------- state ----------
  const S = { client: null, token: getToken(), room: '', snap: null, channel: null, channelFor: '', poll: null, view: 'home' };
  const ui = {
    order: [], rackSig: '', pending: {}, selected: null, blankFor: null, exchange: false, exSel: new Set(),
    busy: false, nick: store.get('scr_nick') || '', confirmPass: false, lastTurnSeat: -1, dictProgress: null, qrFor: '', qrUrl: '', celebrated: ''
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    initTheme();
    const d = $('#live-date'); if (d) d.textContent = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    $('#theme-toggle').addEventListener('click', () => {
      const light = !document.body.classList.contains('light-mode');
      store.set('scr_theme', light ? 'light' : 'dark'); applyTheme(light);
    });
    $('#scr-rules-btn').addEventListener('click', () => $('#scr-rules').classList.add('open'));
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('.scr-overlay').classList.remove('open')));
    document.querySelectorAll('.scr-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); }));

    if (!window.supabase || !CFG.supabaseUrl || !CFG.anonKey) {
      $('#scr-app').innerHTML = '<div class="scr-panel scr-center"><h2>Cannot reach the game server</h2><p class="scr-muted">Check your connection and that config.js has the Supabase URL and anon key.</p></div>';
      return;
    }
    S.client = window.supabase.createClient(CFG.supabaseUrl, CFG.anonKey);
    const room = new URLSearchParams(location.search).get('room');
    if (room) openRoom(room); else renderHome();
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.room) loadSnapshot(); });
  }

  function initTheme() {
    const saved = store.get('scr_theme') || store.get('k50_theme');
    applyTheme(saved ? saved === 'light' : window.matchMedia('(prefers-color-scheme: light)').matches);
  }
  function applyTheme(light) {
    document.body.classList.toggle('light-mode', light);
    document.body.classList.toggle('dark-mode', !light);
    const i = $('#theme-icon'); if (i) i.className = 'fa-solid ' + (light ? 'fa-sun' : 'fa-moon');
  }

  async function rpc(name, args) {
    const { data, error } = await S.client.rpc(name, args || {});
    if (error) throw new Error(error.message || 'Request failed');
    return data;
  }

  // ===================================================================
  // HOME
  // ===================================================================
  function renderHome() {
    S.view = 'home'; S.room = ''; teardown();
    const last = store.get('scr_room');
    $('#scr-app').innerHTML = `
      <section class="scr-hero">
        <h1>Scrabble</h1>
        <p>Two to four players, each on their own device. Build words, hit the premium squares and challenge anything that looks made up.</p>
      </section>
      <div class="scr-home-grid">
        <div class="scr-panel">
          <h2><i class="fa-solid fa-plus"></i> New game</h2>
          <label class="scr-label" for="scr-nick-new">Your nickname</label>
          <input id="scr-nick-new" class="scr-input" maxlength="14" placeholder="e.g. Amina" value="${esc(ui.nick)}" autocomplete="off">
          <button class="scr-btn block" style="margin-top:.8rem" id="scr-create"><i class="fa-solid fa-play"></i> Create game</button>
        </div>
        <div class="scr-panel">
          <h2><i class="fa-solid fa-right-to-bracket"></i> Join a game</h2>
          <label class="scr-label" for="scr-code">Room code</label>
          <input id="scr-code" class="scr-input scr-code-input" maxlength="5" placeholder="ABCDE" autocomplete="off" autocapitalize="characters">
          <label class="scr-label" for="scr-nick-join" style="margin-top:.6rem">Your nickname</label>
          <input id="scr-nick-join" class="scr-input" maxlength="14" placeholder="e.g. Brian" value="${esc(ui.nick)}" autocomplete="off">
          <button class="scr-btn block" style="margin-top:.8rem" id="scr-join"><i class="fa-solid fa-arrow-right"></i> Join</button>
          ${last ? `<button class="scr-btn ghost block small" style="margin-top:.6rem" id="scr-resume">Resume game ${esc(last)}</button>` : ''}
        </div>
      </div>`;
    $('#scr-create').addEventListener('click', createGame);
    $('#scr-nick-new').addEventListener('keydown', e => { if (e.key === 'Enter') createGame(); });
    $('#scr-join').addEventListener('click', () => joinGame($('#scr-code').value));
    $('#scr-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinGame($('#scr-code').value); });
    if ($('#scr-resume')) $('#scr-resume').addEventListener('click', () => openRoom(last));
  }
  async function createGame() {
    const nick = $('#scr-nick-new').value.trim();
    if (!nick) { toast('Enter a nickname first.'); return; }
    ui.nick = nick; store.set('scr_nick', nick);
    const b = $('#scr-create'); b.disabled = true;
    try {
      const snap = await rpc('scr_create', { p_token: S.token, p_nickname: nick });
      enterRoom(snap);
    } catch (e) { toast(e.message); b.disabled = false; }
  }
  async function joinGame(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const nick = ($('#scr-nick-join') ? $('#scr-nick-join').value : ui.nick).trim();
    if (code.length < 4) { toast('Enter the room code.'); return; }
    if (!nick) { toast('Enter a nickname first.'); return; }
    ui.nick = nick; store.set('scr_nick', nick);
    try { enterRoom(await rpc('scr_join', { p_room: code, p_token: S.token, p_nickname: nick })); }
    catch (e) { toast(e.message); }
  }
  // opened from a link or a resume: if I'm already in the game just show it, otherwise ask for a nickname
  async function openRoom(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    try {
      const snap = await rpc('scr_snapshot', { p_room: code, p_token: S.token });
      if (snap.me || snap.game.status !== 'LOBBY') { enterRoom(snap); return; }
      S.view = 'invite'; S.room = code; teardown();
      $('#scr-app').innerHTML = `<div class="scr-panel scr-narrow">
        <h2>Join game ${esc(code)}</h2>
        <p class="scr-muted">${snap.players.map(p => esc(p.nickname)).join(', ')} ${snap.players.length === 1 ? 'is' : 'are'} waiting.</p>
        <label class="scr-label" for="scr-nick-join">Your nickname</label>
        <input id="scr-nick-join" class="scr-input" maxlength="14" value="${esc(ui.nick)}" autocomplete="off">
        <div class="scr-row" style="margin-top:.8rem"><button class="scr-btn" id="scr-join2">Join</button><button class="scr-btn ghost" id="scr-home">Back</button></div></div>`;
      $('#scr-join2').addEventListener('click', () => joinGame(code));
      $('#scr-nick-join').addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(code); });
      $('#scr-home').addEventListener('click', leave);
    } catch (e) { toast(e.message); renderHome(); }
  }
  function enterRoom(snap) {
    S.room = snap.game.roomCode; S.view = 'game'; S.snap = null;
    store.set('scr_room', S.room);
    try { history.replaceState(null, '', location.pathname + '?room=' + S.room); } catch (e) { /* ignore */ }
    ui.pending = {}; ui.selected = null; ui.exchange = false; ui.order = []; ui.rackSig = ''; ui.lastTurnSeat = -1; ui.celebrated = '';
    $('#scr-app').innerHTML = '<div class="scr-layout" id="scr-layout"></div>';
    $('#scr-layout').addEventListener('click', onClick);
    applySnapshot(snap);
    clearInterval(S.poll); S.poll = setInterval(() => { if (!document.hidden) loadSnapshot(); }, 4000);
  }
  function leave() {
    teardown(); S.snap = null; S.room = '';
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    renderHome();
  }
  function teardown() {
    if (S.channel) { try { S.client.removeChannel(S.channel); } catch (e) { /* ignore */ } S.channel = null; S.channelFor = ''; }
    clearInterval(S.poll); S.poll = null;
  }

  // ===================================================================
  // SYNC
  // ===================================================================
  let loading = false, queued = false, deb = null;
  async function loadSnapshot() {
    if (!S.room || S.view !== 'game') return;
    if (loading) { queued = true; return; }
    loading = true;
    try { applySnapshot(await rpc('scr_snapshot', { p_room: S.room, p_token: S.token })); }
    catch (e) { if (/not found/i.test(e.message)) { toast('This game no longer exists.'); leave(); } }
    finally { loading = false; if (queued) { queued = false; setTimeout(loadSnapshot, 80); } }
  }
  function subscribe(id) {
    if (S.channelFor === id) return;
    if (S.channel) { try { S.client.removeChannel(S.channel); } catch (e) { /* ignore */ } }
    S.channelFor = id;
    try {
      S.channel = S.client.channel('scr-' + id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'scr_pings', filter: 'game_id=eq.' + id }, () => { clearTimeout(deb); deb = setTimeout(loadSnapshot, 90); })
        .subscribe();
    } catch (e) { /* polling keeps us in sync */ }
  }

  function applySnapshot(snap) {
    if (!snap || !snap.game) return;
    const prev = S.snap; S.snap = snap;
    subscribe(snap.game.id);

    // rack bookkeeping: keep the player's own tile order while the rack is unchanged
    const rack = snap.me ? snap.me.rack : '';
    if (rack !== ui.rackSig) {
      const same = sortStr(rack) === sortStr(ui.rackSig);
      ui.rackSig = rack;
      if (!same || ui.order.length !== rack.length) { ui.order = rack.split('').map((_, i) => i); ui.pending = {}; ui.selected = null; }
    }
    // drop pending tiles that collide with tiles that just arrived on the board
    Object.keys(ui.pending).forEach(k => { const p = ui.pending[k]; if (snap.board[p.r * 15 + p.c] !== '.') delete ui.pending[k]; });
    if (!myTurn()) { ui.exchange = false; ui.exSel = new Set(); }

    const g = snap.game;
    if (snap.me && g.status === 'PLAYING' && g.turnSeat === snap.me.seat && ui.lastTurnSeat !== snap.me.seat && prev) {
      toast('Your turn!', true);
      try { navigator.vibrate && navigator.vibrate(200); } catch (e) { /* ignore */ }
    }
    ui.lastTurnSeat = g.turnSeat;
    document.title = (myTurn() ? '● Your turn | ' : '') + 'Scrabble | Athena Game Hub';
    if (g.status === 'FINISHED' && ui.celebrated !== g.id) {
      ui.celebrated = g.id;
      if (window.confetti && g.winners && snap.me && g.winners.includes(snap.me.seat)) {
        window.confetti({ particleCount: 140, spread: 90, origin: { y: 0.6 } });
      }
    }
    render();
  }
  const sortStr = s => String(s || '').split('').sort().join('');
  function myTurn() { const s = S.snap; return !!(s && s.me && s.game.status === 'PLAYING' && s.game.turnSeat === s.me.seat); }

  async function act(fn, args, after) {
    if (ui.busy) return;
    ui.busy = true; const lay = $('#scr-layout'); if (lay) lay.classList.add('busy');
    try {
      const r = await rpc(fn, Object.assign({ p_room: S.room, p_token: S.token }, args || {}));
      if (r && r.deleted) { leave(); return; }
      if (r && r.game) { if (after) after(r); applySnapshot(r); }
    } catch (e) { toast(e.message); }
    finally { ui.busy = false; if (lay) lay.classList.remove('busy'); }
  }

  // ===================================================================
  // MOVE ANALYSIS (same rules as the server; used for the live score preview)
  // ===================================================================
  function analyze(board, placed) {
    const n = placed.length;
    if (n < 1) return { error: '' };
    let b = board;
    const set = (i, ch) => { b = b.slice(0, i) + ch + b.slice(i + 1); };
    const pidx = [];
    for (const t of placed) {
      const i = t.r * 15 + t.c;
      if (b[i] !== '.') return { error: 'That square is taken.' };
      set(i, t.blank ? t.ch.toLowerCase() : t.ch.toUpperCase()); pidx.push(i);
    }
    const rows = new Set(placed.map(t => t.r)), cols = new Set(placed.map(t => t.c));
    if (rows.size > 1 && cols.size > 1) return { error: 'Tiles must be in a single row or column.' };
    if (n > 1) {
      if (rows.size === 1) {
        const r = placed[0].r, lo = Math.min(...cols), hi = Math.max(...cols);
        for (let c = lo; c <= hi; c++) if (b[r * 15 + c] === '.') return { error: 'There cannot be gaps in a word.' };
      } else {
        const c = placed[0].c, lo = Math.min(...rows), hi = Math.max(...rows);
        for (let r = lo; r <= hi; r++) if (b[r * 15 + c] === '.') return { error: 'There cannot be gaps in a word.' };
      }
    }
    if (board === EMPTY) {
      if (n < 2) return { error: 'The first word needs two tiles.' };
      if (!pidx.includes(112)) return { error: 'The first word must cover the centre star.' };
    } else {
      const touches = pidx.some(i => {
        const r = Math.floor(i / 15), c = i % 15;
        return (r > 0 && board[i - 15] !== '.') || (r < 14 && board[i + 15] !== '.') || (c > 0 && board[i - 1] !== '.') || (c < 14 && board[i + 1] !== '.');
      });
      if (!touches) return { error: 'Your word must connect to tiles on the board.' };
    }
    const words = []; const seen = new Set(); let score = 0;
    for (const i of pidx) {
      for (let dir = 0; dir < 2; dir++) {
        const dx = dir === 0 ? 1 : 0, dy = dir === 0 ? 0 : 1;
        let x = i % 15, y = Math.floor(i / 15);
        while (x - dx >= 0 && y - dy >= 0 && b[(y - dy) * 15 + x - dx] !== '.') { x -= dx; y -= dy; }
        const key = (y * 15 + x) * 2 + dir;
        if (seen.has(key)) continue; seen.add(key);
        let w = '', tot = 0, wm = 1;
        while (x <= 14 && y <= 14 && b[y * 15 + x] !== '.') {
          const k = y * 15 + x, ch = b[k]; let v = VAL[ch] || 0;
          if (pidx.includes(k)) {
            const p = PREM[Math.floor(k / 15)][k % 15];
            if (p === 'l') v *= 2; else if (p === 'L') v *= 3; else if (p === 'w') wm *= 2; else if (p === 'W') wm *= 3;
          }
          tot += v; w += ch.toUpperCase(); x += dx; y += dy;
        }
        if (w.length >= 2) { words.push({ w, s: tot * wm }); score += tot * wm; }
      }
    }
    if (!words.length) return { error: 'Your tiles do not form a word.' };
    if (n === 7) score += 50;
    return { words, score, bingo: n === 7 };
  }
  function pendingList() {
    return Object.keys(ui.pending).map(k => { const p = ui.pending[k]; return { r: p.r, c: p.c, ch: p.ch, blank: p.blank }; });
  }

  // ===================================================================
  // RENDER
  // ===================================================================
  function render() {
    const lay = $('#scr-layout'); if (!lay || !S.snap) return;
    const s = S.snap, g = s.game;
    if (g.status === 'LOBBY') { lay.className = 'scr-layout lobby'; lay.innerHTML = lobbyHtml(s); afterLobby(s); return; }
    lay.className = 'scr-layout' + (ui.busy ? ' busy' : '');
    lay.innerHTML = `
      <div class="scr-main">
        ${boardHtml(s)}
      </div>
      <aside class="scr-side">
        <div class="scr-statusbar">${statusHtml(s)}</div>
        <div class="scr-panel">${playersHtml(s)}</div>
        <div class="scr-panel scr-log"><h3>Game log</h3><ul>${(s.log || []).slice(0, 12).map(l => `<li>${esc(l.text)}</li>`).join('')}</ul>
          <div class="scr-row between" style="margin-top:.7rem"><button class="scr-btn small ghost" data-act="leave"><i class="fa-solid fa-arrow-left"></i> Leave</button>
          ${s.me && s.me.isCreator ? (g.status === 'PLAYING' ? '<button class="scr-btn small ghost" data-act="end">End game</button>' : '<button class="scr-btn small ghost" data-act="delete">Delete game</button>') : ''}</div></div>
        ${rackHtml(s)}
      </aside>
      ${ui.blankFor ? blankPickerHtml() : ''}`;
  }

  function lobbyHtml(s) {
    const g = s.game, url = joinUrl(), creator = s.me && s.me.isCreator;
    return `<div class="scr-panel scr-narrow">
      <div class="scr-room"><div class="scr-muted">Room code</div><div class="code">${esc(g.roomCode)}</div>
        <div class="scr-link">${esc(url)}</div>
        <div class="scr-row" style="justify-content:center;margin-top:.5rem"><button class="scr-btn small ghost" data-act="copy-link"><i class="fa-regular fa-copy"></i> Copy invite link</button></div>
        <img id="scr-qr" alt="QR code to join" ${ui.qrFor === url ? `src="${ui.qrUrl}"` : 'class="scr-hide"'}></div>
      <h3>Players (${s.players.length}/4)</h3>
      <div class="scr-plist">${s.players.map(p => `<div class="scr-prow"><span class="scr-dot" style="background:${COLORS[p.seat % 4]}"></span><span class="nm">${esc(p.nickname)}</span>${s.me && s.me.seat === p.seat ? '<span class="scr-pill">You</span>' : ''}${p.seat === 0 ? '<span class="scr-pill gold">Host</span>' : ''}</div>`).join('')}</div>
      ${!s.dictLoaded ? dictHtml(creator) : ''}
      ${creator ? `<button class="scr-btn big block" style="margin-top:1rem" data-act="start" ${s.players.length < 2 || !s.dictLoaded ? 'disabled' : ''}><i class="fa-solid fa-play"></i> Start game</button>
        <p class="scr-muted" style="margin-top:.5rem">${s.players.length < 2 ? 'Waiting for at least one more player.' : 'Ready when everyone is in.'}</p>`
        : '<p class="scr-muted" style="margin-top:1rem">Waiting for the host to start the game…</p>'}
      <div class="scr-row between" style="margin-top:1rem"><button class="scr-btn small ghost" data-act="leave">Leave</button>
        ${creator ? '<button class="scr-btn small ghost" data-act="delete">Delete game</button>' : ''}</div></div>`;
  }
  function dictHtml() {
    const p = ui.dictProgress;
    return `<div class="scr-note"><b>The word list is not loaded yet.</b> This only needs to happen once for the whole game server.
      ${p ? `<div class="scr-bar"><i style="width:${p.pct}%"></i></div><div class="scr-muted">${esc(p.text)}</div>`
        : '<button class="scr-btn small" style="margin-top:.5rem" data-act="load-dict"><i class="fa-solid fa-book"></i> Load dictionary</button>'}</div>`;
  }
  function afterLobby(s) {
    const url = joinUrl();
    if (window.qrcode && ui.qrFor !== url) {
      try {
        const q = window.qrcode(0, 'M'); q.addData(url); q.make();
        ui.qrUrl = q.createDataURL(6, 2); ui.qrFor = url;
        const img = $('#scr-qr'); if (img) { img.src = ui.qrUrl; img.classList.remove('scr-hide'); }
      } catch (e) { /* QR is optional */ }
    }
  }
  function joinUrl() { return location.origin + location.pathname + '?room=' + (S.room || ''); }

  function statusHtml(s) {
    const g = s.game, turn = s.players.find(p => p.seat === g.turnSeat), lm = g.lastMove;
    let h = '';
    if (g.status === 'FINISHED') {
      const w = (g.winners || []).map(x => s.players.find(p => p.seat === x)).filter(Boolean);
      h = `<div class="scr-win"><i class="fa-solid fa-trophy"></i> ${w.length ? esc(w.map(p => p.nickname).join(' and ')) + (w.length > 1 ? ' tie' : ' wins') + ' with ' + w[0].score + ' points!' : 'Game over'}</div>`;
    } else if (turn) {
      const mine = myTurn();
      h = `<div class="scr-turn ${mine ? 'mine' : ''}"><span class="scr-dot" style="background:${COLORS[turn.seat % 4]}"></span>${mine ? '<b>Your turn</b>' : `${esc(turn.nickname)}'s turn`}</div>`;
    }
    if (lm) {
      if (lm.result === 'invalid') h += `<div class="scr-last bad">${esc(lm.challenger)} challenged ${esc(lm.nickname)}: <b>${esc((lm.invalidWords || []).join(', '))}</b> is not a word. ${esc(lm.nickname)}'s play was taken back.</div>`;
      else if (lm.result === 'valid') h += `<div class="scr-last">${esc(lm.challenger)} challenged ${esc(lm.nickname)}, but ${esc((lm.words || []).map(x => x.w).join(', '))} ${lm.words.length === 1 ? 'is' : 'are'} valid. ${esc(lm.challenger)} loses a turn.</div>`;
      else h += `<div class="scr-last">${esc(lm.nickname)} played <b>${esc((lm.words || []).map(x => x.w + ' (' + x.s + ')').join(', '))}</b> for <b>${lm.score}</b>${lm.bingo ? ' (bingo +50)' : ''}.</div>`;
    }
    return h;
  }

  function boardHtml(s) {
    const lm = s.game.lastMove, hl = new Set(lm && lm.placed && lm.result !== 'invalid' ? lm.placed.map(t => t.r * 15 + t.c) : []);
    const pend = {}; Object.keys(ui.pending).forEach(k => { const p = ui.pending[k]; pend[p.r * 15 + p.c] = p; });
    let cells = '';
    for (let i = 0; i < 225; i++) {
      const ch = s.board[i], p = PREM[Math.floor(i / 15)][i % 15], pd = pend[i];
      if (ch !== '.') {
        const blank = ch === ch.toLowerCase();
        cells += `<div class="scr-cell tile${blank ? ' blank' : ''}${hl.has(i) ? ' last' : ''}" data-i="${i}"><b>${ch.toUpperCase()}</b>${blank ? '' : `<sup>${VAL[ch]}</sup>`}</div>`;
      } else if (pd) {
        cells += `<div class="scr-cell tile pending${pd.blank ? ' blank' : ''}" data-act="unplace" data-i="${i}"><b>${pd.ch}</b>${pd.blank ? '' : `<sup>${VAL[pd.ch]}</sup>`}</div>`;
      } else {
        const star = i === 112;
        cells += `<div class="scr-cell empty ${p !== '.' ? 'p' + p : ''}${star ? ' star' : ''}" data-act="cell" data-i="${i}" title="${PREM_NAME[p] || (star ? 'Start' : '')}">${star ? '<i class="fa-solid fa-star"></i>' : (PREM_TEXT[p] || '')}</div>`;
      }
    }
    return `<div class="scr-board-wrap"><div class="scr-board" id="scr-board">${cells}</div></div>`;
  }

  function rackHtml(s) {
    if (!s.me) return `<div class="scr-panel scr-muted">You are watching this game.</div>`;
    const g = s.game, mine = myTurn(), rack = s.me.rack, finished = g.status === 'FINISHED';
    if (finished) return '<div class="scr-panel scr-center"><button class="scr-btn" data-act="leave">Back to start</button></div>';
    const used = new Set(Object.keys(ui.pending).map(Number));
    const tiles = ui.order.map(idx => {
      const ch = rack[idx]; if (ch === undefined) return '';
      if (used.has(idx)) return `<div class="scr-rtile ghost" aria-hidden="true"></div>`;
      const sel = ui.exchange ? ui.exSel.has(idx) : ui.selected === idx;
      return `<button class="scr-rtile${sel ? ' sel' : ''}${ch === '?' ? ' blank' : ''}" data-act="rack" data-idx="${idx}" aria-label="Tile ${ch === '?' ? 'blank' : ch}"><b>${ch === '?' ? '' : ch}</b>${ch === '?' ? '' : `<sup>${VAL[ch]}</sup>`}</button>`;
    }).join('');
    let preview = '';
    const pl = pendingList();
    if (pl.length) {
      const a = analyze(s.board, pl);
      preview = a.error ? `<div class="scr-preview bad">${esc(a.error)}</div>`
        : `<div class="scr-preview ok"><b>${esc(a.words.map(x => x.w).join(', '))}</b> <span class="pts">+${a.score}</span></div>`;
    }
    const lm = g.lastMove;
    const canChallenge = mine && lm && lm.challengeable && lm.seat !== s.me.seat && !lm.out;
    const canAccept = mine && lm && lm.challengeable && lm.out && lm.seat !== s.me.seat;
    const ok = pl.length && !analyze(s.board, pl).error;
    let btns;
    if (ui.exchange) {
      btns = `<button class="scr-btn" data-act="confirm-exchange" ${ui.exSel.size ? '' : 'disabled'}>Exchange ${ui.exSel.size || ''} tile${ui.exSel.size === 1 ? '' : 's'}</button><button class="scr-btn ghost" data-act="cancel-exchange">Cancel</button>`;
    } else {
      btns = `<button class="scr-btn green" data-act="play" ${mine && ok ? '' : 'disabled'}><i class="fa-solid fa-check"></i> Play</button>
        <button class="scr-btn ghost" data-act="recall" ${pl.length ? '' : 'disabled'}>Recall</button>
        <button class="scr-btn ghost" data-act="shuffle"><i class="fa-solid fa-shuffle"></i></button>
        <button class="scr-btn ghost" data-act="exchange" ${mine && !pl.length && g.bagCount >= 7 ? '' : 'disabled'}>Exchange</button>
        <button class="scr-btn ghost" data-act="pass" ${mine && !pl.length ? '' : 'disabled'}>${ui.confirmPass ? 'Really pass?' : 'Pass'}</button>
        ${canChallenge ? '<button class="scr-btn red" data-act="challenge"><i class="fa-solid fa-circle-exclamation"></i> Challenge</button>' : ''}
        ${canAccept ? '<button class="scr-btn green" data-act="accept">Accept final play</button>' : ''}`;
    }
    return `<div class="scr-panel scr-rackbox">
      ${canAccept ? '<div class="scr-note">The last player used every tile. Challenge the play or accept it to end the game.</div>' : ''}
      ${ui.exchange ? '<div class="scr-muted">Tap the tiles you want to swap, then confirm.</div>' : ''}
      <div class="scr-rack">${tiles}</div>${preview}
      <div class="scr-row wrap">${btns}${canAccept ? '<button class="scr-btn red" data-act="challenge">Challenge</button>' : ''}</div></div>`;
  }

  function playersHtml(s) {
    const g = s.game;
    return `<h3>Scores</h3><div class="scr-scores">${s.players.map(p => {
      const turn = g.status === 'PLAYING' && g.turnSeat === p.seat;
      return `<div class="scr-score ${turn ? 'turn' : ''}"><span class="scr-dot" style="background:${COLORS[p.seat % 4]}"></span>
        <span class="nm">${esc(p.nickname)}${s.me && s.me.seat === p.seat ? ' <span class="scr-pill">You</span>' : ''}</span><span class="pts">${p.score}</span>
        <span class="meta">${g.status === 'FINISHED' && p.rack ? 'left: ' + esc(p.rack.replace(/\?/g, '_') || 'none') : plural(p.rackCount, 'tile') + ' in rack'}</span></div>`;
    }).join('')}</div>
    <div class="scr-bag"><i class="fa-solid fa-bag-shopping"></i> ${plural(g.bagCount, 'tile')} in the bag</div>`;
  }

  function blankPickerHtml() {
    return `<div class="scr-overlay open" data-act="blank-cancel"><div class="scr-modal"><h2>Blank tile</h2><p class="scr-muted">Which letter should it stand for?</p>
      <div class="scr-letters">${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `<button class="scr-btn ghost small" data-act="blank-pick" data-v="${l}">${l}</button>`).join('')}</div>
      <button class="scr-btn ghost" style="margin-top:.8rem" data-act="blank-cancel">Cancel</button></div></div>`;
  }

  // ===================================================================
  // INPUT
  // ===================================================================
  function onClick(e) {
    const t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
    const act = t.dataset.act, s = S.snap; if (!s) return;
    if (act === 'blank-cancel' && e.target !== t && !e.target.closest('.scr-btn')) return;
    switch (act) {
      case 'rack': {
        const idx = +t.dataset.idx;
        if (ui.exchange) { ui.exSel.has(idx) ? ui.exSel.delete(idx) : ui.exSel.add(idx); }
        else ui.selected = ui.selected === idx ? null : idx;
        render(); break;
      }
      case 'cell': {
        if (!myTurn()) { toast(s.me ? 'Wait for your turn.' : 'You are watching this game.'); break; }
        if (ui.selected == null) { toast('Pick a tile from your rack first.'); break; }
        const i = +t.dataset.i, idx = ui.selected, ch = s.me.rack[idx];
        if (ch === '?') { ui.blankFor = { idx, r: Math.floor(i / 15), c: i % 15 }; render(); break; }
        ui.pending[idx] = { r: Math.floor(i / 15), c: i % 15, ch, blank: false };
        ui.selected = null; render(); break;
      }
      case 'blank-pick': {
        const b = ui.blankFor; ui.blankFor = null;
        if (b) { ui.pending[b.idx] = { r: b.r, c: b.c, ch: t.dataset.v, blank: true }; ui.selected = null; }
        render(); break;
      }
      case 'blank-cancel': ui.blankFor = null; render(); break;
      case 'unplace': {
        const i = +t.dataset.i;
        Object.keys(ui.pending).forEach(k => { const p = ui.pending[k]; if (p.r * 15 + p.c === i) { delete ui.pending[k]; ui.selected = +k; } });
        render(); break;
      }
      case 'recall': ui.pending = {}; ui.selected = null; render(); break;
      case 'shuffle': ui.order = ui.order.slice().sort(() => Math.random() - 0.5); render(); break;
      case 'exchange': ui.exchange = true; ui.exSel = new Set(); ui.selected = null; render(); break;
      case 'cancel-exchange': ui.exchange = false; ui.exSel = new Set(); render(); break;
      case 'confirm-exchange': {
        const letters = [...ui.exSel].map(i => s.me.rack[i]).join('');
        ui.exchange = false; ui.exSel = new Set();
        act2('scr_exchange', { p_tiles: letters }); break;
      }
      case 'play': {
        const tiles = pendingList();
        act2('scr_play', { p_tiles: tiles }, () => { ui.pending = {}; ui.selected = null; }); break;
      }
      case 'pass':
        if (!ui.confirmPass) { ui.confirmPass = true; render(); setTimeout(() => { ui.confirmPass = false; if (S.snap) render(); }, 3500); }
        else { ui.confirmPass = false; act2('scr_pass'); }
        break;
      case 'challenge': act2('scr_challenge'); break;
      case 'accept': act2('scr_accept'); break;
      case 'start': act2('scr_start'); break;
      case 'end': if (confirmTwice(t, 'Really end?')) act2('scr_end_game'); break;
      case 'delete': if (confirmTwice(t, 'Really delete?')) act2('scr_delete_game'); break;
      case 'leave': leave(); break;
      case 'copy-link':
        if (navigator.clipboard) navigator.clipboard.writeText(joinUrl()).then(() => toast('Invite link copied.', true), () => toast(joinUrl()));
        else toast(joinUrl());
        break;
      case 'load-dict': loadDictionary(); break;
    }
  }
  const act2 = act;
  function confirmTwice(btn, text) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1'; const old = btn.textContent; btn.textContent = text;
    setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = old; } }, 3500);
    return false;
  }

  // ===================================================================
  // ONE-TIME DICTIONARY LOAD (words come from scrabble-words.txt next to this page)
  // ===================================================================
  async function loadDictionary() {
    if (ui.dictProgress) return;
    const setP = (pct, text) => { ui.dictProgress = { pct, text }; if (S.snap && S.snap.game.status === 'LOBBY') render(); };
    try {
      setP(2, 'Downloading word list…');
      const res = await fetch('scrabble-words.txt', { cache: 'force-cache' });
      if (!res.ok) throw new Error('Could not download scrabble-words.txt');
      const words = (await res.text()).split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => /^[a-z]{2,15}$/.test(w));
      const by = {}; words.forEach(w => (by[w[0]] = by[w[0]] || []).push(w));
      const chunks = [];
      Object.keys(by).sort().forEach(l => {
        let cur = [], len = 0, first = true;
        by[l].forEach(w => {
          cur.push(w); len += w.length + 1;
          if (len > 120000) { chunks.push({ l, text: cur.join(' '), first }); cur = []; len = 0; first = false; }
        });
        if (cur.length) chunks.push({ l, text: cur.join(' '), first });
      });
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await rpc('scr_dict_load', { p_bucket: c.l, p_chunk: c.text, p_first: c.first });
        setP(5 + Math.round(90 * (i + 1) / chunks.length), `Loading words… ${i + 1} of ${chunks.length}`);
      }
      await rpc('scr_dict_done');
      toast(`Dictionary loaded (${words.length.toLocaleString()} words).`, true);
    } catch (e) { toast(e.message); }
    ui.dictProgress = null;
    loadSnapshot();
  }
})();

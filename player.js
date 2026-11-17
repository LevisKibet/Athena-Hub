(function(){
  const BOOT = window.QA_BOOTSTRAP || {};
  const LS_KEY = 'quiz_arena_player_v2';
  const state = {
    conn: null,
    connPin: '',
    pendingJoin: '',
    joinTimeout: null,
    snapshot: null,
    playerId: '',
    gamePin: '',
    nickname: '',
    serverOffsetMs: 0,
    timerInterval: null,
    pendingAnswer: false
  };
  const stage = document.getElementById('playerStage');
  const errorEl = document.getElementById('playerError');

  // List of restricted keywords and phrases
  const RESTRICTED_TERMS = [
    'resignation',
    'resign',
    'tutam',
    'twoterms',
    'twoterm',
    'rutomustgo',
    'zakayo',
    'fuck',
    'shit',
    'bitch',
    'asshole',
    'cunt',
    'bastard',
    'dick',
    'pussy'
  ];

  // Helper function to detect blocked keywords
  function isRestrictedNickname(nickname) {
    // Strips out all spaces and special characters so bypasses like "T_U_T_A_M" or "R.e.s.i.g.n" are caught
    const cleanNick = String(nickname || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return RESTRICTED_TERMS.some(term => cleanNick.includes(term));
  }

  function getUrlPin() {
    try {
      const url = new URL(window.location.href);
      return (url.searchParams.get('pin') || url.searchParams.get('gamePin') || '').trim();
    } catch (err) {
      return '';
    }
  }

  function init() {
    if (!BOOT.realtimeUrl) {
      showError('Missing realtimeUrl in config.js.');
      renderJoin();
      return;
    }
    const urlPin = getUrlPin();
    const saved = readSaved();
    if (urlPin) state.gamePin = urlPin;
    if (saved && saved.playerId && saved.gamePin && (!urlPin || urlPin === saved.gamePin)) {
      // Coming back to the same game (page refresh, phone slept): pick up where we were.
      state.playerId = saved.playerId;
      state.gamePin = saved.gamePin;
      state.nickname = saved.nickname || '';
      stage.innerHTML = '<div class="join-card player-status"><p class="subtle"><span class="loading"></span> Reconnecting to your game…</p></div>';
      openConnection(state.gamePin);
    } else {
      renderJoin();
    }
  }

  // ---- Athena Sync connection (Cloudflare) ----
  function openConnection(pin) {
    if (state.conn && state.connPin === pin) return;
    if (state.conn) state.conn.close();
    state.connPin = pin;
    state.conn = window.AthenaSync.connect({
      url: BOOT.realtimeUrl,
      pin: pin,
      role: 'player',
      onOpen: function() {
        hideError();
        if (state.playerId) state.conn.send({ t: 'resume', playerId: state.playerId });
        else if (state.pendingJoin) state.conn.send({ t: 'join', nickname: state.pendingJoin });
      },
      onStatus: function(s) {
        if (s === 'reconnecting' && state.snapshot) showError('Connection lost. Reconnecting…');
      },
      onMessage: onServerMessage,
      onClosedByServer: function() { state.conn = null; state.connPin = ''; }
    });
  }

  function onServerMessage(msg) {
    if (msg.t === 'joined') {
      clearTimeout(state.joinTimeout);
      state.pendingJoin = '';
      state.playerId = msg.playerId;
      state.nickname = msg.nickname;
      state.gamePin = msg.gamePin || state.gamePin;
      savePlayer();
    } else if (msg.t === 'snapshot') {
      setSnapshot(msg.snap);
    } else if (msg.t === 'unknown_player') {
      forgetPlayer();
      renderJoin();
    } else if (msg.t === 'reset') {
      forgetPlayer();
      showError('The host reset the room. Please join again.');
      renderJoin();
    } else if (msg.t === 'error') {
      clearTimeout(state.joinTimeout);
      if (state.pendingJoin) {
        state.pendingJoin = '';
        if (state.conn) { state.conn.close(); state.conn = null; state.connPin = ''; }
        showError(msg.message);
        renderJoin();
        return;
      }
      if (state.pendingAnswer) { state.pendingAnswer = false; render(); }
      showError(msg.message);
    }
  }

  function forgetPlayer() {
    state.playerId = '';
    state.snapshot = null;
    state.pendingAnswer = false;
    clearInterval(state.timerInterval);
    try { localStorage.removeItem(LS_KEY); } catch (err) {}
  }

  function renderJoin() {
    stage.innerHTML = `
      <div class="join-card">
        <h1 class="display" style="font-size:52px;margin:0 0 8px;text-align:center">Join the Arena</h1>
        <p class="subtle" style="text-align:center;margin-bottom:22px">Enter the Game PIN and your stadium nickname.</p>
        <form id="joinForm">
          <label class="subtle" for="pinInput">Game PIN</label>
          <input id="pinInput" class="input" inputmode="numeric" autocomplete="one-time-code" value="${escapeAttr(BOOT.gamePin || state.gamePin || getUrlPin() || '')}" maxlength="12" placeholder="123456">
          <label class="subtle" for="nickInput">Nickname</label>
          <input id="nickInput" class="input" maxlength="20" autocomplete="nickname" value="${escapeAttr(state.nickname || '')}" placeholder="Your name">
          <button class="btn big" style="width:100%" type="submit">Enter Stadium</button>
        </form>
      </div>`;
    document.getElementById('joinForm').addEventListener('submit', join);
  }

  async function join(e) {
    e.preventDefault();
    hideError();
    const pin = document.getElementById('pinInput').value.trim();
    const nick = document.getElementById('nickInput').value.trim();
    if (!pin) return showError('Game PIN is required.');
    if (!/^\d{4,12}$/.test(pin)) return showError('The Game PIN is numbers only.');
    if (!nick) return showError('Nickname is required.');
    if (nick.length > 20) return showError('Nickname must be 20 characters or fewer.');
    
    if (isRestrictedNickname(nick)) {
      return showError('Please choose an appropriate nickname.');
    }

    stage.querySelector('button').disabled = true;
    stage.querySelector('button').innerHTML = '<span class="loading"></span> Joining';
    forgetPlayer();
    state.gamePin = pin;
    state.pendingJoin = nick;
    if (state.conn && state.connPin === pin && state.conn.isOpen()) state.conn.send({ t: 'join', nickname: nick });
    else openConnection(pin);
    clearTimeout(state.joinTimeout);
    state.joinTimeout = setTimeout(function(){
      if (!state.pendingJoin) return;
      state.pendingJoin = '';
      if (state.conn) { state.conn.close(); state.conn = null; state.connPin = ''; }
      showError("Couldn't reach the game. Check your connection and try again.");
      renderJoin();
    }, 15000);
  }

  function setSnapshot(snap) {
    if (!snap || !snap.game || !snap.player) return;
    const prev = state.snapshot;
    state.snapshot = snap;
    state.serverOffsetMs = new Date(snap.serverTime).getTime() - Date.now();
    state.playerId = snap.player.playerId;
    state.nickname = snap.player.nickname;
    if (snap.answer) state.pendingAnswer = false;
    if (prev && prev.game.currentRound !== snap.game.currentRound) state.pendingAnswer = false;
    savePlayer();
    hideError();
    render();
    startTimerLoop();
  }

  function nowServerMs() { return Date.now() + state.serverOffsetMs; }
  function startTimerLoop() {
    clearInterval(state.timerInterval);
    state.timerInterval = setInterval(updateTimer, 180);
    updateTimer();
  }
  function updateTimer() {
    const snap = state.snapshot;
    if (!snap || !snap.game || snap.game.status !== 'QUESTION') return;
    const g = snap.game;
    const limit = Number(g.questionTimerLimit || 20);
    const started = new Date(g.questionStartedAt || snap.serverTime).getTime();
    const remaining = Math.max(0, limit - ((nowServerMs() - started) / 1000));
    const timer = document.getElementById('playerTimer');
    if (timer) timer.textContent = String(Math.ceil(remaining));
    const ring = document.getElementById('playerTimerRing');
    if (ring) ring.style.setProperty('--pct', Math.max(0, Math.min(100, remaining / limit * 100)) + '%');
  }

  function render() {
    const snap = state.snapshot;
    if (!snap) return renderJoin();
    const status = snap.game.status;
    if (status === 'LOBBY' || status === 'PRECOUNTDOWN') return renderWaiting(status);
    if (status === 'QUESTION') return renderQuestionController();
    if (status === 'REVEAL' || status === 'LEADERBOARD') return renderBetweenQuestions(status);
    if (status === 'FINISHED') return renderFinished();
    renderWaiting(status);
  }

  function renderWaiting(status) {
    const p = state.snapshot.player;
    stage.innerHTML = `
      <div class="join-card player-status">
        ${scoreBadge(p)}
        <h1 class="display" style="font-size:48px;margin:0 0 12px">You're in!</h1>
        <p class="subtle">Check the stadium jumbotron for your name.</p>
        <div class="player-chip" style="width:max-content;margin:20px auto 0"><span class="avatar" style="background:${escapeAttr(p.avatarColor)}">${escapeHtml((p.nickname || '?').slice(0,1).toUpperCase())}</span>${escapeHtml(p.nickname)}</div>
        <p class="status-pill" style="margin:22px auto 0;width:max-content"><span class="status-dot"></span>${escapeHtml(status)}</p>
      </div>`;
  }

  function renderQuestionController() {
    const snap = state.snapshot;
    const p = snap.player;
    const answered = !!snap.answer;
    if (answered || state.pendingAnswer) {
      stage.innerHTML = `
        <div class="join-card player-status">
          <div class="player-chip" style="width:max-content;margin:0 auto 20px"><span class="avatar" style="background:${escapeAttr(p.avatarColor)}">${escapeHtml((p.nickname || '?').slice(0,1).toUpperCase())}</span>${escapeHtml(p.nickname)}</div>
          <h1 class="display" style="font-size:46px;margin:0 0 10px">Answer submitted</h1>
          <p class="subtle">Check the main screen.</p>
          <div style="font-size:80px;margin-top:20px">✅</div>
        </div>`;
      return;
    }

    /* Player View renders clean letter choice buttons without shape emojis */
    stage.innerHTML = `
      <div class="join-card">
        <div class="player-status">
          ${scoreBadge(p)}
          <div id="playerTimerRing" class="timer-ring" style="width:96px;height:96px;margin-bottom:18px"><div class="timer-ring-inner" style="width:76px;height:76px;font-size:28px"><span id="playerTimer">${Number(snap.game.questionTimerLimit || 20)}</span></div></div>
          <h2 style="margin:0 0 18px">Choose your answer</h2>
          <p class="subtle" style="margin-top:-8px">Question text is on the jumbotron.</p>
        </div>
        <div class="controller-grid">
          ${['A','B','C','D'].map(function(letter){ return `<button class="controller-btn ${letter}" data-choice="${letter}">${letter}</button>`; }).join('')}
        </div>
      </div>`;
    document.querySelectorAll('[data-choice]').forEach(function(btn){
      btn.addEventListener('click', function(){ submitAnswer(btn.getAttribute('data-choice')); });
    });
    updateTimer();
  }

  function submitAnswer(choice) {
    if (state.pendingAnswer || !state.conn) return;
    const sent = state.conn.send({ t: 'answer', round: state.snapshot.game.currentRound, choice: choice });
    if (!sent) return showError('Not connected. Reconnecting… try again in a second.');
    state.pendingAnswer = true;
    renderQuestionController();
  }

  function renderBetweenQuestions(status) {
    state.pendingAnswer = false;
    const p = state.snapshot.player;
    const a = state.snapshot.answer;
    const result = a && a.pointsAwarded !== null ? (a.isCorrect ? 'Correct!' : (a.choice === 'TIMEOUT' ? 'No answer' : 'Not this time')) : 'Round complete';
    const points = a && a.pointsAwarded !== null ? `${Number(a.pointsAwarded || 0).toLocaleString()} pts` : '';
    stage.innerHTML = `
      <div class="join-card player-status">
        ${scoreBadge(p)}
        <h1 class="display" style="font-size:48px;margin:0 0 10px">${escapeHtml(result)}</h1>
        <p class="subtle">${escapeHtml(points)} ${points ? 'this round' : 'Check the jumbotron.'}</p>
        <div class="card" style="margin-top:20px;padding:18px">
          <div style="font-size:18px;color:var(--muted)">Current Rank</div>
          <div class="pin" style="font-size:80px">#${p.rank || '—'}</div>
          <div style="font-weight:1000;font-size:28px">${Number(p.totalScore || 0).toLocaleString()} points</div>
        </div>
        <p class="status-pill" style="margin:22px auto 0;width:max-content"><span class="status-dot"></span>${escapeHtml(status)}</p>
      </div>`;
  }

  function renderFinished() {
    state.pendingAnswer = false;
    const p = state.snapshot.player;
    stage.innerHTML = `
      <div class="join-card player-status">
        <div style="font-size:80px">🏆</div>
        <h1 class="display" style="font-size:52px;margin:0 0 10px">Final Score</h1>
        <div class="pin" style="font-size:86px">#${p.rank || '—'}</div>
        <div style="font-weight:1000;font-size:34px">${Number(p.totalScore || 0).toLocaleString()} pts</div>
        <p class="subtle">Great game, ${escapeHtml(p.nickname)}.</p>
        <button class="btn secondary" id="leaveBtn" style="margin-top:18px">Join another game</button>
      </div>`;
    document.getElementById('leaveBtn').onclick = function(){ forgetPlayer(); if (state.conn) state.conn.close(); state.conn = null; state.connPin = ''; renderJoin(); };
  }

  function scoreBadge(p) {
    return `<div class="score-badge"><span>${escapeHtml(p.nickname || '')}</span><span>Score: ${Number(p.totalScore || 0).toLocaleString()}</span><span>Rank: #${p.rank || '—'}</span></div>`;
  }

  function readSaved() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (err) { return null; }
  }
  function savePlayer() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ gamePin: state.gamePin, playerId: state.playerId, nickname: state.nickname })); } catch (err) {}
  }
  function shape(letter) { return ({ A:'▲', B:'✕', C:'●', D:'■' })[letter] || letter; }
  function showError(message) { errorEl.textContent = String(message || 'Something went wrong.'); errorEl.classList.remove('hidden'); }
  function hideError() { errorEl.classList.add('hidden'); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }

  window.addEventListener('load', init);
})();

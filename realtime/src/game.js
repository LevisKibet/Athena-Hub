// Athena Sync game room logic.
//
// One GameLogic instance runs inside one Durable Object, and one Durable Object
// exists per game PIN. Everything here is plain JavaScript with no Cloudflare
// imports, so the same code runs in the Worker and in the local simulation
// (test/sim.mjs).
//
// The snapshots it sends keep the same shape the old Supabase RPCs returned
// (qa_host_snapshot / qa_player_snapshot), so the host and player screens did
// not need to change how they render.

const AVATAR_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'
];
const CHOICES = ['A', 'B', 'C', 'D'];
const MAX_PLAYERS = 1500;
const LEADERBOARD_SIZE = 10;
const PRECOUNTDOWN_SECONDS = 3;
const ANSWER_GRACE_MS = 1500;      // allowance for network delay on the last second
const HOST_BROADCAST_MS = 250;     // at most 4 host screen updates per second
const MAX_QUESTIONS = 200;

function nowIso(ms) { return new Date(ms).toISOString(); }
function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function cleanText(v, max) { return String(v == null ? '' : v).slice(0, max); }

export class GameLogic {
  /**
   * @param storage  { get(k), put(k,v), delete(k|k[]), list({prefix}) } (Durable Object storage API)
   * @param io       { sockets(tag), meta(ws), setMeta(ws,m), send(ws,obj), close(ws,code,reason), isOpen(ws),
   *                   setAlarm(ms), setTimer(fn,ms), clearTimer(h), now() }
   */
  constructor(storage, io) {
    this.storage = storage;
    this.io = io;
    this.game = null;
    this.questions = [];
    this.players = new Map();
    this.nickIndex = new Map();
    this.hostTimer = null;
  }

  async load() {
    this.game = (await this.storage.get('game')) || null;
    this.questions = (await this.storage.get('questions')) || [];
    const rows = await this.storage.list({ prefix: 'p:' });
    for (const p of rows.values()) {
      this.players.set(p.playerId, p);
      this.nickIndex.set(p.nickname.toLowerCase(), p.playerId);
    }
  }

  now() { return this.io.now(); }

  // ---------- persistence ----------
  async saveGame() { this.game.updatedAt = this.now(); await this.storage.put('game', this.game); }
  async savePlayer(p) { await this.storage.put('p:' + p.playerId, p); }
  async saveAllPlayers() {
    // put() accepts up to 128 entries per call
    const entries = Array.from(this.players.values());
    for (let i = 0; i < entries.length; i += 128) {
      const batch = {};
      entries.slice(i, i + 128).forEach(p => { batch['p:' + p.playerId] = p; });
      await this.storage.put(batch);
    }
  }

  // ---------- message entry points ----------
  async onMessage(ws, raw, pin) {
    const meta = this.io.meta(ws) || {};
    const limit = meta.role === 'host' ? 900000 : 4000;
    if (typeof raw !== 'string' || raw.length > limit) return this.error(ws, 'Message too large.');
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return this.error(ws, 'Bad message.'); }
    if (!msg || typeof msg.t !== 'string') return;

    try {
      if (meta.role === 'host') return await this.onHostMessage(ws, meta, msg, pin);
      return await this.onPlayerMessage(ws, meta, msg);
    } catch (err) {
      this.error(ws, err && err.message ? err.message : String(err));
    }
  }

  async onClose(ws) {
    const meta = this.io.meta(ws) || {};
    if (meta.role === 'player') this.scheduleHostBroadcast();
    if (meta.role === 'host') this.broadcastHosts();
  }

  async onAlarm() {
    if (!this.game) return;
    const g = this.game;
    const t = this.now();
    // Backup for a host tab that froze or went to sleep: keep the game moving.
    if (g.status === 'QUESTION' && t >= g.questionStartedAt + g.questionTimerLimit * 1000 + ANSWER_GRACE_MS) {
      await this.reveal();
    } else if (g.status === 'PRECOUNTDOWN' && t >= g.precountdownStartedAt + (PRECOUNTDOWN_SECONDS + 2) * 1000) {
      await this.startQuestion();
    } else {
      this.armAlarm();
    }
  }

  // ---------- host ----------
  async onHostMessage(ws, meta, msg, pin) {
    if (msg.t === 'host_hello') {
      const session = cleanText(msg.session, 64);
      if (!session) throw new Error('Missing host session.');
      meta.session = session;
      this.io.setMeta(ws, meta);

      if (!this.game) {
        this.game = {
          gamePin: cleanText(pin, 12), status: 'LOBBY', currentRound: 0,
          questionTimerLimit: 20, questionStartedAt: null, precountdownStartedAt: null,
          controllerSession: '', title: '', createdAt: this.now(), updatedAt: this.now()
        };
      }
      // Questions can only be replaced before the game starts.
      if (Array.isArray(msg.questions) && this.game.status === 'LOBBY' && this.game.currentRound === 0) {
        this.questions = msg.questions.slice(0, MAX_QUESTIONS).map(normalizeQuestion).filter(Boolean);
        await this.storage.put('questions', this.questions);
      }
      if (msg.title) this.game.title = cleanText(msg.title, 120);

      // Same rule as the old host lock: if nobody is controlling, you are.
      const g = this.game;
      const controllerOnline = this.openSockets('host').some(s => s !== ws && (this.io.meta(s) || {}).session === g.controllerSession);
      if (!g.controllerSession || !controllerOnline || g.controllerSession === session) g.controllerSession = session;
      await this.saveGame();
      return this.broadcastHosts();
    }

    if (!this.game) throw new Error('Room not ready.');
    if (meta.session !== this.game.controllerSession) throw new Error('Another screen is controlling this match.');

    if (msg.t === 'advance') return this.advance();
    if (msg.t === 'reveal') return this.reveal();
    if (msg.t === 'reset') return this.reset();
  }

  async advance() {
    const g = this.game;
    if (g.status === 'LOBBY') {
      if (!this.questions.length) throw new Error('This match has no questions.');
      return this.startPrecountdown(1);
    }
    if (g.status === 'PRECOUNTDOWN') return this.startQuestion();
    if (g.status === 'QUESTION') return this.reveal();
    if (g.status === 'REVEAL') { g.status = 'LEADERBOARD'; await this.saveGame(); return this.broadcastAll(); }
    if (g.status === 'LEADERBOARD') {
      if (g.currentRound < this.questions.length) return this.startPrecountdown(g.currentRound + 1);
      g.status = 'FINISHED'; await this.saveGame(); return this.broadcastAll();
    }
    // FINISHED: nothing to advance to
    return this.broadcastHosts();
  }

  async startPrecountdown(round) {
    const g = this.game;
    g.status = 'PRECOUNTDOWN';
    g.currentRound = round;
    g.precountdownStartedAt = this.now();
    g.questionStartedAt = null;
    const q = this.questions[round - 1];
    g.questionTimerLimit = q ? q.timeLimit : 20;
    await this.saveGame();
    this.armAlarm();
    return this.broadcastAll();
  }

  async startQuestion() {
    const g = this.game;
    if (g.status !== 'PRECOUNTDOWN') return this.broadcastHosts();
    g.status = 'QUESTION';
    g.questionStartedAt = this.now();
    await this.saveGame();
    this.armAlarm();
    return this.broadcastAll();
  }

  async reveal() {
    const g = this.game;
    if (g.status !== 'QUESTION' && g.status !== 'PRECOUNTDOWN') return this.broadcastHosts();
    const round = g.currentRound;
    const key = String(round);
    for (const p of this.players.values()) {
      if (!p.answers[key]) p.answers[key] = { choice: 'TIMEOUT', isCorrect: false, pointsAwarded: 0, answeredAt: null };
      const a = p.answers[key];
      if (a.pointsAwarded === null) {
        // scored at answer time but hidden until reveal
        a.pointsAwarded = a.pendingPoints || 0;
        delete a.pendingPoints;
        p.totalScore += a.pointsAwarded;
      }
    }
    this.recomputeRanks();
    g.status = 'REVEAL';
    await this.saveGame();
    await this.saveAllPlayers();
    return this.broadcastAll();
  }

  async reset() {
    const ids = Array.from(this.players.keys()).map(id => 'p:' + id);
    for (let i = 0; i < ids.length; i += 128) await this.storage.delete(ids.slice(i, i + 128));
    this.players.clear();
    this.nickIndex.clear();
    this.sorted = null;
    const g = this.game;
    g.status = 'LOBBY'; g.currentRound = 0;
    g.questionStartedAt = null; g.precountdownStartedAt = null;
    await this.saveGame();
    for (const ws of this.openSockets('player')) {
      this.io.send(ws, { t: 'reset' });
      this.io.close(ws, 4000, 'Room reset');
    }
    return this.broadcastHosts();
  }

  // ---------- players ----------
  async onPlayerMessage(ws, meta, msg) {
    if (msg.t === 'join') {
      if (!this.game) throw new Error('Game not found. Check the PIN, or wait for the host to open the room.');
      if (this.game.status !== 'LOBBY') throw new Error('This game has already started.');
      const nickname = cleanText(msg.nickname, 20).trim();
      if (!nickname) throw new Error('Nickname is required.');
      if (this.nickIndex.has(nickname.toLowerCase())) throw new Error('That nickname is taken. Try another one.');
      if (this.players.size >= MAX_PLAYERS) throw new Error('This game is full.');
      const p = {
        playerId: randomId(), nickname,
        avatarColor: AVATAR_COLORS[this.players.size % AVATAR_COLORS.length],
        totalScore: 0, rank: null, joinedAt: this.now(), answers: {}
      };
      this.players.set(p.playerId, p);
      this.nickIndex.set(nickname.toLowerCase(), p.playerId);
      await this.savePlayer(p);
      meta.playerId = p.playerId;
      this.io.setMeta(ws, meta);
      this.io.send(ws, { t: 'joined', playerId: p.playerId, nickname: p.nickname, gamePin: this.game.gamePin });
      this.sendPlayer(ws, p);
      return this.scheduleHostBroadcast();
    }

    if (msg.t === 'resume') {
      const p = this.players.get(cleanText(msg.playerId, 64));
      if (!this.game || !p) { this.io.send(ws, { t: 'unknown_player' }); return; }
      meta.playerId = p.playerId;
      this.io.setMeta(ws, meta);
      this.sendPlayer(ws, p);
      return this.scheduleHostBroadcast();
    }

    if (msg.t === 'answer') {
      const p = this.players.get(meta.playerId);
      if (!p) throw new Error('Join the game first.');
      const g = this.game;
      const choice = String(msg.choice || '').toUpperCase();
      if (!CHOICES.includes(choice)) throw new Error('Invalid choice.');
      if (g.status !== 'QUESTION' || Number(msg.round) !== g.currentRound) throw new Error('Time is up for this question.');
      const elapsedMs = this.now() - g.questionStartedAt;
      if (elapsedMs > g.questionTimerLimit * 1000 + ANSWER_GRACE_MS) throw new Error('Time is up for this question.');
      const key = String(g.currentRound);
      if (p.answers[key]) { this.sendPlayer(ws, p); return; }   // already answered: just resend state
      const q = this.questions[g.currentRound - 1];
      const isCorrect = !!q && q.correct === choice;
      const frac = Math.min(1, Math.max(0, elapsedMs / (g.questionTimerLimit * 1000)));
      const points = isCorrect ? Math.round(1000 * (1 - frac / 2)) : 0;
      // Correctness and points stay hidden from the phone until the reveal.
      p.answers[key] = { choice, isCorrect: null, pointsAwarded: null, pendingPoints: points, answeredAt: this.now(), correctHidden: isCorrect };
      await this.savePlayer(p);
      this.sendPlayer(ws, p);
      return this.scheduleHostBroadcast(true);
    }
  }

  recomputeRanks() {
    const sorted = Array.from(this.players.values()).sort((a, b) => (b.totalScore - a.totalScore) || (a.joinedAt - b.joinedAt));
    let lastScore = null, lastRank = 0;
    sorted.forEach((p, i) => {
      if (p.totalScore !== lastScore) { lastRank = i + 1; lastScore = p.totalScore; }
      p.rank = lastRank;
    });
    // Reveal correctness now that the round is closed.
    const key = String(this.game.currentRound);
    for (const p of sorted) {
      const a = p.answers[key];
      if (a && a.isCorrect === null) { a.isCorrect = !!a.correctHidden; delete a.correctHidden; }
    }
    this.sorted = sorted;
  }

  // ---------- snapshots ----------
  baseGame(includeHostFields) {
    const g = this.game;
    const out = {
      id: g.gamePin, gamePin: g.gamePin, status: g.status, currentRound: g.currentRound,
      questionTimerLimit: g.questionTimerLimit,
      questionStartedAt: g.questionStartedAt ? nowIso(g.questionStartedAt) : null
    };
    if (includeHostFields) {
      out.precountdownStartedAt = g.precountdownStartedAt ? nowIso(g.precountdownStartedAt) : null;
      out.totalRounds = this.questions.length;
      out.title = g.title;
    }
    return out;
  }

  playerSnapshot(p) {
    const g = this.game;
    const raw = p.answers[String(g.currentRound)] || null;
    let answer = null;
    if (raw && (g.status === 'QUESTION' || g.status === 'REVEAL' || g.status === 'LEADERBOARD' || g.status === 'FINISHED')) {
      answer = { choice: raw.choice, isCorrect: raw.isCorrect, pointsAwarded: raw.pointsAwarded };
    }
    return {
      serverTime: nowIso(this.now()),
      game: this.baseGame(false),
      player: { playerId: p.playerId, nickname: p.nickname, avatarColor: p.avatarColor, totalScore: p.totalScore, rank: p.rank },
      answer
    };
  }

  hostSnapshot() {
    const g = this.game;
    const round = String(g.currentRound);
    const stats = { A: 0, B: 0, C: 0, D: 0, total: 0 };
    const players = [];
    for (const p of this.players.values()) {
      players.push({ playerId: p.playerId, nickname: p.nickname, avatarColor: p.avatarColor });
      const a = p.answers[round];
      if (a && CHOICES.includes(a.choice)) { stats[a.choice]++; stats.total++; }
    }
    const online = new Set();
    for (const ws of this.openSockets('player')) {
      const m = this.io.meta(ws);
      if (m && m.playerId) online.add(m.playerId);
    }
    const q = g.currentRound > 0 ? this.questions[g.currentRound - 1] : null;
    const ranked = this.sorted || Array.from(this.players.values()).sort((a, b) => b.totalScore - a.totalScore);
    return {
      serverTime: nowIso(this.now()),
      game: this.baseGame(true),
      players,
      question: q ? { ...q, image_url: q.imageUrl } : null,
      answerStats: stats,
      activePlayerCount: online.size,
      playerCount: this.players.size,
      leaderboard: ranked.slice(0, LEADERBOARD_SIZE).map((p, i) => ({ nickname: p.nickname, totalScore: p.totalScore, rank: p.rank || i + 1, avatarColor: p.avatarColor }))
    };
  }

  // ---------- sending ----------
  openSockets(tag) { return this.io.sockets(tag).filter(ws => this.io.isOpen(ws)); }

  sendPlayer(ws, p) { this.io.send(ws, { t: 'snapshot', snap: this.playerSnapshot(p) }); }

  broadcastPlayers() {
    for (const ws of this.openSockets('player')) {
      const m = this.io.meta(ws);
      const p = m && this.players.get(m.playerId);
      if (p) this.sendPlayer(ws, p);
    }
  }

  broadcastHosts() {
    if (this.hostTimer) { this.io.clearTimer(this.hostTimer); this.hostTimer = null; }
    if (!this.game) return;
    const snap = this.hostSnapshot();
    for (const ws of this.openSockets('host')) {
      const m = this.io.meta(ws) || {};
      this.io.send(ws, { t: 'host_snapshot', snap: { ...snap, isController: m.session === this.game.controllerSession } });
    }
  }

  // Joins and answers arrive in bursts; batch the host screen updates.
  scheduleHostBroadcast(answerPing) {
    if (answerPing) {
      for (const ws of this.openSockets('host')) this.io.send(ws, { t: 'answer_ping' });
    }
    if (this.hostTimer) return;
    this.hostTimer = this.io.setTimer(() => { this.hostTimer = null; this.broadcastHosts(); }, HOST_BROADCAST_MS);
  }

  broadcastAll() { this.broadcastHosts(); this.broadcastPlayers(); }

  armAlarm() {
    const g = this.game;
    if (g.status === 'QUESTION') this.io.setAlarm(g.questionStartedAt + g.questionTimerLimit * 1000 + ANSWER_GRACE_MS + 500);
    else if (g.status === 'PRECOUNTDOWN') this.io.setAlarm(g.precountdownStartedAt + (PRECOUNTDOWN_SECONDS + 2) * 1000);
  }

  error(ws, message) { this.io.send(ws, { t: 'error', message }); }
}

function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const correct = String(q.correct || '').toUpperCase();
  let image = cleanText(q.imageUrl || q.image_url || '', 2000);
  if (image.startsWith('data:')) image = '';
  const limit = Number(q.timeLimit || q.time_limit || 20);
  return {
    question: cleanText(q.question, 1000),
    optionA: cleanText(q.optionA != null ? q.optionA : q.option_a, 300),
    optionB: cleanText(q.optionB != null ? q.optionB : q.option_b, 300),
    optionC: cleanText(q.optionC != null ? q.optionC : q.option_c, 300),
    optionD: cleanText(q.optionD != null ? q.optionD : q.option_d, 300),
    correct: CHOICES.includes(correct) ? correct : 'A',
    imageUrl: image || 'Images/kahoot.jpg',
    timeLimit: Math.min(240, Math.max(5, isFinite(limit) ? limit : 20))
  };
}

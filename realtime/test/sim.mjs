// In-process simulation of a full game: N players, Q questions.
// Runs the real game logic with a fake storage and fake sockets.
//   node test/sim.mjs [players=450] [questions=10]
import { GameLogic } from '../src/game.js';

const N = Number(process.argv[2] || 450);
const Q = Number(process.argv[3] || 10);

let clock = Date.parse('2026-11-18T09:00:00Z');
const store = new Map();
let storageWrites = 0;
const storage = {
  async get(k) { return structuredClone(store.get(k)); },
  async put(k, v) {
    if (typeof k === 'object') { for (const [kk, vv] of Object.entries(k)) { store.set(kk, structuredClone(vv)); storageWrites++; } }
    else { store.set(k, structuredClone(v)); storageWrites++; }
  },
  async delete(k) { (Array.isArray(k) ? k : [k]).forEach(x => store.delete(x)); },
  async list({ prefix }) { const m = new Map(); for (const [k, v] of store) if (k.startsWith(prefix)) m.set(k, structuredClone(v)); return m; }
};

class FakeWS {
  constructor(role) { this.role = role; this.open = true; this.inbox = []; this.attachment = { role, pin: '123456' }; }
}
const sockets = [];
let sent = 0, sentBytes = 0, alarmAt = null;
const io = {
  sockets: tag => sockets.filter(s => s.role === tag),
  meta: ws => ws.attachment,
  setMeta: (ws, m) => { ws.attachment = { ...m }; },
  send: (ws, obj) => { const s = JSON.stringify(obj); sent++; sentBytes += s.length; ws.inbox.push(obj); },
  close: ws => { ws.open = false; },
  isOpen: ws => ws.open,
  setAlarm: ms => { alarmAt = ms; },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: h => clearTimeout(h),
  now: () => clock
};

let incoming = 0;
let logic = new GameLogic(storage, io);
await logic.load();
const send = async (ws, obj) => { incoming++; await logic.onMessage(ws, JSON.stringify(obj), '123456'); };
const last = (ws, t) => [...ws.inbox].reverse().find(m => m.t === t);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };

// Host opens the room with questions
const host = new FakeWS('host'); sockets.push(host);
const spectator = new FakeWS('host'); sockets.push(spectator);
const questions = Array.from({ length: Q }, (_, i) => ({ question: 'Q' + (i + 1), option_a: 'a', option_b: 'b', option_c: 'c', option_d: 'd', correct: 'ABCD'[i % 4], time_limit: 20, image_url: 'Images/x.jpg' }));
await send(host, { t: 'host_hello', session: 'hostA', questions, title: 'Test' });
await send(spectator, { t: 'host_hello', session: 'hostB' });
assert(last(host, 'host_snapshot').snap.isController === true, 'host should control');
assert(last(spectator, 'host_snapshot').snap.isController === false, 'second screen should be spectator');

// Players join
const players = [];
for (let i = 0; i < N; i++) {
  const ws = new FakeWS('player'); sockets.push(ws);
  await send(ws, { t: 'join', nickname: 'Player' + i });
  const j = last(ws, 'joined'); assert(j, 'join failed for ' + i);
  ws.playerId = j.playerId; players.push(ws);
}
const dup = new FakeWS('player'); sockets.push(dup);
await send(dup, { t: 'join', nickname: 'player0' });
assert(last(dup, 'error'), 'duplicate nickname should be refused');
dup.open = false;

// Spectator cannot control
await send(spectator, { t: 'advance' });
assert(last(spectator, 'error'), 'spectator advance should be refused');

await new Promise(r => setTimeout(r, 300));
let hs = last(host, 'host_snapshot').snap;
assert(hs.players.length === N, 'host should see all players, saw ' + hs.players.length);

// Simulate one player dropping and reconnecting mid-game
const dropper = players[7];
const expected = new Map();

for (let round = 1; round <= Q; round++) {
  await send(host, { t: 'advance' });                 // -> PRECOUNTDOWN (or from LEADERBOARD)
  assert(logic.game.status === 'PRECOUNTDOWN', 'expected PRECOUNTDOWN, got ' + logic.game.status);
  clock += 3000;
  await send(host, { t: 'advance' });                 // -> QUESTION
  assert(logic.game.status === 'QUESTION', 'expected QUESTION');
  const start = clock;
  const correct = 'ABCD'[(round - 1) % 4];

  if (round === 3) { dropper.open = false; await logic.onClose(dropper); }

  for (let i = 0; i < players.length; i++) {
    const ws = players[i];
    if (!ws.open) continue;
    if (i % 10 === 9) continue;                         // 10% never answer
    clock = start + (i % 20) * 900;                     // spread answers over 18s
    const choice = i % 3 === 0 ? 'ABCD'[(round) % 4] : correct;
    await send(ws, { t: 'answer', round, choice });
    await send(ws, { t: 'answer', round, choice: 'A' }); // double tap is ignored
    const elapsed = clock - start;
    const pts = choice === correct ? Math.round(1000 * (1 - (elapsed / 20000) / 2)) : 0;
    expected.set(ws.playerId, (expected.get(ws.playerId) || 0) + pts);
    const snap = last(ws, 'snapshot').snap;
    assert(snap.answer && snap.answer.pointsAwarded === null && snap.answer.isCorrect === null, 'result must stay hidden until reveal');
  }
  if (round === 3) {
    const back = new FakeWS('player'); sockets.push(back);
    await send(back, { t: 'resume', playerId: dropper.playerId });
    assert(last(back, 'snapshot').snap.player.playerId === dropper.playerId, 'resume failed');
    back.playerId = dropper.playerId; players[7] = back;
  }
  // late answer is refused
  clock = start + 25000;
  const lateWs = players[9];
  await send(lateWs, { t: 'answer', round, choice: correct });
  assert(last(lateWs, 'error'), 'late answer should be refused');

  await new Promise(r => setTimeout(r, 300));
  hs = last(host, 'host_snapshot').snap;
  assert(hs.answerStats.total > 0, 'host should see answer counts');

  // timer runs out: host reveals (or the alarm would)
  await send(host, { t: 'reveal' });
  assert(logic.game.status === 'REVEAL', 'expected REVEAL');
  const ps = last(players[0], 'snapshot').snap;
  assert(ps.answer.pointsAwarded !== null && typeof ps.answer.isCorrect === 'boolean', 'result visible after reveal');
  await send(host, { t: 'advance' });                 // -> LEADERBOARD
  assert(logic.game.status === 'LEADERBOARD', 'expected LEADERBOARD');
}
await send(host, { t: 'advance' });
assert(logic.game.status === 'FINISHED', 'expected FINISHED, got ' + logic.game.status);

// Check every score
for (const ws of players) {
  const p = logic.players.get(ws.playerId);
  assert(p.totalScore === (expected.get(ws.playerId) || 0), `score mismatch for ${p.nickname}: ${p.totalScore} vs ${expected.get(ws.playerId)}`);
}
hs = last(host, 'host_snapshot').snap;
const top = hs.leaderboard;
assert(top.length === 10 && top[0].totalScore >= top[9].totalScore, 'leaderboard sorted');

// Object restart: state must survive (hibernation / eviction)
const restarted = new GameLogic(storage, io);
await restarted.load();
assert(restarted.players.size === N && restarted.game.status === 'FINISHED', 'state lost on restart');
const r0 = restarted.players.get(players[0].playerId);
assert(r0.totalScore === logic.players.get(players[0].playerId).totalScore, 'score lost on restart');

// Alarm backup: host goes quiet during a question
logic = restarted;
await send(host, { t: 'reset' });
assert(logic.game.status === 'LOBBY' && logic.players.size === 0, 'reset failed');
const p1 = new FakeWS('player'); sockets.push(p1);
await send(p1, { t: 'join', nickname: 'Solo' });
await send(host, { t: 'advance' });
clock += 6000; await logic.onAlarm();
assert(logic.game.status === 'QUESTION', 'alarm should start the question');
clock += 22500; await logic.onAlarm();
assert(logic.game.status === 'REVEAL', 'alarm should reveal');

await new Promise(r => setTimeout(r, 300));
console.log(`PASS  ${N} players x ${Q} questions`);
console.log(`  billable incoming messages: ${incoming} (free plan: 100,000/day; WebSocket messages are billed at 1/20, so ~${Math.ceil(incoming / 20)} requests)`);
console.log(`  outgoing messages: ${sent} (${(sentBytes / 1e6).toFixed(1)} MB) - not billed`);
console.log(`  storage writes: ${storageWrites}`);

// Athena Sync load test: one fake host + N fake phones play a short game.
//
//   node loadtest.mjs <worker-url> [players=450] [questions=5]
//   node loadtest.mjs https://athena-sync.yourname.workers.dev 450 5
//
// It uses its own random PIN (starting with 9), so it never touches a real
// match, and resets the room at the end. Needs Node 22+ (built-in WebSocket).

const base = (process.argv[2] || '').replace(/\/+$/, '').replace(/^http/, 'ws');
const N = Number(process.argv[3] || 450);
const Q = Number(process.argv[4] || 5);
const QUESTION_SECONDS = 10;
if (!base) { console.log('Usage: node loadtest.mjs <worker-url> [players] [questions]'); process.exit(1); }

const pin = '9' + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const url = role => `${base}/room/${pin}/ws?role=${role}`;

function client(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url(role));
    const c = { ws, inbox: [], waiters: [], open: false, errors: [] };
    c.send = obj => ws.send(JSON.stringify(obj));
    c.wait = (pred, ms = 15000) => new Promise((res, rej) => {
      const hit = c.inbox.find(pred);
      if (hit) return res(hit);
      const w = { pred, res };
      c.waiters.push(w);
      setTimeout(() => { c.waiters = c.waiters.filter(x => x !== w); rej(new Error('timeout')); }, ms);
    });
    ws.onopen = () => { c.open = true; resolve(c); };
    ws.onerror = () => { if (!c.open) reject(new Error('connect failed')); };
    ws.onclose = () => { c.open = false; };
    ws.onmessage = ev => {
      if (ev.data === 'pong') return;
      const m = JSON.parse(ev.data);
      if (m.t === 'error') c.errors.push(m.message);
      c.inbox.push(m);
      if (c.inbox.length > 50) c.inbox.shift();
      for (const w of [...c.waiters]) if (w.pred(m)) { c.waiters = c.waiters.filter(x => x !== w); w.res(m); }
    };
  });
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] : 0; };
const snapOf = (c, status, round) => c.wait(m => m.t === 'snapshot' && m.snap.game.status === status && (round == null || m.snap.game.currentRound === round));

console.log(`Load test: ${N} players, ${Q} questions, PIN ${pin}, ${base}`);
const t0 = Date.now();
const host = await client('host');
const questions = Array.from({ length: Q }, (_, i) => ({ question: 'Load test ' + (i + 1), option_a: 'A', option_b: 'B', option_c: 'C', option_d: 'D', correct: 'A', time_limit: QUESTION_SECONDS }));
host.send({ t: 'host_hello', session: 'loadtest-' + pin, questions, title: 'Load test' });
await host.wait(m => m.t === 'host_snapshot');

// Phones arrive over ~15 seconds, like people scanning a QR code.
const players = [];
let connectFails = 0, joinFails = 0;
const joinLatency = [];
await Promise.all(Array.from({ length: N }, async (_, i) => {
  await sleep(Math.random() * 15000);
  let c;
  try { c = await client('player'); } catch (e) { connectFails++; return; }
  const start = Date.now();
  c.send({ t: 'join', nickname: 'Bot' + i });
  try { await c.wait(m => m.t === 'joined'); joinLatency.push(Date.now() - start); players.push(c); }
  catch (e) { joinFails++; }
}));
await sleep(1000);
let hs = await host.wait(m => m.t === 'host_snapshot' && m.snap.players.length === players.length, 5000).catch(() => null);
console.log(`Joined: ${players.length}/${N} (connect failures ${connectFails}, join failures ${joinFails}); join time p50 ${pct(joinLatency, 50)}ms, p95 ${pct(joinLatency, 95)}ms`);
console.log(`Host sees ${hs ? hs.snap.players.length : '?'} players`);

const answerLatency = [];
let missedQuestion = 0, missedReveal = 0;
for (let round = 1; round <= Q; round++) {
  host.inbox.length = 0;
  players.forEach(p => { p.inbox.length = 0; });
  host.send({ t: 'advance' });                                     // get ready
  await sleep(3000);
  host.send({ t: 'advance' });                                     // question
  await Promise.all(players.map(async p => {
    try { await snapOf(p, 'QUESTION', round); } catch (e) { missedQuestion++; return; }
    if (Math.random() < 0.1) return;                               // some never answer
    await sleep(Math.random() * (QUESTION_SECONDS - 1) * 1000);
    const start = Date.now();
    p.send({ t: 'answer', round, choice: 'ABCD'[Math.floor(Math.random() * 4)] });
    try { await p.wait(m => m.t === 'snapshot' && m.snap.answer && m.snap.game.currentRound === round); answerLatency.push(Date.now() - start); }
    catch (e) { /* counted below */ }
  }));
  host.send({ t: 'reveal' });
  await Promise.all(players.map(p => snapOf(p, 'REVEAL', round).catch(() => { missedReveal++; })));
  hs = await host.wait(m => m.t === 'host_snapshot' && m.snap.game.status === 'REVEAL');
  console.log(`Round ${round}: ${hs.snap.answerStats.total} answers, ${hs.snap.activePlayerCount} phones connected`);
  host.send({ t: 'advance' });                                     // leaderboard
  await sleep(1000);
}
host.send({ t: 'advance' });
const fin = await host.wait(m => m.t === 'host_snapshot' && m.snap.game.status === 'FINISHED').catch(() => null);
const errors = players.flatMap(p => p.errors);
const stillOpen = players.filter(p => p.open).length;

console.log('---');
console.log(`Answer confirmation p50 ${pct(answerLatency, 50)}ms, p95 ${pct(answerLatency, 95)}ms, max ${pct(answerLatency, 100)}ms (${answerLatency.length} answers)`);
console.log(`Phones that missed a question: ${missedQuestion}, missed a reveal: ${missedReveal}`);
console.log(`Phones still connected at the end: ${stillOpen}/${players.length}`);
console.log(`Errors sent to phones: ${errors.length}${errors.length ? ' e.g. ' + errors[0] : ''}`);
console.log(`Winner: ${fin ? fin.snap.leaderboard[0].nickname + ' ' + fin.snap.leaderboard[0].totalScore : '?'}`);
console.log(`Total time ${(Date.now() - t0) / 1000}s`);

// Clean up the test room
host.send({ t: 'reset' });
await sleep(1500);
players.forEach(p => { try { p.ws.close(); } catch (e) {} });
host.ws.close();
const ok = players.length === N && missedQuestion === 0 && missedReveal === 0;
console.log(ok ? 'RESULT: PASS' : 'RESULT: CHECK THE NUMBERS ABOVE');
process.exit(ok ? 0 : 1);

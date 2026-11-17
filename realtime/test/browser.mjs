// Browser test: real kahoot.html host screen + real play.html phones in Chrome,
// against the local dev server, with Supabase stubbed out.
// Needs Playwright + Chrome; run test/devserver.mjs first. Adjust the require path below to where Playwright is installed.
import { createRequire } from 'node:module';
const require = createRequire('/opt/node22/lib/node_modules/');
const { chromium } = require('playwright');

const BASE = 'http://localhost:8787';
const PIN = '123456';
const shots = process.argv[2] || '/tmp/shots';
import fs from 'node:fs';
fs.mkdirSync(shots, { recursive: true });

const QUESTIONS = [
  { id: 1, sort_order: 1, question: 'What is the capital of Kenya?', option_a: 'Mombasa', option_b: 'Nairobi', option_c: 'Kisumu', option_d: 'Nakuru', correct: 'B', image_url: 'Images/Kenya@50.jpg', time_limit: 8 },
  { id: 2, sort_order: 2, question: 'Which planet is the Red Planet?', option_a: 'Mars', option_b: 'Venus', option_c: 'Jupiter', option_d: 'Saturn', correct: 'A', image_url: 'Images/focus.jpg', time_limit: 8 }
];
const supabaseStub = `
window.supabase = { createClient: function(){
  const data = { games: [{ id: 'g1', game_pin: '${PIN}', host_token: 'u1', status: 'LOBBY' }], questions: ${JSON.stringify(QUESTIONS)}, config: [{ key: 'title', value: 'Browser test' }] };
  function chain(table){ const res = { data: data[table] || [], error: null };
    const c = { select(){return c}, eq(){return c}, in(){return c}, order(){return c}, limit(){return c},
      single(){ return Promise.resolve({ data: (data[table]||[])[0] || null, error: null }); },
      then(a,b){ return Promise.resolve(res).then(a,b); } }; return c; }
  return { from: chain, rpc(){ return Promise.resolve({ data: null, error: { message: 'rpc should not be called' } }); },
    channel(){ throw new Error('supabase realtime should not be used'); },
    auth: { getSession(){ return Promise.resolve({ data: { session: null } }); }, getUser(){ return Promise.resolve({ data: { user: null } }); },
      onAuthStateChange(){ return { data: { subscription: { unsubscribe(){} } } }; } },
    storage: { from(){ return { getPublicUrl(){ return { data: { publicUrl: '' } }; } }; } },
    functions: { invoke(){ return Promise.resolve({}); } } };
}};`;

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const route = async page => {
  await page.route('**/supabase-js@2**', r => r.fulfill({ contentType: 'text/javascript', body: supabaseStub }));
  await page.route('**/config.js*', r => r.fulfill({ contentType: 'text/javascript', body: `window.QA_CONFIG = { supabaseUrl: 'x', anonKey: 'y', realtimeUrl: '${BASE}' };` }));
  await page.route(/fonts\.googleapis|fonts\.gstatic|cdnjs|cdn\.jsdelivr\.net\/npm\/(qrcode|mammoth|canvas)/, r => r.fulfill({ body: '' }));
};
const errors = [];
const hostPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await route(hostPage);
hostPage.on('pageerror', e => errors.push('host: ' + e.message));
hostPage.on('dialog', d => d.accept());
await hostPage.goto(BASE + '/kahoot.html');
await hostPage.waitForTimeout(800);
await hostPage.evaluate(() => window.hostMatch('g1'));
await hostPage.waitForSelector('text=Joined Players', { timeout: 8000 });

const phones = [];
for (const name of ['Amina', 'Brian']) {
  const p = await browser.newPage({ viewport: { width: 390, height: 780 } });
  await route(p);
  p.on('pageerror', e => errors.push(name + ': ' + e.message));
  await p.goto(BASE + '/play.html?pin=' + PIN);
  await p.fill('#nickInput', name);
  await p.click('button[type=submit]');
  await p.waitForSelector("text=You're in!", { timeout: 8000 });
  phones.push(p);
}
// Duplicate nickname is refused with a clear message
const dupe = await browser.newPage({ viewport: { width: 390, height: 780 } });
await route(dupe);
await dupe.goto(BASE + '/play.html?pin=' + PIN);
await dupe.fill('#nickInput', 'amina');
await dupe.click('button[type=submit]');
await dupe.waitForSelector('text=That nickname is taken', { timeout: 8000 });
await dupe.close();

await hostPage.waitForSelector('text=Brian', { timeout: 5000 });
await hostPage.screenshot({ path: shots + '/1-host-lobby.png' });
await phones[0].screenshot({ path: shots + '/1-phone-lobby.png' });

await hostPage.click('text=Start Game');
await hostPage.waitForSelector('text=GET READY', { timeout: 5000 });
// Host screen counts down 3s and starts the question on its own
await hostPage.waitForSelector('text=What is the capital of Kenya?', { timeout: 8000 });
await phones[0].waitForSelector('text=Choose your answer', { timeout: 5000 });
await hostPage.screenshot({ path: shots + '/2-host-question.png' });
await phones[0].screenshot({ path: shots + '/2-phone-question.png' });

await phones[0].click('[data-choice=B]');               // Amina: correct
await phones[0].waitForSelector('text=Answer submitted', { timeout: 5000 });
// Brian refreshes the page mid-question, then answers wrong
await phones[1].reload();
await phones[1].waitForSelector('text=Choose your answer', { timeout: 8000 });
await phones[1].click('[data-choice=C]');
await phones[1].waitForSelector('text=Answer submitted', { timeout: 5000 });
await hostPage.waitForSelector('text=2 / 2 answered', { timeout: 5000 });

// Timer runs out on the host -> reveal -> auto leaderboard
await phones[0].waitForSelector('text=Correct!', { timeout: 12000 });
await phones[1].waitForSelector('text=Not this time', { timeout: 5000 });
await phones[0].screenshot({ path: shots + '/3-phone-correct.png' });
await hostPage.waitForSelector('text=Leaderboard', { timeout: 8000 });
await hostPage.screenshot({ path: shots + '/3-host-leaderboard.png' });

// Round 2: nobody answers
await hostPage.waitForTimeout(800);
await hostPage.click('text=Next Question');
await hostPage.waitForSelector('text=Which planet is the Red Planet?', { timeout: 8000 });
await phones[1].waitForSelector('text=No answer', { timeout: 15000 });
await hostPage.waitForSelector('text=Next Question', { timeout: 8000 });
await hostPage.waitForTimeout(800);
await hostPage.click('text=Next Question');
await hostPage.waitForSelector('text=Final Podium', { timeout: 8000 });
await phones[0].waitForSelector('text=Final Score', { timeout: 5000 });
const rank = await phones[0].textContent('.pin');
await hostPage.waitForTimeout(15500);
await hostPage.screenshot({ path: shots + '/4-host-podium.png' });
await phones[0].screenshot({ path: shots + '/4-phone-final.png' });

// Reset sends phones back to the join screen
await hostPage.click('text=Reset Match');
await phones[1].waitForSelector('text=The host reset the room', { timeout: 5000 });

console.log('Amina final rank:', rank.trim());
console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'No page errors');
console.log('BROWSER TEST PASS');
await browser.close();

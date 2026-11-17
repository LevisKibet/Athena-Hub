// Local stand-in for the Cloudflare Worker, for testing without a Cloudflare
// account: serves the hub's static files and runs the same game logic over a
// tiny built-in WebSocket server (no npm packages needed).
//   node test/devserver.mjs [port=8787] [staticDir=..]
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GameLogic } from '../src/game.js';

const PORT = Number(process.argv[2] || 8787);
const STATIC = path.resolve(process.argv[3] || path.join(import.meta.dirname, '..', '..'));
const rooms = new Map();

function makeRoom(pin) {
  const store = new Map();
  const sockets = new Set();
  let alarm = null;
  const storage = {
    async get(k) { return structuredClone(store.get(k)); },
    async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) store.set(a, structuredClone(b)); else store.set(k, structuredClone(v)); },
    async delete(k) { (Array.isArray(k) ? k : [k]).forEach(x => store.delete(x)); },
    async list({ prefix }) { const m = new Map(); for (const [k, v] of store) if (k.startsWith(prefix)) m.set(k, structuredClone(v)); return m; }
  };
  const room = { sockets };
  const io = {
    sockets: tag => [...sockets].filter(s => s.meta.role === tag),
    meta: ws => ws.meta, setMeta: (ws, m) => { ws.meta = { ...m }; },
    send: (ws, obj) => ws.sendText(JSON.stringify(obj)),
    close: (ws, code, reason) => ws.closeWith(code, reason),
    isOpen: ws => ws.isOpen,
    setAlarm: ms => { clearTimeout(alarm); alarm = setTimeout(() => room.logic.onAlarm(), Math.max(0, ms - Date.now())); },
    setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: h => clearTimeout(h), now: () => Date.now()
  };
  room.logic = new GameLogic(storage, io);
  room.ready = room.logic.load();
  // Same as the Durable Object: one message at a time, in order.
  room.queue = Promise.resolve();
  return room;
}

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/health') return res.end('ok');
  const file = path.join(STATIC, decodeURIComponent(u.pathname === '/' ? '/Index.html' : u.pathname));
  if (!file.startsWith(STATIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };
  res.setHeader('content-type', types[path.extname(file).toLowerCase()] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

server.on('upgrade', async (req, socket) => {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/room\/(\d{4,12})\/ws$/);
  if (!m) return socket.destroy();
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const pin = m[1];
  if (!rooms.has(pin)) rooms.set(pin, makeRoom(pin));
  const room = rooms.get(pin);
  await room.ready;
  const ws = {
    meta: { role: u.searchParams.get('role') === 'host' ? 'host' : 'player', pin },
    isOpen: true,
    sendText: s => { if (ws.isOpen) socket.write(frame(1, Buffer.from(s))); },
    closeWith: (code = 1000, reason = '') => {
      if (!ws.isOpen) return;
      const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code, 0); p.write(reason, 2);
      socket.write(frame(8, p)); ws.isOpen = false; socket.end();
    }
  };
  room.sockets.add(ws);
  let buf = Buffer.alloc(0);
  const gone = () => { if (!room.sockets.has(ws)) return; ws.isOpen = false; room.sockets.delete(ws); room.queue = room.queue.then(() => room.logic.onClose(ws)); };
  socket.on('close', gone);
  socket.on('error', gone);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f; let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { ws.closeWith(1000); gone(); return; }
      if (op === 9) { socket.write(frame(10, data)); continue; }
      if (op !== 1) continue;
      const text = data.toString();
      if (text === 'ping') { ws.sendText('pong'); continue; }
      room.queue = room.queue.then(() => room.logic.onMessage(ws, text, pin)).catch(e => console.error(e));
    }
  });
});

server.listen(PORT, () => console.log(`Athena Sync dev server on http://localhost:${PORT} (static: ${STATIC})`));

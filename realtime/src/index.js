// Athena Sync realtime Worker.
//
//   wss://<worker>/room/<PIN>/ws?role=player   phones
//   wss://<worker>/room/<PIN>/ws?role=host     the jumbotron / host screen
//   https://<worker>/health                    quick check that the Worker is up
//
// Each PIN maps to one GameRoom Durable Object that holds the whole game.

import { DurableObject } from 'cloudflare:workers';
import { GameLogic } from './game.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok', { headers: { 'access-control-allow-origin': '*' } });

    const match = url.pathname.match(/^\/room\/(\d{4,12})\/ws$/);
    if (!match) return new Response('Not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });

    // Optional: only accept pages from your own site(s). Comma separated in wrangler.toml.
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    if (allowed.length && !allowed.includes(origin)) return new Response('Origin not allowed', { status: 403 });

    const id = env.GAME_ROOM.idFromName(match[1]);
    return env.GAME_ROOM.get(id).fetch(request);
  }
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Phones send "ping" every 20s; Cloudflare answers "pong" without waking
    // the object, so keep-alives cost nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    const io = {
      sockets: tag => ctx.getWebSockets(tag),
      meta: ws => { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } },
      setMeta: (ws, m) => ws.serializeAttachment(m),
      send: (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch (e) {} },
      close: (ws, code, reason) => { try { ws.close(code, reason); } catch (e) {} },
      isOpen: ws => ws.readyState === 1,
      setAlarm: ms => { ctx.storage.setAlarm(ms); },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: h => clearTimeout(h),
      now: () => Date.now()
    };
    this.logic = new GameLogic(ctx.storage, io);
    ctx.blockConcurrencyWhile(() => this.logic.load());
  }

  async fetch(request) {
    const url = new URL(request.url);
    const pin = url.pathname.split('/')[2];
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, pin });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const meta = this.logic.io.meta(ws);
    await this.logic.onMessage(ws, typeof message === 'string' ? message : '', meta.pin);
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (e) {}
    await this.logic.onClose(ws);
  }

  async webSocketError(ws) {
    await this.logic.onClose(ws);
  }

  async alarm() {
    await this.logic.onAlarm();
  }
}

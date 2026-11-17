# Athena Sync: live Kahoot games on Cloudflare

This folder holds the server for the live part of the Kahoot game. Questions, matches,
sign-in and the AI question generator stay on Supabase. When a game goes live, the
host screen and the phones connect to this Worker, not to Supabase Realtime. That
removes Supabase's free-plan limit of 200 connections.

- `src/game.js`: the game rules (joining, timing, scoring, leaderboard)
- `src/index.js`: the Cloudflare Worker and one Durable Object per game PIN
- `loadtest.mjs`: plays a full game with up to 450 fake phones against the live Worker
- `test/`: local tests that need no Cloudflare account (`sim.mjs`, `devserver.mjs`, `browser.mjs`)

## Set up (about 10 minutes, once)

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up.
2. In Terminal:
   ```
   cd ~/Documents/GitHub/"Athena Games"/"Athena Hub"/realtime
   npx wrangler login      # opens the browser; approve access
   npx wrangler deploy
   ```
   When it finishes, it prints the address, for example `https://athena-sync.<you>.workers.dev`.
3. Paste that address into `config.js` in the main folder:
   ```js
   realtimeUrl: "https://athena-sync.<you>.workers.dev"
   ```
4. Check that it works with a full rehearsal against the live Worker:
   ```
   node loadtest.mjs https://athena-sync.<you>.workers.dev 450 5
   ```
   It should end with `RESULT: PASS`. The test uses its own random PIN, so it never
   touches a real match.

## Going live, and going back

The site is served by GitHub Pages. To use this version:

1. Push the branch: `git push -u origin cloudflare-realtime`
2. On GitHub, go to the repo's **Settings → Pages** and set the branch to `cloudflare-realtime`.

To go back to the old Supabase version, set the Pages branch back to `main`. Nothing
on Supabase changed, so `main` works exactly as it did before.

## What changed for the host and players

- **Same screens and the same flow.** Lobby → get ready → question → reveal → leaderboard → podium.
- **Reconnects.** Phones that lose signal or refresh the page reconnect to the same player and score.
- **Duplicate nicknames.** These are refused with a clear message.
- **Joining late.** Players can only join while the room is in the lobby.
- **Leaderboard.** The host's leaderboard shows the top 10.
- **Scoring.** A correct answer is worth 500–1000 points, depending on how fast it was.
- **Timer safety net.** If the host's laptop sleeps during a question, the server still
  closes the question when the timer runs out.
- **Scores are not saved to Supabase.** Scores live on the Worker until the host resets the room.

## Free-plan usage per session

A 450-player, 30-question game uses about 14,000 of the 100,000 daily requests
on the Workers Free plan. Messages sent to phones are not billed.

## Local testing without Cloudflare

```
node test/sim.mjs 450 10                      # game rules, 450 players
node test/devserver.mjs 8787 ..               # local stand-in server + the site
node loadtest.mjs http://localhost:8787 450 3 # 450 real WebSocket connections
```

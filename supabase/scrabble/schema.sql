-- ===================================================================
-- SCRABBLE (online, 2-4 players) - database schema + game logic
-- Run once in the Supabase SQL Editor. Safe to re-run (it recreates
-- every scr_* table and function, so it also resets any games).
-- It only touches objects whose names start with scr_.
-- After this, open scrabble.html and press "Load dictionary" once.
-- ===================================================================

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'scr\_%'
  loop
    execute 'drop function if exists ' || r.sig::text || ' cascade';
  end loop;
end $$;

drop table if exists scr_pings, scr_log, scr_players, scr_games, scr_dict, scr_meta cascade;

create table scr_meta (id int primary key default 1, loaded boolean not null default false, check (id = 1));
insert into scr_meta (id) values (1);

create table scr_dict (bucket text primary key, words text not null);

create table scr_games (
  id uuid primary key default gen_random_uuid(),
  room_code text not null unique,
  status text not null default 'LOBBY' check (status in ('LOBBY', 'PLAYING', 'FINISHED')),
  creator_token text not null,
  board text not null default repeat('.', 225),
  bag text not null default '',
  turn_seat int not null default 0,
  scoreless int not null default 0,
  last_move jsonb,
  winners int[],
  end_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table scr_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references scr_games(id) on delete cascade,
  token text not null,
  nickname text not null check (char_length(nickname) between 1 and 14),
  seat int not null,
  rack text not null default '',
  score int not null default 0,
  unique (game_id, token),
  unique (game_id, seat)
);

create table scr_log (
  id bigserial primary key,
  game_id uuid not null references scr_games(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

create table scr_pings (game_id uuid primary key references scr_games(id) on delete cascade, rev int not null default 1);

alter table scr_meta enable row level security;
alter table scr_dict enable row level security;
alter table scr_games enable row level security;
alter table scr_players enable row level security;
alter table scr_log enable row level security;
alter table scr_pings enable row level security;
revoke all on scr_meta, scr_dict, scr_games, scr_players, scr_log, scr_pings from anon, authenticated;
revoke all on sequence scr_log_id_seq from anon, authenticated;
create policy "scr pings are readable" on scr_pings for select using (true);
grant select on scr_pings to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table scr_pings;
exception when others then
  raise notice 'Could not add scr_pings to the realtime publication (%). The app falls back to polling.', sqlerrm;
end $$;

-- -------------------------------------------------------------------
-- Helpers
-- -------------------------------------------------------------------
create function scr_touch(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into scr_pings (game_id, rev) values (p_game, 1)
  on conflict (game_id) do update set rev = scr_pings.rev + 1;
  update scr_games set updated_at = now() where id = p_game;
end $$;

create function scr_say(p_game uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
begin insert into scr_log (game_id, text) values (p_game, p_text); end $$;

create function scr_lock_game(p_room text) returns scr_games
language plpgsql security definer set search_path = public as $$
declare g scr_games;
begin
  select * into g from scr_games where room_code = upper(btrim(coalesce(p_room, ''))) for update;
  if g.id is null then raise exception 'Game not found. Check the room code.'; end if;
  return g;
end $$;

create function scr_value(p_ch text) returns int
language sql immutable as $$
  select case p_ch
    when 'A' then 1 when 'B' then 3 when 'C' then 3 when 'D' then 2 when 'E' then 1 when 'F' then 4
    when 'G' then 2 when 'H' then 4 when 'I' then 1 when 'J' then 8 when 'K' then 5 when 'L' then 1
    when 'M' then 3 when 'N' then 1 when 'O' then 1 when 'P' then 3 when 'Q' then 10 when 'R' then 1
    when 'S' then 1 when 'T' then 1 when 'U' then 1 when 'V' then 4 when 'W' then 4 when 'X' then 8
    when 'Y' then 4 when 'Z' then 10 else 0 end
$$;

create function scr_rack_value(p_rack text) returns int
language sql immutable as $$
  select coalesce(sum(scr_value(c)), 0)::int from regexp_split_to_table(coalesce(p_rack, ''), '') c
$$;

create function scr_shuffle(p_text text) returns text
language sql volatile as $$
  select coalesce(string_agg(c, '' order by random()), '') from regexp_split_to_table(coalesce(p_text, ''), '') c
$$;

-- 100 standard English tiles (? = blank)
create function scr_new_bag() returns text
language sql volatile as $$
  select scr_shuffle(
    repeat('A', 9) || repeat('B', 2) || repeat('C', 2) || repeat('D', 4) || repeat('E', 12) || repeat('F', 2) ||
    repeat('G', 3) || repeat('H', 2) || repeat('I', 9) || 'J' || 'K' || repeat('L', 4) || repeat('M', 2) ||
    repeat('N', 6) || repeat('O', 8) || repeat('P', 2) || 'Q' || repeat('R', 6) || repeat('S', 4) ||
    repeat('T', 6) || repeat('U', 4) || repeat('V', 2) || repeat('W', 2) || 'X' || repeat('Y', 2) || 'Z' || '??')
$$;

create function scr_rack_remove(p_rack text, p_ch text) returns text
language plpgsql immutable as $$
declare pos int := position(p_ch in p_rack);
begin
  if pos = 0 then return null; end if;
  return overlay(p_rack placing '' from pos for 1);
end $$;

-- premium square at board index: W triple word, w double word, L triple letter, l double letter
create function scr_prem(p_idx int) returns text
language plpgsql immutable as $$
declare
  rows text[] := array[
    'W..l...W...l..W', '.w...L...L...w.', '..w...l.l...w..', 'l..w...l...w..l', '....w.....w....',
    '.L...L...L...L.', '..l...l.l...l..', 'W..l...w...l..W', '..l...l.l...l..', '.L...L...L...L.',
    '....w.....w....', 'l..w...l...w..l', '..w...l.l...w..', '.w...L...L...w.', 'W..l...W...l..W'];
begin
  return substr(rows[p_idx / 15 + 1], p_idx % 15 + 1, 1);
end $$;

create function scr_word_ok(p_word text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare w text := lower(p_word); b text;
begin
  select words into b from scr_dict where bucket = left(w, 1);
  if b is null then return false; end if;
  return position(' ' || w || ' ' in b) > 0;
end $$;

create function scr_next_seat(p_game uuid, p_seat int) returns int
language sql stable as $$
  select (p_seat + 1) % (select count(*)::int from scr_players where game_id = p_game)
$$;

-- -------------------------------------------------------------------
-- Move analysis: validates the geometry and scores a play.
-- p_tiles = [{"r":7,"c":7,"ch":"A","blank":false}, ...]
-- Returns {"error": "..."} or {"board","words":[{"w","s"}],"score","bingo","placed"}.
-- -------------------------------------------------------------------
create function scr_analyze(p_board text, p_tiles jsonb) returns jsonb
language plpgsql immutable as $$
declare
  n int; i int; e jsonb; rr int; cc int; ix int; ltr text; blank boolean;
  b text := p_board; rs int[] := '{}'; cs int[] := '{}'; pidx int[] := '{}';
  placed jsonb := '[]'::jsonb; horiz boolean; vert boolean; lo int; hi int;
  empty_board boolean := (p_board = repeat('.', 225));
  touches boolean := false; dir int; sx int; sy int; dx int; dy int; x int; y int; seen int[] := '{}';
  words jsonb := '[]'::jsonb; w text; tot int; wm int; wsc int; sc int := 0; pc text; v int; k int; ln int;
begin
  if p_tiles is null or jsonb_typeof(p_tiles) <> 'array' then return jsonb_build_object('error', 'No tiles were placed.'); end if;
  n := jsonb_array_length(p_tiles);
  if n < 1 or n > 7 then return jsonb_build_object('error', 'Place between 1 and 7 tiles.'); end if;

  for i in 0 .. n - 1 loop
    e := p_tiles -> i;
    begin
      rr := (e ->> 'r')::int; cc := (e ->> 'c')::int;
    exception when others then
      return jsonb_build_object('error', 'Invalid tile position.');
    end;
    ltr := upper(coalesce(e ->> 'ch', ''));
    blank := coalesce((e ->> 'blank')::boolean, false);
    if rr < 0 or rr > 14 or cc < 0 or cc > 14 then return jsonb_build_object('error', 'Tile is off the board.'); end if;
    if ltr !~ '^[A-Z]$' then return jsonb_build_object('error', 'Invalid letter.'); end if;
    ix := rr * 15 + cc;
    if substr(b, ix + 1, 1) <> '.' then return jsonb_build_object('error', 'That square is already taken.'); end if;
    b := overlay(b placing (case when blank then lower(ltr) else ltr end) from ix + 1 for 1);
    rs := rs || rr; cs := cs || cc; pidx := pidx || ix;
    placed := placed || jsonb_build_array(jsonb_build_object('r', rr, 'c', cc, 'ch', ltr, 'blank', blank));
  end loop;

  horiz := (select count(distinct x1) = 1 from unnest(rs) x1);
  vert := (select count(distinct x1) = 1 from unnest(cs) x1);
  if not horiz and not vert then return jsonb_build_object('error', 'Tiles must be in a single row or column.'); end if;

  if n > 1 then
    if horiz then
      lo := (select min(x1) from unnest(cs) x1); hi := (select max(x1) from unnest(cs) x1);
      for cc in lo .. hi loop
        if substr(b, rs[1] * 15 + cc + 1, 1) = '.' then return jsonb_build_object('error', 'There cannot be gaps in a word.'); end if;
      end loop;
    else
      lo := (select min(x1) from unnest(rs) x1); hi := (select max(x1) from unnest(rs) x1);
      for rr in lo .. hi loop
        if substr(b, rr * 15 + cs[1] + 1, 1) = '.' then return jsonb_build_object('error', 'There cannot be gaps in a word.'); end if;
      end loop;
    end if;
  end if;

  if empty_board then
    if n < 2 then return jsonb_build_object('error', 'The first word needs at least two tiles.'); end if;
    if not (112 = any(pidx)) then return jsonb_build_object('error', 'The first word must cover the centre star.'); end if;
  else
    foreach ix in array pidx loop
      rr := ix / 15; cc := ix % 15;
      if (rr > 0 and substr(p_board, ix - 15 + 1, 1) <> '.') or (rr < 14 and substr(p_board, ix + 15 + 1, 1) <> '.')
         or (cc > 0 and substr(p_board, ix - 1 + 1, 1) <> '.') or (cc < 14 and substr(p_board, ix + 1 + 1, 1) <> '.') then
        touches := true;
      end if;
    end loop;
    if not touches then return jsonb_build_object('error', 'Your word must connect to tiles already on the board.'); end if;
  end if;

  -- every word (length >= 2) that runs through a new tile, in both directions
  foreach ix in array pidx loop
    for dir in 0 .. 1 loop
      dx := case when dir = 0 then 1 else 0 end; dy := case when dir = 0 then 0 else 1 end;
      x := ix % 15; y := ix / 15;
      while x - dx >= 0 and y - dy >= 0 and substr(b, (y - dy) * 15 + (x - dx) + 1, 1) <> '.' loop
        x := x - dx; y := y - dy;
      end loop;
      sx := x; sy := y;
      if (sy * 15 + sx) * 2 + dir = any(seen) then continue; end if;
      w := ''; tot := 0; wm := 1; ln := 0;
      while x <= 14 and y <= 14 and substr(b, y * 15 + x + 1, 1) <> '.' loop
        pc := substr(b, y * 15 + x + 1, 1);
        v := scr_value(pc);
        k := y * 15 + x;
        if k = any(pidx) then
          case scr_prem(k)
            when 'l' then v := v * 2;
            when 'L' then v := v * 3;
            when 'w' then wm := wm * 2;
            when 'W' then wm := wm * 3;
            else null;
          end case;
        end if;
        tot := tot + v; w := w || upper(pc); ln := ln + 1;
        x := x + dx; y := y + dy;
      end loop;
      seen := seen || ((sy * 15 + sx) * 2 + dir);
      if ln >= 2 then
        wsc := tot * wm; sc := sc + wsc;
        words := words || jsonb_build_array(jsonb_build_object('w', w, 's', wsc));
      end if;
    end loop;
  end loop;

  if jsonb_array_length(words) = 0 then return jsonb_build_object('error', 'Your tiles do not form a word.'); end if;
  if n = 7 then sc := sc + 50; end if;
  return jsonb_build_object('board', b, 'words', words, 'score', sc, 'bingo', n = 7, 'placed', placed);
end $$;

-- -------------------------------------------------------------------
-- End of game
-- -------------------------------------------------------------------
create function scr_finalize(p_game uuid, p_out_seat int, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p record; pool int := 0; best int; w int[];
begin
  for p in select * from scr_players where game_id = p_game loop
    pool := pool + case when p.seat = p_out_seat then 0 else scr_rack_value(p.rack) end;
  end loop;
  for p in select * from scr_players where game_id = p_game loop
    if p.seat = p_out_seat then
      update scr_players set score = score + pool where id = p.id;
    elsif p_reason <> 'host' then
      update scr_players set score = score - scr_rack_value(p.rack) where id = p.id;
    end if;
  end loop;
  select max(score) into best from scr_players where game_id = p_game;
  select array_agg(seat order by seat) into w from scr_players where game_id = p_game and score = best;
  update scr_games set status = 'FINISHED', winners = w, end_reason = p_reason,
    last_move = case when last_move is null then null else jsonb_set(last_move, '{challengeable}', 'false') end
  where id = p_game;
  perform scr_say(p_game, case p_reason
    when 'out' then 'Game over. A player used every tile.'
    when 'passes' then 'Game over. Six turns in a row scored nothing.'
    else 'The host ended the game.' end);
end $$;

-- -------------------------------------------------------------------
-- Snapshot: everything a browser needs. Other players' racks stay hidden.
-- -------------------------------------------------------------------
create function scr_build_snapshot(p_game uuid, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games; me scr_players; v_players jsonb; v_me jsonb := null; v_log jsonb; v_last jsonb := null;
begin
  select * into g from scr_games where id = p_game;
  select * into me from scr_players where game_id = p_game and token = p_token;

  select coalesce(jsonb_agg(jsonb_build_object(
    'seat', p.seat, 'nickname', p.nickname, 'score', p.score, 'rackCount', char_length(p.rack),
    'rack', case when g.status = 'FINISHED' then p.rack else null end
  ) order by p.seat), '[]'::jsonb) into v_players from scr_players p where p.game_id = p_game;

  if me.id is not null then
    v_me := jsonb_build_object('seat', me.seat, 'nickname', me.nickname, 'rack', me.rack,
                               'isCreator', me.token = g.creator_token);
  end if;

  if g.last_move is not null then
    v_last := g.last_move - 'board_before' - 'rack_before' - 'drawn';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('text', l.text) order by l.id desc), '[]'::jsonb) into v_log
  from (select * from scr_log where game_id = p_game order by id desc limit 25) l;

  return jsonb_build_object(
    'serverTime', now(),
    'dictLoaded', (select loaded from scr_meta where id = 1),
    'game', jsonb_build_object('id', g.id, 'roomCode', g.room_code, 'status', g.status,
      'turnSeat', g.turn_seat, 'bagCount', char_length(g.bag), 'scoreless', g.scoreless,
      'lastMove', v_last, 'winners', to_jsonb(g.winners), 'endReason', g.end_reason),
    'board', g.board,
    'players', v_players,
    'me', v_me,
    'log', v_log);
end $$;

-- -------------------------------------------------------------------
-- Public API
-- -------------------------------------------------------------------
create function scr_snapshot(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games;
begin
  select * into g from scr_games where room_code = upper(btrim(coalesce(p_room, '')));
  if g.id is null then raise exception 'Game not found. Check the room code.'; end if;
  return scr_build_snapshot(g.id, p_token);
end $$;

create function scr_create(p_token text, p_nickname text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid; v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_try int := 0; v_nick text := btrim(coalesce(p_nickname, ''));
begin
  if p_token is null or char_length(p_token) < 8 then raise exception 'Missing device token. Refresh and try again.'; end if;
  if char_length(v_nick) < 1 or char_length(v_nick) > 14 then raise exception 'Pick a nickname (1 to 14 characters).'; end if;
  loop
    v_code := '';
    for i in 1 .. 5 loop v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1); end loop;
    exit when not exists (select 1 from scr_games where room_code = v_code);
    v_try := v_try + 1;
    if v_try > 30 then raise exception 'Could not create a room code. Try again.'; end if;
  end loop;
  insert into scr_games (room_code, creator_token) values (v_code, p_token) returning id into v_id;
  insert into scr_players (game_id, token, nickname, seat) values (v_id, p_token, v_nick, 0);
  perform scr_say(v_id, v_nick || ' opened the game.');
  perform scr_touch(v_id);
  return scr_build_snapshot(v_id, p_token);
end $$;

create function scr_join(p_room text, p_token text, p_nickname text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games; me scr_players; v_nick text := btrim(coalesce(p_nickname, '')); n int;
begin
  g := scr_lock_game(p_room);
  if p_token is null or char_length(p_token) < 8 then raise exception 'Missing device token. Refresh and try again.'; end if;
  select * into me from scr_players where game_id = g.id and token = p_token;
  if me.id is not null and g.status <> 'LOBBY' then return scr_build_snapshot(g.id, p_token); end if;
  if g.status <> 'LOBBY' then raise exception 'This game has already started.'; end if;
  if char_length(v_nick) < 1 or char_length(v_nick) > 14 then raise exception 'Pick a nickname (1 to 14 characters).'; end if;
  if exists (select 1 from scr_players where game_id = g.id and lower(nickname) = lower(v_nick) and token <> p_token) then
    raise exception 'That nickname is already taken in this game.';
  end if;
  if me.id is null then
    select count(*) into n from scr_players where game_id = g.id;
    if n >= 4 then raise exception 'This game is full (4 players).'; end if;
    insert into scr_players (game_id, token, nickname, seat) values (g.id, p_token, v_nick, n);
    perform scr_say(g.id, v_nick || ' joined.');
  else
    update scr_players set nickname = v_nick where id = me.id;
  end if;
  perform scr_touch(g.id);
  return scr_build_snapshot(g.id, p_token);
end $$;

create function scr_start(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games; n int; p record; v_bag text;
begin
  g := scr_lock_game(p_room);
  if g.creator_token <> p_token then raise exception 'Only the player who opened the game can start it.'; end if;
  if g.status <> 'LOBBY' then raise exception 'The game has already started.'; end if;
  select count(*) into n from scr_players where game_id = g.id;
  if n < 2 then raise exception 'You need at least 2 players.'; end if;
  if not (select loaded from scr_meta where id = 1) then raise exception 'Load the dictionary first.'; end if;
  v_bag := scr_new_bag();
  for p in select * from scr_players where game_id = g.id order by seat loop
    update scr_players set rack = left(v_bag, 7), score = 0 where id = p.id;
    v_bag := substr(v_bag, 8);
  end loop;
  update scr_games set status = 'PLAYING', bag = v_bag, board = repeat('.', 225), turn_seat = floor(random() * n)::int,
    scoreless = 0, last_move = null, winners = null, end_reason = null where id = g.id;
  perform scr_say(g.id, 'The game has started. ' || (select nickname from scr_players where game_id = g.id and seat = (select turn_seat from scr_games where id = g.id)) || ' goes first.');
  perform scr_touch(g.id);
  return scr_build_snapshot(g.id, p_token);
end $$;

-- shared guard for turn actions
create function scr_turn_guard(g scr_games, p_token text) returns scr_players
language plpgsql security definer set search_path = public as $$
declare me scr_players;
begin
  if g.status <> 'PLAYING' then raise exception 'The game is not in progress.'; end if;
  select * into me from scr_players where game_id = g.id and token = p_token;
  if me.id is null then raise exception 'You are not in this game.'; end if;
  if me.seat <> g.turn_seat then raise exception 'It is not your turn.'; end if;
  if g.last_move is not null and coalesce((g.last_move ->> 'out')::boolean, false) and coalesce((g.last_move ->> 'challengeable')::boolean, false) then
    raise exception 'Accept or challenge the final play first.';
  end if;
  return me;
end $$;

create function scr_play(p_room text, p_token text, p_tiles jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games; me scr_players; a jsonb; t jsonb; r text; need text; k int; v_drawn text; v_bag text; v_out boolean; n int;
begin
  g := scr_lock_game(p_room);
  me := scr_turn_guard(g, p_token);
  a := scr_analyze(g.board, p_tiles);
  if a ? 'error' then raise exception '%', a ->> 'error'; end if;

  r := me.rack;
  for t in select * from jsonb_array_elements(a -> 'placed') loop
    need := case when (t ->> 'blank')::boolean then '?' else t ->> 'ch' end;
    r := scr_rack_remove(r, need);
    if r is null then raise exception 'You do not have those tiles.'; end if;
  end loop;

  n := jsonb_array_length(a -> 'placed');
  k := least(n, char_length(g.bag));
  v_drawn := left(g.bag, k);
  v_bag := substr(g.bag, k + 1);
  v_out := (r || v_drawn = '' and v_bag = '');

  update scr_players set rack = r || v_drawn, score = score + (a ->> 'score')::int where id = me.id;
  update scr_games set board = a ->> 'board', bag = v_bag, scoreless = 0,
    turn_seat = scr_next_seat(g.id, g.turn_seat),
    last_move = jsonb_build_object('seat', me.seat, 'nickname', me.nickname, 'words', a -> 'words',
      'score', (a ->> 'score')::int, 'bingo', a -> 'bingo', 'placed', a -> 'placed',
      'challengeable', true, 'out', v_out, 'board_before', g.board, 'rack_before', me.rack, 'drawn', v_drawn)
  where id = g.id;
  perform scr_say(g.id, format('%s played %s for %s points%s.', me.nickname,
    (select string_agg(x ->> 'w', ', ') from jsonb_array_elements(a -> 'words') x), a ->> 'score',
    case when (a ->> 'bingo')::boolean then ' (bingo, +50)' else '' end));
  perform scr_touch(g.id);
  return scr_build_snapshot(g.id, p_token);
end $$;

create function scr_pass(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games; me scr_players;
begin
  g := scr_lock_game(p_room);
  me := scr_turn_guard(g, p_token);
  update scr_games set scoreless = scoreless + 1, turn_seat = scr_next_seat(g.id, g.turn_seat),
    last_move = case when last_move is null then null else jsonb_set(last_move, '{challengeable}', 'false') end
  where id = g.id;
  perform scr_say(g.id, me.nickname || ' passed.');
  if g.scoreless + 1 >= 6 then perform scr_finalize(g.id, null, 'passes'); end if;
  perform scr_touch(g.id);
  return scr_build_snapshot(g.id, p_token);
end $$;

create function scr_exchange(p_room text, p_token text, p_tiles text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games; me scr_players; r text; c text; k int; v_new text; v_bag text; v_give text := upper(coalesce(p_tiles, ''));
begin
  g := scr_lock_game(p_room);
  me := scr_turn_guard(g, p_token);
  k := char_length(v_give);
  if k < 1 or k > 7 then raise exception 'Choose 1 to 7 tiles to exchange.'; end if;
  if char_length(g.bag) < 7 then raise exception 'There must be at least 7 tiles in the bag to exchange.'; end if;
  r := me.rack;
  foreach c in array regexp_split_to_array(v_give, '') loop
    r := scr_rack_remove(r, c);
    if r is null then raise exception 'You do not have those tiles.'; end if;
  end loop;
  v_new := left(g.bag, k);
  v_bag := scr_shuffle(substr(g.bag, k + 1) || v_give);
  update scr_players set rack = r || v_new where id = me.id;
  update scr_games set bag = v_bag, scoreless = scoreless + 1, turn_seat = scr_next_seat(g.id, g.turn_seat),
    last_move = case when last_move is null then null else jsonb_set(last_move, '{challengeable}', 'false') end
  where id = g.id;
  perform scr_say(g.id, format('%s exchanged %s tile%s.', me.nickname, k, case when k = 1 then '' else 's' end));
  if g.scoreless + 1 >= 6 then perform scr_finalize(g.id, null, 'passes'); end if;
  perform scr_touch(g.id);
  return scr_build_snapshot(g.id, p_token);
end $$;

-- The player whose turn it is may challenge the previous play before moving.
create function scr_challenge(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games; me scr_players; lm jsonb; bad text[]; x jsonb; mover scr_players; v_bag text;
begin
  g := scr_lock_game(p_room);
  if g.status <> 'PLAYING' then raise exception 'The game is not in progress.'; end if;
  select * into me from scr_players where game_id = g.id and token = p_token;
  if me.id is null then raise exception 'You are not in this game.'; end if;
  if me.seat <> g.turn_seat then raise exception 'It is not your turn.'; end if;
  lm := g.last_move;
  if lm is null or not coalesce((lm ->> 'challengeable')::boolean, false) then raise exception 'There is no play to challenge.'; end if;
  if (lm ->> 'seat')::int = me.seat then raise exception 'You cannot challenge your own play.'; end if;

  bad := '{}';
  for x in select * from jsonb_array_elements(lm -> 'words') loop
    if not scr_word_ok(x ->> 'w') then bad := bad || (x ->> 'w'); end if;
  end loop;

  select * into mover from scr_players where game_id = g.id and seat = (lm ->> 'seat')::int;

  if array_length(bad, 1) is not null then
    -- challenge succeeds: play is taken back, mover loses the points and the turn
    v_bag := scr_shuffle(g.bag || (lm ->> 'drawn'));
    update scr_players set rack = lm ->> 'rack_before', score = score - (lm ->> 'score')::int where id = mover.id;
    update scr_games set board = lm ->> 'board_before', bag = v_bag, scoreless = scoreless + 1,
      last_move = jsonb_build_object('seat', mover.seat, 'nickname', mover.nickname, 'words', lm -> 'words',
        'score', (lm ->> 'score')::int, 'placed', lm -> 'placed', 'challengeable', false, 'out', false,
        'result', 'invalid', 'invalidWords', to_jsonb(bad), 'challenger', me.nickname)
    where id = g.id;
    perform scr_say(g.id, format('%s challenged %s. Not a word: %s. The play is taken back.', me.nickname, mover.nickname, array_to_string(bad, ', ')));
    if g.scoreless + 1 >= 6 then perform scr_finalize(g.id, null, 'passes'); end if;
  else
    perform scr_say(g.id, format('%s challenged %s, but every word is valid. %s loses a turn.', me.nickname, mover.nickname, me.nickname));
    if coalesce((lm ->> 'out')::boolean, false) then
      update scr_games set last_move = lm || jsonb_build_object('challengeable', false, 'result', 'valid', 'challenger', me.nickname) where id = g.id;
      perform scr_finalize(g.id, mover.seat, 'out');
    else
      update scr_games set turn_seat = scr_next_seat(g.id, g.turn_seat),
        last_move = lm || jsonb_build_object('challengeable', false, 'result', 'valid', 'challenger', me.nickname)
      where id = g.id;
    end if;
  end if;
  perform scr_touch(g.id);
  return scr_build_snapshot(g.id, p_token);
end $$;

-- After a player goes out, the next player accepts the final play to end the game.
create function scr_accept(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games; me scr_players;
begin
  g := scr_lock_game(p_room);
  if g.status <> 'PLAYING' then raise exception 'The game is not in progress.'; end if;
  select * into me from scr_players where game_id = g.id and token = p_token;
  if me.id is null or me.seat <> g.turn_seat then raise exception 'It is not your turn.'; end if;
  if g.last_move is null or not coalesce((g.last_move ->> 'out')::boolean, false) or not coalesce((g.last_move ->> 'challengeable')::boolean, false) then
    raise exception 'There is no final play to accept.';
  end if;
  perform scr_finalize(g.id, (g.last_move ->> 'seat')::int, 'out');
  perform scr_touch(g.id);
  return scr_build_snapshot(g.id, p_token);
end $$;

create function scr_end_game(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games;
begin
  g := scr_lock_game(p_room);
  if g.creator_token <> p_token then raise exception 'Only the player who opened the game can end it.'; end if;
  if g.status <> 'PLAYING' then raise exception 'The game is not in progress.'; end if;
  perform scr_finalize(g.id, null, 'host');
  perform scr_touch(g.id);
  return scr_build_snapshot(g.id, p_token);
end $$;

create function scr_delete_game(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g scr_games;
begin
  g := scr_lock_game(p_room);
  if g.creator_token <> p_token then raise exception 'Only the player who opened the game can delete it.'; end if;
  delete from scr_games where id = g.id;
  return jsonb_build_object('deleted', true);
end $$;

-- One-time dictionary loading (locked once finished)
create function scr_dict_load(p_bucket text, p_chunk text, p_first boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if (select loaded from scr_meta where id = 1) then raise exception 'The dictionary is already loaded.'; end if;
  if p_bucket !~ '^[a-z]$' then raise exception 'Bad bucket.'; end if;
  if p_chunk is null or p_chunk !~ '^[a-z]+( [a-z]+)*$' or char_length(p_chunk) > 1500000 then raise exception 'Bad word chunk.'; end if;
  if coalesce(p_first, false) then
    insert into scr_dict (bucket, words) values (p_bucket, ' ' || p_chunk || ' ')
    on conflict (bucket) do update set words = excluded.words;
  else
    update scr_dict set words = words || p_chunk || ' ' where bucket = p_bucket;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create function scr_dict_done() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from scr_dict) < 20 then raise exception 'The dictionary is incomplete.'; end if;
  update scr_meta set loaded = true where id = 1;
  return jsonb_build_object('loaded', true);
end $$;

-- -------------------------------------------------------------------
-- Permissions: only the API below is callable from the browser.
-- -------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'scr\_%'
  loop
    execute 'revoke all on function ' || r.sig::text || ' from public, anon, authenticated';
  end loop;
end $$;

grant execute on function
  scr_snapshot(text, text), scr_create(text, text), scr_join(text, text, text), scr_start(text, text),
  scr_play(text, text, jsonb), scr_pass(text, text), scr_exchange(text, text, text), scr_challenge(text, text),
  scr_accept(text, text), scr_end_game(text, text), scr_delete_game(text, text),
  scr_dict_load(text, text, boolean), scr_dict_done()
to anon, authenticated;

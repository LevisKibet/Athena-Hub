-- ===================================================================
-- KENYA @ 50 — database schema + game logic (v2)
-- ===================================================================
-- HOW TO INSTALL
--   1. Supabase Dashboard -> SQL Editor -> New query -> paste THIS file -> Run.
--   2. New query -> paste seed_cards.sql -> Run (the red/black word cards).
--
-- WARNING: this file starts by DROPPING every k50_* table and function, so
-- re-running it wipes all Kenya @ 50 games/cards. It never touches Kahoot.
--
-- HOW IT WORKS
--   * Every table is locked down with Row Level Security and has NO policies,
--     so the public anon key cannot read or write them directly.
--   * All reads/writes go through the k50_* functions below ("RPCs"). They run
--     with elevated rights and enforce the rules server-side.
--   * Secret card words are masked INSIDE k50_build_snapshot(): only the
--     current describer receives the words while a round is running. After the
--     timer ends, the card is revealed to everyone for scoring.
--   * The only table the browser can read is k50_pings (a counter bumped on
--     every change) — it exists purely so Realtime can tell devices "refresh".
--   * The host is a signed-in Supabase user (auth.uid()). Players are
--     anonymous: each device sends a random secret token stored in localStorage.
-- ===================================================================


-- -------------------------------------------------------------------
-- 0. Clean slate (v1 leftovers + earlier runs of this file)
-- -------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'k50\_%'
  loop
    execute 'drop function if exists ' || r.sig::text || ' cascade';
  end loop;
end $$;

drop table if exists
  k50_pings, k50_events, k50_review_votes, k50_used_cards, k50_players,
  k50_teams, k50_games, k50_cards, k50_judiciary_cards, k50_board_tiles,
  k50_word_bank, k50_game_used_cards, k50_supreme_court_cards, k50_game_events
cascade;

-- -------------------------------------------------------------------
-- 1. Tables
-- -------------------------------------------------------------------

-- The 42-tile loop. kind: START | RED | BLACK | JUDICIARY | SPECIAL
-- Landing on a BLACK tile -> read a RED card. Landing on a RED tile -> read a BLACK card.
create table k50_board_tiles (
  position int primary key,
  kind text not null,
  code text,
  label text,
  effect jsonb
);

-- 11 words per card. deck = which physical pile it belongs to.
create table k50_cards (
  id uuid primary key default gen_random_uuid(),
  deck text not null check (deck in ('RED', 'BLACK')),
  words text[] not null check (array_length(words, 1) = 11)
);

create table k50_judiciary_cards (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  effect jsonb not null
);

create table k50_games (
  id uuid primary key default gen_random_uuid(),
  room_code text unique not null,
  host_id uuid not null,                       -- auth.uid() of the host
  status text not null default 'LOBBY',
    -- LOBBY | AWAITING_ROLL | CARD_PREP | ROUND_ACTIVE | REVIEW
    -- | CHOOSE_TARGET | EVENT | FINISHED
  current_team_id uuid,
  current_card_id uuid,
  swaps_used int not null default 0,
  round_started_at timestamptz,
  round_seconds int not null default 50,
  points_per_word int not null default 10,
  winning_score int not null default 500,
  start_bonus int not null default 50,
  winner_team_id uuid,
  proposed_correct int[],                      -- word indexes the describer ticked
  review_proposed boolean not null default false,
  review_note text,
  pending_choice jsonb,                        -- {"type":"give|steal","value":10}
  last_roll int,
  roll_seq int not null default 0,
  last_event jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table k50_teams (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references k50_games(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 14),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  icon text not null,
  seq int not null,                            -- turn order
  score int not null default 0,
  position int not null default 0,
  describer_cursor int not null default 0,     -- rotates through the team's players
  skip_next boolean not null default false,
  jail_free int not null default 0,
  created_at timestamptz not null default now()
);

create table k50_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references k50_games(id) on delete cascade,
  team_id uuid references k50_teams(id) on delete set null,
  token text not null,                         -- secret per-device token, never sent to clients
  nickname text not null check (char_length(nickname) between 1 and 14),
  join_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (game_id, token)
);

create table k50_used_cards (
  game_id uuid not null references k50_games(id) on delete cascade,
  card_id uuid not null references k50_cards(id) on delete cascade,
  primary key (game_id, card_id)
);

create table k50_review_votes (
  game_id uuid not null references k50_games(id) on delete cascade,
  player_id uuid not null references k50_players(id) on delete cascade,
  vote text not null check (vote in ('approve', 'dispute')),
  primary key (game_id, player_id)
);

create table k50_events (
  id bigserial primary key,
  game_id uuid not null references k50_games(id) on delete cascade,
  kind text not null,
  text text not null,
  team_id uuid,
  created_at timestamptz not null default now()
);

-- Public "something changed" counter used only for Realtime.
create table k50_pings (
  game_id uuid primary key references k50_games(id) on delete cascade,
  rev bigint not null default 0
);

-- -------------------------------------------------------------------
-- 2. Locked-down access (RLS on, no policies, except the ping counter)
-- -------------------------------------------------------------------
alter table k50_board_tiles     enable row level security;
alter table k50_cards           enable row level security;
alter table k50_judiciary_cards enable row level security;
alter table k50_games           enable row level security;
alter table k50_teams           enable row level security;
alter table k50_players         enable row level security;
alter table k50_used_cards      enable row level security;
alter table k50_review_votes    enable row level security;
alter table k50_events          enable row level security;
alter table k50_pings           enable row level security;

revoke all on k50_board_tiles, k50_cards, k50_judiciary_cards, k50_games, k50_teams,
  k50_players, k50_used_cards, k50_review_votes, k50_events, k50_pings from anon, authenticated;
revoke all on sequence k50_events_id_seq from anon, authenticated;

create policy "k50 pings are readable" on k50_pings for select using (true);
grant select on k50_pings to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table k50_pings;
exception when others then
  raise notice 'Could not add k50_pings to the realtime publication (%). The app falls back to polling.', sqlerrm;
end $$;

-- -------------------------------------------------------------------
-- 3. Seed data: board + judiciary cards (word cards are in seed_cards.sql)
-- -------------------------------------------------------------------

insert into k50_board_tiles (position, kind, code, label, effect) values
  (0, 'START', 'START', 'START HERE', null),
  (1, 'RED', null, null, null),
  (2, 'BLACK', null, null, null),
  (3, 'RED', null, null, null),
  (4, 'JUDICIARY', null, null, null),
  (5, 'BLACK', null, null, null),
  (6, 'RED', null, null, null),
  (7, 'BLACK', null, null, null),
  (8, 'SPECIAL', 'GIVE', 'Give 10 points to any team!', '{"type": "choose_give", "value": 10}'::jsonb),
  (9, 'RED', null, null, null),
  (10, 'JUDICIARY', null, null, null),
  (11, 'BLACK', null, null, null),
  (12, 'RED', null, null, null),
  (13, 'BLACK', null, null, null),
  (14, 'SPECIAL', 'SGR', 'Take a trip on the SGR. Collect 10 points.', '{"type": "points", "value": 10}'::jsonb),
  (15, 'RED', null, null, null),
  (16, 'JUDICIARY', null, null, null),
  (17, 'BLACK', null, null, null),
  (18, 'SPECIAL', 'RHINO', 'Rare find, a rhino! Move 4 steps forward.', '{"type": "move", "value": 4}'::jsonb),
  (19, 'RED', null, null, null),
  (20, 'BLACK', null, null, null),
  (21, 'SPECIAL', 'MOMBASA', 'Mombasa raha! Skip a turn.', '{"type": "skip_turn"}'::jsonb),
  (22, 'BLACK', null, null, null),
  (23, 'RED', null, null, null),
  (24, 'JUDICIARY', null, null, null),
  (25, 'RED', null, null, null),
  (26, 'BLACK', null, null, null),
  (27, 'SPECIAL', 'STEAL', 'Steal 10 points from any team!', '{"type": "choose_steal", "value": 10}'::jsonb),
  (28, 'RED', null, null, null),
  (29, 'BLACK', null, null, null),
  (30, 'RED', null, null, null),
  (31, 'JUDICIARY', null, null, null),
  (32, 'BLACK', null, null, null),
  (33, 'RED', null, null, null),
  (34, 'BLACK', null, null, null),
  (35, 'RED', null, null, null),
  (36, 'SPECIAL', 'MARA', 'Welcome to the Mara! Mauled by lions: go back 3 spaces.', '{"type": "move", "value": -3}'::jsonb),
  (37, 'RED', null, null, null),
  (38, 'BLACK', null, null, null),
  (39, 'JUDICIARY', null, null, null),
  (40, 'RED', null, null, null),
  (41, 'SPECIAL', 'HOME', 'Back home! Collect 50 points after passing START.', '{"type": "none"}'::jsonb);

-- effect types: points | move | move_to | skip_turn | jail_free | lose_to_next | lose_to_prev
--   | gain_from_next | gain_from_prev | collect_from_all | pay_all | steal_from_leader
-- "next"/"prev" = the next/previous team in turn order.
insert into k50_judiciary_cards (description, effect) values
  ('The Chief Justice rules in your favour. Collect 20 points.',              '{"type":"points","value":20}'),
  ('Judge takes a liking to your argument. Collect 25 points.',               '{"type":"points","value":25}'),
  ('Land dispute settled in your favour. Collect 10 points.',                 '{"type":"points","value":10}'),
  ('Court-approved inheritance! Collect 30 points.',                          '{"type":"points","value":30}'),
  ('Contempt of court! Pay a fine of 15 points.',                             '{"type":"points","value":-15}'),
  ('Tax arrears. Pay 20 points to the taxman.',                               '{"type":"points","value":-20}'),
  ('Traffic fine from NTSA. Lose 10 points.',                                 '{"type":"points","value":-10}'),
  ('Out-of-court settlement. Pay 10 points to the next team.',                '{"type":"lose_to_next","value":10}'),
  ('Your lawyer overcharged you. Give 10 points to the previous team.',       '{"type":"lose_to_prev","value":10}'),
  ('Misplaced case file. Pay 5 points to the next team.',                     '{"type":"lose_to_next","value":5}'),
  ('Appeal successful! Take 10 points from the next team.',                   '{"type":"gain_from_next","value":10}'),
  ('Class action win. Take 10 points from the previous team.',                '{"type":"gain_from_prev","value":10}'),
  ('Out-of-court mediation. Take 5 points from the next team.',               '{"type":"gain_from_next","value":5}'),
  ('Public interest litigation: every other team pays you 5 points.',         '{"type":"collect_from_all","value":5}'),
  ('Legal fees! Pay 5 points to every other team.',                           '{"type":"pay_all","value":5}'),
  ('Robin Hood ruling: take 15 points from the highest-scoring other team.',  '{"type":"steal_from_leader","value":15}'),
  ('Caught red-handed! Straight to jail: miss your next turn.',               '{"type":"skip_turn"}'),
  ('The gavel falls. Jail time: miss your next turn.',                        '{"type":"skip_turn"}'),
  ('GET OUT OF JAIL FREE. Keep this card: it cancels your next lost turn.',   '{"type":"jail_free"}'),
  ('The Judiciary pardons you. Keep this Get Out of Jail Free card.',         '{"type":"jail_free"}'),
  ('Fast-tracked case. Move forward 3 spaces.',                               '{"type":"move","value":3}'),
  ('Case adjourned. Move back 2 spaces.',                                     '{"type":"move","value":-2}'),
  ('Retrial ordered: return to START (no bonus).',                            '{"type":"move_to","value":0}');

-- -------------------------------------------------------------------
-- 4. Internal helpers (NOT callable from the browser; see grants at the end)
-- -------------------------------------------------------------------

create function k50_touch(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into k50_pings (game_id, rev) values (p_game, 1)
  on conflict (game_id) do update set rev = k50_pings.rev + 1;
  update k50_games set updated_at = now() where id = p_game;
end $$;

create function k50_log(p_game uuid, p_kind text, p_text text, p_team uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into k50_events (game_id, kind, text, team_id) values (p_game, p_kind, p_text, p_team);
end $$;

create function k50_lock_game(p_room text) returns k50_games
language plpgsql security definer set search_path = public as $$
declare g k50_games;
begin
  select * into g from k50_games where room_code = upper(btrim(coalesce(p_room, ''))) for update;
  if g.id is null then
    raise exception 'Game not found. Check the room code.';
  end if;
  return g;
end $$;

create function k50_is_host(g k50_games) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and auth.uid() = g.host_id
$$;

create function k50_player_by_token(p_game uuid, p_token text) returns k50_players
language plpgsql security definer set search_path = public as $$
declare p k50_players;
begin
  if p_token is null or p_token = '' then return null; end if;
  select * into p from k50_players where game_id = p_game and token = p_token;
  return p;
end $$;

-- Which player describes (and rolls) for a team right now.
create function k50_describer_id(p_game uuid, p_team uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_cursor int; v_cnt int; v_id uuid;
begin
  if p_team is null then return null; end if;
  select describer_cursor into v_cursor from k50_teams where id = p_team;
  select count(*) into v_cnt from k50_players where team_id = p_team;
  if v_cnt = 0 then return null; end if;
  select id into v_id from k50_players
  where team_id = p_team
  order by join_order, created_at
  offset (v_cursor % v_cnt) limit 1;
  return v_id;
end $$;

create function k50_team_ids(p_game uuid) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(id order by seq), '{}') from k50_teams where game_id = p_game
$$;

-- p_dir = 1 -> next team in turn order, -1 -> previous team.
create function k50_neighbor(p_game uuid, p_team uuid, p_dir int) returns uuid
language plpgsql security definer set search_path = public as $$
declare ids uuid[]; n int; i int;
begin
  ids := k50_team_ids(p_game);
  n := coalesce(array_length(ids, 1), 0);
  i := array_position(ids, p_team);
  if n < 2 or i is null then return null; end if;
  return ids[(((i - 1 + p_dir) % n) + n) % n + 1];
end $$;

-- Moves points between teams. Only moves what the payer actually has.
create function k50_transfer(p_from uuid, p_to uuid, p_amount int) returns int
language plpgsql security definer set search_path = public as $$
declare v_have int; v_amt int;
begin
  select score into v_have from k50_teams where id = p_from;
  v_amt := least(greatest(p_amount, 0), coalesce(v_have, 0));
  if v_amt > 0 then
    update k50_teams set score = score - v_amt where id = p_from;
    update k50_teams set score = score + v_amt where id = p_to;
  end if;
  return v_amt;
end $$;

-- Moves a team around the loop. Every time a FORWARD move passes (or lands on)
-- START the team collects the start bonus (50). Moving back never costs points.
create function k50_move_team(p_game uuid, p_team uuid, p_delta int, p_allow_bonus boolean) returns text
language plpgsql security definer set search_path = public as $$
declare v_pos int; v_n int; v_raw int; v_bonus int; v_note text := '';
begin
  select count(*) into v_n from k50_board_tiles;
  select position into v_pos from k50_teams where id = p_team;
  select start_bonus into v_bonus from k50_games where id = p_game;
  v_raw := v_pos + p_delta;
  if p_delta > 0 and v_raw >= v_n and p_allow_bonus then
    update k50_teams set score = score + v_bonus where id = p_team;
    v_note := format(' and passed START (+%s points)', v_bonus);
  end if;
  update k50_teams set position = ((v_raw % v_n) + v_n) % v_n where id = p_team;
  return v_note;
end $$;

-- A "skip your next turn". A saved Get Out of Jail Free card cancels it automatically.
create function k50_apply_skip(p_team uuid) returns text
language plpgsql security definer set search_path = public as $$
declare t k50_teams;
begin
  select * into t from k50_teams where id = p_team;
  if t.jail_free > 0 then
    update k50_teams set jail_free = jail_free - 1 where id = p_team;
    return t.name || ' used a Get Out of Jail Free card and keeps the next turn!';
  end if;
  update k50_teams set skip_next = true where id = p_team;
  return t.name || ' will miss the next turn.';
end $$;

-- Applies one effect (from a tile or a judiciary card). Returns a human sentence.
create function k50_apply_effect(p_game uuid, p_team uuid, p_effect jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_type text := p_effect ->> 'type';
  v_val int := coalesce((p_effect ->> 'value')::int, 0);
  v_name text; v_other uuid; v_other_name text; v_moved int; v_total int := 0; r record; v_note text;
begin
  select name into v_name from k50_teams where id = p_team;

  if v_type = 'points' then
    update k50_teams set score = greatest(0, score + v_val) where id = p_team;
    if v_val >= 0 then return format('%s collects %s points.', v_name, v_val); end if;
    return format('%s loses %s points.', v_name, -v_val);

  elsif v_type = 'move' then
    v_note := k50_move_team(p_game, p_team, v_val, v_val > 0);
    return format('%s moves %s %s space%s%s.', v_name,
      case when v_val > 0 then 'forward' else 'back' end, abs(v_val),
      case when abs(v_val) = 1 then '' else 's' end, v_note);

  elsif v_type = 'move_to' then
    update k50_teams set position = v_val where id = p_team;
    return format('%s is sent back to START.', v_name);

  elsif v_type = 'skip_turn' then
    return k50_apply_skip(p_team);

  elsif v_type = 'jail_free' then
    update k50_teams set jail_free = jail_free + 1 where id = p_team;
    return format('%s keeps a Get Out of Jail Free card for later.', v_name);

  elsif v_type in ('lose_to_next', 'lose_to_prev', 'gain_from_next', 'gain_from_prev') then
    v_other := k50_neighbor(p_game, p_team, case when v_type like '%next' then 1 else -1 end);
    if v_other is null then return 'There is no other team to affect.'; end if;
    select name into v_other_name from k50_teams where id = v_other;
    if v_type like 'lose_%' then
      v_moved := k50_transfer(p_team, v_other, v_val);
      return format('%s pays %s points to %s.', v_name, v_moved, v_other_name);
    end if;
    v_moved := k50_transfer(v_other, p_team, v_val);
    return format('%s takes %s points from %s.', v_name, v_moved, v_other_name);

  elsif v_type = 'collect_from_all' then
    for r in select id from k50_teams where game_id = p_game and id <> p_team loop
      v_total := v_total + k50_transfer(r.id, p_team, v_val);
    end loop;
    return format('%s collects %s points from the other teams.', v_name, v_total);

  elsif v_type = 'pay_all' then
    for r in select id from k50_teams where game_id = p_game and id <> p_team order by seq loop
      v_total := v_total + k50_transfer(p_team, r.id, v_val);
    end loop;
    return format('%s pays %s points to the other teams.', v_name, v_total);

  elsif v_type = 'steal_from_leader' then
    select id, name into v_other, v_other_name from k50_teams
    where game_id = p_game and id <> p_team order by score desc, seq limit 1;
    if v_other is null then return 'There is no other team to affect.'; end if;
    v_moved := k50_transfer(v_other, p_team, v_val);
    return format('%s takes %s points from %s.', v_name, v_moved, v_other_name);
  end if;

  return '';
end $$;

create function k50_draw_card(p_game uuid, p_deck text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select c.id into v_id from k50_cards c
  where c.deck = p_deck
    and not exists (select 1 from k50_used_cards u where u.game_id = p_game and u.card_id = c.id)
  order by random() limit 1;

  if v_id is null then
    -- whole deck used up in this game: shuffle it back in
    delete from k50_used_cards u using k50_cards c
    where u.game_id = p_game and u.card_id = c.id and c.deck = p_deck;
    select id into v_id from k50_cards where deck = p_deck order by random() limit 1;
  end if;

  if v_id is null then
    raise exception 'There are no % cards. Run seed_cards.sql first.', lower(p_deck);
  end if;

  insert into k50_used_cards (game_id, card_id) values (p_game, v_id) on conflict do nothing;
  return v_id;
end $$;

-- Ends the game as soon as any team reaches the winning score.
create function k50_check_win(p_game uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare g k50_games; w k50_teams;
begin
  select * into g from k50_games where id = p_game;
  if g.status = 'FINISHED' then return true; end if;
  select * into w from k50_teams
  where game_id = p_game and score >= g.winning_score
  order by score desc, seq limit 1;
  if w.id is null then return false; end if;

  update k50_games set
    status = 'FINISHED', winner_team_id = w.id, pending_choice = null,
    last_event = jsonb_build_object('kind', 'win', 'title', 'We have a winner!',
                                    'text', format('%s reached %s points.', w.name, w.score))
  where id = p_game;
  perform k50_log(p_game, 'win', format('%s won the game with %s points!', w.name, w.score), w.id);
  return true;
end $$;

-- Hands the turn to the next team (skipping teams that owe a lost turn).
create function k50_advance(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  g k50_games; v_ids uuid[]; v_n int; v_idx int; v_next uuid; v_i int;
  v_team k50_teams; v_skipped text := '';
begin
  select * into g from k50_games where id = p_game;
  v_ids := k50_team_ids(p_game);
  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then return; end if;
  v_idx := coalesce(array_position(v_ids, g.current_team_id), 0);

  for v_i in 1..v_n loop
    v_next := v_ids[((v_idx + v_i - 1) % v_n) + 1];
    select * into v_team from k50_teams where id = v_next;
    exit when not v_team.skip_next;
    update k50_teams set skip_next = false where id = v_next;
    v_skipped := v_skipped || case when v_skipped = '' then '' else ', ' end || v_team.name;
    perform k50_log(p_game, 'skip', v_team.name || ' misses this turn.', v_next);
  end loop;

  update k50_games set
    current_team_id = v_next, current_card_id = null, swaps_used = 0,
    round_started_at = null, proposed_correct = null, review_proposed = false,
    review_note = null, pending_choice = null, status = 'AWAITING_ROLL',
    last_event = case when v_skipped = '' then null else
      jsonb_build_object('kind', 'skip', 'title', 'Turn skipped', 'text', v_skipped || ' missed a turn.') end
  where id = p_game;
  delete from k50_review_votes where game_id = p_game;
end $$;

-- Awards the points for a finished round and moves to the result screen.
create function k50_finalize_round(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g k50_games; t k50_teams; n int; pts int;
begin
  select * into g from k50_games where id = p_game;
  select * into t from k50_teams where id = g.current_team_id;
  n := coalesce(array_length(g.proposed_correct, 1), 0);
  pts := n * g.points_per_word;

  update k50_teams set score = score + pts, describer_cursor = describer_cursor + 1 where id = t.id;
  update k50_games set
    status = 'EVENT', review_proposed = false, review_note = null,
    last_event = jsonb_build_object('kind', 'round', 'title', 'Round complete',
      'text', format('%s got %s of 11 words right: +%s points.', t.name, n, pts),
      'teamId', t.id, 'words', n, 'points', pts)
  where id = p_game;
  perform k50_log(p_game, 'round', format('%s scored %s word%s (+%s points).', t.name, n, case when n = 1 then '' else 's' end, pts), t.id);
  perform k50_check_win(p_game);
end $$;

-- If everyone except the describer has approved, finalize.
create function k50_review_check(p_game uuid) returns void
language plpgsql security definer set search_path = public as $$
declare g k50_games; v_need int; v_ok int;
begin
  select * into g from k50_games where id = p_game;
  if g.status <> 'REVIEW' or not g.review_proposed then return; end if;
  select count(*) into v_need from k50_players
  where game_id = p_game and id is distinct from k50_describer_id(p_game, g.current_team_id);
  select count(*) into v_ok from k50_review_votes where game_id = p_game and vote = 'approve';
  if v_ok >= v_need then perform k50_finalize_round(p_game); end if;
end $$;

-- Works out what happens on the tile a team has just landed on.
create function k50_resolve_landing(p_game uuid, p_team uuid, p_roll int, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  t k50_teams; tile k50_board_tiles; j k50_judiciary_cards;
  v_deck text; v_card uuid; v_detail text;
begin
  select * into t from k50_teams where id = p_team;
  select * into tile from k50_board_tiles where position = t.position;

  if tile.kind in ('RED', 'BLACK') then
    v_deck := case when tile.kind = 'BLACK' then 'RED' else 'BLACK' end;
    v_card := k50_draw_card(p_game, v_deck);
    delete from k50_review_votes where game_id = p_game;
    update k50_games set
      status = 'CARD_PREP', current_card_id = v_card, swaps_used = 0, round_started_at = null,
      proposed_correct = null, review_proposed = false, review_note = null, pending_choice = null,
      last_event = jsonb_build_object('kind', 'card', 'teamId', p_team, 'roll', p_roll, 'note', p_note,
        'deck', v_deck, 'tile', tile.kind,
        'title', format('%s landed on a %s tile', t.name, lower(tile.kind)),
        'text', format('Read from a %s card.', lower(v_deck)))
    where id = p_game;

  elsif tile.kind = 'START' then
    update k50_games set status = 'EVENT', pending_choice = null,
      last_event = jsonb_build_object('kind', 'start', 'teamId', p_team, 'roll', p_roll, 'note', p_note,
        'title', 'Back at START', 'text', t.name || ' landed right on START. Nothing to read: roll again next turn!')
    where id = p_game;

  elsif tile.kind = 'JUDICIARY' then
    select * into j from k50_judiciary_cards order by random() limit 1;
    v_detail := k50_apply_effect(p_game, p_team, j.effect);
    update k50_games set status = 'EVENT', pending_choice = null,
      last_event = jsonb_build_object('kind', 'judiciary', 'teamId', p_team, 'roll', p_roll, 'note', p_note,
        'title', 'Judiciary card', 'text', j.description, 'detail', v_detail)
    where id = p_game;
    perform k50_log(p_game, 'judiciary', t.name || ': ' || j.description || ' ' || v_detail, p_team);

  elsif tile.code in ('GIVE', 'STEAL') then
    update k50_games set status = 'CHOOSE_TARGET',
      pending_choice = jsonb_build_object('type', lower(tile.code), 'value', (tile.effect ->> 'value')::int),
      last_event = jsonb_build_object('kind', lower(tile.code), 'teamId', p_team, 'roll', p_roll, 'note', p_note,
        'title', tile.label, 'text', case when tile.code = 'GIVE' then 'Pick which team receives the points.'
                                          else 'Pick which team to take the points from.' end)
    where id = p_game;

  else
    v_detail := k50_apply_effect(p_game, p_team, tile.effect);
    update k50_games set status = 'EVENT', pending_choice = null,
      last_event = jsonb_build_object('kind', lower(coalesce(tile.code, 'tile')), 'teamId', p_team,
        'roll', p_roll, 'note', p_note, 'title', tile.label, 'text', v_detail)
    where id = p_game;
    perform k50_log(p_game, 'tile', t.name || ': ' || coalesce(v_detail, tile.label), p_team);
  end if;
end $$;

-- Validates and inserts a team. Used by the host and by players creating their own.
create function k50_insert_team(p_game uuid, p_name text, p_color text, p_icon text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_color text := lower(btrim(coalesce(p_color, '')));
  v_icon text := btrim(coalesce(p_icon, ''));
  v_seq int; v_id uuid;
  v_icons text[] := array['chess-pawn','crown','star','paw','rocket','bolt','heart','shield-halved','fire','gem','leaf','sun'];
begin
  if char_length(v_name) < 1 or char_length(v_name) > 14 then
    raise exception 'Team names must be 1 to 14 characters.';
  end if;
  if v_color !~ '^#[0-9a-f]{6}$' then raise exception 'Pick a valid marker colour.'; end if;
  if not (v_icon = any (v_icons)) then raise exception 'Pick a marker shape from the list.'; end if;
  if (select count(*) from k50_teams where game_id = p_game) >= 8 then
    raise exception 'A game can have at most 8 teams.';
  end if;
  if exists (select 1 from k50_teams where game_id = p_game and lower(name) = lower(v_name)) then
    raise exception 'A team called "%" already exists.', v_name;
  end if;
  if exists (select 1 from k50_teams where game_id = p_game and lower(color) = v_color) then
    raise exception 'Another team already uses that colour. Pick a different one.';
  end if;
  select coalesce(max(seq), -1) + 1 into v_seq from k50_teams where game_id = p_game;
  insert into k50_teams (game_id, name, color, icon, seq) values (p_game, v_name, v_color, v_icon, v_seq)
  returning id into v_id;
  return v_id;
end $$;

-- -------------------------------------------------------------------
-- 5. Snapshot: the one read the browser makes. Masks secrets by role.
-- -------------------------------------------------------------------
create function k50_build_snapshot(p_game uuid, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g k50_games; me k50_players; v_is_host boolean; v_describer uuid; v_card k50_cards;
  v_can_see boolean := false; v_card_json jsonb := null; v_teams jsonb; v_players jsonb;
  v_log jsonb; v_review jsonb := null; v_need int; v_votes jsonb; v_me jsonb := null; v_role text;
begin
  select * into g from k50_games where id = p_game;
  me := k50_player_by_token(p_game, p_token);
  v_is_host := (auth.uid() is not null and auth.uid() = g.host_id);
  v_describer := k50_describer_id(g.id, g.current_team_id);

  -- Words are only included for the describer while the round is live, and for
  -- EVERYONE once the timer has ended (REVIEW) so the count can be checked.
  if g.current_card_id is not null and g.status in ('CARD_PREP', 'ROUND_ACTIVE', 'REVIEW') then
    select * into v_card from k50_cards where id = g.current_card_id;
    v_can_see := (g.status = 'REVIEW') or (me.id is not null and me.id = v_describer);
    v_card_json := jsonb_build_object(
      'deck', v_card.deck,
      'count', array_length(v_card.words, 1),
      'words', case when v_can_see then to_jsonb(v_card.words) else null end);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name, 'color', t.color, 'icon', t.icon, 'score', t.score,
    'position', t.position, 'skipNext', t.skip_next, 'jailFree', t.jail_free, 'seq', t.seq
  ) order by t.seq), '[]'::jsonb) into v_teams
  from k50_teams t where t.game_id = g.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'nickname', p.nickname, 'teamId', p.team_id, 'joinOrder', p.join_order
  ) order by p.join_order), '[]'::jsonb) into v_players
  from k50_players p where p.game_id = g.id;

  select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'text', e.text) order by e.id desc), '[]'::jsonb)
  into v_log
  from (select * from k50_events where game_id = g.id order by id desc limit 20) e;

  if g.status = 'REVIEW' then
    select count(*) into v_need from k50_players
    where game_id = g.id and id is distinct from v_describer;
    select coalesce(jsonb_agg(jsonb_build_object('playerId', v.player_id, 'vote', v.vote)), '[]'::jsonb)
    into v_votes from k50_review_votes v where v.game_id = g.id;
    v_review := jsonb_build_object(
      'proposed', to_jsonb(g.proposed_correct),
      'submitted', g.review_proposed,
      'note', g.review_note,
      'needed', v_need,
      'votes', v_votes,
      'points', coalesce(array_length(g.proposed_correct, 1), 0) * g.points_per_word);
  end if;

  if me.id is not null then
    v_me := jsonb_build_object('playerId', me.id, 'nickname', me.nickname, 'teamId', me.team_id);
  end if;
  v_role := case when v_is_host then 'HOST' when me.id is not null then 'PLAYER' else 'SPECTATOR' end;

  return jsonb_build_object(
    'serverTime', now(),
    'role', v_role,
    'me', v_me,
    'game', jsonb_build_object(
      'id', g.id, 'roomCode', g.room_code, 'status', g.status,
      'currentTeamId', g.current_team_id, 'describerId', v_describer,
      'roundStartedAt', g.round_started_at, 'roundSeconds', g.round_seconds,
      'winningScore', g.winning_score, 'pointsPerWord', g.points_per_word,
      'winnerTeamId', g.winner_team_id, 'swapsUsed', g.swaps_used, 'swapsMax', 2,
      'lastRoll', g.last_roll, 'rollSeq', g.roll_seq,
      'lastEvent', g.last_event, 'pendingChoice', g.pending_choice),
    'teams', v_teams,
    'players', v_players,
    'card', v_card_json,
    'review', v_review,
    'log', v_log);
end $$;

-- -------------------------------------------------------------------
-- 6. Public API (these are the functions the browser calls)
--    Every mutating call returns the caller's fresh snapshot.
-- -------------------------------------------------------------------

-- HOST: create a game. Requires a signed-in Supabase user.
create function k50_create_game(p_winning_score int default 500) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text; v_id uuid; v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_try int := 0;
begin
  if auth.uid() is null then raise exception 'Sign in to host a game.'; end if;
  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from k50_games where room_code = v_code);
    v_try := v_try + 1;
    if v_try > 30 then raise exception 'Could not create a room code. Try again.'; end if;
  end loop;

  insert into k50_games (room_code, host_id, winning_score)
  values (v_code, auth.uid(), greatest(50, least(coalesce(p_winning_score, 500), 5000)))
  returning id into v_id;
  perform k50_touch(v_id);
  perform k50_log(v_id, 'lobby', 'Game created. Waiting for teams to join.');
  return jsonb_build_object('roomCode', v_code);
end $$;

-- HOST: my recent games, so I can reopen one after a refresh.
create function k50_my_games() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'roomCode', x.room_code, 'status', x.status, 'createdAt', x.created_at,
      'teams', (select count(*) from k50_teams t where t.game_id = x.id)) order by x.created_at desc)
    from (select * from k50_games where host_id = auth.uid() order by created_at desc limit 8) x
  ), '[]'::jsonb);
end $$;

-- ANYONE: read the game as seen by this viewer.
create function k50_snapshot(p_room text, p_token text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from k50_games where room_code = upper(btrim(coalesce(p_room, '')));
  if v_id is null then raise exception 'Game not found. Check the room code.'; end if;
  return k50_build_snapshot(v_id, p_token);
end $$;

-- PLAYER: join (or re-join / change team in the lobby). Pass an existing team id,
-- or p_new_team_* to create a new team while in the lobby.
create function k50_join(
  p_room text, p_token text, p_nickname text,
  p_team_id uuid default null, p_new_team_name text default null,
  p_new_color text default null, p_new_icon text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g k50_games; me k50_players; v_nick text := btrim(coalesce(p_nickname, '')); v_team uuid;
begin
  g := k50_lock_game(p_room);
  if p_token is null or char_length(p_token) < 8 then raise exception 'Missing device token. Refresh and try again.'; end if;
  if g.status = 'FINISHED' then raise exception 'This game has finished.'; end if;
  if char_length(v_nick) < 1 or char_length(v_nick) > 14 then raise exception 'Pick a nickname (1 to 14 characters).'; end if;
  if exists (select 1 from k50_players where game_id = g.id and lower(nickname) = lower(v_nick) and token <> p_token) then
    raise exception 'That nickname is already taken in this game.';
  end if;

  me := k50_player_by_token(g.id, p_token);

  if coalesce(btrim(p_new_team_name), '') <> '' then
    if g.status <> 'LOBBY' then raise exception 'New teams can only be created before the game starts.'; end if;
    v_team := k50_insert_team(g.id, p_new_team_name, p_new_color, p_new_icon);
  elsif p_team_id is not null then
    select id into v_team from k50_teams where id = p_team_id and game_id = g.id;
    if v_team is null then raise exception 'That team no longer exists.'; end if;
  else
    raise exception 'Choose a team or create one.';
  end if;

  if me.id is not null and me.team_id is distinct from v_team and g.status <> 'LOBBY' then
    raise exception 'You cannot switch teams once the game has started.';
  end if;

  if me.id is null then
    insert into k50_players (game_id, team_id, token, nickname, join_order)
    values (g.id, v_team, p_token, v_nick,
            (select coalesce(max(join_order), -1) + 1 from k50_players where game_id = g.id));
    perform k50_log(g.id, 'join', v_nick || ' joined the game.');
  else
    update k50_players set nickname = v_nick, team_id = v_team where id = me.id;
  end if;

  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- HOST: create a team in the lobby.
create function k50_create_team(p_room text, p_token text, p_name text, p_color text, p_icon text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games;
begin
  g := k50_lock_game(p_room);
  if not k50_is_host(g) then raise exception 'Only the host can do that.'; end if;
  if g.status <> 'LOBBY' then raise exception 'Teams can only be added in the lobby.'; end if;
  perform k50_insert_team(g.id, p_name, p_color, p_icon);
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- HOST: remove an (empty or abandoned) team in the lobby.
create function k50_remove_team(p_room text, p_token text, p_team_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games;
begin
  g := k50_lock_game(p_room);
  if not k50_is_host(g) then raise exception 'Only the host can do that.'; end if;
  if g.status <> 'LOBBY' then raise exception 'Teams can only be removed in the lobby.'; end if;
  delete from k50_teams where id = p_team_id and game_id = g.id;
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- HOST: remove a player (lobby only, to keep turn order sane).
create function k50_remove_player(p_room text, p_token text, p_player_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games;
begin
  g := k50_lock_game(p_room);
  if not k50_is_host(g) then raise exception 'Only the host can do that.'; end if;
  if g.status <> 'LOBBY' then raise exception 'Players can only be removed in the lobby.'; end if;
  delete from k50_players where id = p_player_id and game_id = g.id;
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- HOST: start the game.
create function k50_start_game(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games; v_n int; v_empty text; v_first uuid;
begin
  g := k50_lock_game(p_room);
  if not k50_is_host(g) then raise exception 'Only the host can start the game.'; end if;
  if g.status <> 'LOBBY' then raise exception 'The game has already started.'; end if;
  select count(*) into v_n from k50_teams where game_id = g.id;
  if v_n < 2 then raise exception 'Create at least 2 teams to start.'; end if;
  select t.name into v_empty from k50_teams t
  where t.game_id = g.id and not exists (select 1 from k50_players p where p.team_id = t.id)
  order by t.seq limit 1;
  if v_empty is not null then raise exception 'Team "%" has no players yet.', v_empty; end if;

  delete from k50_used_cards where game_id = g.id;
  delete from k50_review_votes where game_id = g.id;
  select id into v_first from k50_teams where game_id = g.id order by seq limit 1;
  update k50_games set status = 'AWAITING_ROLL', current_team_id = v_first, current_card_id = null,
    winner_team_id = null, last_event = null, last_roll = null where id = g.id;
  perform k50_log(g.id, 'start', 'The game has started!');
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- Roll the die: the player whose turn it is to describe/roll, or the host.
create function k50_roll(p_room text, p_token text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games; me k50_players; v_roll int; v_note text; t k50_teams;
begin
  g := k50_lock_game(p_room);
  if g.status <> 'AWAITING_ROLL' then raise exception 'It is not time to roll right now.'; end if;
  me := k50_player_by_token(g.id, p_token);
  if not (k50_is_host(g) or (me.id is not null and me.id = k50_describer_id(g.id, g.current_team_id))) then
    raise exception 'Only the player whose turn it is (or the host) can roll.';
  end if;

  v_roll := 1 + floor(random() * 6)::int;
  v_note := k50_move_team(g.id, g.current_team_id, v_roll, true);
  update k50_games set last_roll = v_roll, roll_seq = roll_seq + 1 where id = g.id;
  select * into t from k50_teams where id = g.current_team_id;
  perform k50_log(g.id, 'roll', format('%s rolled a %s%s.', t.name, v_roll, v_note), t.id);

  perform k50_resolve_landing(g.id, t.id, v_roll, v_note);
  perform k50_check_win(g.id);
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- DESCRIBER: swap the card for a fresh one (max 2 swaps, before the timer starts).
create function k50_swap_card(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games; me k50_players; v_deck text; v_new uuid;
begin
  g := k50_lock_game(p_room);
  if g.status <> 'CARD_PREP' then raise exception 'You can only swap before the timer starts.'; end if;
  me := k50_player_by_token(g.id, p_token);
  if me.id is null or me.id is distinct from k50_describer_id(g.id, g.current_team_id) then
    raise exception 'Only the describer can swap the card.';
  end if;
  if g.swaps_used >= 2 then raise exception 'No swaps left. You must play this card.'; end if;
  select deck into v_deck from k50_cards where id = g.current_card_id;
  v_new := k50_draw_card(g.id, v_deck);
  update k50_games set current_card_id = v_new, swaps_used = swaps_used + 1 where id = g.id;
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- DESCRIBER (or host): start the 50 second timer.
create function k50_start_round(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games; me k50_players;
begin
  g := k50_lock_game(p_room);
  if g.status <> 'CARD_PREP' then raise exception 'There is no card waiting to be played.'; end if;
  me := k50_player_by_token(g.id, p_token);
  if not (k50_is_host(g) or (me.id is not null and me.id = k50_describer_id(g.id, g.current_team_id))) then
    raise exception 'Only the describer (or the host) can start the timer.';
  end if;
  update k50_games set status = 'ROUND_ACTIVE', round_started_at = now() where id = g.id;
  perform k50_log(g.id, 'round', 'Round started!', g.current_team_id);
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- Ends the round. Describer/host any time; anyone once the time is up.
-- Safe to call many times (every device calls it when its timer hits zero).
create function k50_end_round(p_room text, p_token text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games; me k50_players; v_ok boolean;
begin
  g := k50_lock_game(p_room);
  if g.status <> 'ROUND_ACTIVE' then
    return k50_build_snapshot(g.id, p_token);
  end if;
  me := k50_player_by_token(g.id, p_token);
  v_ok := k50_is_host(g)
       or (me.id is not null and me.id = k50_describer_id(g.id, g.current_team_id))
       or now() >= g.round_started_at + make_interval(secs => g.round_seconds - 1);
  if not v_ok then raise exception 'Time is not up yet.'; end if;

  delete from k50_review_votes where game_id = g.id;
  update k50_games set status = 'REVIEW', proposed_correct = null, review_proposed = false, review_note = null
  where id = g.id;
  perform k50_log(g.id, 'round', 'Time! The card is revealed. Describer: mark the words that were guessed.', g.current_team_id);
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- DESCRIBER: propose which words were guessed (indexes 0 to 10).
create function k50_submit_tally(p_room text, p_token text, p_correct int[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games; me k50_players; v_clean int[];
begin
  g := k50_lock_game(p_room);
  if g.status <> 'REVIEW' then raise exception 'There is no round to score right now.'; end if;
  me := k50_player_by_token(g.id, p_token);
  if me.id is null or me.id is distinct from k50_describer_id(g.id, g.current_team_id) then
    raise exception 'Only the describer can mark the words.';
  end if;
  select coalesce(array_agg(distinct x order by x), '{}') into v_clean from unnest(coalesce(p_correct, '{}')) x;
  if exists (select 1 from unnest(v_clean) x where x < 0 or x > 10) then
    raise exception 'Invalid word selection.';
  end if;

  delete from k50_review_votes where game_id = g.id;
  update k50_games set proposed_correct = v_clean, review_proposed = true, review_note = null where id = g.id;
  perform k50_log(g.id, 'review', format('Describer marked %s word%s. Everyone else: approve or dispute.',
    coalesce(array_length(v_clean, 1), 0), case when coalesce(array_length(v_clean, 1), 0) = 1 then '' else 's' end),
    g.current_team_id);
  perform k50_review_check(g.id);
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- EVERYONE ELSE: approve or dispute the describer's count.
create function k50_vote(p_room text, p_token text, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games; me k50_players;
begin
  g := k50_lock_game(p_room);
  if g.status <> 'REVIEW' or not g.review_proposed then raise exception 'There is nothing to vote on right now.'; end if;
  me := k50_player_by_token(g.id, p_token);
  if me.id is null then raise exception 'Only players in this game can vote.'; end if;
  if me.id = k50_describer_id(g.id, g.current_team_id) then raise exception 'The describer cannot vote on their own count.'; end if;

  if p_approve then
    insert into k50_review_votes (game_id, player_id, vote) values (g.id, me.id, 'approve')
    on conflict (game_id, player_id) do update set vote = 'approve';
    perform k50_review_check(g.id);
  else
    delete from k50_review_votes where game_id = g.id;
    update k50_games set review_proposed = false,
      review_note = me.nickname || ' disputed the count. Describer, please re-check the words.'
    where id = g.id;
    perform k50_log(g.id, 'review', me.nickname || ' disputed the count.', g.current_team_id);
  end if;
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- HOST: settle the count when the vote is stuck (optionally set the words).
create function k50_host_finalize(p_room text, p_token text, p_correct int[] default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games; v_clean int[];
begin
  g := k50_lock_game(p_room);
  if not k50_is_host(g) then raise exception 'Only the host can do that.'; end if;
  if g.status <> 'REVIEW' then raise exception 'There is no round to score right now.'; end if;
  if p_correct is not null then
    select coalesce(array_agg(distinct x order by x), '{}') into v_clean from unnest(p_correct) x;
    if exists (select 1 from unnest(v_clean) x where x < 0 or x > 10) then raise exception 'Invalid word selection.'; end if;
    update k50_games set proposed_correct = v_clean, review_proposed = true where id = g.id;
    g.proposed_correct := v_clean;
  end if;
  if g.proposed_correct is null then raise exception 'Tick the correct words first.'; end if;
  perform k50_finalize_round(g.id);
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- Give 10 / Steal 10: the team that landed picks the other team.
create function k50_choose_target(p_room text, p_token text, p_target uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  g k50_games; me k50_players; v_type text; v_amt int; v_moved int; me_name text; tg_name text; v_text text;
begin
  g := k50_lock_game(p_room);
  if g.status <> 'CHOOSE_TARGET' then raise exception 'There is nothing to choose right now.'; end if;
  me := k50_player_by_token(g.id, p_token);
  if not (k50_is_host(g) or (me.id is not null and me.team_id = g.current_team_id)) then
    raise exception 'Only the team that landed here (or the host) can choose.';
  end if;
  if p_target is null or p_target = g.current_team_id
     or not exists (select 1 from k50_teams where id = p_target and game_id = g.id) then
    raise exception 'Pick one of the other teams.';
  end if;

  v_type := g.pending_choice ->> 'type';
  v_amt := coalesce((g.pending_choice ->> 'value')::int, 10);
  select name into me_name from k50_teams where id = g.current_team_id;
  select name into tg_name from k50_teams where id = p_target;

  if v_type = 'give' then
    v_moved := k50_transfer(g.current_team_id, p_target, v_amt);
    v_text := format('%s gives %s points to %s.', me_name, v_moved, tg_name);
  else
    v_moved := k50_transfer(p_target, g.current_team_id, v_amt);
    v_text := format('%s steals %s points from %s.', me_name, v_moved, tg_name);
  end if;

  update k50_games set status = 'EVENT', pending_choice = null,
    last_event = jsonb_build_object('kind', v_type, 'teamId', g.current_team_id,
      'title', case when v_type = 'give' then 'Points given' else 'Points stolen' end, 'text', v_text)
  where id = g.id;
  perform k50_log(g.id, 'tile', v_text, g.current_team_id);
  perform k50_check_win(g.id);
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- Close the result card and pass the turn on.
create function k50_continue(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games; me k50_players;
begin
  g := k50_lock_game(p_room);
  if g.status <> 'EVENT' then return k50_build_snapshot(g.id, p_token); end if;
  me := k50_player_by_token(g.id, p_token);
  if not (k50_is_host(g) or (me.id is not null and me.team_id = g.current_team_id)) then
    raise exception 'Only the team that just played (or the host) can continue.';
  end if;
  perform k50_advance(g.id);
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- HOST: emergency "skip this turn" if someone is stuck or has left.
create function k50_host_skip_turn(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games;
begin
  g := k50_lock_game(p_room);
  if not k50_is_host(g) then raise exception 'Only the host can do that.'; end if;
  if g.status in ('LOBBY', 'FINISHED') then raise exception 'There is no turn to skip.'; end if;
  perform k50_log(g.id, 'skip', 'The host skipped a turn.', g.current_team_id);
  perform k50_advance(g.id);
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- HOST: back to the lobby with the same teams and players (play again).
create function k50_reset_game(p_room text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games;
begin
  g := k50_lock_game(p_room);
  if not k50_is_host(g) then raise exception 'Only the host can do that.'; end if;
  update k50_teams set score = 0, position = 0, describer_cursor = 0, skip_next = false, jail_free = 0
  where game_id = g.id;
  delete from k50_used_cards where game_id = g.id;
  delete from k50_review_votes where game_id = g.id;
  delete from k50_events where game_id = g.id;
  update k50_games set status = 'LOBBY', current_team_id = null, current_card_id = null, swaps_used = 0,
    round_started_at = null, proposed_correct = null, review_proposed = false, review_note = null,
    pending_choice = null, winner_team_id = null, last_roll = null, roll_seq = 0, last_event = null
  where id = g.id;
  perform k50_log(g.id, 'lobby', 'New game: back in the lobby.');
  perform k50_touch(g.id);
  return k50_build_snapshot(g.id, p_token);
end $$;

-- HOST: delete the game entirely.
create function k50_delete_game(p_room text, p_token text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g k50_games;
begin
  g := k50_lock_game(p_room);
  if not k50_is_host(g) then raise exception 'Only the host can do that.'; end if;
  delete from k50_games where id = g.id;
  return jsonb_build_object('deleted', true);
end $$;

-- -------------------------------------------------------------------
-- 7. Permissions: helpers are private, only the API above is callable.
-- -------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'k50\_%'
  loop
    execute 'revoke all on function ' || r.sig::text || ' from public, anon, authenticated';
  end loop;
end $$;

grant execute on function
  k50_create_game(int), k50_my_games(), k50_snapshot(text, text),
  k50_join(text, text, text, uuid, text, text, text),
  k50_create_team(text, text, text, text, text), k50_remove_team(text, text, uuid),
  k50_remove_player(text, text, uuid), k50_start_game(text, text), k50_roll(text, text),
  k50_swap_card(text, text), k50_start_round(text, text), k50_end_round(text, text),
  k50_submit_tally(text, text, int[]), k50_vote(text, text, boolean),
  k50_host_finalize(text, text, int[]), k50_choose_target(text, text, uuid),
  k50_continue(text, text), k50_host_skip_turn(text, text), k50_reset_game(text, text),
  k50_delete_game(text, text)
to anon, authenticated;

-- 소개팅 시뮬레이션 스키마
-- Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run 하세요.

create extension if not exists pgcrypto;

-- ───────── 테이블 ─────────
create table if not exists rooms (
  code       text primary key,
  host_name  text not null,
  status     text not null default 'lobby' check (status in ('lobby', 'playing', 'ended')),
  created_at timestamptz not null default now()
);

-- 호스트 비밀키: 아무도 직접 읽을 수 없음 (RLS 정책 없음)
create table if not exists room_secrets (
  room_code   text primary key references rooms(code) on delete cascade,
  host_secret uuid not null default gen_random_uuid()
);

create table if not exists players (
  id        uuid primary key default gen_random_uuid(),
  room_code text not null references rooms(code) on delete cascade,
  name      text not null,
  score     int  not null default 0,
  joined_at timestamptz not null default now()
);

-- 참가자 비밀키: 다른 사람이 나인 척 답하지 못하게
create table if not exists player_secrets (
  player_id uuid primary key references players(id) on delete cascade,
  secret    uuid not null default gen_random_uuid()
);

create table if not exists rounds (
  id               bigint generated always as identity primary key,
  room_code        text not null references rooms(code) on delete cascade,
  question         text not null,
  status           text not null default 'open' check (status in ('open', 'closed')),
  winner_answer_id bigint,
  created_at       timestamptz not null default now()
);

create table if not exists answers (
  id         bigint generated always as identity primary key,
  round_id   bigint not null references rounds(id) on delete cascade,
  room_code  text   not null references rooms(code) on delete cascade,
  player_id  uuid   not null references players(id) on delete cascade,
  body       text   not null,
  created_at timestamptz not null default now(),
  unique (round_id, player_id)
);

-- ───────── 권한: 읽기만 공개, 쓰기는 아래 함수로만 ─────────
alter table rooms          enable row level security;
alter table room_secrets   enable row level security;
alter table players        enable row level security;
alter table player_secrets enable row level security;
alter table rounds         enable row level security;
alter table answers        enable row level security;

create policy "public read" on rooms   for select using (true);
create policy "public read" on players for select using (true);
create policy "public read" on rounds  for select using (true);
create policy "public read" on answers for select using (true);

-- ───────── 함수 ─────────
create or replace function _assert_host(p_code text, p_secret uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from room_secrets where room_code = p_code and host_secret = p_secret) then
    raise exception '호스트 권한이 없어요';
  end if;
end $$;

create or replace function create_room(p_host_name text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_name   text := trim(coalesce(p_host_name, ''));
  v_code   text;
  v_secret uuid;
begin
  if length(v_name) = 0 or length(v_name) > 20 then
    raise exception '이름은 1~20자로 입력해 주세요';
  end if;
  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from rooms where code = v_code);
  end loop;
  insert into rooms (code, host_name) values (v_code, v_name);
  insert into room_secrets (room_code) values (v_code) returning host_secret into v_secret;
  return json_build_object('code', v_code, 'secret', v_secret);
end $$;

create or replace function join_room(p_code text, p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_code   text := upper(trim(coalesce(p_code, '')));
  v_name   text := trim(coalesce(p_name, ''));
  v_status text;
  v_id     uuid;
  v_secret uuid;
begin
  select status into v_status from rooms where code = v_code;
  if not found then raise exception '방을 찾을 수 없어요'; end if;
  if v_status = 'ended' then raise exception '이미 끝난 소개팅이에요'; end if;
  if length(v_name) = 0 or length(v_name) > 20 then
    raise exception '닉네임은 1~20자로 입력해 주세요';
  end if;
  if exists (select 1 from players where room_code = v_code and lower(name) = lower(v_name)) then
    raise exception '이미 사용 중인 닉네임이에요';
  end if;
  if (select count(*) from players where room_code = v_code) >= 12 then
    raise exception '방이 가득 찼어요';
  end if;
  insert into players (room_code, name) values (v_code, v_name) returning id into v_id;
  insert into player_secrets (player_id) values (v_id) returning secret into v_secret;
  return json_build_object('code', v_code, 'player_id', v_id, 'secret', v_secret);
end $$;

-- 호스트가 새 이야기를 보냄 (열려 있던 질문은 선택 없이 마감)
create or replace function post_message(p_code text, p_secret uuid, p_text text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_text text := trim(coalesce(p_text, ''));
  v_id   bigint;
begin
  perform _assert_host(p_code, p_secret);
  if (select status from rooms where code = p_code) = 'ended' then
    raise exception '이미 끝난 소개팅이에요';
  end if;
  if length(v_text) = 0 or length(v_text) > 300 then
    raise exception '메시지는 1~300자로 입력해 주세요';
  end if;
  update rounds set status = 'closed' where room_code = p_code and status = 'open';
  insert into rounds (room_code, question) values (p_code, v_text) returning id into v_id;
  update rooms set status = 'playing' where code = p_code and status = 'lobby';
  return v_id;
end $$;

-- 참가자가 답변 (마감 전까지 수정 가능)
create or replace function submit_answer(p_player_id uuid, p_secret uuid, p_round_id bigint, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_body text := trim(coalesce(p_body, ''));
  v_room text;
begin
  select p.room_code into v_room
    from players p join player_secrets s on s.player_id = p.id
   where p.id = p_player_id and s.secret = p_secret;
  if not found then raise exception '참가자 정보가 올바르지 않아요'; end if;
  if not exists (select 1 from rounds where id = p_round_id and room_code = v_room and status = 'open') then
    raise exception '이미 마감된 질문이에요';
  end if;
  if length(v_body) = 0 or length(v_body) > 300 then
    raise exception '답변은 1~300자로 입력해 주세요';
  end if;
  insert into answers (round_id, room_code, player_id, body)
  values (p_round_id, v_room, p_player_id, v_body)
  on conflict (round_id, player_id) do update set body = excluded.body, created_at = now();
end $$;

-- 호스트가 가장 마음에 드는 답변 선택 → +1점, 질문 마감
create or replace function pick_winner(p_code text, p_secret uuid, p_answer_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_round  bigint;
  v_player uuid;
begin
  perform _assert_host(p_code, p_secret);
  select a.round_id, a.player_id into v_round, v_player
    from answers a join rounds r on r.id = a.round_id
   where a.id = p_answer_id and a.room_code = p_code and r.status = 'open'
   for update of r;
  if not found then raise exception '이미 마감된 질문이에요'; end if;
  update rounds  set status = 'closed', winner_answer_id = p_answer_id where id = v_round;
  update players set score = score + 1 where id = v_player;
end $$;

create or replace function end_room(p_code text, p_secret uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _assert_host(p_code, p_secret);
  update rounds set status = 'closed' where room_code = p_code and status = 'open';
  update rooms  set status = 'ended'  where code = p_code;
end $$;

revoke all on function _assert_host(text, uuid) from public, anon, authenticated;
revoke all on function create_room(text), join_room(text, text), post_message(text, uuid, text),
  submit_answer(uuid, uuid, bigint, text), pick_winner(text, uuid, bigint), end_room(text, uuid) from public;
grant execute on function create_room(text), join_room(text, text), post_message(text, uuid, text),
  submit_answer(uuid, uuid, bigint, text), pick_winner(text, uuid, bigint), end_room(text, uuid)
  to anon, authenticated;

-- ───────── 실시간 반영 ─────────
alter publication supabase_realtime add table rooms, players, rounds, answers;

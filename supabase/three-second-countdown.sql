-- Run once in Supabase SQL Editor for an existing deployment.
-- Schedules shared play, pause, and playing seeks three seconds ahead.
alter table public.choir_state alter column transport set default
  '{"playing":false,"positionSec":0,"startAtMs":null,"stopAtMs":null,"revision":0}';
update public.choir_state
set transport = transport || '{"stopAtMs":null}'::jsonb
where not (transport ? 'stopAtMs');

create or replace function private.choir_command(p_command jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_state public.choir_state%rowtype;
  v_type text := p_command->>'type';
  v_now timestamptz := clock_timestamp();
  v_now_ms numeric;
  v_position numeric;
  v_playing boolean;
  v_start numeric;
  v_end numeric;
  v_label text;
  v_color text;
  v_id uuid;
  v_field text;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.choir_conductors where user_id = (select auth.uid())
  ) then
    raise exception '지휘자 권한이 필요합니다.';
  end if;

  select * into strict v_state from public.choir_state where id = 1 for update;
  v_now_ms := extract(epoch from v_now) * 1000;
  v_playing := (v_state.transport->>'playing')::boolean;
  v_position := (v_state.transport->>'positionSec')::numeric;

  -- An expired conductor lease stops the room before another command runs.
  if v_state.leader_until is null or v_state.leader_until <= v_now then
    if v_playing then
      v_position := least(v_state.duration_sec, v_position + greatest(0,
        (extract(epoch from coalesce(v_state.leader_until, v_now)) * 1000 -
         (v_state.transport->>'startAtMs')::numeric) / 1000));
      v_state.transport := jsonb_build_object('playing', false, 'positionSec', v_position,
        'startAtMs', null, 'stopAtMs', null, 'revision', (v_state.transport->>'revision')::integer + 1);
      v_playing := false;
    end if;
    v_state.leader_id := null;
    v_state.leader_until := null;
  end if;

  if v_type = 'participation:set' then
    if jsonb_typeof(p_command->'active') <> 'boolean' then
      raise exception '연습 참여 상태가 올바르지 않습니다.';
    end if;
    if (p_command->>'active')::boolean then
      v_state.leader_id := (select auth.uid());
      v_state.leader_until := v_now + interval '30 seconds';
    elsif v_state.leader_id = (select auth.uid()) then
      if v_playing then
        v_position := least(v_state.duration_sec, v_position + greatest(0,
          (v_now_ms - (v_state.transport->>'startAtMs')::numeric) / 1000));
        v_state.transport := jsonb_build_object('playing', false, 'positionSec', v_position,
          'startAtMs', null, 'stopAtMs', null, 'revision', (v_state.transport->>'revision')::integer + 1);
      end if;
      v_state.leader_id := null;
      v_state.leader_until := null;
    end if;
  elsif v_type = 'heartbeat' then
    v_state.leader_id := (select auth.uid());
    v_state.leader_until := v_now + interval '30 seconds';
  elsif v_type = 'play' then
    if v_state.leader_id is distinct from (select auth.uid()) or
       v_state.leader_until is null or v_state.leader_until <= v_now then
      raise exception '먼저 같이 연습에 참여해 주세요.';
    end if;
    if not v_playing then
      if v_position >= v_state.duration_sec then v_position := 0; end if;
      v_state.transport := jsonb_build_object('playing', true, 'positionSec', v_position,
        'startAtMs', v_now_ms + 3000, 'stopAtMs', null, 'revision', (v_state.transport->>'revision')::integer + 1);
    end if;
  elsif v_type = 'pause' or v_type = 'seek' then
    if v_playing then
      v_position := least(v_state.duration_sec, v_position + greatest(0,
        (v_now_ms + case when v_type = 'pause' then 3000 else 0 end -
         (v_state.transport->>'startAtMs')::numeric) / 1000));
    end if;
    if v_type = 'seek' then
      if jsonb_typeof(p_command->'positionSec') <> 'number' then
        raise exception '재생 위치가 올바르지 않습니다.';
      end if;
      v_position := (p_command->>'positionSec')::numeric;
      if v_position < 0 or v_position > v_state.duration_sec then
        raise exception '재생 위치가 올바르지 않습니다.';
      end if;
    end if;
    v_state.transport := jsonb_build_object('playing', v_type = 'seek' and v_playing,
      'positionSec', v_position, 'startAtMs', case when v_type = 'seek' and v_playing then v_now_ms + 3000 else null end,
      'stopAtMs', case when v_type = 'pause' then v_now_ms + 3000 else null end,
      'revision', (v_state.transport->>'revision')::integer + 1);
  elsif v_type = 'segment:add' or v_type = 'segment:update' then
    v_label := btrim(p_command->>'label');
    v_color := lower(coalesce(p_command->>'color', '#6b9f8c'));
    if v_label is null or char_length(v_label) not between 1 and 40 or
       jsonb_typeof(p_command->'startSec') <> 'number' or
       jsonb_typeof(p_command->'endSec') <> 'number' or
       v_color !~ '^#[0-9a-f]{6}$' then
      raise exception '구간 이름과 시간을 확인해 주세요.';
    end if;
    v_start := (p_command->>'startSec')::numeric;
    v_end := (p_command->>'endSec')::numeric;
    if v_start < 0 or v_end <= v_start or v_end > v_state.duration_sec then
      raise exception '구간 이름과 시간을 확인해 주세요.';
    end if;
    if v_type = 'segment:add' then
      insert into public.choir_segments (song_id, label, start_sec, end_sec, color)
      values (v_state.song_id, v_label, v_start, v_end, v_color);
    else
      begin v_id := (p_command->>'id')::uuid;
      exception when invalid_text_representation then raise exception '구간을 찾을 수 없습니다.'; end;
      update public.choir_segments set label = v_label, start_sec = v_start,
        end_sec = v_end, color = v_color where id = v_id and song_id = v_state.song_id;
      if not found then raise exception '구간을 찾을 수 없습니다.'; end if;
    end if;
  elsif v_type = 'segment:toggle' then
    v_field := p_command->>'field';
    if v_field not in ('highlighted', 'checked') then raise exception '구간을 찾을 수 없습니다.'; end if;
    begin v_id := (p_command->>'id')::uuid;
    exception when invalid_text_representation then raise exception '구간을 찾을 수 없습니다.'; end;
    if v_field = 'highlighted' then
      if not exists (select 1 from public.choir_segments where id = v_id and song_id = v_state.song_id) then
        raise exception '구간을 찾을 수 없습니다.';
      end if;
      if (select highlighted from public.choir_segments where id = v_id) then
        update public.choir_segments set highlighted = false where id = v_id;
      else
        update public.choir_segments set highlighted = false where song_id = v_state.song_id and highlighted;
        update public.choir_segments set highlighted = true where id = v_id;
      end if;
    else
      update public.choir_segments set checked = not checked where id = v_id and song_id = v_state.song_id;
      if not found then raise exception '구간을 찾을 수 없습니다.'; end if;
    end if;
  elsif v_type = 'segment:delete' then
    begin v_id := (p_command->>'id')::uuid;
    exception when invalid_text_representation then raise exception '구간을 찾을 수 없습니다.'; end;
    delete from public.choir_segments where id = v_id and song_id = v_state.song_id;
  else
    raise exception '지원하지 않는 명령입니다.';
  end if;

  update public.choir_state set transport = v_state.transport,
    leader_id = v_state.leader_id, leader_until = v_state.leader_until,
    updated_at = clock_timestamp() where id = 1;
end;
$$;

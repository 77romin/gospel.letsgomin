import { createClient } from '@supabase/supabase-js';

export function createCloud({ url, key, onState, onConnection, onError }) {
  const db = createClient(url, key);
  let channel = null;
  let catalog = null;
  let role = 'listener';
  let connected = false;
  let participating = false;
  let generation = 0;
  let latestState = null;
  let clockOffsetMs = 0;
  let heartbeat = null;

  async function measureClock() {
    let best = null;
    for (let i = 0; i < 3; i++) {
      const before = Date.now();
      const { data, error } = await db.rpc('choir_clock');
      if (error) throw error;
      const after = Date.now();
      const sample = { delay: after - before, offset: Number(data) - (before + after) / 2 };
      if (!best || sample.delay < best.delay) best = sample;
    }
    clockOffsetMs = best.offset;
    return clockOffsetMs;
  }

  function positionAt(transport, timeMs) {
    if (!transport.playing) return Number(transport.positionSec);
    return Math.min(catalog.tracks.choir.durationSec,
      Number(transport.positionSec) + Math.max(0, (timeMs - Number(transport.startAtMs)) / 1000));
  }

  function convert(row, segments) {
    const now = Date.now() + clockOffsetMs;
    const leaseUntilMs = row.leader_until ? Date.parse(row.leader_until) : null;
    const active = !!leaseUntilMs && leaseUntilMs > now;
    let transport = row.transport;
    if (!active && transport.playing) {
      transport = { playing: false, positionSec: positionAt(transport, leaseUntilMs || now),
        startAtMs: null, revision: transport.revision };
    }
    return { type: 'state', serverTimeMs: now, role, title: catalog.title,
      tracks: catalog.tracks, segments: segments.map(s => ({
        id: s.id, label: s.label, startSec: Number(s.start_sec), endSec: Number(s.end_sec),
        color: s.color, highlighted: s.highlighted, checked: s.checked
      })), conductorParticipating: active, leaseUntilMs, transport };
  }

  async function refresh(myGeneration = generation) {
    if (!catalog) {
      const response = await fetch('/tracks.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('음원 목록을 불러올 수 없습니다.');
      catalog = await response.json();
    }
    const [stateResult, segmentResult] = await Promise.all([
      db.from('choir_state').select('*').eq('id', 1).single(),
      db.from('choir_segments').select('*').eq('song_id', catalog.id).order('start_sec')
    ]);
    if (stateResult.error) throw stateResult.error;
    if (segmentResult.error) throw segmentResult.error;
    if (myGeneration !== generation) return;
    if (stateResult.data.song_id !== catalog.id) throw new Error('Supabase 곡 ID와 tracks.json의 ID가 다릅니다.');
    latestState = convert(stateResult.data, segmentResult.data);
    onState(latestState);
  }

  async function getRole() {
    const { data: { user }, error } = await db.auth.getUser();
    if (error || !user) return 'listener';
    const { data, error: roleError } = await db.from('choir_conductors').select('user_id').eq('user_id', user.id).maybeSingle();
    if (roleError) throw roleError;
    return data ? 'conductor' : 'listener';
  }

  async function connect() {
    const myGeneration = ++generation;
    connected = false;
    onConnection(false);
    if (channel) await db.removeChannel(channel);
    role = await getRole();
    channel = db.channel('choir-practice-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'choir_state' }, payload => {
        if (myGeneration !== generation) return;
        const next = payload.new;
        // A conductor renews the participation lease every eight seconds. The
        // lease does not change playback, so it must not restart mobile media.
        if (next && latestState && next.transport?.revision === latestState.transport.revision &&
            next.song_id === catalog?.id) {
          const wasParticipating = latestState.conductorParticipating;
          latestState.leaseUntilMs = next.leader_until ? Date.parse(next.leader_until) : null;
          latestState.conductorParticipating = !!latestState.leaseUntilMs &&
            latestState.leaseUntilMs > Date.now() + clockOffsetMs;
          if (wasParticipating !== latestState.conductorParticipating) onState(latestState);
          return;
        }
        refresh(myGeneration).catch(onError);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'choir_segments' }, () => refresh(myGeneration).catch(onError))
      .subscribe(async status => {
        if (myGeneration !== generation) return;
        connected = status === 'SUBSCRIBED';
        onConnection(connected);
        if (connected) {
          try {
            await refresh(myGeneration);
            if (participating && role === 'conductor') await send({ type: 'participation:set', active: true });
          } catch (error) { onError(error); }
        }
      });
  }

  async function send(message) {
    if (message.type === 'participation:set') participating = message.active;
    if (!connected) throw new Error('실시간 연결을 기다려 주세요.');
    if (role !== 'conductor') throw new Error('지휘자 권한이 필요합니다.');
    const { error } = await db.rpc('choir_command', { p_command: message });
    if (error) throw error;
    if (message.type !== 'heartbeat') await refresh();
  }

  async function login(email, password) {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const nextRole = await getRole();
    if (nextRole !== 'conductor') {
      await db.auth.signOut();
      throw new Error('이 계정에는 지휘자 권한이 없습니다.');
    }
    role = nextRole;
  }

  async function logout() {
    if (participating && connected) {
      try { await send({ type: 'participation:set', active: false }); } catch (error) { onError(error); }
    }
    participating = false;
    const { error } = await db.auth.signOut();
    if (error) throw error;
    role = 'listener';
  }

  heartbeat = setInterval(() => {
    if (connected && participating && role === 'conductor') send({ type: 'heartbeat' }).catch(onError);
  }, 8000);
  window.addEventListener('pagehide', () => {
    if (participating) {
      // Browser shutdown may cancel this request; the server lease still expires.
      send({ type: 'participation:set', active: false }).catch(() => {});
    }
    clearInterval(heartbeat);
  });

  return { connect, send, login, logout, measureClock, refresh, get state() { return latestState; } };
}

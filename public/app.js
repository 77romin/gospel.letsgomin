import { SharedAudioEngine } from './shared-audio.js';

const $ = id => document.getElementById(id);
const audio = $('audio');
const sharedAudio = new SharedAudioEngine();
const names = { choir: ['합창', 'CHOIR'], soprano: ['소프라노', 'SOPRANO'], alto: ['알토', 'ALTO'], tenor: ['테너', 'TENOR'], baritone: ['바리톤', 'BARITONE'] };
let part = localStorage.getItem('gospel-part') || 'choir';
let mode = localStorage.getItem('gospel-mode') === 'shared' ? 'shared' : 'solo';
localStorage.setItem('gospel-mode', mode);
if (!names[part]) part = 'choir';
let state = null;
let socket = null;
let joined = false;
let offsetMs = 0;
let startTimer = null;
let startPlanId = 0;
let countdownUntilMs = null;
let reconnectTimer = null;
let sourceFile = null;
let sharedSourceFile = null;
let sharedReadyFile = null;
let sharedLoadPromise = null;
let lastRevision = -1;
let toastTimer = null;
let videoOpen = true;
let endingRequested = false;
let lastStartTiming = null;
const syncDebug = new URLSearchParams(location.search).has('syncDebug');
let lastMediaEvent = 'none';
let syncDebugBox = null;
let segmentDraft = { id: null, startSec: null, endSec: null };
const defaultSegmentColor = '#6b9f8c';
const cloudEnabled = !!(import.meta.env?.VITE_SUPABASE_URL && import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY);
const cloud = cloudEnabled ? (await import('./cloud.js')).createCloud({
  url: import.meta.env.VITE_SUPABASE_URL,
  key: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  onState: nextState => { state = nextState; render(); syncAudio(); },
  onConnection: setConnection,
  onError: error => showToast(error.message || '서버 연결 오류가 발생했습니다.')
}) : null;
if (cloud) {
  $('username').value = '';
  $('username').type = 'email';
  $('username').placeholder = '지휘자 이메일';
  $('username').previousSibling.textContent = '이메일';
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
function showToast(message) {
  const box = $('toast'); box.textContent = message; box.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 3500);
}
function isSolo() { return mode === 'solo'; }
function displayedPosition() { return isSolo() && Number.isFinite(audio.currentTime) ? audio.currentTime : projectedPosition(); }
function updateVideoDisplay() {
  const hasVideo = audio.readyState >= 1 && audio.videoWidth > 0;
  const showVideo = videoOpen && !!sourceFile && (audio.readyState < 1 || hasVideo);
  $('showVideoBtn').disabled = !hasVideo;
  $('showVideoBtn').textContent = showVideo ? 'Hide Video' : 'Show Video';
  $('showVideoBtn').setAttribute('aria-expanded', String(showVideo));
  $('videoStage').setAttribute('aria-hidden', String(!showVideo));
  $('videoStage').classList.toggle('is-open', showVideo);
  $('playerPanel').classList.toggle('video-open', showVideo);
}
function segmentColor(segment) { return /^#[0-9a-fA-F]{6}$/.test(segment.color) ? segment.color : defaultSegmentColor; }
function updateDraftView() {
  $('segmentStartTime').textContent = segmentDraft.startSec === null ? '미설정' : formatTime(segmentDraft.startSec);
  $('segmentEndTime').textContent = segmentDraft.endSec === null ? '미설정' : formatTime(segmentDraft.endSec);
  $('segmentFormTitle').textContent = segmentDraft.id ? '연습 구간 수정' : '연습 구간 추가';
  $('segmentSubmit').textContent = segmentDraft.id ? '변경 저장' : '구간 추가';
  $('segmentCancel').classList.toggle('hidden', !segmentDraft.id);
}
function resetDraft() {
  segmentDraft = { id: null, startSec: null, endSec: null };
  $('segmentForm').reset();
  updateDraftView();
}
function projectedPosition() {
  if (!state) return 0;
  const t = state.transport;
  const now = Date.now() + offsetMs;
  if (t.playing) return Math.max(0, t.positionSec + Math.max(0, now - t.startAtMs) / 1000);
  if (Number.isFinite(t.stopAtMs) && now < t.stopAtMs) {
    return Math.max(0, t.positionSec - (t.stopAtMs - now) / 1000);
  }
  return t.positionSec;
}
function send(message) {
  if (cloud) return cloud.send(message).catch(error => showToast(error.message));
  if (!socket || socket.readyState !== WebSocket.OPEN) return showToast('서버 연결을 기다려 주세요.');
  socket.send(JSON.stringify(message));
}
function syncConductorParticipation() {
  if (cloud && state?.role === 'conductor') {
    send({ type: 'participation:set', active: joined && !isSolo() });
    return;
  }
  if (state?.role === 'conductor' && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'participation:set', active: joined && !isSolo() }));
  }
}
function setConnection(connected) {
  $('connection').classList.toggle('offline', !connected);
  $('connection').lastChild.textContent = connected ? '실시간 연결됨' : '연결 끊김';
}
async function measureClock() {
  if (cloud) {
    try { offsetMs = await cloud.measureClock(); } catch (error) { showToast(error.message); }
    return;
  }
  const samples = [];
  for (let i = 0; i < 5; i++) {
    try {
      const before = Date.now();
      const response = await fetch('/api/time', { cache: 'no-store' });
      const { serverTimeMs } = await response.json();
      const after = Date.now();
      samples.push({ delay: after - before, offset: serverTimeMs - (before + after) / 2 });
    } catch { break; }
  }
  if (samples.length) offsetMs = samples.sort((a, b) => a.delay - b.delay)[0].offset;
}
function connect() {
  if (cloud) return cloud.connect().catch(error => { setConnection(false); showToast(error.message); });
  clearTimeout(reconnectTimer);
  if (socket) socket.close();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  let receivedInitialState = false;
  socket = ws;
  ws.addEventListener('open', () => setConnection(true));
  ws.addEventListener('message', event => {
    let data; try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'error') return showToast(data.message);
    if (data.type === 'state') {
      state = data;
      if (!receivedInitialState) { receivedInitialState = true; syncConductorParticipation(); }
      render();
      syncAudio();
    }
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    setConnection(false);
    clearTimeout(startTimer);
    audio.pause();
    reconnectTimer = setTimeout(connect, 1600);
  });
}
function prepareAudio() {
  const track = state?.tracks?.[part] || null;
  const file = track?.videoFile || track?.file || null;
  const nextSharedSource = track?.audioFile || null;
  const sourceChanged = file !== sourceFile || nextSharedSource !== sharedSourceFile;
  if (!sourceChanged) {
    audio.muted = !isSolo();
    if (!isSolo() && sharedSourceFile) prepareSharedAudio().catch(() => {});
    return false;
  }
  const soloPosition = isSolo() ? audio.currentTime : null;
  const resumeSolo = isSolo() && joined && !audio.paused;
  sourceFile = file;
  sharedSourceFile = nextSharedSource;
  sharedReadyFile = null;
  sharedLoadPromise = null;
  sharedAudio.stop();
  audio.pause();
  audio.muted = !isSolo();
  if (file) {
    if (soloPosition !== null) audio.addEventListener('loadedmetadata', () => {
      if (sourceFile !== file) return;
      audio.currentTime = Math.min(soloPosition, audio.duration || soloPosition);
      if (resumeSolo) audio.play().catch(() => showToast('소리를 들으려면 연습 참여를 눌러 주세요.'));
    }, { once: true });
    audio.src = file; audio.load();
  }
  else { audio.removeAttribute('src'); audio.load(); }
  if (!isSolo() && sharedSourceFile) prepareSharedAudio().catch(() => {});
  updateVideoDisplay();
  return true;
}

function prepareSharedAudio() {
  const expectedFile = sharedSourceFile;
  if (!expectedFile) return Promise.reject(new Error('공동 재생 음원이 없습니다.'));
  if (sharedReadyFile === expectedFile) return Promise.resolve();
  if (sharedLoadPromise) return sharedLoadPromise;
  sharedLoadPromise = sharedAudio.load(expectedFile).then(() => {
    if (sharedSourceFile !== expectedFile) return;
    sharedReadyFile = expectedFile;
    render();
  }).catch(error => {
    if (error?.name !== 'AbortError') showToast(error.message || '공동 재생 음원을 준비하지 못했습니다.');
    throw error;
  }).finally(() => {
    if (sharedSourceFile === expectedFile) sharedLoadPromise = null;
  });
  return sharedLoadPromise;
}

async function beginAudio(expectedRevision = state?.transport.revision, expectedFile = sharedSourceFile, expectedMode = mode,
    scheduledAtMs = Date.now() + offsetMs, targetPosition = projectedPosition()) {
  if (!joined || !expectedFile || !state?.transport.playing || isSolo()) return;
  const planId = ++startPlanId;
  const stillCurrent = () => planId === startPlanId && joined && mode === expectedMode &&
    state?.transport.playing && state.transport.revision === expectedRevision && sharedSourceFile === expectedFile;
  if (targetPosition >= timelineDuration()) return;
  try {
    await prepareSharedAudio();
    if (!stillCurrent()) return;
    const timing = sharedAudio.schedule({ serverTimeMs: scheduledAtMs, clockOffsetMs: offsetMs, offsetSec: targetPosition });
    if (!timing) return;
    lastStartTiming = { revision: expectedRevision, scheduledAtMs,
      requestedAtMs: Date.now() + offsetMs, playingAtMs: scheduledAtMs };
    countdownUntilMs = scheduledAtMs;
    audio.muted = true;
    try { audio.currentTime = Math.max(0, targetPosition); } catch {}
    clearTimeout(startTimer);
    const startVideo = async () => {
      if (!stillCurrent()) return;
      countdownUntilMs = null;
      render();
      try {
        await audio.play();
        if (!stillCurrent()) audio.pause();
      } catch {}
    };
    startTimer = setTimeout(startVideo, Math.max(0, scheduledAtMs - (Date.now() + offsetMs)));
  } catch { showToast('소리를 들으려면 ‘연습 참여’를 다시 눌러 주세요.'); }
}
function syncAudio() {
  const sourceChanged = prepareAudio();
  if (isSolo()) {
    sharedAudio.stop();
    audio.muted = false;
    return;
  }
  if (!state) return;
  const t = state.transport;
  const now = Date.now() + offsetMs;
  const scheduledStop = joined && !!sharedSourceFile && !t.playing &&
    Number.isFinite(t.stopAtMs) && t.stopAtMs > now && (!cloud || state.conductorParticipating);
  if (scheduledStop) {
    if (t.revision !== lastRevision || sourceChanged) {
      clearTimeout(startTimer);
      countdownUntilMs = null;
      sharedAudio.scheduleStop({ serverTimeMs: t.stopAtMs, clockOffsetMs: offsetMs });
      startTimer = setTimeout(() => audio.pause(), Math.max(0, t.stopAtMs - (Date.now() + offsetMs)));
    }
    lastRevision = t.revision;
    return;
  }
  if (!joined || !sharedSourceFile || !t.playing || (cloud && !state.conductorParticipating)) {
    startPlanId++;
    countdownUntilMs = null;
    clearTimeout(startTimer);
    sharedAudio.stop();
    if (!audio.paused) audio.pause();
    if (sourceFile && audio.readyState >= 1 && !t.playing && (t.revision !== lastRevision || sourceChanged)) {
      try { audio.currentTime = t.positionSec; } catch {}
    }
    lastRevision = t.revision;
    return;
  }
  if (t.revision !== lastRevision || sourceChanged) {
    clearTimeout(startTimer);
    countdownUntilMs = null;
    sharedAudio.stop();
    audio.pause();
    const scheduledAtMs = t.startAtMs > now ? t.startAtMs : now + 3000;
    const targetPosition = t.startAtMs > now ? t.positionSec :
      Math.min(timelineDuration(), t.positionSec + (scheduledAtMs - t.startAtMs) / 1000);
    countdownUntilMs = scheduledAtMs;
    beginAudio(t.revision, sharedSourceFile, mode, scheduledAtMs, targetPosition);
  }
  lastRevision = t.revision;
}
function render() {
  if (!state) return;
  const conductor = state.role === 'conductor';
  const solo = isSolo();
  $('songTitle').textContent = state.title;
  $('heroTitle').textContent = state.title;
  $('rolePill').textContent = conductor ? '✦ 지휘자' : '● 합창단원';
  $('rolePill').classList.toggle('conductor', conductor);
  $('loginOpen').classList.toggle('hidden', conductor);
  $('logout').classList.toggle('hidden', !conductor);
  $('adminPanel').classList.toggle('hidden', !conductor);
  $('listenerNotice').classList.toggle('hidden', conductor || solo);
  $('listenerNotice').textContent = state.conductorParticipating ? '재생은 지휘자가 조작합니다' : '지휘자의 연습 참여를 기다립니다';
  $('syncCaption').textContent = conductor || solo ? '← → 5초 이동 · ↑ ↓ 내 볼륨 조절' : '↑ ↓ 내 볼륨 조절';
  for (const element of document.querySelectorAll('.conductor-only')) element.classList.toggle('hidden', !conductor && !solo);
  $('timeline').classList.toggle('can-seek', conductor || solo);
  $('sharedMode').classList.toggle('active', !solo);
  $('soloMode').classList.toggle('active', solo);
  const selected = names[part];
  $('partName').innerHTML = `${selected[0]} <span>${selected[1]}</span>`;
  for (const tab of document.querySelectorAll('.part-tab')) {
    const active = tab.dataset.part === part;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  const track = state.tracks[part];
  const trackReady = solo ? !!track : !!track?.audioFile && sharedReadyFile === track.audioFile;
  $('trackStatus').textContent = trackReady ? '● 음원 준비 완료' : (track ? '음원 준비 중' : '음원 준비 전');
  $('trackStatus').classList.toggle('ready', trackReady);
  $('playBtn').textContent = solo ? (audio.paused ? '▶' : 'Ⅱ') : (state.transport.playing ? 'Ⅱ' : '▶');
  $('playBtn').disabled = conductor && !solo && !joined;
  $('playBtn').setAttribute('aria-label', solo ? (audio.paused ? '재생' : '일시정지') : (state.transport.playing ? '일시정지' : '재생'));
  $('joinBtn').classList.toggle('hidden', solo);
  $('joinBtn').disabled = solo || !track?.audioFile;
  $('joinBtn').textContent = joined ? '✓  연습 참여 중' : '♫  연습 참여';
  $('joinBtn').classList.toggle('joined', joined);
  $('segmentCount').textContent = `${state.segments.length}개 구간`;
  renderSegments(); renderTimeline();
}
function renderSegments() {
  const list = $('segmentsList'); list.replaceChildren();
  if (!state.segments.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = '지휘자가 연습 구간을 추가하면 이곳에 표시됩니다.'; list.append(empty); return; }
  for (const segment of state.segments) {
    const row = document.createElement('div'); row.className = `segment-row${segment.highlighted ? ' highlighted' : ''}${segment.checked ? ' checked' : ''}`;
    const badge = document.createElement('span'); badge.className = 'segment-badge'; badge.textContent = segment.checked ? '✓' : '♫'; badge.style.backgroundColor = segmentColor(segment);
    const body = document.createElement('span'); body.className = 'segment-body';
    const title = document.createElement('span'); title.className = 'segment-title'; title.textContent = segment.label;
    const range = document.createElement('span'); range.className = 'segment-range'; range.textContent = `${formatTime(segment.startSec)} — ${formatTime(segment.endSec)}`;
    body.append(title, range);
    const canJump = state.role === 'conductor' || isSolo();
    const jump = document.createElement(canJump ? 'button' : 'span'); jump.className = 'segment-jump';
    if (canJump) {
      jump.type = 'button';
      jump.setAttribute('aria-label', `${segment.label} 시작 ${formatTime(segment.startSec)}로 이동`);
      jump.addEventListener('click', () => {
        if (isSolo()) { audio.currentTime = segment.startSec; tick(); }
        else send({ type: 'seek', positionSec: segment.startSec });
      });
    }
    jump.append(badge, body); row.append(jump);
    if (state.role === 'conductor') {
      const actions = document.createElement('div'); actions.className = 'segment-actions';
      for (const [label, field, cls] of [['수정', 'edit', ''], ['강조', 'highlighted', segment.highlighted ? 'highlight-active' : ''], ['완료', 'checked', segment.checked ? 'active' : ''], ['삭제', 'delete', 'delete']]) {
        const button = document.createElement('button'); button.textContent = label; button.className = cls;
        button.addEventListener('click', () => {
          if (field === 'edit') {
            segmentDraft = { id: segment.id, startSec: segment.startSec, endSec: segment.endSec };
            $('segmentLabel').value = segment.label;
            $('segmentColor').value = segmentColor(segment);
            updateDraftView();
            $('adminPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          } else send(field === 'delete' ? { type: 'segment:delete', id: segment.id } : { type: 'segment:toggle', id: segment.id, field });
        });
        actions.append(button);
      }
      row.append(actions);
    }
    list.append(row);
  }
}
function timelineDuration() {
  return state?.tracks?.[part]?.durationSec || (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 60);
}
function renderTimeline() {
  if (!state) return;
  const duration = timelineDuration();
  $('duration').textContent = formatTime(Number.isFinite(audio.duration) ? audio.duration : duration);
  const labels = $('timelineLabels'); const overlays = $('segmentOverlays'); labels.replaceChildren(); overlays.replaceChildren();
  for (const segment of state.segments) {
    const left = Math.min(100, segment.startSec / duration * 100); const width = Math.max(0, Math.min(100 - left, (segment.endSec - segment.startSec) / duration * 100));
    const label = document.createElement('span'); label.className = `timeline-label${segment.highlighted ? ' highlighted' : ''}`; label.style.left = `${Math.min(94, Math.max(6, left + width / 2))}%`; label.textContent = segment.label;
    const overlay = document.createElement('div'); overlay.className = `segment-overlay${segment.highlighted ? ' highlighted' : ''}${segment.checked ? ' checked' : ''}`; overlay.style.left = `${left}%`; overlay.style.width = `${width}%`; overlay.style.backgroundColor = segmentColor(segment);
    labels.append(label); overlays.append(overlay);
  }
}
function tick() {
  if (!state) return;
  if (cloud && !isSolo() && state.conductorParticipating && state.leaseUntilMs <= Date.now() + offsetMs) {
    state.transport = { playing: false, positionSec: Math.min(timelineDuration(), projectedPosition()),
      startAtMs: null, stopAtMs: null, revision: state.transport.revision };
    state.conductorParticipating = false;
    syncAudio(); render();
  }
  const pos = displayedPosition(); const duration = timelineDuration();
  if (countdownUntilMs && joined && !isSolo() && audio.paused) {
    const remaining = Math.ceil((countdownUntilMs - Date.now() - offsetMs) / 1000);
    if (remaining > 0) {
      if (state.role === 'conductor') $('playBtn').textContent = String(remaining);
      else $('listenerNotice').textContent = `${remaining}초 뒤 재생`;
    }
  }
  if (cloud && !isSolo() && state.role === 'conductor' && joined && state.transport.playing && pos >= duration) {
    if (!endingRequested) { endingRequested = true; send({ type: 'pause' }); }
  } else endingRequested = false;
  if (!isSolo() && joined && state.transport.playing && Date.now() + offsetMs >= state.transport.startAtMs && audio.readyState >= 1) {
    audio.muted = true;
    if (Math.abs(audio.currentTime - pos) > 0.3) {
      try { audio.currentTime = pos; } catch {}
    }
    if (audio.paused) audio.play().catch(() => {});
  }
  const pct = Math.max(0, Math.min(100, pos / duration * 100));
  $('timelineProgress').style.width = `${pct}%`; $('timelineThumb').style.left = `${pct}%`;
  $('currentTime').textContent = formatTime(pos);
  $('timeline').setAttribute('aria-valuenow', String(Math.floor(pos)));
  $('timeline').setAttribute('aria-valuemax', String(Math.floor(duration)));
  if (syncDebug && syncDebugBox) {
    const diagnostics = sharedAudio.getDiagnostics();
    const devicePosition = isSolo() ? audio.currentTime : diagnostics.audiblePosition;
    const difference = Number.isFinite(devicePosition) ? devicePosition - pos : null;
    const startDelay = lastStartTiming?.revision === state.transport.revision && lastStartTiming.playingAtMs !== null ?
      `${Math.round(lastStartTiming.playingAtMs - lastStartTiming.scheduledAtMs)}ms` : '-';
    syncDebugBox.textContent = `서버 기준 ${pos.toFixed(2)}초\n이 기기 음원 ${Number.isFinite(devicePosition) ? devicePosition.toFixed(2) : '-'}초\n차이 ${difference === null ? '-' : difference.toFixed(2) + '초'}\n시작 지연 ${startDelay}\n상태 ${isSolo() ? (audio.paused ? '정지' : '재생') : diagnostics.state}\nbase/output ${diagnostics.baseLatency ?? '-'} / ${diagnostics.outputLatency ?? '-'}\n마지막 이벤트 ${lastMediaEvent}\n명령 버전 ${state.transport.revision}\n시계 보정 ${offsetMs.toFixed(0)}ms`;
  }
}

$('sharedMode').addEventListener('click', () => setMode('shared'));
$('soloMode').addEventListener('click', () => setMode('solo'));
async function setMode(nextMode) {
  if (!['shared', 'solo'].includes(nextMode) || mode === nextMode) return;
  const wasPlaying = isSolo() ? !audio.paused : state?.transport.playing;
  const position = isSolo() ? audio.currentTime : projectedPosition();
  if (!isSolo() && joined) {
    joined = false;
    syncConductorParticipation();
  }
  audio.pause();
  sharedAudio.stop();
  mode = nextMode;
  if (!isSolo()) joined = false;
  localStorage.setItem('gospel-mode', mode);
  audio.muted = !isSolo();
  if (Number.isFinite(position)) { try { audio.currentTime = position; } catch {} }
  prepareAudio();
  render();
  syncAudio();
  if (isSolo() && wasPlaying) audio.play().catch(() => showToast('재생 버튼을 다시 눌러 주세요.'));
  if (!isSolo()) {
    try { await sharedAudio.unlock(); await prepareSharedAudio(); }
    catch (error) { showToast(error.message || '공동 재생 음원을 준비하지 못했습니다.'); }
  }
}
document.querySelectorAll('.part-tab').forEach(tab => tab.addEventListener('click', () => {
  part = tab.dataset.part; localStorage.setItem('gospel-part', part); render(); syncAudio();
  if (!state?.tracks?.[part]) showToast('이 파트의 음원이 아직 없습니다.');
}));
$('joinBtn').addEventListener('click', async () => {
  if (joined) {
    joined = false;
    syncConductorParticipation();
    clearTimeout(startTimer);
    sharedAudio.stop();
    audio.pause();
    render();
    showToast('연습 참여를 해제했습니다. 소리가 꺼졌습니다.');
    return;
  }
  try {
    await sharedAudio.unlock();
    await prepareSharedAudio();
  } catch (error) {
    return showToast(error.message || '공동 재생 음원을 준비하지 못했습니다.');
  }
  joined = true; syncConductorParticipation(); render();
  if (cloud && !isSolo()) {
    try { offsetMs = await cloud.measureClock(); } catch (error) { showToast(error.message); }
    lastRevision = -1;
    try { await cloud.refresh(); } catch (error) { showToast(error.message); }
    syncAudio();
    showToast('연습에 참여했습니다. 파트를 선택해 들어 보세요.');
    return;
  }
  lastRevision = -1;
  syncAudio();
  showToast('연습에 참여했습니다. 파트를 선택해 들어 보세요.');
});
$('volumeControl').addEventListener('input', event => {
  audio.volume = Number(event.target.value);
  sharedAudio.setVolume(audio.volume);
  $('volumeValue').textContent = Math.round(audio.volume * 100) + '%';
});
$('playBtn').addEventListener('click', async () => {
  if (!isSolo()) return send({ type: state?.transport.playing ? 'pause' : 'play' });
  if (!state || !sourceFile) return showToast('음원을 불러오는 중입니다. 잠시 후 다시 눌러 주세요.');
  const firstPlay = !joined;
  if (firstPlay) { joined = true; syncConductorParticipation(); }
  try {
    if (audio.paused) await audio.play();
    else audio.pause();
    render();
  } catch {
    if (firstPlay) joined = false;
    render();
    showToast('재생할 수 없습니다. 재생 버튼을 다시 눌러 주세요.');
  }
});
$('backBtn').addEventListener('click', () => { const position = Math.max(0, displayedPosition() - 10); if (isSolo()) { audio.currentTime = position; tick(); } else send({ type: 'seek', positionSec: position }); });
$('forwardBtn').addEventListener('click', () => { const position = Math.min(timelineDuration(), displayedPosition() + 10); if (isSolo()) { audio.currentTime = position; tick(); } else send({ type: 'seek', positionSec: position }); });
$('timeline').addEventListener('click', event => {
  if (state?.role !== 'conductor' && !isSolo()) return;
  const rect = $('timeline').getBoundingClientRect();
  const position = Math.max(0, Math.min(timelineDuration(), (event.clientX - rect.left) / rect.width * timelineDuration())); if (isSolo()) { audio.currentTime = position; tick(); } else send({ type: 'seek', positionSec: position });
});
document.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('dialog[open]') || (target.matches('input, textarea, select') && target !== $('volumeControl')))) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    audio.volume = Math.max(0, Math.min(1, Math.round((audio.volume + (event.key === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100));
    sharedAudio.setVolume(audio.volume);
    $('volumeControl').value = String(audio.volume);
    $('volumeValue').textContent = Math.round(audio.volume * 100) + '%';
    return;
  }
  if (!state || (state.role !== 'conductor' && !isSolo())) return;
  event.preventDefault();
  const positionSec = Math.max(0, Math.min(timelineDuration(), displayedPosition() + (event.key === 'ArrowRight' ? 5 : -5)));
  if (isSolo()) { audio.currentTime = positionSec; tick(); } else send({ type: 'seek', positionSec });
});
audio.addEventListener('loadedmetadata', () => { updateVideoDisplay(); renderTimeline(); tick(); if (state?.transport.playing && joined && !isSolo()) syncAudio(); });
audio.addEventListener('play', render);
audio.addEventListener('pause', render);
audio.addEventListener('ended', render);
audio.addEventListener('playing', () => {
  if (!isSolo()) return;
  if (lastStartTiming?.revision === state?.transport.revision && lastStartTiming.playingAtMs === null)
    lastStartTiming.playingAtMs = Date.now() + offsetMs;
});
if (syncDebug) {
  syncDebugBox = document.createElement('pre');
  syncDebugBox.setAttribute('aria-label', '재생 동기화 진단');
  Object.assign(syncDebugBox.style, {
    position: 'fixed', bottom: '8px', right: '8px', zIndex: '1000',
    background: '#102631ed', color: '#fff', padding: '12px',
    borderRadius: '8px', fontSize: '13px', lineHeight: '1.4', pointerEvents: 'none'
  });
  document.body.append(syncDebugBox);
  for (const eventName of ['playing', 'waiting', 'seeking', 'seeked', 'canplay', 'pause']) {
    audio.addEventListener(eventName, () => { lastMediaEvent = eventName; });
  }
}
$('showVideoBtn').addEventListener('click', () => {
  if (!audio.videoWidth) return showToast('이 음원에는 영상이 없습니다.');
  videoOpen = !videoOpen;
  updateVideoDisplay();
});
$('loginOpen').addEventListener('click', () => $('loginDialog').showModal());
$('loginClose').addEventListener('click', () => $('loginDialog').close());
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginError').textContent = '';
  try {
    if (cloud) {
      await cloud.login($('username').value, $('password').value);
      $('loginDialog').close(); $('password').value = '';
      await connect(); showToast('지휘자로 로그인했습니다.');
      return;
    }
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    $('loginDialog').close(); $('password').value = ''; connect(); showToast('지휘자로 로그인했습니다.');
  } catch (error) { $('loginError').textContent = error.message; }
});
$('logout').addEventListener('click', async () => {
  try {
    if (cloud) await cloud.logout(); else await fetch('/api/logout', { method: 'POST' });
    joined = false; sharedAudio.stop(); audio.pause(); connect(); showToast('로그아웃했습니다.');
  } catch (error) { showToast(error.message); }
});
for (const [buttonId, field] of [['captureStart', 'startSec'], ['captureEnd', 'endSec']]) {
  $(buttonId).addEventListener('click', () => {
    if (state?.role !== 'conductor') return;
    if (isSolo() ? !audio.paused : state?.transport.playing) return showToast('음악을 일시정지한 뒤 기록해 주세요.');
    segmentDraft[field] = Math.max(0, Math.min(timelineDuration(), displayedPosition()));
    updateDraftView();
  });
}
$('segmentCancel').addEventListener('click', resetDraft);
$('segmentForm').addEventListener('submit', event => {
  event.preventDefault();
  if (state?.role !== 'conductor') return;
  const { id, startSec, endSec } = segmentDraft;
  if (startSec === null || endSec === null || endSec <= startSec) return showToast('시작과 종료를 순서대로 기록해 주세요.');
  if (!cloud && (!socket || socket.readyState !== WebSocket.OPEN)) return showToast('서버 연결을 기다려 주세요.');
  send({ type: id ? 'segment:update' : 'segment:add', ...(id ? { id } : {}), label: $('segmentLabel').value, startSec, endSec, color: $('segmentColor').value });
  resetDraft();
});

await measureClock();
connect();
setInterval(tick, 100);

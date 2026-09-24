import { SharedAudioEngine } from './shared-audio.js';

const $ = id => document.getElementById(id);
const video = $('video');
const soloAudio = $('soloAudio');
const sharedAudio = new SharedAudioEngine();
const sharedActionLeadMs = 1500;
const names = { choir: ['합창', 'CHOIR'], soprano: ['소프라노', 'SOPRANO'], alto: ['알토', 'ALTO'], tenor: ['테너', 'TENOR'], baritone: ['바리톤', 'BARITONE'] };
let part = localStorage.getItem('gospel-part') || 'choir';
let mode = 'solo';
if (!names[part]) part = 'choir';
let state = null;
let socket = null;
let joined = false;
let offsetMs = 0;
let startTimer = null;
let startPlanId = 0;
let countdownUntilMs = null;
let reconnectTimer = null;
let videoFile = null;
let soloSourceFile = null;
let sharedSourceFile = null;
let sharedReadyFile = null;
let sharedLoadPromise = null;
let clockMeasurePromise = null;
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
  $('username').type = 'text';
  $('username').placeholder = '';
  $('username').previousSibling.textContent = '아이디';
}

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
function sharedPlaybackSignal() {
  if (!state || isSolo() || !joined) return null;
  const now = Date.now() + offsetMs;
  const transport = state.transport;
  const preparing = transport.playing && Number.isFinite(transport.startAtMs) && transport.startAtMs > now;
  const stopping = !transport.playing && Number.isFinite(transport.stopAtMs) && transport.stopAtMs > now;
  if (preparing) {
    const remainingMs = transport.startAtMs - now;
    if (remainingMs > sharedActionLeadMs / 2) return { phase: 'red', label: '재생 준비' };
    return { phase: 'yellow', label: '곧 재생' };
  }
  if (stopping) return { phase: 'green', label: '정지 준비' };
  return transport.playing ? { phase: 'green', label: '재생 중' } : { phase: 'red', label: '정지' };
}
function updatePlaybackSignal() {
  const signal = sharedPlaybackSignal();
  const playButton = $('playBtn');
  const listenerNotice = $('listenerNotice');
  for (const phase of ['red', 'yellow', 'green']) {
    playButton.classList.toggle(`signal-${phase}`, signal?.phase === phase);
    listenerNotice.classList.toggle(`signal-${phase}`, signal?.phase === phase);
  }
  if (!signal) return;
  if (listenerNotice.textContent !== signal.label) listenerNotice.textContent = signal.label;
  const preparing = state.transport.playing && state.transport.startAtMs > Date.now() + offsetMs;
  playButton.setAttribute('aria-label', preparing ? `${signal.label}, 취소` : signal.label === '재생 중' ? '일시정지' : '재생');
}
function showToast(message) {
  const box = $('toast'); box.textContent = message; box.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 3500);
}
function isSolo() { return mode === 'solo'; }
function displayedPosition() { return isSolo() && Number.isFinite(soloAudio.currentTime) ? soloAudio.currentTime : projectedPosition(); }
function updateVideoDisplay() {
  const hasVideo = video.readyState >= 1 && video.videoWidth > 0;
  const showVideo = videoOpen && !!videoFile && (video.readyState < 1 || hasVideo);
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
  if (clockMeasurePromise) return clockMeasurePromise;
  clockMeasurePromise = (async () => {
    if (cloud) {
      offsetMs = await cloud.measureClock();
      return offsetMs;
    }
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const before = Date.now();
      const response = await fetch('/api/time', { cache: 'no-store' });
      if (!response.ok) throw new Error('서버 시계를 확인하지 못했습니다.');
      const { serverTimeMs } = await response.json();
      const after = Date.now();
      samples.push({ delay: after - before, offset: serverTimeMs - (before + after) / 2 });
    }
    offsetMs = samples.sort((a, b) => a.delay - b.delay)[0].offset;
    return offsetMs;
  })();
  try { return await clockMeasurePromise; }
  finally { clockMeasurePromise = null; }
}

async function restoreSharedSession() {
  if (document.visibilityState !== 'visible' || isSolo() || !joined) return;
  const wasInterrupted = sharedAudio.getDiagnostics().state !== 'running';
  try {
    await measureClock();
    if (cloud) await cloud.refresh();
    if (wasInterrupted) await sharedAudio.unlock();
  } catch (error) {
    if (wasInterrupted) {
      joined = false;
      syncConductorParticipation();
      render();
      showToast('오디오 연결이 중단됐습니다. 연습 참여를 다시 눌러 주세요.');
    }
    return;
  }
  if (wasInterrupted) {
    lastRevision = -1;
    syncAudio();
  }
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
    soloAudio.pause();
    video.pause();
    reconnectTimer = setTimeout(connect, 1600);
  });
}
function prepareAudio({ soloPosition = null, resumeSolo = null } = {}) {
  const track = state?.tracks?.[part] || null;
  const nextVideoFile = track?.videoFile || track?.file || null;
  const nextSharedSource = track?.audioFile || null;
  const videoChanged = nextVideoFile !== videoFile;
  const audioChanged = nextSharedSource !== sharedSourceFile;

  if (videoChanged) {
    videoFile = nextVideoFile;
    video.pause();
    if (videoFile) {
      video.src = videoFile;
      video.load();
    } else {
      video.removeAttribute('src');
      video.load();
    }
  }

  if (audioChanged) {
    sharedSourceFile = nextSharedSource;
    sharedReadyFile = null;
    sharedLoadPromise = null;
    sharedAudio.stop();
  }

  if (isSolo() && nextSharedSource && (nextSharedSource !== soloSourceFile || soloPosition !== null)) {
    const position = Number.isFinite(soloPosition) ? soloPosition : soloAudio.currentTime;
    const shouldResume = resumeSolo ?? (soloSourceFile !== null && !soloAudio.paused);
    soloAudio.pause();
    if (nextSharedSource !== soloSourceFile) {
      soloSourceFile = nextSharedSource;
      soloAudio.addEventListener('loadedmetadata', () => {
        if (soloSourceFile !== nextSharedSource) return;
        try { soloAudio.currentTime = Math.min(position, soloAudio.duration || position); } catch {}
        if (shouldResume) soloAudio.play().catch(() => showToast('재생 버튼을 다시 눌러 주세요.'));
      }, { once: true });
      soloAudio.src = nextSharedSource;
      soloAudio.load();
    } else {
      try { soloAudio.currentTime = Math.min(position, soloAudio.duration || position); } catch {}
      if (shouldResume) soloAudio.play().catch(() => showToast('재생 버튼을 다시 눌러 주세요.'));
    }
  }
  if (!isSolo() && sharedSourceFile) prepareSharedAudio().catch(() => {});
  updateVideoDisplay();
  return videoChanged || audioChanged;
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
    try { video.currentTime = Math.max(0, targetPosition); } catch {}
    clearTimeout(startTimer);
    const startVideo = async () => {
      if (!stillCurrent()) return;
      countdownUntilMs = null;
      render();
      try {
        await video.play();
        if (!stillCurrent()) video.pause();
      } catch {}
    };
    startTimer = setTimeout(startVideo, Math.max(0, scheduledAtMs - (Date.now() + offsetMs)));
  } catch { showToast('소리를 들으려면 ‘연습 참여’를 다시 눌러 주세요.'); }
}
function syncAudio() {
  const sourceChanged = prepareAudio();
  if (isSolo()) {
    sharedAudio.stop();
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
      startTimer = setTimeout(() => video.pause(), Math.max(0, t.stopAtMs - (Date.now() + offsetMs)));
    }
    lastRevision = t.revision;
    return;
  }
  if (!joined || !sharedSourceFile || !t.playing || (cloud && !state.conductorParticipating)) {
    startPlanId++;
    countdownUntilMs = null;
    clearTimeout(startTimer);
    sharedAudio.stop();
    if (!video.paused) video.pause();
    if (videoFile && video.readyState >= 1 && !t.playing && (t.revision !== lastRevision || sourceChanged)) {
      try { video.currentTime = t.positionSec; } catch {}
    }
    lastRevision = t.revision;
    return;
  }
  if (t.revision !== lastRevision || sourceChanged) {
    clearTimeout(startTimer);
    countdownUntilMs = null;
    sharedAudio.stop();
    video.pause();
    const scheduledAtMs = t.startAtMs > now ? t.startAtMs : now + sharedActionLeadMs;
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
  $('sharedMode').setAttribute('aria-pressed', String(!solo));
  $('soloMode').setAttribute('aria-pressed', String(solo));
  const selected = names[part];
  $('partName').innerHTML = `${selected[0]} <span>${selected[1]}</span>`;
  for (const tab of document.querySelectorAll('.part-tab')) {
    const active = tab.dataset.part === part;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  const track = state.tracks[part];
  const trackReady = solo ? !!track?.audioFile && soloSourceFile === track.audioFile && soloAudio.readyState >= 1 :
    !!track?.audioFile && sharedReadyFile === track.audioFile;
  const sharedLocked = !solo && !joined;
  $('trackStatus').textContent = trackReady ? '● 음원 준비 완료' : (track ? '음원 준비 중' : '음원 준비 전');
  $('trackStatus').classList.toggle('ready', trackReady);
  $('playerPanel').classList.toggle('shared-locked', sharedLocked);
  $('practiceLock').classList.toggle('hidden', !sharedLocked);
  $('practiceContent').inert = sharedLocked;
  $('practiceContent').setAttribute('aria-hidden', String(sharedLocked));
  $('playBtn').textContent = solo ? (soloAudio.paused ? '▶' : 'Ⅱ') : (state.transport.playing ? 'Ⅱ' : '▶');
  $('playBtn').disabled = conductor && !solo && !joined;
  $('playBtn').setAttribute('aria-label', solo ? (soloAudio.paused ? '재생' : '일시정지') : (state.transport.playing ? '일시정지' : '재생'));
  updatePlaybackSignal();
  $('joinBtn').classList.toggle('hidden', solo || !joined);
  $('joinBtn').disabled = solo || !joined;
  $('joinOverlayBtn').disabled = solo || !track?.audioFile;
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
        if (isSolo()) { soloAudio.currentTime = segment.startSec; tick(); }
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
  return state?.tracks?.[part]?.durationSec || (Number.isFinite(soloAudio.duration) && soloAudio.duration > 0 ? soloAudio.duration : 60);
}
function renderTimeline() {
  if (!state) return;
  const duration = timelineDuration();
  $('duration').textContent = formatTime(Number.isFinite(soloAudio.duration) ? soloAudio.duration : duration);
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
  updatePlaybackSignal();
  if (cloud && !isSolo() && state.role === 'conductor' && joined && state.transport.playing && pos >= duration) {
    if (!endingRequested) { endingRequested = true; send({ type: 'pause' }); }
  } else endingRequested = false;
  const now = Date.now() + offsetMs;
  const sharedStopPending = !state.transport.playing && Number.isFinite(state.transport.stopAtMs) && now < state.transport.stopAtMs;
  const videoShouldPlay = isSolo() ? !soloAudio.paused && !soloAudio.ended :
    joined && (sharedStopPending || (state.transport.playing && now >= state.transport.startAtMs));
  if (videoShouldPlay && video.readyState >= 1) {
    if (Math.abs(video.currentTime - pos) > 0.3) {
      try { video.currentTime = pos; } catch {}
    }
    if (video.paused) video.play().catch(() => {});
  } else if (!video.paused) {
    video.pause();
  }
  const pct = Math.max(0, Math.min(100, pos / duration * 100));
  $('timelineProgress').style.width = `${pct}%`; $('timelineThumb').style.left = `${pct}%`;
  $('currentTime').textContent = formatTime(pos);
  $('timeline').setAttribute('aria-valuenow', String(Math.floor(pos)));
  $('timeline').setAttribute('aria-valuemax', String(Math.floor(duration)));
  if (syncDebug && syncDebugBox) {
    const diagnostics = sharedAudio.getDiagnostics();
    const devicePosition = isSolo() ? soloAudio.currentTime : diagnostics.audiblePosition;
    const difference = Number.isFinite(devicePosition) ? devicePosition - pos : null;
    const startDelay = lastStartTiming?.revision === state.transport.revision && lastStartTiming.playingAtMs !== null ?
      `${Math.round(lastStartTiming.playingAtMs - lastStartTiming.scheduledAtMs)}ms` : '-';
    syncDebugBox.textContent = `서버 기준 ${pos.toFixed(2)}초\n이 기기 음원 ${Number.isFinite(devicePosition) ? devicePosition.toFixed(2) : '-'}초\n차이 ${difference === null ? '-' : difference.toFixed(2) + '초'}\n시작 지연 ${startDelay}\n상태 ${isSolo() ? (soloAudio.paused ? '정지' : '재생') : diagnostics.state}\nbase/output ${diagnostics.baseLatency ?? '-'} / ${diagnostics.outputLatency ?? '-'}\n마지막 이벤트 ${lastMediaEvent}\n명령 버전 ${state.transport.revision}\n시계 보정 ${offsetMs.toFixed(0)}ms`;
  }
}

$('sharedMode').addEventListener('click', () => setMode('shared'));
$('soloMode').addEventListener('click', () => setMode('solo'));
async function setMode(nextMode) {
  if (!['shared', 'solo'].includes(nextMode) || mode === nextMode) return;
  const wasPlaying = isSolo() ? !soloAudio.paused : state?.transport.playing;
  const position = isSolo() ? soloAudio.currentTime : projectedPosition();
  if (!isSolo() && joined) {
    joined = false;
    syncConductorParticipation();
  }
  soloAudio.pause();
  video.pause();
  sharedAudio.stop();
  mode = nextMode;
  if (!isSolo()) joined = false;
  prepareAudio({ soloPosition: position, resumeSolo: isSolo() && wasPlaying });
  if (Number.isFinite(position)) { try { video.currentTime = position; } catch {} }
  render();
  syncAudio();
  if (!isSolo()) {
    try { await sharedAudio.unlock(); await prepareSharedAudio(); }
    catch (error) { showToast(error.message || '공동 재생 음원을 준비하지 못했습니다.'); }
  }
}
document.querySelectorAll('.part-tab').forEach(tab => tab.addEventListener('click', () => {
  part = tab.dataset.part; localStorage.setItem('gospel-part', part); render(); syncAudio();
  if (!state?.tracks?.[part]) showToast('이 파트의 음원이 아직 없습니다.');
}));
async function togglePracticeParticipation() {
  if (joined) {
    joined = false;
    syncConductorParticipation();
    clearTimeout(startTimer);
    sharedAudio.stop();
    video.pause();
    render();
    showToast('연습에서 나왔습니다. 소리가 꺼졌습니다.');
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
}
$('joinBtn').addEventListener('click', togglePracticeParticipation);
$('joinOverlayBtn').addEventListener('click', togglePracticeParticipation);
$('volumeControl').addEventListener('input', event => {
  soloAudio.volume = Number(event.target.value);
  sharedAudio.setVolume(soloAudio.volume);
  $('volumeValue').textContent = Math.round(soloAudio.volume * 100) + '%';
});
$('playBtn').addEventListener('click', async () => {
  if (!isSolo()) return send({ type: state?.transport.playing ? 'pause' : 'play' });
  if (!state || !soloSourceFile) return showToast('음원을 불러오는 중입니다. 잠시 후 다시 눌러 주세요.');
  const firstPlay = !joined;
  if (firstPlay) { joined = true; syncConductorParticipation(); }
  try {
    if (soloAudio.paused) await soloAudio.play();
    else soloAudio.pause();
    render();
  } catch {
    if (firstPlay) joined = false;
    render();
    showToast('재생할 수 없습니다. 재생 버튼을 다시 눌러 주세요.');
  }
});
$('backBtn').addEventListener('click', () => { const position = Math.max(0, displayedPosition() - 10); if (isSolo()) { soloAudio.currentTime = position; tick(); } else send({ type: 'seek', positionSec: position }); });
$('forwardBtn').addEventListener('click', () => { const position = Math.min(timelineDuration(), displayedPosition() + 10); if (isSolo()) { soloAudio.currentTime = position; tick(); } else send({ type: 'seek', positionSec: position }); });
$('timeline').addEventListener('click', event => {
  if (state?.role !== 'conductor' && !isSolo()) return;
  const rect = $('timeline').getBoundingClientRect();
  const position = Math.max(0, Math.min(timelineDuration(), (event.clientX - rect.left) / rect.width * timelineDuration())); if (isSolo()) { soloAudio.currentTime = position; tick(); } else send({ type: 'seek', positionSec: position });
});
document.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('dialog[open]') || (target.matches('input, textarea, select') && target !== $('volumeControl')))) return;
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    soloAudio.volume = Math.max(0, Math.min(1, Math.round((soloAudio.volume + (event.key === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100));
    sharedAudio.setVolume(soloAudio.volume);
    $('volumeControl').value = String(soloAudio.volume);
    $('volumeValue').textContent = Math.round(soloAudio.volume * 100) + '%';
    return;
  }
  if (!state || (state.role !== 'conductor' && !isSolo())) return;
  event.preventDefault();
  const positionSec = Math.max(0, Math.min(timelineDuration(), displayedPosition() + (event.key === 'ArrowRight' ? 5 : -5)));
  if (isSolo()) { soloAudio.currentTime = positionSec; tick(); } else send({ type: 'seek', positionSec });
});
video.addEventListener('loadedmetadata', () => { updateVideoDisplay(); renderTimeline(); tick(); if (state?.transport.playing && joined && !isSolo()) syncAudio(); });
soloAudio.addEventListener('loadedmetadata', () => { renderTimeline(); tick(); render(); });
soloAudio.addEventListener('play', render);
soloAudio.addEventListener('pause', render);
soloAudio.addEventListener('ended', () => { video.pause(); render(); });
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
    video.addEventListener(eventName, () => { lastMediaEvent = `video:${eventName}`; });
    soloAudio.addEventListener(eventName, () => { lastMediaEvent = `audio:${eventName}`; });
  }
}
$('showVideoBtn').addEventListener('click', () => {
  if (!video.videoWidth) return showToast('악보 영상을 불러오는 중입니다.');
  videoOpen = !videoOpen;
  updateVideoDisplay();
});
$('loginOpen').addEventListener('click', () => $('loginDialog').showModal());
$('loginClose').addEventListener('click', () => $('loginDialog').close());
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginError').textContent = '';
  try {
    if (cloud) {
      const loginId = $('username').value.trim();
      const email = loginId.includes('@') ? loginId : `${loginId}@gospel.letsgomin.com`;
      await cloud.login(email, $('password').value);
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
    joined = false; sharedAudio.stop(); soloAudio.pause(); video.pause(); connect(); showToast('로그아웃했습니다.');
  } catch (error) { showToast(error.message); }
});
for (const [buttonId, field] of [['captureStart', 'startSec'], ['captureEnd', 'endSec']]) {
  $(buttonId).addEventListener('click', () => {
    if (state?.role !== 'conductor') return;
    if (isSolo() ? !soloAudio.paused : state?.transport.playing) return showToast('음악을 일시정지한 뒤 기록해 주세요.');
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

try { await measureClock(); } catch (error) { showToast(error.message); }
connect();
setInterval(tick, 100);
setInterval(() => {
  if (!isSolo() && joined && document.visibilityState === 'visible') measureClock().catch(() => {});
}, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') restoreSharedSession(); });
window.addEventListener('online', restoreSharedSession);

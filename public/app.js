const $ = id => document.getElementById(id);
const audio = $('audio');
const names = { choir: ['합창', 'CHOIR'], soprano: ['소프라노', 'SOPRANO'], alto: ['알토', 'ALTO'], tenor: ['테너', 'TENOR'], baritone: ['바리톤', 'BARITONE'] };
let part = localStorage.getItem('gospel-part') || 'choir';
if (!names[part]) part = 'choir';
let state = null;
let socket = null;
let joined = false;
let offsetMs = 0;
let startTimer = null;
let reconnectTimer = null;
let sourceFile = null;
let lastRevision = -1;
let toastTimer = null;

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
function parseTime(input) {
  const text = input.trim();
  if (/^\d+:\d{1,2}$/.test(text)) { const [m, s] = text.split(':').map(Number); return s < 60 ? m * 60 + s : NaN; }
  return /^\d+$/.test(text) ? Number(text) : NaN;
}
function showToast(message) {
  const box = $('toast'); box.textContent = message; box.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => box.classList.remove('show'), 3500);
}
function projectedPosition() {
  if (!state) return 0;
  const t = state.transport;
  return t.playing ? Math.max(0, t.positionSec + Math.max(0, Date.now() + offsetMs - t.startAtMs) / 1000) : t.positionSec;
}
function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return showToast('서버 연결을 기다려 주세요.');
  socket.send(JSON.stringify(message));
}
function setConnection(connected) {
  $('connection').classList.toggle('offline', !connected);
  $('connection').lastChild.textContent = connected ? '실시간 연결됨' : '연결 끊김';
}
async function measureClock() {
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
  clearTimeout(reconnectTimer);
  if (socket) socket.close();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = ws;
  ws.addEventListener('open', () => setConnection(true));
  ws.addEventListener('message', event => {
    let data; try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'error') return showToast(data.message);
    if (data.type === 'state') {
      state = data;
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
  const file = state?.tracks?.[part]?.file || null;
  if (file === sourceFile) return false;
  sourceFile = file;
  audio.pause();
  if (file) { audio.src = file; audio.load(); }
  else { audio.removeAttribute('src'); audio.load(); }
  return true;
}
async function beginAudio() {
  if (!joined || !sourceFile || !state?.transport.playing) return;
  const position = projectedPosition();
  if (Number.isFinite(audio.duration) && position >= audio.duration) return;
  try {
    if (audio.readyState < 2) await new Promise(resolve => {
      const done = () => { audio.removeEventListener('canplay', done); audio.removeEventListener('error', done); resolve(); };
      audio.addEventListener('canplay', done, { once: true }); audio.addEventListener('error', done, { once: true });
      setTimeout(done, 5000);
    });
    audio.currentTime = Math.max(0, projectedPosition());
    await audio.play();
  } catch { showToast('소리를 들으려면 ‘연습 참여’를 다시 눌러 주세요.'); }
}
function syncAudio() {
  const sourceChanged = prepareAudio();
  if (!state) return;
  const t = state.transport;
  if (!joined || !sourceFile || !t.playing) {
    clearTimeout(startTimer);
    audio.pause();
    if (sourceFile && audio.readyState >= 1 && !t.playing) {
      try { audio.currentTime = t.positionSec; } catch {}
    }
    lastRevision = t.revision;
    return;
  }
  if (t.revision !== lastRevision || sourceChanged || audio.paused) {
    clearTimeout(startTimer);
    audio.pause();
    const delay = t.startAtMs - (Date.now() + offsetMs);
    if (delay > 20) {
      try { audio.currentTime = t.positionSec; } catch {}
      startTimer = setTimeout(beginAudio, delay);
    } else beginAudio();
  }
  lastRevision = t.revision;
}
function render() {
  if (!state) return;
  const conductor = state.role === 'conductor';
  $('songTitle').textContent = state.title;
  $('heroTitle').textContent = state.title;
  $('rolePill').textContent = conductor ? '✦ 지휘자 모드' : '● 청취자 모드';
  $('rolePill').classList.toggle('conductor', conductor);
  $('loginOpen').classList.toggle('hidden', conductor);
  $('logout').classList.toggle('hidden', !conductor);
  $('adminPanel').classList.toggle('hidden', !conductor);
  $('listenerNotice').classList.toggle('hidden', conductor);
  for (const element of document.querySelectorAll('.conductor-only')) element.classList.toggle('hidden', !conductor);
  $('timeline').classList.toggle('can-seek', conductor);
  const selected = names[part];
  $('partName').innerHTML = `${selected[0]} <span>${selected[1]}</span>`;
  for (const tab of document.querySelectorAll('.part-tab')) {
    const active = tab.dataset.part === part;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  const track = state.tracks[part];
  $('trackStatus').textContent = track ? '● 음원 준비 완료' : '음원 준비 전';
  $('trackStatus').classList.toggle('ready', !!track);
  $('playBtn').textContent = state.transport.playing ? 'Ⅱ' : '▶';
  $('playBtn').setAttribute('aria-label', state.transport.playing ? '일시정지' : '재생');
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
    const badge = document.createElement('span'); badge.className = 'segment-badge'; badge.textContent = segment.checked ? '✓' : '♫';
    const body = document.createElement('div'); body.className = 'segment-body';
    const title = document.createElement('div'); title.className = 'segment-title'; title.textContent = segment.label;
    const range = document.createElement('div'); range.className = 'segment-range'; range.textContent = `${formatTime(segment.startSec)} — ${formatTime(segment.endSec)}`;
    body.append(title, range); row.append(badge, body);
    if (state.role === 'conductor') {
      const actions = document.createElement('div'); actions.className = 'segment-actions';
      for (const [label, field, cls] of [['강조', 'highlighted', segment.highlighted ? 'highlight-active' : ''], ['완료', 'checked', segment.checked ? 'active' : ''], ['삭제', 'delete', 'delete']]) {
        const button = document.createElement('button'); button.textContent = label; button.className = cls;
        button.addEventListener('click', () => send(field === 'delete' ? { type: 'segment:delete', id: segment.id } : { type: 'segment:toggle', id: segment.id, field }));
        actions.append(button);
      }
      row.append(actions);
    }
    list.append(row);
  }
}
function timelineDuration() {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Math.max(60, ...((state?.segments || []).map(s => s.endSec)), projectedPosition());
}
function renderTimeline() {
  if (!state) return;
  const duration = timelineDuration();
  $('duration').textContent = formatTime(Number.isFinite(audio.duration) ? audio.duration : duration);
  const labels = $('timelineLabels'); const overlays = $('segmentOverlays'); labels.replaceChildren(); overlays.replaceChildren();
  for (const segment of state.segments) {
    const left = Math.min(100, segment.startSec / duration * 100); const width = Math.max(0, Math.min(100 - left, (segment.endSec - segment.startSec) / duration * 100));
    const label = document.createElement('span'); label.className = `timeline-label${segment.highlighted ? ' highlighted' : ''}`; label.style.left = `${Math.min(94, Math.max(6, left + width / 2))}%`; label.textContent = segment.label;
    const overlay = document.createElement('div'); overlay.className = `segment-overlay${segment.highlighted ? ' highlighted' : ''}${segment.checked ? ' checked' : ''}`; overlay.style.left = `${left}%`; overlay.style.width = `${width}%`;
    labels.append(label); overlays.append(overlay);
  }
}
function tick() {
  if (!state) return;
  const pos = projectedPosition(); const duration = timelineDuration();
  const pct = Math.max(0, Math.min(100, pos / duration * 100));
  $('timelineProgress').style.width = `${pct}%`; $('timelineThumb').style.left = `${pct}%`;
  $('currentTime').textContent = formatTime(pos);
  $('timeline').setAttribute('aria-valuenow', String(Math.floor(pos)));
  $('timeline').setAttribute('aria-valuemax', String(Math.floor(duration)));
  if (joined && state.transport.playing && !audio.paused && sourceFile && Math.abs(audio.currentTime - pos) > 0.25) {
    try { audio.currentTime = pos; } catch {}
  }
}

document.querySelectorAll('.part-tab').forEach(tab => tab.addEventListener('click', () => {
  part = tab.dataset.part; localStorage.setItem('gospel-part', part); render(); syncAudio();
  if (!state?.tracks?.[part]) showToast('이 파트의 음원이 아직 없습니다.');
}));
$('joinBtn').addEventListener('click', async () => {
  if (joined) {
    joined = false;
    clearTimeout(startTimer);
    audio.pause();
    render();
    showToast('연습 참여를 해제했습니다. 소리가 꺼졌습니다.');
    return;
  }
  joined = true; render();
  if (sourceFile) {
    if (state?.transport.playing && state.transport.startAtMs <= Date.now() + offsetMs) await beginAudio();
    else {
      const oldMuted = audio.muted; audio.muted = true;
      try { await audio.play(); audio.pause(); } catch {}
      audio.muted = oldMuted;
      syncAudio();
    }
  }
  showToast('연습에 참여했습니다. 파트를 선택해 들어 보세요.');
});
$('volumeControl').addEventListener('input', event => {
  audio.volume = Number(event.target.value);
  $('volumeValue').textContent = Math.round(audio.volume * 100) + '%';
});
$('playBtn').addEventListener('click', () => send({ type: state?.transport.playing ? 'pause' : 'play' }));
$('backBtn').addEventListener('click', () => send({ type: 'seek', positionSec: Math.max(0, projectedPosition() - 10) }));
$('forwardBtn').addEventListener('click', () => send({ type: 'seek', positionSec: Math.min(timelineDuration(), projectedPosition() + 10) }));
$('timeline').addEventListener('click', event => {
  if (state?.role !== 'conductor') return;
  const rect = $('timeline').getBoundingClientRect();
  send({ type: 'seek', positionSec: Math.max(0, Math.min(timelineDuration(), (event.clientX - rect.left) / rect.width * timelineDuration())) });
});
$('timeline').addEventListener('keydown', event => {
  if (state?.role !== 'conductor' || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault(); send({ type: 'seek', positionSec: Math.max(0, Math.min(timelineDuration(), projectedPosition() + (event.key === 'ArrowRight' ? 5 : -5))) });
});
audio.addEventListener('loadedmetadata', () => { renderTimeline(); tick(); if (state?.transport.playing && joined) syncAudio(); });
$('loginOpen').addEventListener('click', () => $('loginDialog').showModal());
$('loginClose').addEventListener('click', () => $('loginDialog').close());
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginError').textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    $('loginDialog').close(); $('password').value = ''; connect(); showToast('지휘자로 로그인했습니다.');
  } catch (error) { $('loginError').textContent = error.message; }
});
$('logout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); connect(); showToast('로그아웃했습니다.'); });
$('segmentForm').addEventListener('submit', event => {
  event.preventDefault();
  const startSec = parseTime($('segmentStart').value); const endSec = parseTime($('segmentEnd').value);
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return showToast('시작과 끝 시간을 확인해 주세요.');
  send({ type: 'segment:add', label: $('segmentLabel').value, startSec, endSec });
  $('segmentForm').reset();
});

await measureClock();
connect();
setInterval(tick, 100);
setInterval(measureClock, 30000);

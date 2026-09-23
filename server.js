import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const publicDir = path.join(root, 'public');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const stateFile = path.join(dataDir, 'state.json');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const password = process.env.CONDUCTOR_PASSWORD || crypto.randomBytes(9).toString('base64url');
const sessions = new Set();
const wss = new WebSocketServer({ noServer: true });
const clients = new Map();
const activeConductors = new Set();

await fsp.mkdir(dataDir, { recursive: true });
const catalog = JSON.parse(await fsp.readFile(path.join(publicDir, 'tracks.json'), 'utf8'));
if (typeof catalog.id !== 'string' || !catalog.id || typeof catalog.title !== 'string' || !catalog.tracks || typeof catalog.tracks !== 'object') throw new Error('public/tracks.json 형식이 올바르지 않습니다.');
const partNames = ['choir', 'soprano', 'alto', 'tenor', 'baritone'];
if (partNames.some(part => !catalog.tracks[part])) throw new Error('다섯 파트의 음원을 모두 tracks.json에 등록해 주세요.');
for (const track of partNames.map(part => catalog.tracks[part])) {
  if (!track || typeof track.file !== 'string' || !/^\/media\/video\/[a-zA-Z0-9._-]+\.mp4$/.test(track.file)) throw new Error('영상 경로는 /media/video/ 아래 MP4 파일이어야 합니다.');
  if (typeof track.audioFile !== 'string' || !/^\/media\/audio\/[a-zA-Z0-9._-]+\.(mp3|m4a|wav|ogg|webm)$/.test(track.audioFile)) throw new Error('음원 경로는 /media/audio/ 아래 파일이어야 합니다.');
  if (typeof track.videoFile !== 'string' || !/^\/media\/video\/[a-zA-Z0-9._-]+\.mp4$/.test(track.videoFile)) throw new Error('영상 경로는 /media/video/ 아래 MP4 파일이어야 합니다.');
  if (typeof track.durationSec !== 'number' || !Number.isFinite(track.durationSec) || track.durationSec <= 0) throw new Error('각 파트의 durationSec를 초 단위로 입력해 주세요.');
}
if (partNames.some(part => Math.abs(catalog.tracks[part].durationSec - catalog.tracks.choir.durationSec) > 0.1)) throw new Error('다섯 파트의 길이를 같게 맞춰 주세요.');
let saved = { songId: catalog.id, segments: catalog.segments || [] };
try {
  const previous = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  if (previous.songId === catalog.id && Array.isArray(previous.segments)) saved = { songId: catalog.id, segments: previous.segments };
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
let transport = { playing: false, positionSec: 0, startAtMs: null, revision: 0 };
let endTimer = null;
function roomDuration() {
  const duration = catalog.tracks.choir?.durationSec || Object.values(catalog.tracks).find(track => track.durationSec)?.durationSec;
  return Number.isFinite(duration) ? duration : null;
}
function scheduleEnd() {
  clearTimeout(endTimer);
  const duration = roomDuration();
  if (!transport.playing || duration === null) return;
  const delay = Math.max(0, transport.startAtMs - Date.now() + (duration - transport.positionSec) * 1000);
  endTimer = setTimeout(() => {
    transport = { playing: false, positionSec: duration, startAtMs: null, revision: transport.revision + 1 };
    broadcast();
  }, delay);
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x.length === 2));
}
function isConductor(req) { return sessions.has(cookies(req).choir_session); }
function secureEqual(a, b) {
  const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function currentPosition(now = Date.now()) {
  return transport.playing ? transport.positionSec + Math.max(0, (now - transport.startAtMs) / 1000) : transport.positionSec;
}
function stopWhenUnattended() {
  if (activeConductors.size || !transport.playing) return;
  transport = { playing: false, positionSec: Math.min(roomDuration() ?? Infinity, currentPosition()), startAtMs: null, revision: transport.revision + 1 };
  scheduleEnd();
}
function snapshot(role = 'listener') {
  return { type: 'state', serverTimeMs: Date.now(), role, title: catalog.title, tracks: catalog.tracks, segments: saved.segments, conductorParticipating: activeConductors.size > 0, transport };
}
function broadcast() {
  for (const [ws, token] of clients) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(snapshot(sessions.has(token) ? 'conductor' : 'listener')));
}
async function persist() {
  const temp = `${stateFile}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(saved, null, 2));
  await fsp.rename(temp, stateFile);
}
function bad(res, message, status = 400) { json(res, status, { error: message }); }
function readJson(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let size = 0; let chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(new Error('요청이 너무 큽니다.')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('JSON 형식이 올바르지 않습니다.')); } });
    req.on('error', reject);
  });
}
function safeNumber(value, max = 86400) { return Number.isFinite(value) && value >= 0 && value <= max; }
function segmentFields(msg) {
  const label = String(msg.label || '').trim();
  const duration = roomDuration();
  if (!label || label.length > 40 || !safeNumber(msg.startSec, duration) || !safeNumber(msg.endSec, duration) || msg.endSec <= msg.startSec) throw new Error('구간 이름과 시간을 확인해 주세요.');
  const color = msg.color === undefined ? '#6b9f8c' : msg.color;
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('구간 색상을 확인해 주세요.');
  return { label, startSec: msg.startSec, endSec: msg.endSec, color: color.toLowerCase() };
}
function mime(file) {
  return ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'audio/webm' })[path.extname(file)] || 'application/octet-stream';
}
async function serveFile(req, res, file, cache = 'no-store') {
  let stat;
  try { stat = await fsp.stat(file); if (!stat.isFile()) throw new Error(); } catch { return bad(res, '파일을 찾을 수 없습니다.', 404); }
  const range = req.headers.range;
  const headers = { 'content-type': mime(file), 'accept-ranges': 'bytes', 'cache-control': cache };
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return bad(res, '지원하지 않는 범위입니다.', 416);
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= stat.size) return bad(res, '지원하지 않는 범위입니다.', 416);
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    fs.createReadStream(file).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/time' && req.method === 'GET') return json(res, 200, { serverTimeMs: Date.now() });
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, snapshot(isConductor(req) ? 'conductor' : 'listener'));
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.username !== 'conductor' || !secureEqual(body.password, password)) return bad(res, '아이디 또는 비밀번호가 틀렸습니다.', 401);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.add(token);
      return json(res, 200, { ok: true }, { 'set-cookie': `choir_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${req.socket.encrypted ? '; Secure' : ''}` });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const token = cookies(req).choir_session;
      sessions.delete(token);
      for (const ws of activeConductors) if (clients.get(ws) === token) activeConductors.delete(ws);
      stopWhenUnattended();
      broadcast();
      return json(res, 200, { ok: true }, { 'set-cookie': 'choir_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (req.method === 'GET') {
      const requested = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.resolve(publicDir, `.${requested}`);
      if (file.startsWith(publicDir + path.sep)) return serveFile(req, res, file);
    }
    bad(res, '페이지를 찾을 수 없습니다.', 404);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) bad(res, error.message || '서버 오류가 발생했습니다.', 500);
  }
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    const token = cookies(req).choir_session;
    clients.set(ws, token);
    ws.send(JSON.stringify(snapshot(sessions.has(token) ? 'conductor' : 'listener')));
    ws.on('close', () => {
      clients.delete(ws);
      if (activeConductors.delete(ws)) {
        stopWhenUnattended();
        broadcast();
      }
    });
    ws.on('message', async raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!sessions.has(clients.get(ws))) return ws.send(JSON.stringify({ type: 'error', message: '지휘자 권한이 필요합니다.' }));
      try {
        const now = Date.now();
        if (msg.type === 'participation:set') {
          if (typeof msg.active !== 'boolean') throw new Error('연습 참여 상태가 올바르지 않습니다.');
          if (msg.active) activeConductors.add(ws); else activeConductors.delete(ws);
          stopWhenUnattended();
        } else if (msg.type === 'play') {
          if (!activeConductors.has(ws)) throw new Error('먼저 같이 연습에 참여해 주세요.');
          if (!Object.keys(catalog.tracks).length) throw new Error('저장소에 음원을 추가해 주세요.');
          if (transport.playing) return;
          const duration = roomDuration();
          const positionSec = duration !== null && currentPosition() >= duration ? 0 : currentPosition();
          transport = { playing: true, positionSec, startAtMs: now + 3000, revision: transport.revision + 1 };
        } else if (msg.type === 'pause') {
          transport = { playing: false, positionSec: currentPosition(now), startAtMs: null, revision: transport.revision + 1 };
        } else if (msg.type === 'seek') {
          if (!safeNumber(msg.positionSec)) throw new Error('재생 위치가 올바르지 않습니다.');
          transport = { playing: transport.playing, positionSec: msg.positionSec, startAtMs: transport.playing ? now + 3000 : null, revision: transport.revision + 1 };
        } else if (msg.type === 'segment:add') {
          saved.segments.push({ id: crypto.randomUUID(), ...segmentFields(msg), highlighted: false, checked: false });
          saved.segments.sort((a, b) => a.startSec - b.startSec);
          await persist();
        } else if (msg.type === 'segment:update') {
          const segment = saved.segments.find(s => s.id === msg.id);
          if (!segment) throw new Error('구간을 찾을 수 없습니다.');
          Object.assign(segment, segmentFields(msg));
          saved.segments.sort((a, b) => a.startSec - b.startSec);
          await persist();
        } else if (msg.type === 'segment:toggle') {
          const segment = saved.segments.find(s => s.id === msg.id);
          if (!segment || !['highlighted', 'checked'].includes(msg.field)) throw new Error('구간을 찾을 수 없습니다.');
          const next = !segment[msg.field];
          if (msg.field === 'highlighted') for (const s of saved.segments) s.highlighted = false;
          segment[msg.field] = next;
          await persist();
        } else if (msg.type === 'segment:delete') {
          saved.segments = saved.segments.filter(s => s.id !== msg.id);
          await persist();
        } else return;
        if (['play', 'pause', 'seek'].includes(msg.type)) scheduleEnd();
        broadcast();
      } catch (error) { ws.send(JSON.stringify({ type: 'error', message: error.message })); }
    });
  });
});

server.listen(port, host, () => {
  console.log(`Choir practice running at http://localhost:${port}`);
  if (!process.env.CONDUCTOR_PASSWORD) console.log(`Temporary conductor password: ${password}`);
});

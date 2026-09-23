import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';

function waitForMessage(ws, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', receive); reject(new Error('Timed out waiting for WebSocket message')); }, 6000);
    function receive(raw) {
      const data = JSON.parse(raw.toString());
      if (!predicate(data)) return;
      clearTimeout(timeout); ws.off('message', receive); resolve(data);
    }
    ws.on('message', receive);
  });
}
function connect(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
    ws.once('error', reject);
    ws.once('message', raw => resolve({ ws, state: JSON.parse(raw.toString()) }));
  });
}
test('conductor controls shared state while listeners remain read-only', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gospel-test-'));
  const port = 33000 + Math.floor(Math.random() * 10000);
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', CONDUCTOR_PASSWORD: 'test-secret' }, stdio: 'ignore' });
  t.after(async () => { server.kill(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { const response = await fetch(`${base}/api/state`); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  assert.equal(ready, true, 'server started');
  const page = await (await fetch(base)).text();
  assert.match(page, /id="practiceLock"/);
  assert.match(page, /id="joinOverlayBtn"/);
  assert.match(page, /id="joinBtn">연습 나가기<\/button>/);
  assert.ok(page.indexOf('id="soloMode"') < page.indexOf('id="sharedMode"'), 'solo mode is listed before shared mode');
  assert.ok(page.indexOf('id="soloMode"') < page.indexOf('class="top-actions"'), 'practice modes are placed beside the logo');
  const videoTrack = await fetch(`${base}/media/video/navigator-chorus.mp4`, { headers: { range: 'bytes=0-43' } });
  assert.equal(videoTrack.status, 206);
  assert.equal((await videoTrack.arrayBuffer()).byteLength, 44);
  const audioTrack = await fetch(`${base}/media/audio/navigator-chorus.mp3`, { headers: { range: 'bytes=0-43' } });
  assert.equal(audioTrack.status, 206);
  assert.equal((await audioTrack.arrayBuffer()).byteLength, 44);
  const deniedUpload = await fetch(`${base}/api/upload/choir`, { method: 'PUT' });
  assert.equal(deniedUpload.status, 404, 'the page no longer has an upload API');
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'conductor', password: 'test-secret' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { ws: listener, state: listenerState } = await connect(base.replace('http', 'ws') + '/ws');
  const { ws: conductor, state: conductorState } = await connect(base.replace('http', 'ws') + '/ws', cookie);
  t.after(() => { listener.close(); conductor.close(); });
  assert.equal(listenerState.role, 'listener'); assert.equal(conductorState.role, 'conductor');
  assert.equal(conductorState.tracks.choir.file, '/media/video/navigator-chorus.mp4');
  assert.equal(conductorState.tracks.choir.audioFile, '/media/audio/navigator-chorus.mp3');
  assert.equal(conductorState.tracks.choir.videoFile, '/media/video/navigator-chorus.mp4');
  listener.send(JSON.stringify({ type: 'play' }));
  assert.equal((await waitForMessage(listener, data => data.type === 'error')).type, 'error');
  conductor.send(JSON.stringify({ type: 'segment:add', label: 'Test bridge', startSec: 0, endSec: 1, color: '#aabbcc' }));
  const segmentState = await waitForMessage(listener, data => data.type === 'state' && data.segments.length === 1);
  const added = segmentState.segments.find(segment => segment.label === 'Test bridge');
  assert.ok(added);
  assert.equal(added.color, '#aabbcc');
  conductor.send(JSON.stringify({ type: 'segment:update', id: added.id, label: 'Rehearsal bridge', startSec: 1, endSec: 3, color: '#ff8833' }));
  const updated = await waitForMessage(listener, data => data.type === 'state' && data.segments[0]?.label === 'Rehearsal bridge');
  assert.equal(updated.segments[0].color, '#ff8833');
  assert.equal(updated.segments[0].startSec, 1);
  conductor.send(JSON.stringify({ type: 'segment:update', id: added.id, label: 'Bad range', startSec: 2, endSec: 999, color: '#ff8833' }));
  assert.equal((await waitForMessage(conductor, data => data.type === 'error')).type, 'error');
  conductor.send(JSON.stringify({ type: 'segment:toggle', id: added.id, field: 'highlighted' }));
  assert.equal((await waitForMessage(listener, data => data.type === 'state' && data.segments.find(s => s.id === added.id)?.highlighted)).segments.find(s => s.id === added.id).highlighted, true);
  conductor.send(JSON.stringify({ type: 'segment:toggle', id: added.id, field: 'highlighted' }));
  assert.equal((await waitForMessage(listener, data => data.type === 'state' && !data.segments.find(s => s.id === added.id)?.highlighted)).segments.find(s => s.id === added.id).highlighted, false);
  conductor.send(JSON.stringify({ type: 'play' }));
  assert.match((await waitForMessage(conductor, data => data.type === 'error')).message, /참여/);
  conductor.send(JSON.stringify({ type: 'participation:set', active: true }));
  assert.equal((await waitForMessage(listener, data => data.type === 'state' && data.conductorParticipating)).conductorParticipating, true);
  conductor.send(JSON.stringify({ type: 'play' }));
  const playing = await waitForMessage(listener, data => data.type === 'state' && data.transport.playing);
  assert.ok(playing.transport.startAtMs - playing.serverTimeMs >= 2900, 'shared play has a three-second preparation window');
  conductor.send(JSON.stringify({ type: 'pause' }));
  const paused = await waitForMessage(listener, data => data.type === 'state' && !data.transport.playing);
  assert.ok(paused.transport.stopAtMs - paused.serverTimeMs >= 2900, 'shared pause has a three-second preparation window');
  assert.ok(paused.transport.positionSec < 0.25, 'pause during countdown only advances by the command transit time');
  conductor.send(JSON.stringify({ type: 'play' }));
  await waitForMessage(listener, data => data.type === 'state' && data.transport.playing);
  conductor.send(JSON.stringify({ type: 'participation:set', active: false }));
  const unattended = await waitForMessage(listener, data => data.type === 'state' && !data.transport.playing && !data.conductorParticipating);
  assert.ok(unattended.transport.positionSec < 0.25, 'leaving during countdown stops everyone promptly');
  conductor.send(JSON.stringify({ type: 'play' }));
  assert.match((await waitForMessage(conductor, data => data.type === 'error')).message, /참여/);
  conductor.send(JSON.stringify({ type: 'participation:set', active: true }));
  await waitForMessage(listener, data => data.type === 'state' && data.conductorParticipating);
  conductor.send(JSON.stringify({ type: 'seek', positionSec: 258.4 }));
  await waitForMessage(listener, data => data.type === 'state' && data.transport.positionSec === 258.4);
  conductor.send(JSON.stringify({ type: 'play' }));
  await waitForMessage(listener, data => data.type === 'state' && data.transport.playing);
  const ended = await waitForMessage(listener, data => data.type === 'state' && !data.transport.playing && data.transport.positionSec === 258.6);
  assert.equal(ended.transport.positionSec, 258.6, 'playback stops at the shared track end');
  conductor.send(JSON.stringify({ type: 'participation:set', active: false }));
  await waitForMessage(listener, data => data.type === 'state' && !data.conductorParticipating);
  const { ws: departing } = await connect(base.replace('http', 'ws') + '/ws', cookie);
  t.after(() => departing.close());
  departing.send(JSON.stringify({ type: 'participation:set', active: true }));
  await waitForMessage(listener, data => data.type === 'state' && data.conductorParticipating);
  departing.send(JSON.stringify({ type: 'play' }));
  await waitForMessage(listener, data => data.type === 'state' && data.transport.playing);
  departing.close();
  const disconnected = await waitForMessage(listener, data => data.type === 'state' && !data.transport.playing && !data.conductorParticipating);
  assert.ok(disconnected.transport.positionSec < 0.25, 'disconnecting the last participating conductor stops everyone promptly');
  const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200);
  conductor.send(JSON.stringify({ type: 'seek', positionSec: 0.5 }));
  assert.equal((await waitForMessage(conductor, data => data.type === 'error')).type, 'error', 'logout revokes an existing socket');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';

function waitForMessage(ws, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', receive); reject(new Error('Timed out waiting for WebSocket message')); }, 3000);
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
  const track = await fetch(`${base}/audio/demo-choir.wav`, { headers: { range: 'bytes=0-43' } });
  assert.equal(track.status, 206);
  assert.equal((await track.arrayBuffer()).byteLength, 44);
  const deniedUpload = await fetch(`${base}/api/upload/choir`, { method: 'PUT' });
  assert.equal(deniedUpload.status, 404, 'the page no longer has an upload API');
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'conductor', password: 'test-secret' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { ws: listener, state: listenerState } = await connect(base.replace('http', 'ws') + '/ws');
  const { ws: conductor, state: conductorState } = await connect(base.replace('http', 'ws') + '/ws', cookie);
  t.after(() => { listener.close(); conductor.close(); });
  assert.equal(listenerState.role, 'listener'); assert.equal(conductorState.role, 'conductor');
  assert.equal(conductorState.tracks.choir.file, '/audio/demo-choir.wav');
  listener.send(JSON.stringify({ type: 'play' }));
  assert.equal((await waitForMessage(listener, data => data.type === 'error')).type, 'error');
  conductor.send(JSON.stringify({ type: 'segment:add', label: 'Test bridge', startSec: 0, endSec: 1 }));
  const segmentState = await waitForMessage(listener, data => data.type === 'state' && data.segments.length === 5);
  const added = segmentState.segments.find(segment => segment.label === 'Test bridge');
  assert.ok(added);
  conductor.send(JSON.stringify({ type: 'segment:toggle', id: added.id, field: 'highlighted' }));
  assert.equal((await waitForMessage(listener, data => data.type === 'state' && data.segments.find(s => s.id === added.id)?.highlighted)).segments.find(s => s.id === added.id).highlighted, true);
  conductor.send(JSON.stringify({ type: 'segment:toggle', id: added.id, field: 'highlighted' }));
  assert.equal((await waitForMessage(listener, data => data.type === 'state' && !data.segments.find(s => s.id === added.id)?.highlighted)).segments.find(s => s.id === added.id).highlighted, false);
  conductor.send(JSON.stringify({ type: 'play' }));
  const playing = await waitForMessage(listener, data => data.type === 'state' && data.transport.playing);
  assert.ok(playing.transport.startAtMs > playing.serverTimeMs);
  conductor.send(JSON.stringify({ type: 'pause' }));
  const paused = await waitForMessage(listener, data => data.type === 'state' && !data.transport.playing);
  assert.equal(paused.transport.positionSec, 0, 'pause during countdown keeps starting position');
  conductor.send(JSON.stringify({ type: 'seek', positionSec: 15.8 }));
  await waitForMessage(listener, data => data.type === 'state' && data.transport.positionSec === 15.8);
  conductor.send(JSON.stringify({ type: 'play' }));
  await waitForMessage(listener, data => data.type === 'state' && data.transport.playing);
  const ended = await waitForMessage(listener, data => data.type === 'state' && !data.transport.playing && data.transport.positionSec === 16);
  assert.equal(ended.transport.positionSec, 16, 'playback stops at the shared track end');
  const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200);
  conductor.send(JSON.stringify({ type: 'seek', positionSec: 0.5 }));
  assert.equal((await waitForMessage(conductor, data => data.type === 'error')).type, 'error', 'logout revokes an existing socket');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceTimeToAudioTime, serverTimeToPerformanceTime } from '../public/shared-audio.js';

test('server time is converted into the local performance clock', () => {
  assert.equal(serverTimeToPerformanceTime(10_500, 500, 9_000, 2_000), 3_000);
});

test('performance time is converted with an output timestamp', () => {
  const timestamp = { contextTime: 4, performanceTime: 2_000 };
  assert.equal(performanceTimeToAudioTime(3_500, timestamp, 10, 2_500), 5.5);
});

test('performance conversion falls back to current audio time', () => {
  assert.equal(performanceTimeToAudioTime(3_500, null, 10, 2_500), 11);
});

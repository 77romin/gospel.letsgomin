export function serverTimeToPerformanceTime(serverTimeMs, clockOffsetMs, epochNowMs = Date.now(), performanceNowMs = performance.now()) {
  const localEpochTargetMs = serverTimeMs - clockOffsetMs;
  return performanceNowMs + (localEpochTargetMs - epochNowMs);
}

export function performanceTimeToAudioTime(performanceTimeMs, timestamp, currentAudioTime, performanceNowMs = performance.now()) {
  if (timestamp?.contextTime > 0 && timestamp?.performanceTime > 0) {
    return timestamp.contextTime + (performanceTimeMs - timestamp.performanceTime) / 1000;
  }
  return currentAudioTime + (performanceTimeMs - performanceNowMs) / 1000;
}

export class SharedAudioEngine {
  constructor() {
    this.context = null;
    this.gain = null;
    this.source = null;
    this.buffer = null;
    this.bufferUrl = null;
    this.loadGeneration = 0;
    this.startAudioTime = null;
    this.startOffsetSec = 0;
    this.volume = 1;
  }

  getContext() {
    if (this.context && this.context.state !== 'closed') return this.context;
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('이 브라우저는 공동 재생에 필요한 Web Audio를 지원하지 않습니다.');
    this.context = new AudioContextClass({ latencyHint: 'interactive' });
    this.gain = this.context.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(this.context.destination);

    // Keep the output route warm. Some mobile/Bluetooth stacks rebuild their
    // playback buffer after silence, which makes the next start less stable.
    const keepalive = this.context.createOscillator();
    const keepaliveGain = this.context.createGain();
    keepalive.frequency.value = 1;
    keepaliveGain.gain.value = 0.0001;
    keepalive.connect(keepaliveGain);
    keepaliveGain.connect(this.gain);
    keepalive.start();

    if (typeof navigator !== 'undefined' && navigator.audioSession) {
      try { navigator.audioSession.type = 'playback'; } catch {}
    }
    return this.context;
  }

  async unlock() {
    const context = this.getContext();
    if (context.state === 'suspended' || context.state === 'interrupted') await context.resume();
    const silent = context.createBufferSource();
    silent.buffer = context.createBuffer(1, 1, context.sampleRate);
    silent.connect(this.gain);
    silent.start();
  }

  async load(url) {
    if (!url) throw new Error('공동 재생 음원 경로가 없습니다.');
    if (this.buffer && this.bufferUrl === url) return this.buffer;
    const generation = ++this.loadGeneration;
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`공동 재생 음원을 불러올 수 없습니다. (${response.status})`);
    const encoded = await response.arrayBuffer();
    const decoded = await this.getContext().decodeAudioData(encoded);
    if (generation !== this.loadGeneration) throw new DOMException('다른 파트로 변경되었습니다.', 'AbortError');
    this.stop();
    this.buffer = decoded;
    this.bufferUrl = url;
    return decoded;
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, Number(value)));
    if (this.gain && this.context) this.gain.gain.setValueAtTime(this.volume, this.context.currentTime);
  }

  stop(when = null) {
    const source = this.source;
    this.source = null;
    this.startAudioTime = null;
    if (!source) return;
    try { source.stop(when ?? 0); } catch {}
    if (when === null) {
      try { source.disconnect(); } catch {}
    }
  }

  schedule({ serverTimeMs, clockOffsetMs, offsetSec }) {
    const context = this.getContext();
    if (!this.buffer || context.state !== 'running') throw new Error('공동 재생 음원이 아직 준비되지 않았습니다.');
    this.stop();

    const performanceTarget = serverTimeToPerformanceTime(serverTimeMs, clockOffsetMs);
    const timestamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : null;
    let startAudioTime = performanceTimeToAudioTime(performanceTarget, timestamp, context.currentTime);
    let startOffsetSec = Math.max(0, offsetSec);
    const minimumStart = context.currentTime + 0.02;
    if (startAudioTime < minimumStart) {
      startOffsetSec += minimumStart - startAudioTime;
      startAudioTime = minimumStart;
    }
    if (startOffsetSec >= this.buffer.duration) return null;

    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    source.start(startAudioTime, startOffsetSec);
    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      this.startAudioTime = null;
    };
    this.source = source;
    this.startAudioTime = startAudioTime;
    this.startOffsetSec = startOffsetSec;
    return { startAudioTime, startOffsetSec, performanceTarget };
  }

  scheduleStop({ serverTimeMs, clockOffsetMs }) {
    if (!this.context || !this.source) return null;
    const performanceTarget = serverTimeToPerformanceTime(serverTimeMs, clockOffsetMs);
    const timestamp = typeof this.context.getOutputTimestamp === 'function' ? this.context.getOutputTimestamp() : null;
    const stopAudioTime = Math.max(this.context.currentTime,
      performanceTimeToAudioTime(performanceTarget, timestamp, this.context.currentTime));
    try { this.source.stop(stopAudioTime); } catch { return null; }
    return { stopAudioTime, performanceTarget };
  }

  getAudiblePosition() {
    if (!this.context || this.startAudioTime === null) return null;
    let outputAudioTime = this.context.currentTime;
    if (typeof this.context.getOutputTimestamp === 'function') {
      const timestamp = this.context.getOutputTimestamp();
      if (timestamp.contextTime > 0) outputAudioTime = timestamp.contextTime;
    }
    return this.startOffsetSec + Math.max(0, outputAudioTime - this.startAudioTime);
  }

  getDiagnostics() {
    if (!this.context) return { state: 'not-created', baseLatency: null, outputLatency: null, audiblePosition: null };
    return {
      state: this.context.state,
      baseLatency: Number.isFinite(this.context.baseLatency) ? this.context.baseLatency : null,
      outputLatency: Number.isFinite(this.context.outputLatency) ? this.context.outputLatency : null,
      audiblePosition: this.getAudiblePosition()
    };
  }
}

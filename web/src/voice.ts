export type Capture = { stop: () => void; cancel: () => void };
export async function record(onComplete: (audio: Blob, endedAt: string) => void, onError: (e: Error) => void): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('此页面无法使用麦克风，请使用 localhost 或 HTTPS');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(stream), processor = context.createScriptProcessor(4096, 1, 1), mute = context.createGain(); mute.gain.value = 0;
  source.connect(processor); processor.connect(mute); mute.connect(context.destination);
  const chunks: Float32Array[] = []; let heard = false, lastSound = Date.now(), done = false;
  const started = Date.now();
  const finish = (cancel = false) => {
    if (done) return; done = true; clearInterval(timer);
    const endedAt = new Date().toISOString();
    processor.onaudioprocess = null; source.disconnect(); processor.disconnect(); mute.disconnect(); stream.getTracks().forEach(t => t.stop()); void context.close();
    if (cancel) { chunks.length = 0; return; }
    if (!heard) { chunks.length = 0; onError(new Error('没有听到声音，请靠近麦克风重试')); return; }
    const count = chunks.reduce((n, c) => n + c.length, 0), bytes = new ArrayBuffer(44 + count * 2), view = new DataView(bytes);
    const string = (offset: number, value: string) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
    string(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); string(8, 'WAVE'); string(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, context.sampleRate, true); view.setUint32(28, context.sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); string(36, 'data'); view.setUint32(40, count * 2, true);
    let i = 44; for (const chunk of chunks) for (const value of chunk) { const v = Math.max(-1, Math.min(1, value)); view.setInt16(i, v * (v < 0 ? 32768 : 32767), true); i += 2; } chunks.length = 0;
    onComplete(new Blob([bytes], { type: 'audio/wav' }), endedAt);
  };
  processor.onaudioprocess = event => {
    if (done) return;
    const samples = event.inputBuffer.getChannelData(0); chunks.push(samples.slice());
    const rms = Math.sqrt(samples.reduce((n, v) => n + v * v, 0) / samples.length);
    if (rms > 0.012) { heard = true; lastSound = Date.now(); }
  };
  const timer = setInterval(() => { if (heard && Date.now() - lastSound > 2000 || Date.now() - started > 60_000 || !heard && Date.now() - started > 10_000) finish(); }, 100);
  return { stop: () => finish(), cancel: () => finish(true) };
}

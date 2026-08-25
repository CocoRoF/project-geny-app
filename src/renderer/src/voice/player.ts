/**
 * Speech playback, with the waveform exposed.
 *
 * Two reasons this is not just `new Audio(src).play()`:
 *  · replies arrive in pieces, and overlapping playback is unlistenable —
 *    so clips queue.
 *  · the avatar's mouth should follow the ACTUAL voice, not a fake talking
 *    rhythm, which means an AnalyserNode on the graph.
 */
import type { SpokenAudio } from '@shared/voice';

export type LevelListener = (level: number) => void;

class VoicePlayer {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private readonly queue: SpokenAudio[] = [];
  private playing = false;
  private readonly listeners = new Set<LevelListener>();
  private raf = 0;
  private current: SpokenAudio | null = null;

  onLevel(listener: LevelListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  speaking(): SpokenAudio | null {
    return this.current;
  }

  enqueue(audio: SpokenAudio): void {
    this.queue.push(audio);
    if (!this.playing) void this.drain();
  }

  stop(): void {
    this.queue.length = 0;
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.context.destination);
    }
    // a context created before any user gesture starts suspended
    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  private async drain(): Promise<void> {
    this.playing = true;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      try {
        await this.playOne(next);
      } catch (err) {
        console.error('[voice] playback failed', err);
      }
    }
    this.playing = false;
    this.current = null;
    this.emit(0);
  }

  private emit(level: number): void {
    for (const listener of this.listeners) listener(level);
  }

  private async playOne(audio: SpokenAudio): Promise<void> {
    const context = this.ensureContext();
    const bytes = Uint8Array.from(atob(audio.base64), (c) => c.charCodeAt(0));
    // decodeAudioData detaches the buffer, so it must own its own copy
    const decoded = await context.decodeAudioData(bytes.buffer as ArrayBuffer);

    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(this.analyser!);
    this.source = source;
    this.current = audio;

    const data = new Uint8Array(this.analyser!.frequencyBinCount);
    const tick = (): void => {
      this.analyser!.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) {
        const centred = (v - 128) / 128;
        sum += centred * centred;
      }
      // RMS is small for speech; scale so a normal voice reaches ~1
      this.emit(Math.min(1, Math.sqrt(sum / data.length) * 3.2));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);

    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
    cancelAnimationFrame(this.raf);
    this.source = null;
    this.emit(0);
  }
}

/** One per window — playback is a property of the window, not of a React tree. */
export const voicePlayer = new VoicePlayer();

/** Wire the main-process audio push into this window's player. */
export function attachVoicePlayback(): () => void {
  return window.geny.voice.onAudio((audio) => voicePlayer.enqueue(audio));
}

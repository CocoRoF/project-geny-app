/**
 * Microphone capture for push-to-talk.
 *
 * `audio/webm;codecs=opus` is what Chromium records natively and what both
 * OpenAI and vLLM's whisper accept, so there is no transcode step. The
 * stream's tracks are stopped on every exit path — a live mic indicator
 * that never goes away is the kind of bug users do not forgive.
 */
export interface Recording {
  base64: string;
  mime: string;
  seconds: number;
}

const PREFERRED = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const mimeType = PREFERRED.find((t) => MediaRecorder.isTypeSupported(t));
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.startedAt = performance.now();
    this.recorder.start();
  }

  async stop(): Promise<Recording | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      this.release();
      return null;
    }
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }));
      recorder.stop();
    });
    const seconds = (performance.now() - this.startedAt) / 1000;
    this.release();
    if (blob.size === 0) return null;

    const buffer = await blob.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    // chunked: String.fromCharCode(...bytes) blows the stack past ~100k samples
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { base64: btoa(binary), mime: recorder.mimeType || 'audio/webm', seconds };
  }

  /** Always safe to call — the mic must never stay open on an error path. */
  release(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

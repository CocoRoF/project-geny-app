/**
 * VoiceService — configuration, secrets, and the two calls the rest of the
 * app makes: `transcribe` and `speak`.
 *
 * The app serves no audio of its own. What it owns is the *connection*: the
 * settings, the credentials, and health checks that tell the truth about
 * what is on the other end.
 */
import type {
  SpokenAudio, VoiceConfig, VoiceHealth, VoiceOption,
} from '@shared/voice';
import { DEFAULT_VOICE_CONFIG } from '@shared/voice';
import { VoiceError } from './http';
import { sttHealth, transcribe, type TranscribeInput } from './stt';
import { listVoices, synthesize, ttsHealth } from './tts';

export interface VoiceDeps {
  settings: { get(key: string): string | undefined; set(key: string, value: string): void };
  secrets: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
  };
  /** hand audio to every surface that can play it (and to the avatar, whose
   *  mouth is driven by the waveform) */
  play(audio: SpokenAudio): void;
}

const KEY = 'voice.config';
export const SECRET_STT = 'apiKey:voice.stt';
export const SECRET_TTS = 'apiKey:voice.tts';

/** A stored config may predate a field; merging with the default keeps an
 *  old install from losing its endpoint to an `undefined`. */
const merge = (raw: string | undefined): VoiceConfig => {
  if (!raw) return structuredClone(DEFAULT_VOICE_CONFIG);
  try {
    const parsed = JSON.parse(raw) as Partial<VoiceConfig>;
    return {
      stt: { ...DEFAULT_VOICE_CONFIG.stt, ...(parsed.stt ?? {}) },
      tts: { ...DEFAULT_VOICE_CONFIG.tts, ...(parsed.tts ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_VOICE_CONFIG);
  }
};

const message = (err: unknown): string =>
  err instanceof VoiceError || err instanceof Error ? err.message : String(err);

export class VoiceService {
  constructor(private readonly deps: VoiceDeps) {}

  config(): VoiceConfig {
    const config = merge(this.deps.settings.get(KEY));
    // `hasKey` is derived, never stored — the settings row must not become
    // a place a secret could leak into
    config.stt.hasKey = Boolean(this.deps.secrets.get(SECRET_STT));
    config.tts.hasKey = Boolean(this.deps.secrets.get(SECRET_TTS));
    return config;
  }

  save(next: VoiceConfig): VoiceConfig {
    const { stt, tts } = next;
    const stripped = {
      stt: { ...stt, hasKey: undefined },
      tts: { ...tts, hasKey: undefined },
    };
    this.deps.settings.set(KEY, JSON.stringify(stripped));
    return this.config();
  }

  setKey(which: 'stt' | 'tts', key: string | null): VoiceConfig {
    const name = which === 'stt' ? SECRET_STT : SECRET_TTS;
    if (key) this.deps.secrets.set(name, key);
    else this.deps.secrets.delete(name);
    return this.config();
  }

  enabled(): { stt: boolean; tts: boolean } {
    const config = this.config();
    return { stt: config.stt.provider !== 'none', tts: config.tts.provider !== 'none' };
  }

  /** `force` is what the settings button means: the user just dropped a
   *  profile onto the server and wants to see it now. */
  async voices(force = false): Promise<VoiceOption[]> {
    const config = this.config();
    return listVoices(config.tts, this.deps.secrets.get(SECRET_TTS), force);
  }

  async transcribe(input: TranscribeInput): Promise<string> {
    const config = this.config();
    return transcribe(config.stt, this.deps.secrets.get(SECRET_STT), input);
  }

  /**
   * Say something. Audio comes back to the app and is played by a surface
   * (which is also what drives the avatar's mouth); OS voices speak
   * themselves and return nothing to play.
   */
  async speak(text: string): Promise<{ played: boolean; local: boolean }> {
    const config = this.config();
    const result = await synthesize(config.tts, this.deps.secrets.get(SECRET_TTS), text);
    if (result.kind === 'local') return { played: true, local: true };
    this.deps.play({ base64: result.audio.toString('base64'), mime: result.mime, text });
    return { played: true, local: false };
  }

  private async probe(
    which: 'stt' | 'tts',
  ): Promise<VoiceHealth> {
    const config = this.config();
    const side = which === 'stt' ? config.stt : config.tts;
    if (side.provider === 'none') return { ok: false, error: '설정되지 않음' };
    const started = Date.now();
    try {
      const key = this.deps.secrets.get(which === 'stt' ? SECRET_STT : SECRET_TTS);
      const { url, detail } =
        which === 'stt' ? await sttHealth(config.stt, key) : await ttsHealth(config.tts, key);
      const latencyMs = Date.now() - started;

      // omnivoice answers /health with 200 the whole time it is loading a
      // multi-GB model — reporting that as "ok" would make the first real
      // request's 503 look like a different, unrelated failure
      const loading = /"status"\s*:\s*"loading"/.test(detail);
      if (loading) {
        return { ok: false, url, latencyMs, error: '모델을 아직 불러오는 중입니다 (status: loading)', detail };
      }
      return { ok: true, url, latencyMs, detail };
    } catch (err) {
      return {
        ok: false,
        url: err instanceof VoiceError ? err.url : undefined,
        latencyMs: Date.now() - started,
        error: message(err),
      };
    }
  }

  async health(): Promise<{ stt: VoiceHealth; tts: VoiceHealth }> {
    const [stt, tts] = await Promise.all([this.probe('stt'), this.probe('tts')]);
    return { stt, tts };
  }
}

/**
 * Voice configuration — the contract between the app's settings and the
 * clients that call out to a speech service.
 *
 * This app serves NO audio itself (an explicit scope decision). Everything
 * here is about *calling* somebody else's service properly: OpenAI's, a
 * self-hosted `geny-audio-services` box, or an endpoint the user describes
 * by hand.
 */

export type SttProviderId = 'none' | 'openai' | 'whisper' | 'custom';
export type TtsProviderId = 'none' | 'openai' | 'omnivoice' | 'custom' | 'system';

/** How a provider is reached. `system` needs none of it. */
export interface EndpointConfig {
  /** service root, e.g. `http://gpu-box:8001` — never the full path */
  baseUrl: string;
  /** stored in the secret store, never here */
  hasKey?: boolean;
  model?: string;
  /** seconds; a cold GPU box can take a while on its first request */
  timeoutSeconds?: number;
  /** extra headers for `custom` — auth schemes we do not model */
  headers?: Record<string, string>;
}

export interface SttConfig extends EndpointConfig {
  provider: SttProviderId;
  language?: string;
  /** `custom` only: the multipart field the endpoint expects the audio in */
  fileField?: string;
  /** `custom` only: dotted path to the text in the JSON reply, e.g. `result.text` */
  textPath?: string;
}

export interface TtsConfig extends EndpointConfig {
  provider: TtsProviderId;
  /** openai: a voice name (`alloy`); omnivoice: a profile id from /voices */
  voice?: string;
  /** omnivoice: which reference clip of the profile — its `emotion` */
  emotion?: string;
  language?: string;
  speed?: number;
  format?: 'wav' | 'mp3' | 'ogg';
  /** omnivoice diffusion steps — the quality/latency dial (24 is balanced) */
  numStep?: number;
  /** speak the assistant's replies without being asked */
  autoSpeak?: boolean;
}

export interface VoiceConfig {
  stt: SttConfig;
  tts: TtsConfig;
}

/** A voice the TTS service offers. `emotions` is omnivoice's per-profile
 *  reference clips; other providers return a single unnamed variant. */
export interface VoiceOption {
  id: string;
  name: string;
  language?: string;
  emotions?: string[];
}

export interface VoiceHealth {
  ok: boolean;
  /** what the service said about itself — model, device, status */
  detail?: string;
  /** the URL actually probed, so a misconfiguration is visible */
  url?: string;
  error?: string;
  latencyMs?: number;
}

export interface SpokenAudio {
  /** base64 — audio crosses the IPC boundary, and Buffers do not survive it
   *  as anything readable by the Web Audio API */
  base64: string;
  mime: string;
  /** the text this audio says, so the UI can caption it */
  text: string;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  stt: { provider: 'none', baseUrl: '', model: '', timeoutSeconds: 120 },
  tts: { provider: 'none', baseUrl: '', model: '', timeoutSeconds: 180, format: 'wav', speed: 1 },
};

/**
 * Ready-made settings for the services this project actually ships.
 *
 * `geny-audio-services` publishes omnivoice on 9881 and whisper-stt on 8001,
 * and whisper-stt is vLLM's OpenAI-compatible server — so the STT wire
 * format is identical to OpenAI's and only the base URL and auth differ.
 */
export const PRESETS = {
  stt: {
    openai: { baseUrl: 'https://api.openai.com', model: 'whisper-1' },
    whisper: { baseUrl: 'http://localhost:8001', model: 'openai/whisper-large-v3' },
  },
  tts: {
    openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini-tts', voice: 'alloy' },
    omnivoice: { baseUrl: 'http://localhost:9881', model: '', numStep: 24 },
  },
} as const;

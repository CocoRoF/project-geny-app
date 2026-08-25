/**
 * Text → speech.
 *
 * The omnivoice path is where the real work is. A client that just POSTs
 * `{text}` to `/tts` gets a DIFFERENT RANDOM VOICE on every call, because
 * the service's `mode` defaults to `auto`. Using a chosen voice means
 * resolving the profile through `GET /voices` into the three fields the
 * service actually keys on — `mode: "clone"`, `ref_audio_path` and
 * `ref_text` — and that resolution is this module's reason to exist.
 *
 * (The service README's example uses `voice_profile`/`format`; those are
 * not fields of `TTSRequest`. Written from the README, a client silently
 * gets `auto` mode. The schema is the contract, not the README.)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TtsConfig, VoiceOption } from '@shared/voice';
import { authHeaders, joinUrl, request, VoiceError } from './http';

const run = promisify(execFile);

export type SynthesisResult =
  | { kind: 'audio'; audio: Buffer; mime: string }
  /** the OS spoke it directly — there are no bytes to hand back */
  | { kind: 'local' };

const MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
};

interface OmniVoiceProfile {
  id: string;
  name: string;
  language?: string | null;
  is_template?: boolean;
  ref_audios?: Array<{ emotion: string; file: string; prompt_text?: string | null }>;
}

/**
 * Voice profiles change only when the operator drops a folder into the
 * service's `voices/`, so a short cache is safe — and necessary: every
 * synthesis has to resolve the profile, so an uncached read would put a
 * second round trip in front of every sentence spoken.
 */
const profileCache = new Map<string, { at: number; profiles: OmniVoiceProfile[] }>();
const CACHE_MS = 30_000;

async function fetchProfiles(
  config: TtsConfig,
  apiKey: string | undefined,
  force = false,
): Promise<OmniVoiceProfile[]> {
  const cached = profileCache.get(config.baseUrl);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.profiles;

  const response = await request(joinUrl(config.baseUrl, '/voices'), {
    method: 'GET',
    headers: { ...authHeaders(apiKey), ...(config.headers ?? {}) },
    timeoutSeconds: Math.min(config.timeoutSeconds ?? 15, 15),
  });
  const payload = (await response.json()) as { voices?: OmniVoiceProfile[] };
  const profiles = payload.voices ?? [];
  profileCache.set(config.baseUrl, { at: Date.now(), profiles });
  return profiles;
}

export async function listVoices(
  config: TtsConfig,
  apiKey?: string,
  /** the user pressing "목록 가져오기" means now, not up-to-30-seconds-ago */
  force = false,
): Promise<VoiceOption[]> {
  if (config.provider === 'openai') {
    // OpenAI has no voice-list endpoint; these are the documented names
    return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']
      .map((id) => ({ id, name: id }));
  }
  if (config.provider !== 'omnivoice') return [];

  return (await fetchProfiles(config, apiKey, force)).map((v) => ({
    id: v.id,
    name: v.name || v.id,
    language: v.language ?? undefined,
    emotions: (v.ref_audios ?? []).map((r) => r.emotion),
  }));
}

/**
 * Turn `voice` + `emotion` into the clone fields the service keys on.
 *
 * Returns null when no profile is selected — the caller then leaves `mode`
 * at `auto` deliberately, which is a random voice but at least an intended
 * one rather than an accident.
 */
async function resolveClone(
  config: TtsConfig,
  apiKey?: string,
): Promise<{ ref_audio_path: string; ref_text?: string } | null> {
  if (!config.voice) return null;
  let profiles = await fetchProfiles(config, apiKey);
  let profile = profiles.find((v) => v.id === config.voice);
  if (!profile) {
    // a profile added since the cache was filled is the likely story, so
    // pay for one fresh read before declaring it missing
    profiles = await fetchProfiles(config, apiKey, true);
    profile = profiles.find((v) => v.id === config.voice);
  }
  if (!profile) {
    throw new VoiceError(`'${config.voice}' 음성 프로필이 서버에 없습니다`);
  }
  const clips = profile.ref_audios ?? [];
  if (clips.length === 0) {
    throw new VoiceError(`'${config.voice}' 프로필에 레퍼런스 오디오가 없습니다`);
  }
  const clip = clips.find((c) => c.emotion === config.emotion) ?? clips[0];
  if (!clip) throw new VoiceError(`'${config.voice}' 프로필에 레퍼런스 오디오가 없습니다`);
  return {
    // an absolute path INSIDE the container — the service reads it, not us
    ref_audio_path: clip.file,
    ref_text: clip.prompt_text ?? undefined,
  };
}

export async function synthesize(
  config: TtsConfig,
  apiKey: string | undefined,
  text: string,
): Promise<SynthesisResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new VoiceError('읽을 텍스트가 비어 있습니다');

  if (config.provider === 'none') {
    throw new VoiceError('음성 합성 제공자가 설정되지 않았습니다 (설정 → 음성)');
  }
  if (config.provider === 'system') {
    await speakWithOs(trimmed);
    return { kind: 'local' };
  }
  if (!config.baseUrl) throw new VoiceError('음성 합성 주소가 비어 있습니다');

  const format = config.format ?? 'wav';

  if (config.provider === 'omnivoice') {
    const clone = await resolveClone(config, apiKey);
    const body = {
      text: trimmed,
      // `auto` is a RANDOM voice, so a selected profile must switch the mode
      mode: clone ? 'clone' : 'auto',
      ...clone,
      language: config.language || null,
      speed: config.speed ?? 1,
      num_step: config.numStep ?? 24,
      audio_format: format,
    };
    const response = await request(joinUrl(config.baseUrl, '/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey), ...(config.headers ?? {}) },
      body: JSON.stringify(body),
      timeoutSeconds: config.timeoutSeconds,
    });
    return {
      kind: 'audio',
      audio: Buffer.from(await response.arrayBuffer()),
      mime: response.headers.get('content-type') ?? MIME[format] ?? 'audio/wav',
    };
  }

  if (config.provider === 'openai') {
    const response = await request(joinUrl(config.baseUrl, '/v1/audio/speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey), ...(config.headers ?? {}) },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini-tts',
        input: trimmed,
        voice: config.voice || 'alloy',
        response_format: format,
        speed: config.speed ?? 1,
      }),
      timeoutSeconds: config.timeoutSeconds,
    });
    return {
      kind: 'audio',
      audio: Buffer.from(await response.arrayBuffer()),
      mime: response.headers.get('content-type') ?? MIME[format] ?? 'audio/mpeg',
    };
  }

  // custom: the user's own endpoint. We send a shape that covers the
  // common cases and hand back whatever bytes come out.
  const response = await request(config.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey), ...(config.headers ?? {}) },
    body: JSON.stringify({
      text: trimmed,
      input: trimmed,
      voice: config.voice,
      model: config.model,
      language: config.language,
      speed: config.speed ?? 1,
      format,
    }),
    timeoutSeconds: config.timeoutSeconds,
  });
  const mime = response.headers.get('content-type') ?? MIME[format] ?? 'audio/wav';
  if (mime.includes('json')) {
    throw new VoiceError('오디오 대신 JSON이 왔습니다 — 이 엔드포인트는 오디오 바이트를 반환해야 합니다');
  }
  return { kind: 'audio', audio: Buffer.from(await response.arrayBuffer()), mime };
}

/**
 * The zero-configuration fallback: whatever the OS already has.
 *
 * Not as good as a real model, but it works on first run with no endpoint,
 * no key, and no GPU — which is the difference between the feature existing
 * and the feature being reachable.
 */
async function speakWithOs(text: string): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      await run('say', [text]);
      return;
    }
    if (process.platform === 'win32') {
      // -EncodedCommand avoids every quoting problem the text could carry
      const script = `Add-Type -AssemblyName System.Speech; ` +
        `(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak([Console]::In.ReadToEnd())`;
      const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
      child.stdin?.end(text);
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', () => resolve());
      });
      return;
    }
    await run('spd-say', ['--wait', text]);
  } catch (err) {
    const what = process.platform === 'linux' ? 'spd-say (speech-dispatcher)' : '시스템 음성';
    throw new VoiceError(
      `${what} 을(를) 실행하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function ttsHealth(
  config: TtsConfig,
  apiKey?: string,
): Promise<{ url: string; detail: string }> {
  if (config.provider === 'system') {
    return { url: process.platform, detail: 'OS 내장 음성' };
  }
  const url =
    config.provider === 'openai'
      ? joinUrl(config.baseUrl, '/v1/models')
      : config.provider === 'omnivoice'
        ? joinUrl(config.baseUrl, '/health')
        : config.baseUrl;
  const response = await request(url, {
    method: 'GET',
    headers: { ...authHeaders(apiKey), ...(config.headers ?? {}) },
    timeoutSeconds: Math.min(config.timeoutSeconds ?? 15, 15),
  });
  return { url, detail: (await response.text()).slice(0, 200) };
}

/**
 * Speech → text.
 *
 * `openai` and `whisper` are one implementation on purpose, not by
 * accident: `geny-audio-services`' whisper-stt IS vLLM's OpenAI-compatible
 * server, so the wire format is identical and only the base URL and auth
 * differ. Pretending they were two protocols would mean two things to keep
 * working instead of one.
 */
import type { SttConfig } from '@shared/voice';
import { authHeaders, joinUrl, request, VoiceError } from './http';

export interface TranscribeInput {
  /** raw audio bytes as captured by the renderer */
  audio: Buffer;
  mime: string;
  filename?: string;
}

const extensionFor = (mime: string): string => {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'wav';
};

/** dotted lookup for `custom`'s `textPath`, e.g. `result.segments.0.text` */
const dig = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((at, key) => {
    if (at === null || at === undefined) return undefined;
    return (at as Record<string, unknown>)[key];
  }, value);

export async function transcribe(
  config: SttConfig,
  apiKey: string | undefined,
  input: TranscribeInput,
): Promise<string> {
  if (config.provider === 'none') {
    throw new VoiceError('음성 인식 제공자가 설정되지 않았습니다 (설정 → 음성)');
  }
  if (!config.baseUrl) throw new VoiceError('음성 인식 주소가 비어 있습니다');

  const file = new File(
    [new Uint8Array(input.audio)],
    input.filename ?? `speech.${extensionFor(input.mime)}`,
    { type: input.mime },
  );
  const form = new FormData();

  if (config.provider === 'custom') {
    form.append(config.fileField || 'file', file);
    if (config.model) form.append('model', config.model);
    if (config.language) form.append('language', config.language);
    const response = await request(config.baseUrl, {
      method: 'POST',
      body: form,
      headers: { ...authHeaders(apiKey), ...(config.headers ?? {}) },
      timeoutSeconds: config.timeoutSeconds,
    });
    const text = await response.text();
    if (!config.textPath) return text.trim();
    const found = dig(JSON.parse(text), config.textPath);
    if (typeof found !== 'string') {
      throw new VoiceError(`응답에서 '${config.textPath}' 를 찾지 못했습니다`);
    }
    return found.trim();
  }

  // OpenAI-compatible: `model` is REQUIRED by vLLM even though the server
  // hosts exactly one — omitting it is a 400, not a default
  form.append('file', file);
  form.append('model', config.model || 'whisper-1');
  if (config.language) form.append('language', config.language);
  form.append('response_format', 'json');

  const url = joinUrl(config.baseUrl, '/v1/audio/transcriptions');
  const response = await request(url, {
    method: 'POST',
    body: form,
    headers: { ...authHeaders(apiKey), ...(config.headers ?? {}) },
    timeoutSeconds: config.timeoutSeconds,
  });
  const payload = (await response.json()) as { text?: string };
  if (typeof payload.text !== 'string') {
    throw new VoiceError('응답에 text 필드가 없습니다');
  }
  return payload.text.trim();
}

export async function sttHealth(
  config: SttConfig,
  apiKey: string | undefined,
): Promise<{ url: string; detail: string }> {
  // the self-hosted container answers /health; OpenAI does not, so its
  // reachability is proved by the endpoint that actually matters
  const url =
    config.provider === 'openai'
      ? joinUrl(config.baseUrl, '/v1/models')
      : joinUrl(config.baseUrl, '/health');
  const response = await request(url, {
    method: 'GET',
    headers: { ...authHeaders(apiKey), ...(config.headers ?? {}) },
    timeoutSeconds: Math.min(config.timeoutSeconds ?? 15, 15),
  });
  const body = await response.text();
  return { url, detail: body.slice(0, 200) };
}

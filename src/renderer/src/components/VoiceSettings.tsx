/**
 * Voice settings — which service to call, and proof that it answers.
 *
 * This app serves no audio. What it owns is the connection, so the panel is
 * built around that: an endpoint, a credential, and a 연결 확인 button that
 * really calls the service and shows what it said. A green light that was
 * inferred from the config rather than measured would be worse than none.
 */
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type {
  SttProviderId, TtsProviderId, VoiceConfig, VoiceHealth, VoiceOption,
} from '@shared/voice';
import { PRESETS } from '@shared/voice';

const STT_PROVIDERS: Array<{ id: SttProviderId; label: string; hint: string }> = [
  { id: 'none', label: '사용 안 함', hint: '' },
  { id: 'whisper', label: 'Geny whisper-stt', hint: 'geny-audio-services 컨테이너 (기본 8001)' },
  { id: 'openai', label: 'OpenAI', hint: 'api.openai.com · whisper-1 / gpt-4o-transcribe' },
  { id: 'custom', label: '직접 지정', hint: 'multipart 로 오디오를 받는 아무 엔드포인트' },
];

const TTS_PROVIDERS: Array<{ id: TtsProviderId; label: string; hint: string }> = [
  { id: 'none', label: '사용 안 함', hint: '' },
  { id: 'omnivoice', label: 'Geny omnivoice', hint: 'geny-audio-services 컨테이너 (기본 9881) · 음성 복제' },
  { id: 'openai', label: 'OpenAI', hint: 'api.openai.com · gpt-4o-mini-tts' },
  { id: 'system', label: 'OS 내장 음성', hint: '설정 없이 바로 — say · SAPI · spd-say' },
  { id: 'custom', label: '직접 지정', hint: '오디오 바이트를 돌려주는 아무 엔드포인트' },
];

const Field = ({ label, children }: { label: string; children: JSX.Element }): JSX.Element => (
  <label className="flex items-center gap-2">
    <span className="w-24 shrink-0 text-dim">{label}</span>
    {children}
  </label>
);

const input = 'flex-1 rounded border border-line bg-panel px-2 py-1 outline-none focus:border-accent';

function Light({ health }: { health?: VoiceHealth }): JSX.Element {
  if (!health) return <span className="text-dim">미확인</span>;
  if (health.ok) {
    return (
      <span className="text-emerald-300">
        연결됨{health.latencyMs !== undefined ? ` · ${health.latencyMs}ms` : ''}
        {health.detail && <span className="text-dim"> · {health.detail.slice(0, 90)}</span>}
      </span>
    );
  }
  return <span className="text-red-300">{health.error ?? '응답 없음'}{health.url ? ` (${health.url})` : ''}</span>;
}

export function VoiceSettings(): JSX.Element {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [health, setHealth] = useState<{ stt?: VoiceHealth; tts?: VoiceHealth }>({});
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<{ stt: string; tts: string }>({ stt: '', tts: '' });
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState<string | null>(null);

  useEffect(() => {
    void window.geny.voice.config().then(setConfig);
  }, []);

  const patch = (next: VoiceConfig): void => {
    setConfig(next);
    void window.geny.voice.save(next).then(setConfig);
  };

  const setStt = (p: Partial<VoiceConfig['stt']>): void => {
    if (config) patch({ ...config, stt: { ...config.stt, ...p } });
  };
  const setTts = (p: Partial<VoiceConfig['tts']>): void => {
    if (config) patch({ ...config, tts: { ...config.tts, ...p } });
  };

  const check = (): void => {
    setBusy(true);
    void window.geny.voice
      .health()
      .then(setHealth)
      .finally(() => setBusy(false));
  };

  const loadVoices = (): void => {
    setVoicesError(null);
    void window.geny.voice
      .voices()
      .then(setVoices)
      .catch((err: unknown) => setVoicesError(err instanceof Error ? err.message : String(err)));
  };

  if (!config) return <section />;

  const selected = voices.find((v) => v.id === config.tts.voice);

  return (
    <section data-testid="voice-settings">
      <h2 className="mb-2 text-[10px] uppercase tracking-widest text-dim">음성</h2>
      <p className="mb-2 text-[11px] text-dim">
        이 앱은 음성을 직접 서빙하지 않습니다 — 설정한 서비스를 <b>호출</b>합니다.
        Geny 의 <code>geny-audio-services</code> 를 GPU 서버에 띄웠다면 주소만 적으면 됩니다.
      </p>

      {/* ── STT ─────────────────────────────────────────────── */}
      <div className="mb-3 rounded border border-line p-2">
        <div className="mb-1 flex items-center gap-2">
          <b>받아쓰기 (STT)</b>
          <Light health={health.stt} />
        </div>
        <div className="flex flex-col gap-1">
          <Field label="제공자">
            <select
              className={input}
              value={config.stt.provider}
              onChange={(e) => {
                const provider = e.target.value as SttProviderId;
                const preset = provider === 'openai' || provider === 'whisper' ? PRESETS.stt[provider] : null;
                setStt({ provider, ...(preset ?? {}) });
              }}
            >
              {STT_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </Field>
          <p className="pl-24 text-[11px] text-dim">
            {STT_PROVIDERS.find((p) => p.id === config.stt.provider)?.hint}
          </p>
          {config.stt.provider !== 'none' && (
            <>
              <Field label={config.stt.provider === 'custom' ? '전체 URL' : '주소'}>
                <input
                  className={input}
                  value={config.stt.baseUrl}
                  placeholder="http://gpu-box:8001"
                  onChange={(e) => setStt({ baseUrl: e.target.value })}
                />
              </Field>
              <Field label="모델">
                <input
                  className={input}
                  value={config.stt.model ?? ''}
                  placeholder="openai/whisper-large-v3"
                  onChange={(e) => setStt({ model: e.target.value })}
                />
              </Field>
              <Field label="언어">
                <input
                  className={input}
                  value={config.stt.language ?? ''}
                  placeholder="ko — 비우면 자동 감지"
                  onChange={(e) => setStt({ language: e.target.value })}
                />
              </Field>
              <Field label="API 키">
                <input
                  className={input}
                  type="password"
                  value={keyDrafts.stt}
                  placeholder={config.stt.hasKey ? '저장됨 — 바꾸려면 새로 입력' : '자체 호스팅이면 비워 두세요'}
                  onChange={(e) => setKeyDrafts((s) => ({ ...s, stt: e.target.value }))}
                  onBlur={() => {
                    if (!keyDrafts.stt) return;
                    void window.geny.voice.setKey('stt', keyDrafts.stt).then(setConfig);
                    setKeyDrafts((s) => ({ ...s, stt: '' }));
                  }}
                />
              </Field>
            </>
          )}
        </div>
      </div>

      {/* ── TTS ─────────────────────────────────────────────── */}
      <div className="mb-2 rounded border border-line p-2">
        <div className="mb-1 flex items-center gap-2">
          <b>말하기 (TTS)</b>
          <Light health={health.tts} />
        </div>
        <div className="flex flex-col gap-1">
          <Field label="제공자">
            <select
              className={input}
              value={config.tts.provider}
              onChange={(e) => {
                const provider = e.target.value as TtsProviderId;
                const preset = provider === 'openai' || provider === 'omnivoice' ? PRESETS.tts[provider] : null;
                setVoices([]);
                setTts({ provider, voice: undefined, emotion: undefined, ...(preset ?? {}) });
              }}
            >
              {TTS_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </Field>
          <p className="pl-24 text-[11px] text-dim">
            {TTS_PROVIDERS.find((p) => p.id === config.tts.provider)?.hint}
          </p>

          {config.tts.provider !== 'none' && config.tts.provider !== 'system' && (
            <>
              <Field label={config.tts.provider === 'custom' ? '전체 URL' : '주소'}>
                <input
                  className={input}
                  value={config.tts.baseUrl}
                  placeholder="http://gpu-box:9881"
                  onChange={(e) => setTts({ baseUrl: e.target.value })}
                />
              </Field>
              {config.tts.provider === 'openai' && (
                <Field label="모델">
                  <input
                    className={input}
                    value={config.tts.model ?? ''}
                    onChange={(e) => setTts({ model: e.target.value })}
                  />
                </Field>
              )}
              <Field label="목소리">
                <span className="flex flex-1 items-center gap-1">
                  <select
                    className={input}
                    value={config.tts.voice ?? ''}
                    onChange={(e) => setTts({ voice: e.target.value || undefined, emotion: undefined })}
                  >
                    <option value="">
                      {config.tts.provider === 'omnivoice' ? '지정 안 함 (매번 임의의 목소리)' : '기본'}
                    </option>
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rounded border border-line px-2 py-1 hover:bg-white/5"
                    onClick={loadVoices}
                  >
                    목록 가져오기
                  </button>
                </span>
              </Field>
              {selected?.emotions && selected.emotions.length > 0 && (
                <Field label="감정">
                  <select
                    className={input}
                    value={config.tts.emotion ?? ''}
                    onChange={(e) => setTts({ emotion: e.target.value || undefined })}
                  >
                    <option value="">첫 번째</option>
                    {selected.emotions.map((em) => (
                      <option key={em} value={em}>{em}</option>
                    ))}
                  </select>
                </Field>
              )}
              {voicesError && <p className="pl-24 text-[11px] text-red-300">{voicesError}</p>}
              {config.tts.provider === 'omnivoice' && !config.tts.voice && (
                <p className="pl-24 text-[11px] text-amber-300">
                  프로필을 고르지 않으면 omnivoice 는 <code>auto</code> 모드로 매번 다른 목소리를 냅니다.
                </p>
              )}
              <Field label="API 키">
                <input
                  className={input}
                  type="password"
                  value={keyDrafts.tts}
                  placeholder={config.tts.hasKey ? '저장됨 — 바꾸려면 새로 입력' : '자체 호스팅이면 비워 두세요'}
                  onChange={(e) => setKeyDrafts((s) => ({ ...s, tts: e.target.value }))}
                  onBlur={() => {
                    if (!keyDrafts.tts) return;
                    void window.geny.voice.setKey('tts', keyDrafts.tts).then(setConfig);
                    setKeyDrafts((s) => ({ ...s, tts: '' }));
                  }}
                />
              </Field>
            </>
          )}

          {config.tts.provider !== 'none' && (
            <label className="flex items-center gap-1 pl-24">
              <input
                type="checkbox"
                checked={config.tts.autoSpeak ?? false}
                onChange={(e) => setTts({ autoSpeak: e.target.checked })}
              />
              에이전트의 답변을 자동으로 읽어 주기
            </label>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          className="rounded border border-line px-2 py-1 hover:bg-white/5 disabled:opacity-40"
          onClick={check}
        >
          {busy ? '확인 중…' : '연결 확인'}
        </button>
        <button
          type="button"
          disabled={config.tts.provider === 'none'}
          className="rounded border border-line px-2 py-1 hover:bg-white/5 disabled:opacity-40"
          onClick={() => {
            setSample('말하는 중…');
            void window.geny.voice
              .speak('안녕하세요. 음성 연결이 정상입니다.')
              .then((r) => setSample(r.local ? 'OS 음성으로 재생했습니다' : '재생했습니다'))
              .catch((err: unknown) => setSample(err instanceof Error ? err.message : String(err)));
          }}
        >
          시험 삼아 말해 보기
        </button>
        {sample && <span className="text-dim">{sample}</span>}
      </div>
    </section>
  );
}

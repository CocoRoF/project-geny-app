/**
 * The voice layer is a CLIENT. What must be true is not "it compiles" but
 * "it sends what geny-audio-services actually expects" — so this test
 * stands up a stub that speaks the real contracts (omnivoice's schema,
 * vLLM's OpenAI-compatible transcription endpoint) and inspects the bytes
 * the app puts on the wire.
 *
 * The load-bearing assertion is the omnivoice voice profile: `mode`
 * defaults to `auto`, which is a DIFFERENT RANDOM VOICE every call, so a
 * chosen profile only works if the client resolves it into
 * mode=clone + ref_audio_path + ref_text.
 */
import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seen = [];
let health = { status: 'ok', model: 'k2-fsa/OmniVoice', device: 'cuda:0' };

/** 44-byte WAV header + a little silence — enough to be real audio bytes */
const wav = () => {
  const data = Buffer.alloc(1600);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(16000, 24); head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
};

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const record = { method: req.method, url: req.url, raw: raw.toString('latin1') };
    seen.push(record);
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };

    if (req.url === '/health') return send(200, JSON.stringify(health));
    if (req.url === '/voices') {
      return send(200, JSON.stringify({
        voices: [{
          id: 'paimon_ko',
          name: '파이몬',
          language: 'ko',
          ref_audios: [
            { emotion: 'neutral', file: '/voices/paimon_ko/ref_neutral.wav', prompt_text: '안녕' },
            { emotion: 'happy', file: '/voices/paimon_ko/ref_happy.wav', prompt_text: '반가워' },
          ],
        }],
      }));
    }
    if (req.url === '/tts') {
      try {
        record.body = JSON.parse(raw.toString('utf8'));
      } catch { /* recorded raw anyway */ }
      if (record.body?.text?.includes('BOOM')) {
        return send(500, JSON.stringify({ detail: '합성 실패: CUDA out of memory' }));
      }
      return send(200, wav(), 'audio/wav');
    }
    if (req.url === '/v1/audio/transcriptions') {
      return send(200, JSON.stringify({ text: '받아쓴 문장입니다' }));
    }
    send(404, JSON.stringify({ detail: 'not found' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const env = { ...process.env, GENY_DATA_ROOT: mkdtempSync(join(tmpdir(), 'geny-voice-')) };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', '--no-sandbox'], env });
const main = await app.firstWindow();
await main.waitForLoadState('domcontentloaded');

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const lastTo = (url) => [...seen].reverse().find((r) => r.url === url);

// ── configure both sides at the stub ───────────────────────────────────
await main.evaluate(async (baseUrl) => {
  const config = await window.geny.voice.config();
  await window.geny.voice.save({
    stt: { ...config.stt, provider: 'whisper', baseUrl, model: 'openai/whisper-large-v3' },
    tts: { ...config.tts, provider: 'omnivoice', baseUrl, format: 'wav', numStep: 24 },
  });
}, base);
check('config persists', (await main.evaluate(() => window.geny.voice.config())).tts.provider === 'omnivoice');

// ── health, including the loading trap ─────────────────────────────────
let h = await main.evaluate(() => window.geny.voice.health());
check('health probes both endpoints', h.stt.ok && h.tts.ok, `${h.tts.latencyMs}ms`);

health = { status: 'loading', model: 'k2-fsa/OmniVoice' };
h = await main.evaluate(() => window.geny.voice.health());
check(
  'a service still loading its model is NOT reported healthy',
  h.tts.ok === false && /loading/.test(h.tts.error ?? ''),
  h.tts.error ?? '',
);
health = { status: 'ok', model: 'k2-fsa/OmniVoice' };

// ── voices ─────────────────────────────────────────────────────────────
const voices = await main.evaluate(() => window.geny.voice.voices());
check('voice profiles listed', voices.length === 1 && voices[0].id === 'paimon_ko');
check('per-profile emotions surfaced', (voices[0]?.emotions ?? []).join(',') === 'neutral,happy');

// ── the real assertion: an unselected profile means a random voice ─────
await main.evaluate(() => window.geny.voice.speak('목소리 미지정'));
check(
  'no profile selected → mode auto (honest, not silently wrong)',
  lastTo('/tts')?.body?.mode === 'auto',
  lastTo('/tts')?.body?.mode,
);

await main.evaluate(async (baseUrl) => {
  const config = await window.geny.voice.config();
  await window.geny.voice.save({
    ...config,
    tts: { ...config.tts, baseUrl, voice: 'paimon_ko', emotion: 'happy' },
  });
}, base);
await main.evaluate(() => window.geny.voice.speak('안녕하세요'));
const tts = lastTo('/tts')?.body ?? {};
check('selected profile switches the request to clone mode', tts.mode === 'clone', tts.mode);
check(
  'the chosen emotion resolves to its reference clip',
  tts.ref_audio_path === '/voices/paimon_ko/ref_happy.wav',
  tts.ref_audio_path,
);
check('the clip transcript is sent with it', tts.ref_text === '반가워', tts.ref_text);
check('quality dial and format are honoured', tts.num_step === 24 && tts.audio_format === 'wav');

// ── the profile lookup must not cost a round trip per sentence ─────────
const before = seen.filter((r) => r.url === '/voices').length;
await main.evaluate(async () => {
  for (const line of ['한 문장', '두 문장', '세 문장']) await window.geny.voice.speak(line);
});
const added = seen.filter((r) => r.url === '/voices').length - before;
check(
  'repeated speech reuses the profile list instead of refetching it',
  added === 0,
  `${added} extra /voices calls for 3 utterances`,
);
check('...and all three were still synthesized', seen.filter((r) => r.url === '/tts').length >= 4);

// ── audio actually reaches a window ────────────────────────────────────
await main.evaluate(() => {
  window.__spoken = [];
  window.geny.voice.onAudio((a) => window.__spoken.push(a));
});
await main.evaluate(() => window.geny.voice.speak('재생 확인'));
await main.waitForTimeout(400);
const spoken = await main.evaluate(() => window.__spoken);
check(
  'synthesized audio is handed to a surface to play',
  spoken.length === 1 && spoken[0].mime.includes('audio/wav') && spoken[0].base64.length > 100,
  `${spoken[0]?.base64?.length ?? 0} b64 chars`,
);

// ── errors say what the service said ───────────────────────────────────
const failure = await main.evaluate(() =>
  window.geny.voice.speak('BOOM').then(() => null, (e) => String(e)),
);
check('the service\'s own error text survives', /CUDA out of memory/.test(failure ?? ''), failure ?? '');

// ── STT: vLLM requires `model` even with one model loaded ──────────────
const heard = await main.evaluate(() =>
  window.geny.voice.transcribe({ base64: btoa('fake audio bytes'), mime: 'audio/webm' }),
);
check('transcription returns the text', heard.text === '받아쓴 문장입니다');
const stt = lastTo('/v1/audio/transcriptions')?.raw ?? '';
check('multipart carries the required model field', stt.includes('name="model"') && stt.includes('openai/whisper-large-v3'));
check('multipart carries the audio as a file part', /name="file"/.test(stt) && stt.includes('fake audio bytes'));

// ── the agent-facing tools ─────────────────────────────────────────────
const said = await app.evaluate(({}, _) => globalThis.__genyHostTool('Speak', { text: '도구로 말하기' }, 'x'));
check('the Speak tool speaks', said?.spoken === true);
check('...and it went to the configured service', lastTo('/tts')?.body?.text === '도구로 말하기');

// ── turning it off must actually turn it off ───────────────────────────
await main.evaluate(async () => {
  const config = await window.geny.voice.config();
  await window.geny.voice.save({ ...config, tts: { ...config.tts, provider: 'none' } });
});
const refused = await app.evaluate(() => globalThis.__genyHostTool('Speak', { text: 'x' }, 'x'));
check('with no provider the tool refuses clearly instead of failing deep', refused?.spoken === false, refused?.reason);

await app.close();
server.close();
const ok = results.every(Boolean);
console.log(`\nvoice: ${ok ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(ok ? 0 : 1);

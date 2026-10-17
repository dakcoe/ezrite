'use strict';

// 맥 RateLimitTests, TranslationInputTests(ProviderTests.swift) 이식 + Groq 호출부 시험 (가짜 fetch)
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GroqClient, GroqError, RateLimitedError, translationInput, parseTranslation,
} = require('../lib/groq');

const KEY = 'gsk_SECRET_test_key_1234567890';

/** 응답을 차례로 돌려주는 가짜 fetch. 함수를 넣으면 그 함수가 응답을 만든다 */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r === undefined) throw new Error('예상보다 많이 불림');
    if (typeof r === 'function') return r(url, init);
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (body, status, headers = {}) => new Response(body, { status, headers });

function client(responses, opts = {}) {
  const fetch = fakeFetch(responses);
  const sleeps = [];
  let t = opts.start ?? 1_000_000;
  const c = new GroqClient({
    fetch,
    getKey: () => (opts.noKey ? null : KEY),
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => t,
    ...opts.extra,
  });
  return { c, fetch, sleeps, advance: (ms) => { t += ms; } };
}

/** multipart 본문에서 칸 이름 → 값 */
function fields(body) {
  const s = Buffer.from(body).toString('latin1');
  const out = {};
  const re = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="[^"]+")?\r\n(?:Content-Type: [^\r]+\r\n)?\r\n([\s\S]*?)\r\n--/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2];
  return out;
}

const WAV = Buffer.from('RIFFfakewav');
const segs = (list) => json({ text: '', duration: 6.5, segments: list });

// --- 맥 시험 이식 ---

test('[mac RateLimitTests] 기다릴_시간을_초나_분으로_알린다', () => {
  assert.equal(new RateLimitedError(23).message, 'Groq 무료 한도에 걸렸습니다. 23초 뒤 다시 눌러 주세요.');
  assert.equal(new RateLimitedError(7.2).message, 'Groq 무료 한도에 걸렸습니다. 8초 뒤 다시 눌러 주세요.');
  assert.equal(new RateLimitedError(125).message, 'Groq 무료 한도에 걸렸습니다. 3분 뒤 다시 눌러 주세요.');
  assert.equal(new RateLimitedError(null).message, 'Groq 무료 한도에 걸렸습니다. 잠시 뒤 다시 눌러 주세요.');
});

test('[mac TranslationInputTests] 앞줄은_번호_없이_참고로_주고_옮길_줄만_번호를_붙인다', () => {
  const t = translationInput(['one at a time.', 'First, we look at all the tumors.'],
    ['the algorithm is going to look at the classes']);
  assert.ok(t.includes('the algorithm is going to look at the classes'));
  assert.ok(!t.includes('1. the algorithm'));
  assert.ok(t.includes('1. one at a time.'));
  assert.ok(t.includes('2. First, we look at all the tumors.'));
});

test('[mac TranslationInputTests] 앞줄이_없으면_옮길_줄만_보낸다', () => {
  assert.equal(translationInput(['Hello.'], []), '1. Hello.');
});

// --- 상수 ---

test('엔드포인트·모델 이름·재시도 횟수는 맥과 같다', () => {
  assert.deepEqual(GroqClient.WHISPER_MODELS, ['whisper-large-v3', 'whisper-large-v3-turbo']);
  assert.deepEqual(GroqClient.CHAT_MODELS, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  assert.equal(GroqClient.TRANSCRIBE_URL, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(GroqClient.CHAT_URL, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(GroqClient.RETRIES, 3);
  assert.equal(GroqClient.VISION_MODEL, 'qwen/qwen3.8-27b');
  assert.equal(GroqClient.REASONING_MODEL, 'openai/gpt-oss-120b');
  assert.ok(GroqClient.TRANSLATE_PROMPT.startsWith('Translate numbered lecture transcript lines into natural Korean.'));
});

test('translationInput: 앞줄 여러 개는 한 칸 띄어 잇는다', () => {
  assert.equal(translationInput(['x'], ['a', 'b']), 'Previous (do not translate): a b\n1. x');
});

// --- parseTranslation ---

test('parseTranslation: 번호로 자리를 찾고, 못 찾은 줄은 null', () => {
  assert.deepEqual(parseTranslation('1. 하나\n3. 셋\n', 3), ['하나', null, '셋']);
});

test('parseTranslation: 범위 밖 번호·빈 번역·번호 없는 줄은 무시, 앞뒤 공백은 자른다', () => {
  const out = '  2.   둘  \n0. 영\n4. 넷\n1.\n잡담\nx. 엑스\n1. 하나';
  assert.deepEqual(parseTranslation(out, 3), ['하나', '둘', null]);
});

test('parseTranslation: CRLF 응답도 줄로 나눈다', () => {
  assert.deepEqual(parseTranslation('1. a\r\n2. b\r\n', 2), ['a', 'b']);
});

test('parseTranslation: 같은 번호가 두 번이면 뒤의 것, 번역 안의 마침표는 그대로', () => {
  assert.deepEqual(parseTranslation('1. 첫\n1. 둘째. 끝.', 1), ['둘째. 끝.']);
  assert.deepEqual(parseTranslation('', 2), [null, null]);
});

// --- 받아쓰기 요청 ---

test('받아쓰기 요청: 주소, 헤더, multipart 칸이 맥과 같다', async () => {
  const { c, fetch } = client([segs([{ text: ' 안녕하세요', start: 0, end: 1, no_speech_prob: 0.01 }])]);
  const out = await c.transcribe(WAV, { language: 'ko', prompt: '' });
  assert.equal(out, '안녕하세요');

  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  const boundary = init.headers['Content-Type'].match(/^multipart\/form-data; boundary=(ezrite-[0-9a-f-]{36})$/)[1];
  const body = Buffer.from(init.body).toString('latin1');
  assert.ok(body.endsWith(`\r\n--${boundary}--\r\n`));
  assert.ok(body.includes('name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFFfakewav\r\n'));
  const f = fields(init.body);
  assert.equal(f.model, 'whisper-large-v3');
  assert.equal(f.response_format, 'verbose_json');
  assert.equal(f.temperature, '0');
  assert.equal(f.language, 'ko');
  assert.equal('prompt' in f, false); // 빈 문맥은 보내지 않는다
  assert.ok(init.signal instanceof AbortSignal); // 60초 시간 제한
});

test('받아쓰기 요청: 직전 문맥은 끝 400글자만 prompt 로 보낸다', async () => {
  const { c, fetch } = client([segs([])]);
  const prompt = '가'.repeat(100) + '나'.repeat(400);
  await c.transcribe(WAV, { language: 'en', prompt });
  const f = fields(fetch.calls[0].init.body);
  assert.equal(Buffer.from(f.prompt, 'latin1').toString('utf8'), '나'.repeat(400));
  assert.equal(f.language, 'en');
});

test('받아쓰기 결과: 할루시네이션 구간을 거르고 한 칸 띄어 잇는다', async () => {
  const { c } = client([segs([
    { text: ' 그래서 답은 40입니다', start: 0, end: 2, no_speech_prob: 0.01 },
    { text: ' 시청해주셔서 감사합니다.', start: 2, end: 3, no_speech_prob: 0.2 },
    { text: ' 다음 장면', start: 3, end: 4, no_speech_prob: 0.9 },
    { text: ' 끝', start: 4, end: 5, no_speech_prob: 0.1 },
  ])]);
  assert.equal(await c.transcribe(WAV, { language: 'ko', prompt: '' }), '그래서 답은 40입니다 끝');
});

test('segments: 구간별 글·시각·말소리 없음 확률, 숫자가 아니면 0', async () => {
  const { c } = client([segs([{ text: 'a', start: 1.5, end: '2', no_speech_prob: 0.3 }, { start: 3 }])]);
  const s = await c.segments(WAV, { language: 'ko', prompt: '' });
  assert.deepEqual(s, [
    { text: 'a', start: 1.5, end: 0, noSpeech: 0.3 },
    { text: '', start: 3, end: 0, noSpeech: 0 },
  ]);
});

test('segments 가 없으면 text 하나를 구간으로, 비었으면 빈 목록', async () => {
  const { c } = client([json({ text: '  통째 글 \n' }), json({ text: '   ' }), text('not json', 200)]);
  assert.deepEqual(await c.segments(WAV, { language: 'ko', prompt: '' }),
    [{ text: '통째 글', start: 0, end: 0, noSpeech: 0 }]);
  assert.deepEqual(await c.segments(WAV, { language: 'ko', prompt: '' }), []);
  assert.deepEqual(await c.segments(WAV, { language: 'ko', prompt: '' }), []);
});

test('남은 횟수 헤더와 음성 길이를 알린다', async () => {
  const usage = [];
  const spent = [];
  const { c } = client([json({ duration: 6.5, segments: [] }, 200, {
    'x-ratelimit-limit-requests': '2000', 'x-ratelimit-remaining-requests': '1974',
  })], { extra: { onUsage: (m, u) => usage.push([m, u]), onSpent: (m, k, a) => spent.push([m, k, a]) } });
  await c.transcribe(WAV, { language: 'ko', prompt: '' });
  assert.deepEqual(usage, [['whisper-large-v3', { remaining: 1974, limit: 2000 }]]);
  assert.deepEqual(spent, [['whisper-large-v3', 'audio', 6.5]]);
});

test('키가 없으면 보내지 않고 안내 문구로 실패', async () => {
  const { c, fetch } = client([], { noKey: true });
  await assert.rejects(c.transcribe(WAV, { language: 'ko', prompt: '' }),
    { name: 'GroqError', message: 'Groq API 키가 없습니다. 설정에서 키를 입력하세요.' });
  await assert.rejects(c.translate(['a']), { message: 'Groq API 키가 없습니다. 설정에서 키를 입력하세요.' });
  assert.equal(fetch.calls.length, 0);
});

test('401 은 다시 보내지 않고 키 오류로 실패', async () => {
  const { c, fetch } = client([json({ error: { message: 'Invalid API Key' } }, 401)]);
  await assert.rejects(c.transcribe(WAV, { language: 'ko', prompt: '' }),
    { message: 'API 키가 올바르지 않습니다. 설정에서 다시 확인하세요.' });
  assert.equal(fetch.calls.length, 1);
});

test('5xx 는 1.5초·3초 쉬고 3번까지 보낸 뒤 실패 (HTML 본문은 보이지 않는다)', async () => {
  const html = '<html>cloudflare</html>';
  const { c, fetch, sleeps } = client([text(html, 520), text(html, 502), text(html, 525)]);
  await assert.rejects(c.transcribe(WAV, { language: 'ko', prompt: '' }),
    { message: 'Groq 서버 일시 장애 (525) — 3번 다시 보냈지만 실패' });
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [1500, 3000]);
});

test('네트워크 오류는 같은 음성으로 다시 보내 성공하면 그 결과', async () => {
  const { c, fetch, sleeps } = client([new TypeError('fetch failed'), segs([{ text: '됐다', no_speech_prob: 0 }])]);
  assert.equal(await c.transcribe(WAV, { language: 'ko', prompt: '' }), '됐다');
  assert.equal(fetch.calls.length, 2);
  assert.deepEqual(sleeps, [1500]);
  // 같은 음성을 다시 보낸다
  assert.ok(Buffer.from(fetch.calls[1].init.body).includes(WAV));
});

test('네트워크 오류만 계속되면 마지막 오류 + 3번 문구', async () => {
  const e = () => new TypeError('fetch failed');
  const { c } = client([e(), e(), e()]);
  await assert.rejects(c.transcribe(WAV, { language: 'ko', prompt: '' }),
    { message: '네트워크 오류: fetch failed — 3번 다시 보냈지만 실패' });
});

test('응답 본문을 읽다 끊겨도 네트워크 오류로 다시 보낸다', async () => {
  const broken = { status: 200, headers: new Headers(), arrayBuffer: async () => { throw new Error('reset'); } };
  const { c, fetch } = client([broken, segs([{ text: '됐다', no_speech_prob: 0 }])]);
  assert.equal(await c.transcribe(WAV, { language: 'ko', prompt: '' }), '됐다');
  assert.equal(fetch.calls.length, 2);
});

test('429 면 다음 모델로 넘기고 알린다. 막힌 모델은 retry-after 동안 건너뛴다', async () => {
  const fallbacks = [];
  const { c, fetch, advance } = client([
    json({}, 429, { 'retry-after': '45' }),
    segs([{ text: '터보', no_speech_prob: 0 }]),
    segs([{ text: '또 터보', no_speech_prob: 0 }]),
    segs([{ text: '다시 large', no_speech_prob: 0 }]),
  ]);
  const onFallback = (a, b) => fallbacks.push([a, b]);
  assert.equal(await c.transcribe(WAV, { language: 'ko', prompt: '', onFallback }), '터보');
  assert.deepEqual(fallbacks, [['whisper-large-v3', 'whisper-large-v3-turbo']]);
  assert.equal(fields(fetch.calls[1].init.body).model, 'whisper-large-v3-turbo');

  advance(44_000);
  assert.equal(await c.transcribe(WAV, { language: 'ko', prompt: '' }), '또 터보');
  assert.equal(fields(fetch.calls[2].init.body).model, 'whisper-large-v3-turbo');

  advance(1_000); // 45초 지남
  assert.equal(await c.transcribe(WAV, { language: 'ko', prompt: '' }), '다시 large');
  assert.equal(fields(fetch.calls[3].init.body).model, 'whisper-large-v3');
});

test('쉬는 시간은 최소 30초, 최대 600초. retry-after 가 숫자가 아니면 30초', async () => {
  const { c, fetch, advance } = client([
    json({}, 429, { 'retry-after': '3' }), json({}, 429, { 'retry-after': 'abc' }),
    segs([]), // 29초 뒤: 둘 다 쉬는 중이라 large-v3 하나만
  ]);
  await assert.rejects(c.transcribe(WAV, { language: 'ko', prompt: '' }),
    { message: "'whisper-large-v3-turbo' 한도를 초과했고 대체할 모델도 없습니다. 잠시 후 다시 시도하세요." });
  advance(29_000);
  await c.transcribe(WAV, { language: 'ko', prompt: '' });
  assert.equal(fields(fetch.calls[2].init.body).model, 'whisper-large-v3');

  const big = client([json({}, 429, { 'retry-after': '5000' }), segs([]), segs([])]);
  await big.c.transcribe(WAV, { language: 'ko', prompt: '' });
  big.advance(599_000);
  await big.c.transcribe(WAV, { language: 'ko', prompt: '' });
  assert.equal(fields(big.fetch.calls[2].init.body).model, 'whisper-large-v3-turbo');
});

test('둘 다 쉬는 중이면 large-v3 로 한 번 보내 보고, 또 막히면 그 모델 이름으로 실패', async () => {
  const { c } = client([json({}, 429), json({}, 429), json({}, 429)]);
  await assert.rejects(c.transcribe(WAV, { language: 'ko', prompt: '' }));
  await assert.rejects(c.transcribe(WAV, { language: 'ko', prompt: '' }),
    { message: "'whisper-large-v3' 한도를 초과했고 대체할 모델도 없습니다. 잠시 후 다시 시도하세요." });
});

test('그 밖의 오류: error.message, 없으면 본문 앞 200바이트', async () => {
  const { c } = client([
    json({ error: { message: 'file too large' } }, 413),
    text('x'.repeat(300), 400),
  ]);
  await assert.rejects(c.transcribe(WAV, { language: 'ko', prompt: '' }), { message: 'Groq 오류 413: file too large' });
  await assert.rejects(c.transcribe(WAV, { language: 'ko', prompt: '' }), { message: `Groq 오류 400: ${'x'.repeat(200)}` });
});

test('API 키는 어떤 오류 메시지에도 들어가지 않는다', async () => {
  const leak = `bad header Bearer ${KEY}`;
  const { c } = client([
    new Error(leak), new Error(leak), new Error(leak),
    text(`echo ${KEY}`, 400),
    json({ error: { message: `key ${KEY} invalid` } }, 403),
  ]);
  for (let i = 0; i < 3; i++) {
    const err = await c.transcribe(WAV, { language: 'ko', prompt: '' }).catch((e) => e);
    assert.ok(err instanceof GroqError);
    assert.ok(!err.message.includes(KEY), err.message);
    assert.ok(!String(err.stack).includes(KEY));
    if (i === 0) assert.ok(err.message.includes('***'));
  }
});

// --- 번역 ---

test('번역 요청: 120b, system 프롬프트, temperature 0.2, reasoning low. 결과는 번호로 맞춘다', async () => {
  const spent = [];
  const { c, fetch } = client([json({
    choices: [{ message: { content: '1. 한 번에 하나씩.\n2. 먼저 종양을 봅니다.' } }],
    usage: { total_tokens: 321 },
  })], { extra: { onSpent: (m, k, a) => spent.push([m, k, a]) } });
  const out = await c.translate(['one at a time.', 'First, the tumors.'], ['prev line']);
  assert.deepEqual(out, ['한 번에 하나씩.', '먼저 종양을 봅니다.']);

  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.reasoning_effort, 'low');
  assert.deepEqual(body.messages, [
    { role: 'system', content: GroqClient.TRANSLATE_PROMPT },
    { role: 'user', content: translationInput(['one at a time.', 'First, the tumors.'], ['prev line']) },
  ]);
  assert.deepEqual(spent, [['openai/gpt-oss-120b', 'tokens', 321]]);
  assert.equal(c.lastTokens, 321);
});

test('번역: 120b 가 429 면 쉬지 않고 20b 로', async () => {
  const { c, fetch, sleeps } = client([
    json({}, 429),
    json({ choices: [{ message: { content: '1. 됨' } }] }),
  ]);
  assert.deepEqual(await c.translate(['ok']), ['됨']);
  assert.equal(JSON.parse(fetch.calls[1].init.body).model, 'openai/gpt-oss-20b');
  assert.deepEqual(sleeps, []);
});

test('번역: 둘 다 429 면 "번역 한도 초과"', async () => {
  const { c } = client([json({}, 429), json({}, 429)]);
  await assert.rejects(c.translate(['a']), { message: '번역 한도 초과' });
});

test('번역: 5xx 는 모델마다 3번씩 보내고, 다 실패하면 마지막 오류', async () => {
  const r = () => text('x', 503);
  const { c, fetch, sleeps } = client([r(), r(), r(), r(), r(), r()]);
  await assert.rejects(c.translate(['a']), { message: '번역: Groq 서버 일시 장애 (503)' });
  assert.equal(fetch.calls.length, 6);
  assert.deepEqual(sleeps, [1500, 3000, 1500, 3000]);
});

test('번역: 401 은 바로 실패', async () => {
  const { c, fetch } = client([json({}, 401)]);
  await assert.rejects(c.translate(['a']), { message: 'API 키가 올바르지 않습니다. 설정에서 다시 확인하세요.' });
  assert.equal(fetch.calls.length, 1);
});

test('chat: content 가 없으면 빈 글, 남은 횟수 헤더를 알린다', async () => {
  const usage = [];
  const { c } = client([json({ choices: [] }, 200, {
    'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '10',
  })], { extra: { onUsage: (m, u) => usage.push([m, u]) } });
  assert.equal(await c.chat({ model: 'm', messages: [] }, KEY), '');
  assert.deepEqual(usage, [['m', { remaining: 10, limit: 1000 }]]);
});

test('chat: 429 는 RateLimitedError(retryAfter) 로 던진다', async () => {
  const { c } = client([json({}, 429, { 'retry-after': '12' })]);
  const e = await c.chat({ model: 'm' }, KEY).catch((x) => x);
  assert.ok(e instanceof RateLimitedError);
  assert.equal(e.retryAfter, 12);
});

test('chat: JSON 을 시켰는데 거절된 원문(failed_generation)은 lenientJSON 이 있으면 고쳐 쓴다', async () => {
  const err = { error: { message: 'json_validate_failed', failed_generation: '{"a":"\\x"}' } };
  const fixed = client([json(err, 400)], { extra: { lenientJSON: (raw) => (raw.includes('a') ? '{"a":"x"}' : null) } });
  assert.equal(await fixed.c.chat({ model: 'm', response_format: { type: 'json_object' } }, KEY), '{"a":"x"}');

  const none = client([json(err, 400)]);
  await assert.rejects(none.c.chat({ model: 'm', response_format: { type: 'json_object' } }, KEY),
    { message: 'Groq 오류 400: json_validate_failed' });

  const noFormat = client([json(err, 400)], { extra: { lenientJSON: () => '{}' } });
  await assert.rejects(noFormat.c.chat({ model: 'm' }, KEY), { message: 'Groq 오류 400: json_validate_failed' });
});

test('probeLimits: 채팅 3모델(1토큰)과 whisper 2모델(0.3초 무음)에 한 번씩, 실패는 무시', async () => {
  const { c, fetch } = client([json({}, 500), json({}), json({}), segs([]), new Error('x')]);
  await c.probeLimits();
  assert.equal(fetch.calls.length, 5);
  const chat = fetch.calls.slice(0, 3).map((x) => JSON.parse(x.init.body));
  assert.deepEqual(chat.map((b) => b.model), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
  assert.ok(chat.every((b) => b.max_tokens === 1));
  const wav = fields(fetch.calls[3].init.body);
  assert.equal(wav.model, 'whisper-large-v3');
  assert.equal(fields(fetch.calls[4].init.body).model, 'whisper-large-v3-turbo');
  // 4800 샘플 = 9600 바이트 + 헤더 44
  assert.ok(Buffer.from(fetch.calls[3].init.body).toString('latin1').includes('RIFF'));
});

test('probeLimits: 키가 없으면 아무것도 보내지 않는다', async () => {
  const { c, fetch } = client([], { noKey: true });
  await c.probeLimits();
  assert.equal(fetch.calls.length, 0);
});

test('생성자: fetch 를 주지 않으면 전역 fetch, getKey 는 필수', () => {
  assert.throws(() => new GroqClient({}), TypeError);
  assert.ok(new GroqClient({ getKey: () => null }));
});

// --- 번역 한 줄 밀림 (e2e 07: 앞줄이 문장 중간에서 끊기면 모델이 앞줄까지 "1." 로 옮겨 번호가 하나씩 밀렸다) ---

test('parseTranslation: 앞줄을 1번으로 옮겨 번호가 하나 밀린 응답(옮길 줄 수 + 1)은 첫 줄을 버리고 당긴다', () => {
  const raw = '1. 이 조건을 만족하는 모든 할당은 A선 위에 위치하며, 우리는 이를 계약곡선이라고 부릅니다. 따라서 계약곡선상의 모든 점은  \n'
    + '2. 파레토 효율적입니다. 효율성은 공정성에 대해 아무것도 말하지 않으며, 한 사람이 거의 모든 것을 소유하고 있는 경우에도 효율적일 수 있습니다.';
  assert.deepEqual(parseTranslation(raw, 1, { context: true }), ['파레토 효율적입니다. 효율성은 공정성에 대해 아무것도 말하지 않으며, 한 사람이 거의 모든 것을 소유하고 있는 경우에도 효율적일 수 있습니다.']);
  assert.deepEqual(parseTranslation('1. 앞\n2. 가\n3. 나', 2, { context: true }), ['가', '나']);
});

test('parseTranslation: 앞줄이 없거나 번호가 맞으면 그대로 (하나 많아도 앞줄이 없으면 당기지 않는다)', () => {
  assert.deepEqual(parseTranslation('1. 가\n2. 나', 2, { context: true }), ['가', '나']);
  assert.deepEqual(parseTranslation('1. 가\n2. 나', 1), ['가']);
  assert.deepEqual(parseTranslation('1. 가\n3. 다', 2, { context: true }), ['가', null]); // 빠진 번호가 있으면 밀림으로 보지 않는다
});

test('번역 요청: 앞줄이 있으면 밀린 응답도 제자리로 (GroqClient.translate)', async () => {
  const fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '1. 앞줄 번역\n2. 이 줄 번역' } }] }), { status: 200 });
  const g = new GroqClient({ fetch, getKey: () => 'k', sleep: async () => {} });
  assert.deepEqual(await g.translate(['this line'], ['previous line ends mid sentence is']), ['이 줄 번역']);
});

test('번역 프롬프트: 앞줄(Previous)은 옮기지 말고 1번은 첫 번호 줄이라고 못 박는다', () => {
  assert.ok(GroqClient.TRANSLATE_PROMPT.includes('never output it'));
});

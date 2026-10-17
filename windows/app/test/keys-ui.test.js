'use strict';
// 실제 앱 화면에서 키 칸을 눌러 넣고 저장해 본다 (scripts/check-keys.js, 창은 띄우지 않는다).
// 1.1.2 "키 입력이 안 된다" 의 재발 방지: 입력칸·버튼이 창 끌기 영역에 먹히지 않고, 세 곳 모두 저장된다
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electron = (() => { try { return require('electron'); } catch { return null; } })();

test('모든 화면의 입력칸·버튼·링크는 창 끌기(drag) 영역 밖이고, 세 곳에서 Groq 키·설정에서 Claude 키가 저장된다', { skip: !electron, timeout: 120_000 }, () => {
  const r = spawnSync(electron, [path.join(__dirname, '..', 'scripts', 'check-keys.js')], { encoding: 'utf8', timeout: 110_000 });
  const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('{'));
  assert.ok(line, `결과 없음: ${r.stderr}`);
  const out = JSON.parse(line);
  assert.equal(out.error, undefined, out.error);
  assert.deepEqual(out.dragged, [], '끌기 영역에 먹히는 요소');
  for (const where of ['onboarding', 'settings', 'banner', 'claude']) {
    const k = out.keys[where];
    assert.deepEqual({ disabled: k.disabled, focused: k.focused, saveEnabled: k.saveEnabled, saved: k.saved, fieldCleared: k.fieldCleared },
      { disabled: false, focused: true, saveEnabled: true, saved: true, fieldCleared: true }, where);
  }
  assert.equal(out.keys.bannerOpenedSettings, true, '"키 넣기" 가 설정의 키 칸을 연다');
  // 맥처럼 저장하자마자 확인: 모델 목록 → 용도별로 실제 답하는 모델
  assert.match(out.keys.claude.status, /연결됨 · 화면 설명 claude-sonnet-5-5 · 번역 claude-haiku-5-5/);
  assert.deepEqual(out.keys.claude.featureProviders, ['groq', 'claude'], '키를 넣은 서비스만 고를 수 있다');
  assert.ok(out.sent.includes('GET https://api.anthropic.com/v1/models'));
  assert.ok(out.sent.includes('GET https://api.groq.com/openai/v1/models'), 'Groq 키도 저장할 때 목록으로 확인한다');
  for (const list of Object.values(out.regions)) assert.ok(list.length > 0);
  assert.equal(out.ok, true);
});

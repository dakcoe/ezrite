'use strict';

// 메인 프로세스의 처리 안 된 예외를 기본 오류 대화상자 대신 로그 파일로 보낸다.
// Electron 은 process.on('uncaughtException') 가 있으면 "A JavaScript error occurred in the main process" 창을 띄우지 않는다.
// 로그에 API 키가 섞여 들어가지 않게 키 모양 글자는 가린다.

const fs = require('fs');
const path = require('path');

const KEY_PATTERN = /\b(gsk_|sk-ant-|sk-proj-|sk-|AIza)[A-Za-z0-9_-]{8,}/g;

function redact(text) {
  return String(text).replace(KEY_PATTERN, (m, prefix) => `${prefix}***`);
}

/** 로그 한 덩어리: 시각, 종류, 메시지와 스택 */
function formatEntry(kind, err, now = new Date()) {
  const body = err instanceof Error ? (err.stack || `${err.name}: ${err.message}`) : String(err);
  return `[${now.toISOString()}] ${kind}\n${redact(body)}\n\n`;
}

/**
 * process 에 처리기를 단다. logDir 에 main.log 로 쓰고, onError(짧은 메시지) 를 부른다.
 * onError 가 다시 던져도 대화상자가 뜨지 않게 감싼다. 돌려준 함수로 처리기를 뗀다 (시험용).
 */
function install({ logDir, onError = () => {}, proc = process, now = () => new Date() } = {}) {
  const write = (kind, err) => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'main.log'), formatEntry(kind, err, now()));
    } catch {
      // 로그를 못 써도 앱은 계속 간다
    }
    try {
      const msg = err instanceof Error ? err.message : String(err);
      onError(redact(msg));
    } catch {
      // 알림이 실패해도 대화상자는 띄우지 않는다
    }
  };
  const onException = (err) => write('uncaughtException', err);
  const onRejection = (reason) => write('unhandledRejection', reason);
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.removeListener('uncaughtException', onException);
    proc.removeListener('unhandledRejection', onRejection);
  };
}

module.exports = { install, formatEntry, redact };

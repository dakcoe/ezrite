'use strict';

// 스크린샷 PNG 는 불투명해야 한다: Mica 창을 capturePage 로 찍으면 바탕이 투명하게 들어가 가이드 그림이 회색·검게 보였다
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { readPNG, flattenBGRA } = require('../lib/png');

/** 시험용 PNG 만들기 (필터 0, 8비트) */
function makePNG(width, height, colorType, rows) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (~c) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG 읽기: 색 형식과 가장 투명한 점의 알파', () => {
  const rgb = readPNG(makePNG(2, 1, 2, [[1, 2, 3, 4, 5, 6]]));
  assert.deepEqual([rgb.width, rgb.height, rgb.colorType, rgb.minAlpha], [2, 1, 2, 255]);
  const rgba = readPNG(makePNG(2, 1, 6, [[1, 2, 3, 255, 4, 5, 6, 10]]));
  assert.equal(rgba.minAlpha, 10);
});

test('BGRA 를 바탕색 위에 얹어 불투명하게 (반투명한 점은 바탕과 섞는다)', () => {
  const px = Buffer.from([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 200, 128]); // 투명, 흰색, 반투명 빨강(BGRA)
  const out = flattenBGRA(px, { r: 238, g: 240, b: 242 });
  assert.deepEqual([...out], [242, 240, 238, 255, 255, 255, 255, 255, 121, 120, 219, 255]);
});

test('사용 가이드·디자인 스크린샷 그림은 모두 불투명하다', () => {
  const dirs = [path.join(__dirname, '..', 'renderer', 'guide', 'shots'), path.join(__dirname, '..', '..', 'design', 'win')];
  // design/ 은 공개 소스(windows/)에 없다. 사용 가이드 그림은 늘 있다
  const files = dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.png')).map((f) => path.join(d, f)) : []));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const p = readPNG(fs.readFileSync(f));
    assert.equal(p.minAlpha, 255, path.relative(path.join(__dirname, '..', '..'), f));
  }
});

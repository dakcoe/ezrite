'use strict';

// 스크린샷을 불투명하게 저장하기 위한 작은 도구.
// Mica·Acrylic 창은 바탕이 투명이라 capturePage 결과에 알파가 들어온다 → 바탕색 위에 얹어 불투명하게 저장한다.
// readPNG 는 시험용: 8비트 RGB/RGBA/회색, 겹침(interlace) 없는 PNG 의 크기·색 형식·가장 작은 알파를 읽는다.

const zlib = require('node:zlib');

/** BGRA 점들을 바탕색(r,g,b) 위에 얹어 알파 255 로 */
function flattenBGRA(data, { r, g, b }) {
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3] / 255;
    out[i] = Math.round(out[i] * a + b * (1 - a));
    out[i + 1] = Math.round(out[i + 1] * a + g * (1 - a));
    out[i + 2] = Math.round(out[i + 2] * a + r * (1 - a));
    out[i + 3] = 255;
  }
  return out;
}

/** "#eef0f2" → {r,g,b} */
function hexColor(hex) {
  const v = parseInt(String(hex).replace('#', '').slice(0, 6), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function readPNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG 가 아님');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let depth = 0;
  let interlace = 0;
  const idat = [];
  let hasTRNS = false;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'tRNS') hasTRNS = true;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = CHANNELS[colorType];
  if (depth !== 8 || !ch || interlace) throw new Error(`읽지 않는 PNG 형식 (깊이 ${depth}, 색 ${colorType}, 겹침 ${interlace})`);
  const hasAlpha = colorType === 4 || colorType === 6;
  if (!hasAlpha) return { width, height, colorType, minAlpha: hasTRNS ? 0 : 255 };

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  let prev = Buffer.alloc(stride);
  let minAlpha = 255;
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= ch ? line[i - ch] : 0;
      const up = prev[i];
      const ul = i >= ch ? prev[i - ch] : 0;
      let add = 0;
      if (f === 1) add = left;
      else if (f === 2) add = up;
      else if (f === 3) add = (left + up) >> 1;
      else if (f === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      line[i] = (line[i] + add) & 255;
    }
    for (let i = ch - 1; i < stride; i += ch) if (line[i] < minAlpha) minAlpha = line[i];
    prev = line;
  }
  return { width, height, colorType, minAlpha };
}

/**
 * 8비트·겹침 없는 PNG(회색·RGB·RGBA) → { width, height, data: BGRA } (화면 번역 시험: Electron 없이 그림 화소를 읽는다)
 */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG 가 아님');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let depth = 0;
  let interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = CHANNELS[colorType];
  if (depth !== 8 || !ch || interlace) throw new Error(`읽지 않는 PNG 형식 (깊이 ${depth}, 색 ${colorType}, 겹침 ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= ch ? line[i - ch] : 0;
      const up = prev[i];
      const ul = i >= ch ? prev[i - ch] : 0;
      let add = 0;
      if (f === 1) add = left;
      else if (f === 2) add = up;
      else if (f === 3) add = (left + up) >> 1;
      else if (f === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      line[i] = (line[i] + add) & 255;
    }
    for (let x = 0; x < width; x++) {
      const s = x * ch;
      const o = (y * width + x) * 4;
      const [r, g, b] = ch >= 3 ? [line[s], line[s + 1], line[s + 2]] : [line[s], line[s], line[s]];
      out[o] = b;
      out[o + 1] = g;
      out[o + 2] = r;
      out[o + 3] = ch === 4 ? line[s + 3] : ch === 2 ? line[s + 1] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** helper grab 이 쓴 32비트 BMP(위→아래, BI_RGB) → { width, height, data: BGRA }. 아래→위 BMP 도 읽는다 */
function decodeBMP(buf) {
  if (buf.toString('latin1', 0, 2) !== 'BM') throw new Error('BMP 가 아님');
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawH = buf.readInt32LE(22);
  const bits = buf.readUInt16LE(28);
  if (bits !== 32 || width <= 0 || rawH === 0) throw new Error(`읽지 않는 BMP 형식 (${bits}비트)`);
  const height = Math.abs(rawH);
  const stride = width * 4;
  if (rawH < 0) return { width, height, data: Buffer.from(buf.subarray(offset, offset + stride * height)) };
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) buf.copy(data, y * stride, offset + (height - 1 - y) * stride, offset + (height - y) * stride);
  return { width, height, data };
}

module.exports = { readPNG, decodePNG, decodeBMP, flattenBGRA, hexColor };

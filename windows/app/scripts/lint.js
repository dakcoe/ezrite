'use strict';

// app 아래 모든 .js 파일을 node --check로 문법 검사한다 (node_modules 제외)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(root);

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    process.stderr.write(r.stderr);
  }
}
console.log(`node --check: ${files.length - failed}/${files.length} 통과`);
process.exit(failed ? 1 : 0);

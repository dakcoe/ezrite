'use strict';

// 화면마다 EZRITE_PREVIEW + EZRITE_SHOT 으로 앱을 띄워 창 내용(capturePage)을 PNG로 찍는다. 찍고 나면 앱은 스스로 끝난다.
// 사용: node scripts/shots.js [--out 폴더] [--scale 1] [--themes light,dark] [--name "{screen}-{theme}"] [화면...]
//   맥과 나란히 볼 기본 세트:  node scripts/shots.js --out ../design/win --scale 1 --themes light --name "{screen}"
const path = require('path');
const { spawnSync } = require('child_process');
const electron = require('electron'); // electron 패키지는 실행 파일 경로를 돌려준다

const args = process.argv.slice(2);
const opt = { out: path.join(__dirname, '..', '..', 'design', 'win'), scale: '1', themes: 'light,dark', name: '{screen}-{theme}' };
const screens = [];
for (let i = 0; i < args.length; i++) {
  const m = /^--(out|scale|themes|name)$/.exec(args[i]);
  if (m) opt[m[1]] = args[++i];
  else screens.push(args[i]);
}
const list = screens.length ? screens : ['popover', 'compact', 'live', 'history', 'settings', 'onboarding'];

let failed = 0;
for (const screen of list) {
  for (const theme of opt.themes.split(',')) {
    const file = path.resolve(opt.out, `${opt.name.replace('{screen}', screen).replace('{theme}', theme)}.png`);
    const r = spawnSync(electron, ['.'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, EZRITE_PREVIEW: screen, EZRITE_THEME: theme, EZRITE_SHOT: file, EZRITE_TEST_SCALE: opt.scale },
      timeout: 60000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (r.status !== 0) failed++;
    console.log(`${r.status === 0 ? 'ok ' : 'ERR'} ${file}`);
  }
}
process.exit(failed ? 1 : 0);

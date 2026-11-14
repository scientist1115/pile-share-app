// 맥 도우미를 "맥을 켜면 자동 실행"으로 설치/제거 (macOS launchd)
//   설치:  npm run bridge:install
//   제거:  npm run bridge:uninstall
//   기록 보기: npm run bridge:log
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const LABEL = 'com.phonedrop.bridge';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = path.join(HOME, 'PhoneDrop', 'bridge.log');
const cmd = process.argv[2];

if (process.platform !== 'darwin') {
  console.log('이 설치는 맥에서만 할 수 있어요.');
  process.exit(1);
}

const launchctl = (...args) => { try { execFileSync('launchctl', args, { stdio: 'ignore' }); } catch { /* 이미 꺼져 있음 */ } };
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

if (cmd === 'install') {
  // 다운로드·데스크탑·문서 폴더는 macOS 보안 때문에 백그라운드 프로그램이 못 읽을 수 있음
  const protectedDirs = ['Downloads', 'Desktop', 'Documents'].map((d) => path.join(HOME, d) + path.sep);
  if (protectedDirs.some((d) => (APP_DIR + path.sep).startsWith(d))) {
    console.log(`⚠️  지금 앱이 ${APP_DIR} 에 있어요.`);
    console.log('   다운로드·데스크탑·문서 폴더 안에 있으면 macOS가 자동 실행을 막을 수 있어요.');
    console.log('   먼저 홈 폴더로 옮긴 다음 거기서 다시 설치해 주세요:\n');
    console.log(`   mv "${APP_DIR}" ~/phonedrop && cd ~/phonedrop && npm run bridge:install\n`);
    process.exit(1);
  }
  if (!existsSync(path.join(APP_DIR, '.env'))) {
    console.log('❌ .env 파일이 없어요. 먼저 .env에 CLOUD_URL과 APP_PASSWORD를 넣어 주세요.');
    process.exit(1);
  }
  await fs.mkdir(path.dirname(PLIST), { recursive: true });
  await fs.mkdir(path.dirname(LOG), { recursive: true });
  const envPath = [path.join(HOME, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(APP_DIR, 'bridge.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(APP_DIR)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(envPath)}</string></dict>
</dict>
</plist>
`;
  launchctl('unload', PLIST);
  await fs.writeFile(PLIST, plist);
  launchctl('load', PLIST);
  console.log('✅ 맥 도우미를 설치했어요. 이제 맥을 켜면 자동으로 실행돼요.');
  console.log(`   기록 보기: npm run bridge:log   (파일: ${LOG})`);
} else if (cmd === 'uninstall') {
  launchctl('unload', PLIST);
  await fs.rm(PLIST, { force: true });
  console.log('🗑  맥 도우미 자동 실행을 껐어요.');
} else {
  console.log('사용법: npm run bridge:install | npm run bridge:uninstall');
}

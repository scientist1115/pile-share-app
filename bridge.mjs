// PhoneDrop 맥 도우미
// Railway(클라우드)의 대기열을 5초마다 확인해서, 폰이 USB로 연결돼 있으면 카드·파일을 폰 갤러리에 넣어요.
// 실행: npm run bridge   (자동 실행 설치: npm run bridge:install)
import dotenv from 'dotenv';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createPhone, findMtpBin } from './lib/phone.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

const CLOUD_URL = (process.env.CLOUD_URL || '').trim().replace(/\/+$/, '');
const PASSWORD = (process.env.APP_PASSWORD || '').trim();
const INTERVAL = Math.max(3, Number(process.env.BRIDGE_INTERVAL_SEC) || 5) * 1000;
const OUTBOX = process.env.OUTBOX || path.join(os.homedir(), 'PhoneDrop');
const INBOX = path.join(OUTBOX, 'from-cloud');

const log = (msg) => console.log(`[${new Date().toLocaleString('ko-KR', { hour12: false })}] ${msg}`);

if (!/^https?:\/\//.test(CLOUD_URL) || !PASSWORD) {
  log('❌ .env에 CLOUD_URL(Railway 주소)과 APP_PASSWORD를 넣어 주세요. 예) CLOUD_URL=https://phonedrop-production.up.railway.app');
  process.exit(1);
}

const phone = createPhone({
  mtpBin: process.env.MTP_BIN || findMtpBin(),
  phoneDir: process.env.PHONE_DIR,
  phoneStorage: (process.env.PHONE_STORAGE || '').trim(),
});

function macNotify(text) {
  if (process.platform !== 'darwin') return;
  const safe = String(text).replace(/["\\]/g, '');
  execFile('osascript', ['-e', `display notification "${safe}" with title "PhoneDrop"`], () => {});
}

function api(p, { method = 'GET', json, timeout = 30_000 } = {}) {
  const headers = { 'X-App-Password': PASSWORD };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(CLOUD_URL + p, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    signal: AbortSignal.timeout(timeout),
  });
}

let lastPhone = '';
let lastCloudError = '';

async function tick() {
  // 1) 폰 상태 확인 → 클라우드에 알림
  const st = await phone.status();
  try {
    const hb = await api('/api/bridge/heartbeat', { method: 'POST', json: { phone: st.state, host: os.hostname() } });
    if (hb.status === 401) { if (lastCloudError !== '401') log('❌ 비밀번호가 클라우드와 달라요. .env의 APP_PASSWORD를 확인하세요.'); lastCloudError = '401'; return; }
    if (!hb.ok) throw new Error(`HTTP ${hb.status}`);
    if (lastCloudError) log('☁️ 클라우드에 다시 연결됐어요.');
    lastCloudError = '';
  } catch (e) {
    if (lastCloudError !== e.message) log(`⚠️ 클라우드에 연결할 수 없어요 (${e.message}). 인터넷과 CLOUD_URL을 확인하세요.`);
    lastCloudError = e.message;
    return;
  }

  if (st.state !== lastPhone) {
    log(st.state === 'connected' ? '📱 폰이 연결됐어요.' : `📱 폰 연결 안 됨 (${st.state})`);
    lastPhone = st.state;
  }
  if (st.state !== 'connected') return;

  // 2) 대기열 확인
  const q = await api('/api/bridge/queue');
  if (!q.ok) return;
  const { items = [] } = await q.json();
  if (!items.length) return;
  log(`📥 대기열 ${items.length}개를 받는 중…`);

  // 3) 맥으로 받기
  await fs.mkdir(INBOX, { recursive: true });
  const local = [];
  for (const it of items) {
    const file = path.join(INBOX, path.basename(it.name));
    const timeout = 60_000 + Math.ceil((it.size || 0) / (1024 * 1024)) * 2000;
    const r = await api('/api/bridge/file/' + encodeURIComponent(it.name), { timeout });
    if (!r.ok || !r.body) { log(`⚠️ ${it.name} 받기 실패 (${r.status})`); break; }
    await pipeline(Readable.fromWeb(r.body), createWriteStream(file));
    local.push({ name: it.name, file });
  }
  if (!local.length) return;

  // 4) 폰에 넣기 → 성공한 것만 대기열에서 지우기
  const result = await phone.withPhone(() => phone.pushToPhone(local.map((x) => x.file)));
  const done = local.slice(0, result.sent).map((x) => x.name);
  if (done.length) {
    await api('/api/bridge/done', { method: 'POST', json: { names: done } }).catch(() => {});
    log(`✅ ${done.length}개를 폰 갤러리('${phone.dir.split('/').pop()}' 앨범)에 넣었어요.`);
    macNotify(`${done.length}개를 폰에 넣었어요`);
  }
  if (!result.ok) log(`⚠️ ${result.hint}${result.detail ? ' — ' + result.detail : ''}`);
}

log(`🚀 PhoneDrop 맥 도우미 시작 — ${CLOUD_URL} 를 ${INTERVAL / 1000}초마다 확인해요.`);
log(`   폰 폴더: ${phone.dir}   mtp-rs: ${phone.mtpBin}`);
let running = false;
const loop = async () => {
  if (running) return;
  running = true;
  try { await tick(); } catch (e) { log(`⚠️ ${e.message}`); } finally { running = false; }
};
loop();
setInterval(loop, INTERVAL);

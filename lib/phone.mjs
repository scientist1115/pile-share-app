// 폰(USB/MTP) 공용 모듈 — 맥에서 도는 서버(server.mjs)와 맥 도우미(bridge.mjs)가 같이 씀
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MTP_HINTS = {
  ENOENT: 'mtp-rs가 설치돼 있지 않아요. 터미널에서 `cargo install mtp-rs-cli`를 실행하세요.',
  TIMEOUT: '폰이 응답하지 않아요. 케이블을 다시 꽂고 폰 잠금을 풀어 주세요.',
  1: '알 수 없는 오류가 났어요. 아래 상세 내용을 확인하세요.',
  2: '폰을 찾지 못했어요. 케이블 연결 → 폰 잠금 해제 → 알림에서 "파일 전송" 선택을 확인하세요.',
  3: '폰 저장소가 여러 개예요. `mtp-rs info`로 번호를 확인해서 .env의 PHONE_STORAGE에 적어 주세요.',
  4: '다른 앱이 폰을 쓰고 있어요. OpenMTP·사진·이미지 캡처를 완전히 종료(⌘+Q)하고 다시 시도하세요.',
  5: '폰 안의 폴더 경로에 문제가 있어요. .env의 PHONE_DIR을 확인하세요.',
  6: '보내는 중에 연결이 끊겼어요. 폰 화면이 꺼지지 않게 하고 다시 보내 보세요.',
  7: '보내긴 했지만 확인 단계에서 실패했어요. 다시 보내 보세요.',
};
export const hintFor = (code) => MTP_HINTS[code] || MTP_HINTS[1];
export const tail = (s, n = 600) => String(s || '').trim().slice(-n);

export function findMtpBin() {
  const candidates = [
    path.join(os.homedir(), '.cargo', 'bin', 'mtp-rs'),
    '/opt/homebrew/bin/mtp-rs',
    '/usr/local/bin/mtp-rs',
  ];
  return candidates.find((p) => existsSync(p)) || 'mtp-rs';
}

export function normalizePhoneDir(dir) {
  return '/' + String(dir || '/Pictures/PhoneDrop').split('/').filter(Boolean).join('/');
}

// `mtp-rs devices --json`은 기기가 하나면 객체 하나, 여러 개면 객체가 이어져 나올 수 있어서 전부 받아 줌
export function parseDevices(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j?.devices)) return j.devices;
    if (j && typeof j === 'object') return [j];
  } catch { /* 이어 붙은 객체들 → 아래에서 하나씩 분리 */ }
  const list = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}' && depth > 0 && --depth === 0) {
      try { list.push(JSON.parse(text.slice(start, i + 1))); } catch { /* 무시 */ }
    }
  }
  return list;
}

export function createPhone({ mtpBin = findMtpBin(), phoneDir = '/Pictures/PhoneDrop', phoneStorage = '' } = {}) {
  const dir = normalizePhoneDir(phoneDir);
  const storageArgs = () => (phoneStorage ? ['--storage', String(phoneStorage)] : []);

  function runMtp(args, { timeout = 120_000 } = {}) {
    return new Promise((resolve) => {
      execFile(mtpBin, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, code: 0, stdout, stderr });
        let code = 1;
        if (err.code === 'ENOENT') code = 'ENOENT';
        else if (err.killed) code = 'TIMEOUT';
        else if (typeof err.code === 'number') code = err.code;
        resolve({ ok: false, code, stdout: stdout || '', stderr: stderr || err.message });
      });
    });
  }

  // USB는 한 번에 한 작업만 — 작업끼리 겹치지 않게 줄 세우기
  let queue = Promise.resolve();
  let busy = false;
  function withPhone(fn) {
    const job = queue.then(async () => {
      busy = true;
      try { return await fn(); } finally { busy = false; }
    });
    queue = job.catch(() => {});
    return job;
  }

  async function ensurePhoneDir() {
    const ls = () => runMtp(['ls', dir, ...storageArgs(), '--json'], { timeout: 30_000 });
    const first = await ls();
    if (first.ok) return first;
    // 폴더가 없을 때(경로 오류)만 만들어 보고, 연결 문제면 그대로 알려 줌
    if (first.code !== 5 && first.code !== 1) return first;
    let cur = '';
    for (const part of dir.split('/').filter(Boolean)) {
      cur += '/' + part;
      await runMtp(['mkdir', cur, ...storageArgs(), '--json'], { timeout: 30_000 });
    }
    return ls();
  }

  // 파일들을 폰 폴더로 보냄. 실패하면 거기까지 보낸 개수(sent)와 이유를 돌려줌
  async function pushToPhone(files) {
    const check = await ensurePhoneDir();
    if (!check.ok) return { ok: false, sent: 0, code: check.code, hint: hintFor(check.code), detail: tail(check.stderr) };
    let sent = 0;
    for (const file of files) {
      const size = (await fs.stat(file).catch(() => ({ size: 0 }))).size;
      const timeout = 120_000 + Math.ceil(size / (1024 * 1024)) * 1000; // 1MB당 1초 여유 (큰 영상 대비)
      const r = await runMtp(['put', file, dir + '/', ...storageArgs(), '--json'], { timeout });
      if (!r.ok) return { ok: false, sent, code: r.code, hint: hintFor(r.code), detail: tail(r.stderr) };
      sent++;
    }
    return { ok: true, sent, phoneDir: dir };
  }

  async function status() {
    const r = await runMtp(['devices', '--json'], { timeout: 15_000 });
    if (!r.ok) {
      const state = r.code === 'ENOENT' ? 'no-tool' : r.code === 2 ? 'disconnected' : 'error';
      return { state, hint: hintFor(r.code), detail: tail(r.stderr, 300) };
    }
    const list = parseDevices(r.stdout);
    const names = list.map((d) => d.product || d.model || d.name || '').filter(Boolean);
    return list.length > 0 ? { state: 'connected', names } : { state: 'disconnected', hint: MTP_HINTS[2] };
  }

  return { dir, mtpBin, runMtp, withPhone, ensurePhoneDir, pushToPhone, status, storageArgs, isBusy: () => busy };
}

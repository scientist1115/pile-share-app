// PhoneDrop 서버
// 맥에서 받은 글·파일 → (AI가 카드로 정리) → 브라우저가 카드 PNG로 그림 → 이 서버가 mtp-rs로 폰에 전송
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { extractText, getDocumentProxy } from 'unpdf';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createPhone, findMtpBin, hintFor, tail, MTP_HINTS, normalizePhoneDir } from './lib/phone.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 어느 폴더에서 실행하든 앱 폴더의 .env를 읽음
const ENV_PATH = path.join(__dirname, '.env');
dotenv.config({ path: ENV_PATH, quiet: true });

// AI 키: GROQ_API_KEY 또는 OPENAI_API_KEY. gsk_로 시작하면 Groq로 자동 연결
const API_KEY = (process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY || '').trim();
const IS_GROQ = Boolean(process.env.GROQ_API_KEY) || API_KEY.startsWith('gsk_');
const PROVIDER = IS_GROQ ? 'Groq' : process.env.OPENAI_BASE_URL ? 'OpenAI 호환' : 'OpenAI';

// 가볍고 무료 사용량이 많은 순서 (위에서부터 쓸 수 있는 걸 고름)
const TEXT_PREFS = IS_GROQ
  ? ['llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b']
  : ['gpt-5.4-mini', 'gpt-4.1-mini', 'gpt-4o-mini'];
const VISION_PATTERN = /llama-4-scout|llama-4-maverick|qwen\/qwen3\.\d+-\d+b|vision|-vl/i;

// Railway 같은 클라우드에서 돌면 폰 대신 '대기열'에 넣고, 맥 도우미(bridge.mjs)가 가져가서 폰에 넣음
const CLOUD = process.env.CLOUD_MODE === '1' || Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
if (CLOUD && !process.env.TZ) process.env.TZ = 'Asia/Seoul';
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const QUEUE_DIR = process.env.QUEUE_DIR
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'queue') : path.join(os.tmpdir(), 'phonedrop-queue'));
const INCOMING_DIR = path.join(QUEUE_DIR, '.incoming');

const CONFIG = {
  port: Number(process.env.PORT) || 3939,
  model: process.env.MODEL || TEXT_PREFS[0],
  visionModel: process.env.VISION_MODEL || '', // 비우면 자동으로 찾음
  maxInputChars: Number(process.env.MAX_INPUT_CHARS) || (IS_GROQ ? 6000 : 40000),
  maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS) || 3000,
  phoneDir: normalizePhoneDir(process.env.PHONE_DIR),
  phoneStorage: (process.env.PHONE_STORAGE || '').trim(),
  outbox: process.env.OUTBOX || path.join(os.homedir(), 'PhoneDrop'),
  mtpBin: process.env.MTP_BIN || findMtpBin(),
};

const ai = API_KEY
  ? new OpenAI({
      apiKey: API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || (IS_GROQ ? 'https://api.groq.com/openai/v1' : undefined),
    })
  : null;

// 실제로 쓸 수 있는 모델 목록을 받아서, 설정한 모델이 없으면 다른 걸로 바꿈
async function pickModels() {
  if (!ai) return;
  let ids = [];
  try {
    for await (const m of ai.models.list()) ids.push(m.id);
  } catch (e) {
    console.log(`⚠️  모델 목록을 못 받았어요 (${e.status || ''} ${e.message}). 키를 확인하세요.`);
    return;
  }
  if (!ids.includes(CONFIG.model)) {
    const alt = TEXT_PREFS.find((id) => ids.includes(id)) || ids.find((id) => !/whisper|tts|guard|embed|compound/i.test(id));
    if (alt) { console.log(`ℹ️  '${CONFIG.model}' 모델이 없어서 '${alt}'로 바꿨어요.`); CONFIG.model = alt; }
  }
  if (!CONFIG.visionModel || !ids.includes(CONFIG.visionModel)) {
    CONFIG.visionModel = ids.find((id) => VISION_PATTERN.test(id)) || '';
  }
}

// ─────────────────────────────── 폰(MTP) ───────────────────────────────

const phone = createPhone({ mtpBin: CONFIG.mtpBin, phoneDir: CONFIG.phoneDir, phoneStorage: CONFIG.phoneStorage });

// ─────────────────────────────── AI ───────────────────────────────

const SYSTEM_PROMPT = `너는 "PhoneDrop"의 AI야. 사용자는 맥북에서 너에게 글이나 파일을 주고, 너의 결과는 '카드 이미지'로 그려져 USB로 사용자의 갤럭시 A13 갤러리에 저장돼. 폰에는 갤러리 말고 글을 볼 앱이 거의 없어서, 카드가 곧 사용자가 폰에서 보게 될 유일한 형태야.

반드시 아래 형태의 JSON 하나만 출력해:
{
  "reply": "채팅창에 보여줄 짧은 한국어 답 (1~2문장)",
  "cards": [ { "title": "카드 제목 (20자 이내)", "body": "카드 내용" } ],
  "fontScale": null 또는 0.8~1.6 사이 숫자,
  "theme": null 또는 "light" 또는 "dark"
}

카드 작성 규칙:
- 폰 화면에서 한눈에 읽히도록 카드 한 장에 주제 하나. 본문은 대략 6~10줄, 문장은 짧게.
- body에서 쓸 수 있는 문법은 "# 소제목", "- 글머리 항목", "- [ ] 체크 항목", "1. 번호 항목", "**강조**", 빈 줄(문단 구분)뿐이야. 표·코드블록·링크·이모지 남발은 쓰지 마.
- 절대 되묻지 마. 사용자가 "보내줘", "폰으로", "카드로" 같은 말과 함께 글을 쓰면 그 글 자체를 카드로 만들어. 메모·생각·할 일처럼 보이는 메시지도 그대로 카드로 만들어. (예: "나는 지금 해야 할 일이 너무 많다 보내줘" → 제목 "메모", 본문 "나는 지금 해야 할 일이 너무 많다")
- 할 일·준비물·체크리스트는 "- [ ] 항목" 형식으로 써.
- 단어 퀴즈를 원하면 문제 카드(단어만)와 정답 카드(단어 — 뜻)를 번갈아 만들어. 제목은 "퀴즈 1", "정답 1"처럼.
- 웹페이지 글이 첨부되면 광고·메뉴·댓글 같은 군더더기는 빼고 본문만 읽기 좋게 정리해.
- 사용자가 '그대로', '원문 그대로'를 원하면 내용을 바꾸지 말고 카드로 나누기만 해. 요약·정리를 원하면 핵심만 남겨. 특별한 말이 없으면 읽기 좋게 정리하되 중요한 정보(숫자, 날짜, 이름, 단어)는 빠뜨리지 마.
- 단어장·목록은 항목을 하나도 빠뜨리지 말고 여러 카드에 나눠 담아. 예: "- **abandon** — 버리다".
- 이미지가 첨부되면 그 안의 글자와 내용을 읽어서 카드로 옮겨.
- 원문이 영어면 영어 원문은 유지하고, 설명·제목은 한국어로 써.
- 사용자가 수정(글씨 크게, 어둡게, 2번 카드 고쳐줘 등)을 요청하면 수정된 전체 cards를 다시 출력하고, 필요하면 fontScale/theme을 설정해.
- cards를 비워도 되는 건 사용자가 이 앱 사용법을 묻는 경우뿐이야. 그 외에는 항상 카드를 만들어.`;

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'html', 'htm', 'css', 'java', 'c', 'h', 'cpp', 'swift', 'kt', 'rs', 'go', 'rb', 'php', 'sh', 'yml', 'yaml', 'xml', 'srt', 'vtt', 'log', 'ini', 'toml']);
const AI_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const isTextFile = (mime, name) =>
  mime.startsWith('text/') || /json|xml|javascript|yaml|csv/.test(mime) || TEXT_EXT.has(extOf(name));

// ─────────────────────────── 웹페이지 → 글 ───────────────────────────
const URL_RE = /https?:\/\/[^\s<>"'）)\]]+/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—' };
function decodeEntities(str) {
  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlToText(html) {
  let h = html.replace(/<!--[\s\S]*?-->/g, '');
  const titleMatch = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i.exec(h) || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  h = h.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|button|select|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const longest = (tag) => {
    const m = h.match(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'));
    return m ? m.sort((a, b) => b.length - a.length)[0] : null;
  };
  let body = longest('article') || longest('main') || (/<body[\s\S]*<\/body>/i.exec(h) || [h])[0];
  body = body
    .replace(/<h[1-6][^>]*>/gi, '\n# ').replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|li|blockquote|pre|table|ul|ol|figure)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const text = decodeEntities(body).replace(/[ \t\u00a0]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter((l) => l && l !== '#' && l !== '-')
    .join('\n');
  return { title, text };
}
async function fetchPage(rawUrl) {
  let url = rawUrl.replace(/[.,!?。]+$/, '');
  // 네이버 블로그는 본문이 iframe 안에 있어서 모바일 주소로 바꿔서 읽음
  url = url.replace(/^https?:\/\/blog\.naver\.com\//i, 'https://m.blog.naver.com/');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`페이지를 열 수 없어요 (${res.status})`);
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (type.includes('application/pdf')) return { title: decodeURIComponent(url.split('/').pop() || url), text: await pdfToText(buf) };
  if (type && !/html|text\/plain|xml/.test(type)) throw new Error('웹페이지가 아니라서 읽을 수 없어요');
  let charset = (/charset=["']?([\w-]+)/i.exec(type) || [])[1];
  if (!charset) charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
  let html;
  try { html = new TextDecoder(charset || 'utf-8').decode(buf); } catch { html = buf.toString('utf8'); }
  if (type.includes('text/plain')) return { title: url, text: html.trim() };
  const page = htmlToText(html);
  if (page.text.length < 80) throw new Error('본문을 찾지 못했어요 (로그인이 필요하거나 앱 전용 페이지일 수 있어요)');
  return page;
}

async function pdfToText(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return String(text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 모델마다 지원하는 옵션이 달라서, 거절당하면 그 옵션을 빼고 다시 시도
async function createCompletion(params) {
  let p = { ...params };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await ai.chat.completions.create(p);
    } catch (e) {
      const msg = String(e.message || '').toLowerCase();
      if (e.status !== 400) throw e;
      if (p.reasoning_format && msg.includes('reasoning')) { delete p.reasoning_format; continue; }
      if (p.response_format && (msg.includes('json') || msg.includes('response_format'))) { delete p.response_format; continue; }
      if (p.max_tokens && msg.includes('max_tokens')) { delete p.max_tokens; continue; }
      throw e;
    }
  }
  return ai.chat.completions.create(p);
}

function friendlyAiError(e) {
  const m = String(e.message || '');
  if (e.status === 401) return `AI 키가 맞지 않아요 (${PROVIDER}). .env의 키를 확인하세요.`;
  if (e.status === 429) return '무료 사용량 한도에 걸렸어요. 1분쯤 기다렸다가 다시 보내 보세요. (긴 파일은 나눠서 보내면 덜 걸려요)';
  if (e.status === 413 || /too large|context length|maximum context|tokens per minute/i.test(m))
    return '한 번에 보내기엔 내용이 너무 길어요. 나눠서 보내 주세요.';
  if (e.status === 404 || /model.*(not found|does not exist|decommissioned)/i.test(m))
    return `모델을 찾을 수 없어요. .env의 MODEL을 비우고 서버를 다시 켜면 자동으로 골라요. (${m})`;
  return `AI 요청 실패: ${m}`;
}

function parseAiJson(raw) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return tryParse(text)
    || tryParse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
    || tryParse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    || { reply: text, cards: [] };
}

function normalizeResult(data) {
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const scale = Number(data.fontScale);
  return {
    reply: typeof data.reply === 'string' ? data.reply : '',
    cards: cards
      .map((c) => ({ title: String(c?.title ?? '').trim(), body: String(c?.body ?? '').trim() }))
      .filter((c) => c.title || c.body),
    fontScale: Number.isFinite(scale) && scale > 0 ? Math.min(1.6, Math.max(0.8, scale)) : null,
    theme: data.theme === 'dark' || data.theme === 'light' ? data.theme : null,
  };
}

// ─────────────────────────────── 서버 ───────────────────────────────

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 8 } });

// 업데이트 후에도 브라우저가 예전 화면을 쓰지 않게 매번 새로 확인
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 비밀번호 확인 (클라우드에선 필수 — 아무나 내 AI 키를 쓰거나 내 폰에 파일을 넣지 못하게)
const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
app.use('/api', (req, res, next) => {
  if (req.path === '/config' || req.path === '/health') return next();
  if (CLOUD && !APP_PASSWORD) return res.status(503).json({ error: 'Railway 변수에 APP_PASSWORD를 설정해야 쓸 수 있어요.' });
  if (!APP_PASSWORD || sameText(req.get('x-app-password') || '', APP_PASSWORD)) return next();
  res.status(401).json({ error: '비밀번호가 틀렸거나 없어요.', needPassword: true });
});

app.get('/api/config', (_req, res) => {
  res.json({ hasKey: Boolean(ai), provider: PROVIDER, model: CONFIG.model, visionModel: CONFIG.visionModel, phoneDir: CONFIG.phoneDir, outbox: CONFIG.outbox, cloud: CLOUD, needsPassword: Boolean(APP_PASSWORD) || CLOUD });
});

// 클라우드: 맥 도우미가 마지막으로 연락한 시각과 폰 상태
let bridgeState = { at: 0, phone: 'unknown', host: '' };
const queueNames = async () => {
  const names = await fs.readdir(QUEUE_DIR).catch(() => []);
  const out = [];
  for (const n of names.sort()) {
    if (n.startsWith('.')) continue;
    const st = await fs.stat(path.join(QUEUE_DIR, n)).catch(() => null);
    if (st?.isFile()) out.push({ name: n, size: st.size });
  }
  return out;
};

app.get('/api/status', async (_req, res) => {
  if (CLOUD) {
    const age = bridgeState.at ? Date.now() - bridgeState.at : null;
    return res.json({
      state: 'cloud',
      bridgeOnline: age !== null && age < 30_000,
      phone: bridgeState.phone,
      host: bridgeState.host,
      queue: (await queueNames()).length,
    });
  }
  if (phone.isBusy()) return res.json({ state: 'busy' });
  res.json(await phone.status());
});

app.post('/api/chat', upload.array('files', 8), async (req, res) => {
  if (!ai) return res.status(400).json({ error: '.env에 AI 키(GROQ_API_KEY 또는 OPENAI_API_KEY)가 없어요. "그대로" 모드는 키 없이도 돼요.' });

  let history = [];
  try { history = JSON.parse(req.body?.history || '[]'); } catch { /* 무시 */ }
  const message = String(req.body?.message || '').trim();

  const notes = [];
  const texts = [];
  const images = [];
  let budget = Math.max(1000, CONFIG.maxInputChars - message.length);
  const addText = (label, text) => {
    const clean = String(text || '').trim();
    if (!clean) return;
    if (budget <= 0) { notes.push(`${label}: 내용이 너무 많아서 빼고 정리했어요. 따로 보내 주세요.`); return; }
    const cut = clean.slice(0, budget);
    if (cut.length < clean.length) notes.push(`${label}: 너무 길어서 앞부분 ${cut.length.toLocaleString()}자만 정리했어요. 나머지는 나눠서 보내 주세요.`);
    budget -= cut.length;
    texts.push(`[첨부 파일: ${label}]\n${cut}`);
  };

  // 메시지 속 웹 링크는 본문을 가져와서 같이 정리
  const urls = [...new Set(message.match(URL_RE) || [])].slice(0, 2);
  for (const u of urls) {
    try {
      const page = await fetchPage(u);
      addText(`웹페이지: ${page.title || u}`, page.text);
    } catch (e) {
      notes.push(`${u}: ${e.name === 'TimeoutError' ? '페이지가 응답하지 않아요' : e.message}`);
    }
  }

  for (const f of req.files || []) {
    // multer는 파일 이름을 latin1로 읽어서 한글이 깨짐 → utf8로 되돌리기
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const mime = (f.mimetype || '').toLowerCase();
    if (AI_IMAGE_TYPES.has(mime)) {
      if (images.length >= 3) { notes.push(`${name}: 사진은 한 번에 3장까지만 읽을 수 있어요.`); continue; }
      images.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${f.buffer.toString('base64')}` } });
    } else if (mime === 'application/pdf' || extOf(name) === 'pdf') {
      try {
        const text = await pdfToText(f.buffer);
        if (text) addText(name, text);
        else notes.push(`${name}: 글자가 없는 PDF(스캔본)라서 못 읽었어요. 화면을 캡처해서 사진으로 보내 주세요.`);
      } catch (e) {
        notes.push(`${name}: PDF를 열지 못했어요 (${e.message})`);
      }
    } else if (isTextFile(mime, name)) {
      addText(name, f.buffer.toString('utf8'));
    } else {
      notes.push(`${name}: 이 형식은 AI가 읽을 수 없어요 (텍스트·PDF·PNG/JPG만 가능)`);
    }
  }
  if (images.length && !CONFIG.visionModel) {
    notes.push('사진을 읽을 수 있는 AI 모델이 없어서 사진은 빼고 정리했어요. ("그대로" 모드로 사진 자체는 보낼 수 있어요)');
    images.length = 0;
  }
  if (!message && !texts.length && !images.length) return res.status(400).json({ error: '보낼 내용이 없어요.', notes });

  const withoutUrls = message.replace(URL_RE, '').trim();
  const instruction = withoutUrls || (urls.length ? '이 웹페이지 내용을 폰에서 읽기 좋은 카드로 정리해 줘.' : '첨부한 내용을 폰에서 읽기 좋은 카드로 만들어 줘.');
  const userText = [instruction, ...texts].join('\n\n');
  const model = images.length ? CONFIG.visionModel : CONFIG.model;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-6).map((h) => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: String(h.content || '').slice(0, 3000),
    })),
    { role: 'user', content: images.length ? [{ type: 'text', text: userText }, ...images] : userText },
  ];

  const params = { model, messages, response_format: { type: 'json_object' }, max_tokens: CONFIG.maxOutputTokens };
  if (IS_GROQ && /qwen/i.test(model)) params.reasoning_format = 'hidden';

  try {
    const completion = await createCompletion(params);
    const choice = completion.choices?.[0];
    const raw = choice?.message?.content || '';
    if (choice?.finish_reason === 'length') notes.push('답이 너무 길어서 끝부분이 잘렸을 수 있어요. 내용을 나눠서 보내 보세요.');
    res.json({ ...normalizeResult(parseAiJson(raw)), notes, raw, model });
  } catch (e) {
    res.status(502).json({ error: friendlyAiError(e), notes });
  }
});

const pad = (n) => String(n).padStart(2, '0');
async function outboxDir() {
  const now = new Date();
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  let stamp = `${day}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 클라우드: 받는 중인 파일은 .incoming에 두었다가 다 받으면 대기열로 옮김 (도우미가 덜 받은 파일을 가져가지 않게)
  if (CLOUD) {
    stamp += '_' + crypto.randomBytes(2).toString('hex');
    await fs.mkdir(INCOMING_DIR, { recursive: true });
    return { stamp, dir: INCOMING_DIR };
  }
  const dir = path.join(CONFIG.outbox, day);
  await fs.mkdir(dir, { recursive: true });
  return { stamp, dir };
}

// 맥에서는 바로 폰으로, 클라우드에서는 대기열로
async function deliver(files) {
  if (!CLOUD) return phone.withPhone(() => phone.pushToPhone(files));
  await fs.mkdir(QUEUE_DIR, { recursive: true });
  const names = [];
  for (const f of files) {
    const name = path.basename(f);
    await fs.rename(f, path.join(QUEUE_DIR, name));
    names.push(name);
  }
  const bridgeOnline = bridgeState.at > 0 && Date.now() - bridgeState.at < 30_000;
  return { ok: true, cloud: true, queued: names.length, names, bridgeOnline, phone: bridgeState.phone };
}
const safeBase = (name) => String(name || 'file').replace(/\.[^.]+$/, '')
  .replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'file';

// 영상·사진 등 원본 파일을 그대로 폰으로 (AI를 거치지 않음, 최대 4GB)
const fileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => { outboxDir().then(({ stamp, dir }) => { req.stamp = stamp; cb(null, dir); }, cb); },
    filename: (req, file, cb) => {
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const ext = (path.extname(name) || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${req.stamp}_${safeBase(name)}${ext}`);
    },
  }),
  limits: { fileSize: (CLOUD ? 0.5 : 4) * 1024 ** 3, files: 20 },
});

app.post('/api/send-files', fileUpload.array('files', 20), async (req, res) => {
  const files = (req.files || []).map((f) => f.path);
  if (!files.length) return res.status(400).json({ error: '보낼 파일이 없어요.' });
  const result = await deliver(files);
  res.json({ ...result, saved: files.length, outbox: CLOUD ? '' : path.dirname(files[0]) });
});

app.post('/api/send', express.json({ limit: '100mb' }), async (req, res) => {
  const images = Array.isArray(req.body?.images) ? req.body.images : [];
  if (!images.length) return res.status(400).json({ error: '보낼 이미지가 없어요.' });

  const { stamp, dir } = await outboxDir();

  const files = [];
  for (const [i, img] of images.entries()) {
    const m = /^data:image\/(png|jpe?g|webp|gif|heic|heif);base64,(.+)$/s.exec(String(img?.dataUrl || ''));
    if (!m) continue;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const base = String(img?.name || 'card').replace(/\.[a-z0-9]+$/i, '')
      .replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'card';
    const file = path.join(dir, `${stamp}_${pad(i + 1)}_${base}.${ext}`);
    await fs.writeFile(file, Buffer.from(m[2], 'base64'));
    files.push(file);
  }
  if (!files.length) return res.status(400).json({ error: '이미지 형식을 읽지 못했어요.' });

  const result = await deliver(files);
  res.json({ ...result, saved: files.length, outbox: CLOUD ? '' : dir });
});

// ─────────────────────────── 맥 도우미(bridge.mjs)용 API ───────────────────────────
app.get('/api/bridge/queue', async (_req, res) => res.json({ items: await queueNames() }));
app.get('/api/bridge/file/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  if (!name || name.startsWith('.')) return res.status(400).json({ error: '잘못된 이름' });
  res.sendFile(path.join(QUEUE_DIR, name), (err) => { if (err && !res.headersSent) res.status(404).json({ error: '없는 파일' }); });
});
app.post('/api/bridge/done', express.json(), async (req, res) => {
  const names = Array.isArray(req.body?.names) ? req.body.names : [];
  for (const n of names) {
    const name = path.basename(String(n));
    if (name && !name.startsWith('.')) await fs.unlink(path.join(QUEUE_DIR, name)).catch(() => {});
  }
  res.json({ ok: true, removed: names.length });
});
app.post('/api/bridge/heartbeat', express.json(), (req, res) => {
  bridgeState = { at: Date.now(), phone: String(req.body?.phone || 'unknown'), host: String(req.body?.host || '').slice(0, 60) };
  res.json({ ok: true });
});

app.get('/api/fetch-url', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: '웹 주소가 아니에요.' });
  try {
    res.json(await fetchPage(url));
  } catch (e) {
    res.status(502).json({ error: e.name === 'TimeoutError' ? '페이지가 응답하지 않아요' : e.message });
  }
});

// ─────────────────────────── 폰 → 맥 (최근 사진 가져오기) ───────────────────────────
const PHONE_PHOTO_DIRS = (process.env.PHONE_PHOTO_DIRS || '/DCIM/Camera,/DCIM/Screenshots,/Pictures/Screenshots')
  .split(',').map((d) => '/' + d.split('/').filter(Boolean).join('/')).filter((d) => d !== '/');
const MEDIA_RE = /\.(jpe?g|png|webp|gif|heic|heif|mp4|mov|3gp)$/i;
const FROM_PHONE = path.join(CONFIG.outbox, 'from-phone');

// `mtp-rs ls --json` 결과 모양이 문서에 없어서, 여러 모양을 다 받아 줌
function parseLs(stdout) {
  const out = [];
  const text = String(stdout || '').trim();
  const visit = (v) => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!v || typeof v !== 'object') return;
    const lists = Object.values(v).filter((x) => Array.isArray(x) && x.some((y) => y && typeof y === 'object'));
    if (lists.length) { lists.forEach(visit); return; }
    const name = v.name ?? v.filename ?? v.file_name ?? (typeof v.path === 'string' ? v.path.split('/').pop() : undefined);
    if (typeof name !== 'string' || !name) return;
    const kind = String(v.kind ?? v.type ?? v.format ?? v.object_type ?? '');
    const folder = Boolean(v.is_folder ?? v.is_dir ?? v.folder ?? v.directory) || /folder|dir|association/i.test(kind);
    out.push({ name, folder, size: Number(v.size ?? v.bytes ?? 0) || 0, modified: v.modified ?? v.date_modified ?? v.mtime ?? v.modification_date ?? null });
  };
  try { visit(JSON.parse(text)); } catch {
    for (const line of text.split('\n')) { try { visit(JSON.parse(line)); } catch { /* 무시 */ } }
  }
  if (!out.length) {
    for (const m of text.matchAll(/([^\s/"'\\]+\.(?:jpe?g|png|webp|gif|heic|heif|mp4|mov|3gp))/gi)) {
      out.push({ name: m[1], folder: false, size: 0, modified: null });
    }
  }
  return out;
}
// 삼성 사진 이름(20261113_234500.jpg, Screenshot_20261113-234500_...)에서 찍은 시각을 읽어 정렬
function sortKey(item) {
  const m = /(20\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/.exec(item.name);
  if (m) return m.slice(1).join('');
  const t = item.modified ? Date.parse(item.modified) : NaN;
  if (Number.isFinite(t)) { const d = new Date(t); return d.toISOString().replace(/\D/g, '').slice(0, 14); }
  return '';
}

app.get('/api/phone/recent', async (req, res) => {
  if (CLOUD) return res.json({ ok: false, hint: '폰 사진 가져오기는 맥에서 실행할 때만 쓸 수 있어요.' });
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 6));
  const result = await phone.withPhone(async () => {
    const all = [];
    let deviceErr = null;
    for (const dir of PHONE_PHOTO_DIRS) {
      const r = await phone.runMtp(['ls', dir, ...phone.storageArgs(), '--json'], { timeout: 90_000 });
      if (!r.ok) {
        if (r.code === 5 || r.code === 1) continue; // 폴더가 없으면 건너뜀
        deviceErr = r; break;
      }
      let items = parseLs(r.stdout);
      if (!items.length) {
        const plain = await phone.runMtp(['ls', dir, ...phone.storageArgs()], { timeout: 90_000 });
        if (plain.ok) items = parseLs(plain.stdout);
      }
      for (const it of items) if (!it.folder && MEDIA_RE.test(it.name)) all.push({ ...it, dir, key: sortKey(it) });
    }
    if (deviceErr) return { ok: false, code: deviceErr.code, hint: hintFor(deviceErr.code), detail: tail(deviceErr.stderr) };
    all.sort((a, b) => b.key.localeCompare(a.key) || b.name.localeCompare(a.name));
    const pick = all.slice(offset, offset + limit);
    await fs.mkdir(FROM_PHONE, { recursive: true });
    const files = [];
    for (const it of pick) {
      const local = path.join(FROM_PHONE, it.name);
      if (!existsSync(local)) {
        const timeout = 120_000 + Math.ceil((it.size || 0) / (1024 * 1024)) * 1000;
        const g = await phone.runMtp(['get', `${it.dir}/${it.name}`, local, ...phone.storageArgs(), '--json'], { timeout });
        if (!g.ok) return { ok: false, code: g.code, hint: hintFor(g.code), detail: tail(g.stderr), files };
      }
      files.push({ name: it.name, url: '/from-phone/' + encodeURIComponent(it.name), video: /\.(mp4|mov|3gp)$/i.test(it.name) });
    }
    return { ok: true, files, total: all.length, nextOffset: offset + pick.length, folder: FROM_PHONE };
  });
  res.json(result);
});
app.use('/from-phone', express.static(FROM_PHONE));
app.post('/api/open-folder', async (_req, res) => {
  if (CLOUD) return res.json({ ok: false });
  await fs.mkdir(FROM_PHONE, { recursive: true });
  execFile('open', [FROM_PHONE], () => {});
  res.json({ ok: true, folder: FROM_PHONE });
});

// 어떤 오류든 HTML 대신 JSON으로 돌려줌
app.use((err, _req, res, _next) => {
  const msg = err.code === 'LIMIT_FILE_SIZE' ? '파일이 너무 커요.'
    : err.code === 'LIMIT_FILE_COUNT' ? '파일이 너무 많아요. 나눠서 보내 주세요.'
    : err.type === 'entity.too.large' ? '보낼 이미지가 너무 커요. 나눠서 보내 주세요.'
    : err.message || '서버 오류';
  res.status(err.status || 400).json({ error: msg });
});

await pickModels();
app.listen(CONFIG.port, () => {
  console.log(`\n📲 PhoneDrop 실행 중 → http://localhost:${CONFIG.port}`);
  console.log(ai
    ? `   AI: ${PROVIDER} · 글 ${CONFIG.model} · 사진 ${CONFIG.visionModel || '(사진 읽는 모델 없음)'}`
    : `   AI: 키 없음 ("그대로" 모드만 가능) — ${existsSync(ENV_PATH) ? '.env에 GROQ_API_KEY 줄이 비어 있어요' : '.env 파일이 없어요'}: ${ENV_PATH}`);
  if (CLOUD) {
    console.log(`   ☁️  클라우드 모드: 보낸 파일은 대기열(${QUEUE_DIR})에 쌓이고, 맥 도우미가 가져가 폰에 넣어요.`);
    if (!process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.QUEUE_DIR) console.log('   ⚠️  Volume이 없어서 재배포하면 대기열이 지워져요. Railway에서 Volume을 붙이면 안전해요.');
    console.log(APP_PASSWORD ? '   🔒 비밀번호 설정됨\n' : '   ⚠️  APP_PASSWORD가 없어서 아무 기능도 쓸 수 없어요. Railway 변수에 추가하세요.\n');
  } else {
    console.log(`   폰 폴더: ${CONFIG.phoneDir}   맥 복사본: ${CONFIG.outbox}`);
    console.log(`   mtp-rs: ${CONFIG.mtpBin}\n`);
  }
});

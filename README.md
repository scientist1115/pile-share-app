# 📲 PhoneDrop

맥에서 글이나 파일을 주면 **AI가 폰에서 읽기 좋은 카드 이미지로 정리**하고,
**USB 케이블로 갤럭시 갤러리에 바로 넣어 주는** 챗봇 앱.

```
[맥: 채팅 화면] → AI 정리(선택) → 카드 PNG 생성 → mtp-rs(USB) → 폰 갤러리 'PhoneDrop' 앨범
```

## 처음 설치 (한 번만)

```bash
# 1) 폰 전송 도구 (Rust가 없으면 먼저: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh)
cargo install mtp-rs-cli

# 2) 이 폴더에서
npm install
cp .env.example .env      # 그리고 .env에 OPENAI_API_KEY 입력
```

## 실행

```bash
npm start
```
→ 브라우저에서 **http://localhost:3939** 열기

## 쓰는 법

1. 폰을 케이블로 연결 → 폰 잠금 해제 → 알림에서 **'파일 전송'** 선택
2. **OpenMTP는 꺼 두기** (⌘+Q). USB는 한 앱만 잡을 수 있어요.
3. 오른쪽 위에 **📱 폰 연결됨**이 보이면 준비 완료
4. 글을 쓰거나 파일을 끌어다 놓고 Enter

| 모드 | 하는 일 |
|---|---|
| **AI 정리** | 글·텍스트 파일·PDF·사진을 AI가 읽고 카드로 정리. "단어장으로", "요약해서", "글씨 더 크게", "2번 카드 고쳐줘"처럼 말로 지시 가능 |
| **그대로** | 쓴 글은 그대로 카드로, 사진은 변환 없이 그대로 전송 (AI 키 없어도 됨) |

**부가 기능**
- **🔗 웹 링크 → 카드**: 기사·블로그 주소를 붙여넣으면 본문만 뽑아서 카드로 (폰에 브라우저가 없어도 갤러리에서 읽기). 네이버 블로그도 돼요.
- **📥 폰 사진 가져오기**: 위쪽 버튼 한 번으로 폰의 최근 사진·스크린샷 6장을 맥의 `~/PhoneDrop/from-phone`으로. 썸네일을 끌어서 바로 다른 앱에 놓을 수 있어요.
- **빠른 버튼**: 📚 단어 퀴즈(문제 카드 → 정답 카드) · 📝 요약 · ✅ 할 일(체크박스) · 📅 일정 · 📄 원문 그대로
- **짧은 메모는 글씨 자동 확대**: 한 장에 들어가는 만큼 최대 3배까지 키워서 화면을 채워요.
- **체크박스**: `- [ ] 할 일`, `- [x] 끝난 일`로 쓰면 네모 칸으로 그려요.
- **완료 알림**: 다른 창을 보고 있어도 전송이 끝나면 맥 알림으로 알려줘요 (처음에 알림 허용).

- **영상(mp4·mov 등)은 어느 모드든 AI를 거치지 않고 원본 그대로** 폰에 보내요. (최대 4GB, 큰 영상은 시간이 걸려요)
- ⌘V로 스크린샷을 바로 붙여넣을 수 있어요.
- 긴 글은 자동으로 여러 장으로 나뉘고 `1 / 3`처럼 번호가 붙어요.
- 보낸 이미지는 맥의 `~/PhoneDrop/날짜/` 폴더에도 복사본이 남아요. 폰 전송이 실패해도 여기 있어요.

## ☁️ Railway 배포 — 어디서든 쓰고, 집 맥이 폰에 넣어 주기

```
[어디서든 브라우저] → Railway(PhoneDrop 클라우드: AI 정리·카드 만들기·대기열)
                                   ↑ 5초마다 확인
                      [집 맥: 맥 도우미 bridge.mjs] ──USB──▶ [A13 갤러리]
```
클라우드에서 보낸 카드는 **대기열**에 쌓였다가, 집 맥에 폰이 연결되면 도우미가 자동으로 넣어요.
화면에 "📤 대기열에 넣었어요" → "✅ 폰에 도착했어요"로 바뀌어요.

### 1) GitHub에 올리기 (private 저장소)
```bash
cd ~/phonedrop
git init && git add . && git commit -m "PhoneDrop"
gh repo create phonedrop --private --source=. --push
```
`.env`(키·비밀번호)는 `.gitignore` 때문에 올라가지 않아요.

### 2) Railway에서
1. **New Project → Deploy from GitHub repo → phonedrop** (설정 파일 없이 `npm start`로 자동 실행돼요)
2. **Variables**에 추가
   - `GROQ_API_KEY` = Groq 키
   - `APP_PASSWORD` = 길고 아무도 모르는 비밀번호 (없으면 앱이 잠겨요)
3. **Volume 붙이기**: 서비스 오른쪽 클릭 → Attach Volume → 경로 `/data`
   (안 붙이면 재배포할 때 대기열이 지워져요)
4. **Settings → Networking → Generate Domain** → 주소 복사 (예: `https://phonedrop-production.up.railway.app`)
5. (선택) Settings → Healthcheck Path에 `/api/health`

### 3) 맥 도우미 연결
맥의 `.env`에 추가:
```
CLOUD_URL=https://(Railway 주소)
APP_PASSWORD=(Railway와 똑같은 비밀번호)
```
테스트: `npm run bridge` → `📱 폰이 연결됐어요`가 나오면 성공 (Control+C로 끄기)

### 4) 맥을 켜면 자동 실행
```bash
npm run bridge:install     # 설치 (앱 폴더가 다운로드·데스크탑·문서 폴더 안이면 홈으로 옮기라고 안내해요)
npm run bridge:log         # 무슨 일이 있었는지 보기
npm run bridge:uninstall   # 자동 실행 끄기
```
- 폰은 꽂을 때 **잠금 해제 + '파일 전송'** 모드로. 다 넣으면 맥 알림이 떠요.
- 클라우드 버전에서는 📥 폰 사진 가져오기 버튼이 숨겨져요 (맥에서 `npm start`로 쓸 때만 가능).
- 맥에서 `npm start`(맥 전용 모드)도 그대로 쓸 수 있어요.

## 오류가 날 때

| 화면 메시지 | 해결 |
|---|---|
| mtp-rs 없음 | `cargo install mtp-rs-cli` 실행, 또는 .env의 `MTP_BIN`에 경로 입력 |
| 폰을 찾지 못했어요 | 케이블 다시 연결 → 잠금 해제 → '파일 전송' 다시 선택 |
| 다른 앱이 폰을 쓰고 있어요 | OpenMTP·사진·이미지 캡처 종료(⌘+Q) |
| 저장소가 여러 개예요 | `mtp-rs info`로 번호 확인 → .env의 `PHONE_STORAGE`에 입력 |
| 보내는 중에 끊겼어요 | 폰 화면이 꺼지지 않게 하고 다시 보내기 |

직접 확인할 때: `mtp-rs devices --json`, `mtp-rs doctor`

## 파일 구조

- `server.mjs` — 서버: AI 호출, 카드·파일 전송(맥에선 바로 폰, 클라우드에선 대기열), 연결 확인, 도우미용 대기열 API
- `bridge.mjs` — 맥 도우미: 클라우드 대기열 → USB → 폰
- `lib/phone.mjs` — 폰(USB/MTP) 공용 코드
- `scripts/bridge-service.mjs` — 맥 도우미 자동 실행 설치/제거
- `public/index.html` — 채팅 화면 + 카드 이미지 그리기(캔버스, 1080×1920)
- `.env` — 키와 설정

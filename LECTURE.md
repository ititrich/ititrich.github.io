# AI 상품 하나를 실제로 파는 데까지 — 개발 전 과정 기록

> 자소서 첨삭 AI를 상품화해서 랜딩페이지 · API 서버 · 결제까지 붙인 실제 작업 기록입니다.
> 모든 숫자는 실측값이며, 막혔던 지점과 해결 방법을 그대로 남겼습니다.

- 판매 페이지: https://ititrich.github.io
- API 서버: `https://itresume-api.ititrich.workers.dev`
- 소스: https://github.com/ititrich/ititrich.github.io

---

## 1. 무엇을 만들었나

**상품**: AI 자소서 첨삭 리포트 / 29,000원 단일가

| 구분 | 내용 |
|---|---|
| 무료 | 점수 3개 + 가장 치명적인 문제 1개 + 수정안 1개 |
| 유료 | 점수 4개 + 전체 문항 첨삭 + 키워드 매칭표 + 면접질문 10개 |

무료 진단을 미끼로 쓰고, 그 자리에서 결제로 넘기는 구조입니다.
**같은 자소서를 다시 입력할 필요가 없다**는 점이 전환율의 핵심입니다.

---

## 2. 전체 구조

```
[사용자 브라우저]
      │
      │  ① 자소서 입력 → 무료 진단
      ▼
[GitHub Pages]  index.html / success.html / fail.html
      │            (정적 파일, 무료, 서버 없음)
      │
      │  ② POST /free          ③ POST /confirm  ④ POST /status
      ▼
[Cloudflare Workers]  ←── 여기에만 API 키가 있습니다
      │
      ├─────▶ [Claude API]         리포트 생성
      └─────▶ [토스페이먼츠 API]    결제 승인
```

**이 구조를 고른 이유**

- 서버를 직접 빌리지 않습니다. 트래픽이 0이면 비용도 0입니다.
- API 키가 브라우저에 절대 노출되지 않습니다. 키는 Cloudflare 금고에만 있습니다.
- 정적 페이지는 GitHub Pages가 무료로 전 세계에 배포해 줍니다.

---

## 3. 비용 구조 — 수익화의 핵심

### 고정비

| 항목 | 비용 |
|---|---|
| GitHub Pages | **0원** (공개 저장소) |
| Cloudflare Workers | **0원** (하루 10만 요청까지 무료) |
| 도메인 | 0원 (`github.io` 사용 시) |

**월 고정비 0원.** 팔리지 않으면 나가는 돈도 없습니다.

### 변동비 (1건당)

Claude Opus 5 요금은 입력 100만 토큰당 $5, 출력 100만 토큰당 $25입니다.

| 항목 | 추정 |
|---|---|
| 무료 진단 1건 | 약 50~80원 |
| 유료 리포트 1건 | 약 400~700원 |
| 결제 수수료 (카드 약 3%) | 약 850원 |

> 추정치입니다. 실제 토큰 사용량은 자소서 길이에 따라 달라지므로,
> 운영하면서 Anthropic 콘솔의 실제 사용량으로 다시 계산하셔야 합니다.

### 1건 판매 시 손익 (추정)

```
매출                  29,000원
─ 결제 수수료           -850원
─ 유료 리포트 API       -700원
─ 무료 진단 API (전환율 10% 가정, 10명분)  -800원
──────────────────────────────
추정 마진             약 26,650원  (약 92%)
```

**무료 진단 비용을 마케팅비로 봐야 합니다.** 10명이 무료로 써보고 1명이 결제해도
무료 진단 총비용은 800원 수준이라 마진에 거의 영향이 없습니다.
이것이 "무료 체험을 크게 열어도 되는" 근거입니다.

---

## 4. 파일 구성

```
itresume/
├── index.html          판매 페이지 (무료 진단 + 결제위젯)
├── success.html        결제 성공 → 리포트 생성 → 결과 표시
├── fail.html           결제 실패 안내
└── api/
    ├── src/index.js    Worker 서버 (전부 여기 한 파일)
    ├── wrangler.toml   배포 설정
    └── package.json
```

페이지 8개 섹션 순서 (전환율 기준으로 배치):

1. 히어로 — 한 문장 + 결제 버튼
2. 이런 분께 — 고객 고민 3가지
3. **무료 체험** — 여기서 가치를 먼저 증명
4. 결과 샘플 — 유료 리포트 미리보기
5. 가격 — 단일가 + 포함 항목 + 결제
6. 만든 사람 — 신뢰
7. FAQ 5개
8. 푸터 — 사업자정보

---

## 5. 핵심 코드

### 5-1. API 키를 절대 노출하지 않는 법

브라우저 코드에는 **서버 주소만** 둡니다.

```javascript
// index.html 맨 위
const CONFIG = {
  API_URL: "https://itresume-api.ititrich.workers.dev",
  TIMEOUT_MS: 30000,
  TOSS_CLIENT_KEY: "test_gck_...",   // 공개되어도 되는 키
};
```

키는 Worker의 환경변수로만 읽습니다.

```javascript
// api/src/index.js
const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": apiKey,                    // 코드에 키가 없습니다
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM_PROMPT, messages: [...] }),
});
```

키 등록은 코드가 아니라 명령어로 합니다.

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

### 5-2. CORS — 내 페이지에서만 호출되게

이걸 안 하면 남이 내 API를 자기 사이트에 붙여서 내 돈으로 씁니다.

```javascript
const ALLOWED_ORIGINS = ["https://ititrich.github.io"];

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// 프리플라이트(OPTIONS) 처리는 필수입니다
if (request.method === "OPTIONS") {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}
```

### 5-3. JSON 응답을 보장받는 법

프롬프트에 "JSON만 출력"이라고 써도 모델이 앞뒤에 설명을 붙일 때가 있습니다.
**구조화 출력(structured outputs)** 으로 형식을 강제하면 깨질 일이 없습니다.

```javascript
body = {
  model: "claude-opus-5",
  max_tokens: 4000,
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: userText }],
  output_config: {
    effort: "low",
    format: { type: "json_schema", schema: SCHEMA },   // 이 줄이 핵심
  },
};
```

스키마 규칙 2가지:
- 모든 object에 `additionalProperties: false` 가 있어야 합니다
- `minimum` / `maxLength` 같은 제약은 지원하지 않습니다

### 5-4. 무료/유료를 프롬프트 하나로 나누기

시스템 프롬프트는 하나만 두고, 사용자 메시지에 `mode` 를 실어 보냅니다.

```javascript
const userText =
  `mode: "${route.mode}"\n` +           // "free" 또는 "paid"
  `지원 직무: ${job}\n\n` +
  `--- 자소서 ---\n${text}`;
```

```
[무료 모드일 때 (mode: "free")]
· 점수 3개 + 가장 치명적인 문제 1개만
· keywords 와 questions 는 비워 둘 것
· next 에 "나머지는 상세 리포트에서 드립니다" 한 줄

[유료 모드일 때 (mode: "paid")]
· 점수 4개 전부, fixes 최소 10개, questions 정확히 10개
```

**무료에서 일부러 남겨두는 것이 유료 전환 장치입니다.**

### 5-5. 결제 승인은 반드시 서버에서

브라우저가 "결제했어요"라고 말하는 걸 믿으면 안 됩니다.
토스에 직접 물어봐야 합니다.

```javascript
const PRICE = 29000;   // 서버가 가진 정가

// ① 요청 금액이 정가와 다르면 즉시 거절
if (amount !== PRICE) {
  return fail("결제 금액이 올바르지 않습니다.", 400, origin);
}

// ② 토스에 승인 요청 (시크릿 키는 환경변수로만)
const auth = btoa(String(env.TOSS_SECRET_KEY).trim() + ":");
const res = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
  method: "POST",
  headers: {
    Authorization: "Basic " + auth,
    "Content-Type": "application/json",
    "Idempotency-Key": orderId,        // 중복 승인 방지
  },
  body: JSON.stringify({ paymentKey, orderId, amount }),
});
if (!res.ok) throw new Error("승인 실패");

// ③ 토스가 알려준 실제 결제 금액도 다시 확인
const payment = await res.json();
if (Number(payment.totalAmount) !== PRICE) {
  return fail("결제 금액이 올바르지 않습니다.", 400, origin);
}

// ④ 여기까지 왔을 때만 리포트를 만듭니다
```

**금액을 3번 확인합니다.** 화면의 금액을 조작해도 통과하지 못합니다.

### 5-6. 중복 생성 방지

결제 성공 페이지를 새로고침하면 승인 요청이 다시 갑니다.
그때마다 리포트를 새로 만들면 건당 수백 원씩 그냥 나갑니다.

Durable Object에 주문번호별로 상태를 저장해 한 번만 만들게 합니다.

```javascript
const existing = await (await stub.fetch("https://order.local/get")).json();

if (existing.status === "done")       return 기존리포트_그대로_반환;
if (existing.status === "generating") return { status: "generating" };
// 처음 온 요청일 때만 생성 시작
```

---

## 6. 배포 절차

### 서버 (최초 1회)

```bash
cd C:\itresume\api
```
```bash
npm install
```
```bash
npx wrangler login
```
```bash
npx wrangler secret put ANTHROPIC_API_KEY
```
```bash
npx wrangler secret put TOSS_SECRET_KEY
```
```bash
npx wrangler deploy
```

### 이후 수정할 때

```bash
npx wrangler deploy            # 서버를 고쳤을 때 (api 폴더에서)
```
```bash
git add -A; git commit -m "수정"; git push    # 페이지를 고쳤을 때
```

### 문제가 생기면

```bash
npx wrangler tail              # 실시간 서버 로그
```

---

## 7. 실제로 막혔던 지점 7가지

여기가 이 문서에서 가장 쓸모 있는 부분입니다. 전부 실제로 겪은 것들입니다.

### ① API 키가 1글자로 저장됨

**증상**: 모든 호출이 실패. 로그에는 `status=400`, 본문은 비어 있음.

**원인**: PowerShell에서 키를 붙여넣을 때 **Ctrl+V를 누르면 붙여넣기가 안 되고
제어문자(`0x16`)가 입력**됩니다. 키가 그 한 글자로 저장돼 있었습니다.

**해결**: 오른쪽 마우스 클릭으로 붙여넣기. (또는 `Ctrl+Shift+V`)

> 진단 팁: 키 길이를 로그로 찍어보면 1초 만에 알 수 있습니다.
> 정상 키는 100자가 넘습니다.

### ② Anthropic 키가 워크스페이스에 소속되지 않음

**증상**: `This API key is not scoped to a workspace`

**원인**: 콘솔에서 키를 만들 때 Workspace를 지정하지 않으면 조직 전체 키가 발급됩니다.

**해결**: 키 생성 시 **Workspace를 반드시 지정**하세요. 사용량 관리도 편해집니다.

### ③ `compatibility_date` 를 오늘 날짜로 쓰면 배포 실패

**증상**: `Can't set compatibility date in the future`

**원인**: Cloudflare는 UTC 기준입니다. 한국 시간으로 오늘이어도 UTC로는 어제입니다.

**해결**: 날짜를 하루 이상 앞당겨 씁니다.

```toml
compatibility_date = "2026-09-01"
```

### ④ Cloudflare 기본 Rate Limit이 동작하지 않음

**증상**: `[[ratelimits]]` 를 설정했는데 한계값을 1로 낮춰도 계속 통과.

**해결**: **Durable Object로 직접 구현**했습니다. IP마다 카운터가 하나씩 생겨
요청 시각을 기록하는 방식입니다. 서버가 여러 대로 늘어나도 정확히 셉니다.

> 처음엔 메모리 `Map` 으로 만들었다가 실패했습니다.
> Cloudflare는 요청을 여러 서버에 분산시켜서 카운트가 공유되지 않습니다.

### ⑤ 이메일 인증 전에는 Worker를 만들 수 없음

**증상**: `You need to verify your email address to use Workers` (code 10034)

**함정**: 이메일 인증 후에도 **같은 에러가 계속 났습니다.** wrangler가 인증 전에
발급받은 토큰을 들고 있어서입니다.

**해결**: `npx wrangler logout` → `npx wrangler login` 으로 토큰 재발급.

### ⑥ 프롬프트 명세끼리 충돌

`A4 8~12장 분량` 과 `없는 경험·수치를 지어내지 말 것` 을 함께 넣었더니
**모델이 후자를 우선해서 A4 4장에서 멈췄습니다.**

자소서 입력을 3배로 늘려도 4장이었습니다. 지어내지 않고는 8장을 채울 수 없으니
올바른 판단입니다.

**해결**: 분량 대신 **항목 수**로 기준을 바꿨습니다.

```
· 분량을 억지로 늘리지 말 것. 대신 아래 항목 수를 반드시 채울 것
  - fixes: 고칠 문장을 빠짐없이, 최소 10개
  - keywords: "있음"과 "없음" 각각 최소 5개
  - questions: 정확히 10개
```

**결과**: 항목 수 전부 충족 + 생성 시간도 104초 → 72초로 단축.

> 교훈: 프롬프트에 서로 모순되는 지시를 넣으면 모델이 하나를 버립니다.
> 분량보다 **검증 가능한 항목 수**로 지시하는 편이 안정적입니다.

### ⑦ 토스 키는 세트로 맞춰야 함

결제위젯을 쓰면 **결제위젯 연동 키(주문서형)** 를 써야 합니다.
API 개별 연동 키와 섞으면 `INVALID_API_KEY` 가 납니다.

| 키 | 형태 | 보관 위치 |
|---|---|---|
| 클라이언트 키 | `test_gck_...` | 페이지에 직접 (공개 키) |
| 시크릿 키 | `test_gsk_...` | Cloudflare 금고 (절대 노출 금지) |

문서용 데모 키(`test_gck_docs_`)는 일부 결제수단에 제약이 있습니다.
**제대로 테스트하려면 본인 테스트 키를 발급받으세요.**
토스페이먼츠는 사업자등록증 없이도 가입해서 테스트 키를 받을 수 있습니다.

---

## 8. 보안 체크리스트

판매를 시작하기 전에 반드시 확인하세요.

- [x] API 키가 브라우저 코드에 없는가
- [x] 시크릿 키가 GitHub에 올라가 있지 않은가
- [x] CORS가 내 도메인만 허용하는가
- [x] 결제 금액을 서버에서 검증하는가
- [x] 승인 실패 시 상품이 제공되지 않는가
- [x] 같은 주문번호로 두 번 지급되지 않는가
- [x] 에러 메시지에 내부 정보가 노출되지 않는가
- [x] 요청 크기 제한이 있는가 (8,000자)
- [x] IP당 호출 횟수 제한이 있는가 (1분 5회)
- [x] **유료 API가 결제 없이 호출될 수 없는가**

마지막 항목이 가장 위험합니다.
처음엔 `/report` 가 열려 있어서 **주소만 알면 29,000원짜리 리포트를 공짜로**
받을 수 있었습니다. 결제 경로를 만든 뒤 외부 노출을 차단했습니다.

```javascript
// 유료 경로를 ROUTES에서 제거 → 외부에서 호출 불가
// 결제 승인된 주문에 대해서만 내부에서 생성
const ROUTES = {
  "/free": { ... },
  // "/report" 없음
};
```

---

## 9. 실측 데이터

### 응답 시간

| 경로 | 측정값 |
|---|---|
| 무료 진단 | 13.6초 / 17.3초 |
| 유료 리포트 | 72초 / 101초 / 104초 |

무료는 `effort: "low"`, 유료는 `effort: "high"` 로 설정한 결과입니다.

### 유료 리포트 산출물 (자소서 1,300자 입력 기준)

| 항목 | 결과 |
|---|---|
| 문장 단위 수정안 | 13개 |
| 키워드 매칭 | 있음 7개 / 없음 10개 |
| 예상 면접질문 | 10개 (답변 뼈대 포함) |
| 분량 | A4 약 4장 |

### 설계에 반영한 점

- 유료 리포트가 70초 이상 걸리므로 **응답을 기다리지 않는 구조**로 만들었습니다.
  승인 즉시 "생성 중"을 반환하고, 결과 화면이 3초마다 확인합니다.
- 무료 진단 타임아웃은 20초로 잡았다가 **30초로 늘렸습니다.**
  실측 17초와의 여유가 너무 적어 정상 요청이 끊길 수 있었습니다.

---

## 10. 남은 과제

| 과제 | 내용 |
|---|---|
| 실제 결제 1회 통과 | 데모 키 제약으로 미완료. 본인 테스트 키 발급 필요 |
| 상점 키 교체 | 현재는 토스 문서용 데모 키. 실제 입금이 되지 않음 |
| 사업자 정보 | 푸터 사업자정보 칸이 비어 있음 |
| 리포트 메일 발송 | 도메인 구입 필요. 결과 조회 링크 방식이 대안 |

---

## 11. 이 프로젝트에서 얻은 교훈 5가지

**1. 서버 비용 0원으로 시작할 수 있습니다.**
Cloudflare Workers + GitHub Pages 조합이면 팔리기 전까지 나가는 돈이 없습니다.

**2. 무료 체험은 생각보다 싸게 열 수 있습니다.**
무료 진단 1건에 50~80원입니다. 10명이 써보고 1명이 결제해도 마진 92%입니다.

**3. 프롬프트에 모순된 지시를 넣지 마세요.**
"분량을 채워라"와 "지어내지 마라"는 충돌합니다. 검증 가능한 **항목 수**로 지시하세요.

**4. 결제는 반드시 서버에서 검증하세요.**
브라우저가 보내는 금액을 믿으면 100원에 상품을 팔게 됩니다.

**5. 유료 API를 열어두지 마세요.**
결제 경로를 만들기 전에 유료 기능이 공개돼 있으면, 주소를 아는 사람은 전부 공짜로 씁니다.

---

*이 문서의 모든 수치는 실제 측정값입니다. 비용 항목만 공개 요금표 기준 추정치입니다.*

/* ============================================================
   AI 자소서 첨삭 리포트 - API 서버 (Cloudflare Workers)

   경로
     POST /free    무료 간이진단
     POST /report  유료 상세 리포트

   요청 본문(JSON)
     { "text": "자소서 내용", "job": "백엔드 개발" }   // job 은 선택

   응답(JSON)
     성공: { "ok": true,  "result": "결과 텍스트" }
     실패: { "ok": false, "error": "짧은 안내 문구" }
   ============================================================ */

/* ---------- 맨 위 상수 (여기만 고치면 됩니다) ---------- */

// 사용할 Claude 모델
const MODEL = "claude-opus-5";

// 내 GitHub Pages 주소. 끝에 / 를 붙이지 마세요.
const ALLOWED_ORIGINS = [
  "https://ititrich.github.io",
  // 로컬에서 테스트할 때만 아래 줄 앞의 // 를 지우세요.
  // "http://localhost:8000",
];

// 요청 본문 최대 글자 수
const MAX_BODY_CHARS = 8000;

// 같은 IP 기준: 1분(60초) 안에 5번까지 허용
const RATE_LIMIT_COUNT = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/* ---------- Claude 호출 규격 ---------- */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// 모델이 요청을 거절했을 때 서버가 알아서 다른 모델로 재시도하게 해주는 옵션
const ANTHROPIC_BETA = "server-side-fallback-2026-07-01";

/* ---------- 프롬프트 ---------- */

const SYSTEM_FREE = `너는 IT 취업 자소서를 첨삭하는 8년차 현업 개발자다.
사용자가 보낸 자소서 일부를 읽고 "무료 간이진단"을 한국어로 작성한다.

형식을 정확히 지켜라.

[진단 요약]
한 문장으로 현재 상태를 평가한다.

[가장 약한 점 3가지]
1. (문제) - (왜 문제인지 한 줄)
2. ...
3. ...

[한 문장만 고쳐본 예시]
원문: (사용자 문장 중 하나를 그대로 인용)
수정: (고친 문장)

규칙
- 전체 500자 이내로 짧게 쓴다.
- 전체 문장을 다 고쳐주지 않는다. 맛보기 수준까지만 한다.
- 칭찬만 하지 말고 고칠 점을 구체적으로 짚는다.
- 마크다운 기호(#, *, -)는 쓰지 않는다. 대괄호 제목과 줄바꿈만 쓴다.`;

const SYSTEM_REPORT = `너는 IT 취업 자소서를 첨삭하는 8년차 현업 개발자다.
사용자가 보낸 자소서 전체를 읽고 "유료 상세 리포트"를 한국어로 작성한다.

아래 4개 항목을 순서대로, 빠짐없이 작성한다.

[1. 전체 문항 첨삭]
문항별로 무엇이 문제이고 어떻게 고쳐야 하는지 구체적으로 쓴다.

[2. 첨삭 전후 비교]
중요한 문장 5개 이상을 골라 아래 형식으로 쓴다.
원문: (그대로 인용)
수정: (고친 문장)
이유: (한 줄)

[3. 직무 키워드 리포트]
지원 직무 기준으로 자소서에 들어갔어야 하는데 빠진 키워드를 5개 이상 뽑고,
각각 어느 문단에 어떻게 넣으면 되는지 한 줄씩 붙인다.

[4. 예상 면접질문 10개]
이 자소서를 읽은 면접관이 실제로 던질 질문 10개를 번호를 붙여 쓴다.
막연한 질문 말고, 자소서에 적힌 내용을 근거로 파고드는 질문으로 쓴다.

규칙
- 추상적인 조언("구체적으로 쓰세요") 금지. 실제 고친 문장을 보여준다.
- 사용자가 쓰지 않은 경력이나 수치를 지어내지 않는다.
  숫자가 필요한 자리는 (숫자 기입) 처럼 빈칸으로 남긴다.
- 마크다운 기호(#, *, -)는 쓰지 않는다. 대괄호 제목과 줄바꿈만 쓴다.`;

/* ---------- IP 제한 ---------- */

/* IP 하나마다 이 카운터가 하나씩 만들어집니다.
   호출 시각을 기록해두고, 1분 안에 5번을 넘겼는지 판단합니다. */
export class RateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    const now = Date.now();
    const saved = (await this.state.storage.get("times")) || [];
    const times = saved.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);

    const limited = times.length >= RATE_LIMIT_COUNT;
    if (!limited) {
      times.push(now);
      await this.state.storage.put("times", times);
      // 창이 지나면 저장소를 자동으로 비웁니다.
      await this.state.storage.setAlarm(now + RATE_LIMIT_WINDOW_MS);
    }

    return new Response(JSON.stringify({ limited }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}

async function isRateLimited(env, ip) {
  try {
    const id = env.RATE_LIMIT_DO.idFromName(ip);
    const stub = env.RATE_LIMIT_DO.get(id);
    const res = await stub.fetch("https://ratelimit.local/check");
    const data = await res.json();
    return data.limited === true;
  } catch (e) {
    // 카운터에 문제가 생겨도 서비스 자체는 계속 동작하게 둡니다.
    console.error("ratelimit failed", e?.message);
    return false;
  }
}

/* ---------- CORS ---------- */

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // 허용 목록에 있는 주소일 때만 허가 헤더를 붙입니다.
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

function fail(message, status, origin) {
  return json({ ok: false, error: message }, status, origin);
}

/* ---------- Claude 호출 ---------- */

async function callClaude(env, { system, userText, maxTokens, effort }) {
  // 키를 등록할 때 줄바꿈이나 공백이 섞여 들어가는 경우가 있어 정리합니다.
  const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();
  if (apiKey.length !== String(env.ANTHROPIC_API_KEY || "").length) {
    console.error("apiKey had surrounding whitespace (trimmed)");
  }

  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userText }],
    fallbacks: "default",
  };
  if (effort) body.output_config = { effort };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,   // 키는 절대 코드에 쓰지 않습니다
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_BETA,
      // 워크스페이스에 소속되지 않은 키를 쓰는 경우에만 필요합니다.
      // (ANTHROPIC_WORKSPACE_ID 를 등록하지 않았으면 이 줄은 무시됩니다)
      ...(env.ANTHROPIC_WORKSPACE_ID
        ? { "anthropic-workspace-id": String(env.ANTHROPIC_WORKSPACE_ID).trim() }
        : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    // 내부 메시지는 로그에만 남기고 사용자에게는 노출하지 않습니다.
    let detail = "";
    try {
      detail = await res.text();
    } catch (e) {
      detail = "(본문 읽기 실패: " + e.message + ")";
    }
    console.error(
      "anthropic error status=" + res.status + " body=" + detail.slice(0, 800)
    );
    const error = new Error("upstream");
    error.upstreamStatus = res.status;
    throw error;
  }

  const data = await res.json();

  // 모델이 요청을 거절한 경우
  if (data.stop_reason === "refusal") {
    console.error("refusal", JSON.stringify(data.stop_details || {}));
    const error = new Error("refusal");
    error.refusal = true;
    throw error;
  }

  // 응답에서 텍스트 블록만 뽑습니다.
  const text = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) {
    console.error("empty content", JSON.stringify(data).slice(0, 500));
    throw new Error("empty");
  }

  return text;
}

/* ---------- 요청 처리 ---------- */

const ROUTES = {
  "/free": {
    system: SYSTEM_FREE,
    maxTokens: 4000,
    effort: "low",          // 간이진단은 가볍고 빠르게
  },
  "/report": {
    system: SYSTEM_REPORT,
    maxTokens: 16000,
    effort: "high",         // 상세 리포트는 충분히 깊게
  },
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // 1) 프리플라이트(OPTIONS) 처리
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 2) 허용하지 않은 주소에서 온 요청은 거절
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return fail("허용되지 않은 접근입니다.", 403, origin);
    }

    // 3) 경로 확인
    const route = ROUTES[path];
    if (!route) {
      return fail("없는 주소입니다.", 404, origin);
    }
    if (request.method !== "POST") {
      return fail("잘못된 요청 방식입니다.", 405, origin);
    }

    // 4) 서버 설정 확인 (키가 등록되지 않은 경우)
    if (!env.ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY is not set");
      return fail("서버 설정이 아직 완료되지 않았습니다.", 503, origin);
    }

    // 5) IP 제한
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (await isRateLimited(env, ip)) {
      const res = fail("요청이 너무 많습니다. 1분 뒤에 다시 시도해 주세요.", 429, origin);
      res.headers.set("Retry-After", "60");
      return res;
    }

    // 6) 본문 읽기 + 글자 수 제한
    let raw;
    try {
      raw = await request.text();
    } catch {
      return fail("요청을 읽을 수 없습니다.", 400, origin);
    }

    if (raw.length > MAX_BODY_CHARS) {
      return fail(`내용이 너무 깁니다. ${MAX_BODY_CHARS}자 이내로 줄여 주세요.`, 400, origin);
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return fail("요청 형식이 올바르지 않습니다.", 400, origin);
    }

    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    const job = typeof payload?.job === "string" ? payload.job.trim() : "";

    if (text.length < 30) {
      return fail("자소서 내용을 30자 이상 입력해 주세요.", 400, origin);
    }

    // 7) Claude 호출
    const userText = job
      ? `지원 직무: ${job}\n\n--- 자소서 ---\n${text}`
      : `지원 직무: (미입력 - IT 개발 직무 기준으로 판단할 것)\n\n--- 자소서 ---\n${text}`;

    try {
      const result = await callClaude(env, {
        system: route.system,
        userText,
        maxTokens: route.maxTokens,
        effort: route.effort,
      });
      return json({ ok: true, result }, 200, origin);
    } catch (err) {
      // 내부 오류 내용은 로그로만 남기고, 사용자에게는 짧은 안내만 보냅니다.
      console.error("handler error", path, err?.message);

      if (err?.refusal) {
        return fail("이 내용은 처리할 수 없습니다. 자소서 본문만 입력해 주세요.", 422, origin);
      }
      if (err?.upstreamStatus === 429) {
        return fail("지금 이용자가 많습니다. 잠시 뒤에 다시 시도해 주세요.", 503, origin);
      }
      return fail("처리 중 문제가 생겼습니다. 잠시 뒤에 다시 시도해 주세요.", 502, origin);
    }
  },
};

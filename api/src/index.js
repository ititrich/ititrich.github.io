/* ============================================================
   AI 자소서 첨삭 리포트 - API 서버 (Cloudflare Workers)

   경로
     POST /free    무료 간이진단   (mode: "free")
     POST /report  유료 상세 리포트 (mode: "paid")

   요청 본문(JSON)
     { "text": "자소서 내용", "job": "백엔드 개발" }   // job 은 선택

   응답(JSON)
     성공: { "ok": true,  "result": { ...아래 [출력 형식] 구조... } }
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

/* ============================================================
   SYSTEM_PROMPT
   ============================================================ */

const SYSTEM_PROMPT = `당신은 IT 기업 채용 담당자 출신 자소서 첨삭 전문가입니다.
서류 3만 건을 검토한 경험으로 평가합니다.

[평가 기준] 각 100점
1 구체성 - 숫자·기간·역할이 드러나는가
2 직무적합 - 지원 직무 키워드와 맞는가
3 논리 - 질문에 실제로 답하고 있는가
4 가독성 - 첫 두 문장에서 읽히는가

[반드시 할 것]
· 점수마다 근거 한 줄을 붙일 것 (score_reasons 에 기록)
· 문장 단위로 "원문 → 수정안 → 이유" (fixes 의 before/after/why)
· 수정안은 지원자가 쓴 사실만 재배열

[절대 금지]
· 없는 경험·수치를 지어내지 말 것
· "좋습니다" 같은 뭉뚱그린 칭찬 금지
· 합격을 보장하는 표현 금지

[무료 모드일 때 (mode: "free")]
· 점수 3개(구체성·직무적합·논리) + 가장 치명적인 문제 1개만
· 수정안은 한 문장만 예시로 (fixes 는 1개)
· keywords 와 questions 는 비워 둘 것
· next 에 "나머지 문항 첨삭과 면접질문은 상세 리포트에서 드립니다" 한 줄

[유료 모드일 때 (mode: "paid")]
· 점수 4개 전부
· 전 문항 첨삭 (문장 단위 수정안). fixes 를 충분히 많이 채울 것
· fixes 의 before/after 가 곧 첨삭 전/후 비교본이 된다
· 직무 키워드 매칭표 (keywords 의 "있음" / "없음")
· 예상 면접질문 10개 + 답변 뼈대 (questions 에 10개)
· 전체 분량은 A4 기준 8~12장에 해당하는 양으로 작성할 것
· next 는 빈 문자열

[출력 형식]
JSON만 출력. 앞뒤 설명 문장 금지.`;

/* ---------- 출력 형식(스키마) ---------- */

const FIX_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["before", "after", "why"],
  properties: {
    before: { type: "string" },
    after: { type: "string" },
    why: { type: "string" },
  },
};

const QUESTION_ITEM = {
  type: "object",
  additionalProperties: false,
  required: ["질문", "답변뼈대"],
  properties: {
    질문: { type: "string" },
    답변뼈대: { type: "string" },
  },
};

const KEYWORDS = {
  type: "object",
  additionalProperties: false,
  required: ["있음", "없음"],
  properties: {
    있음: { type: "array", items: { type: "string" } },
    없음: { type: "array", items: { type: "string" } },
  },
};

function buildSchema(scoreKeys) {
  const scoreProps = {};
  const reasonProps = {};
  for (const key of scoreKeys) {
    scoreProps[key] = { type: "integer" };
    reasonProps[key] = { type: "string" };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["scores", "score_reasons", "summary", "fixes", "keywords", "questions", "next"],
    properties: {
      scores: {
        type: "object",
        additionalProperties: false,
        required: scoreKeys,
        properties: scoreProps,
      },
      // 점수마다 근거 한 줄
      score_reasons: {
        type: "object",
        additionalProperties: false,
        required: scoreKeys,
        properties: reasonProps,
      },
      summary: { type: "string" },
      fixes: { type: "array", items: FIX_ITEM },
      keywords: KEYWORDS,
      questions: { type: "array", items: QUESTION_ITEM },
      next: { type: "string" },
    },
  };
}

const SCHEMA_FREE = buildSchema(["구체성", "직무적합", "논리"]);
const SCHEMA_PAID = buildSchema(["구체성", "직무적합", "논리", "가독성"]);

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

// 응답이 길어도 연결이 끊기지 않도록 스트리밍으로 받아서 서버에서 합칩니다.
async function readStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let text = "";
  let stopReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;

      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      if (
        event.type === "content_block_delta" &&
        event.delta &&
        event.delta.type === "text_delta"
      ) {
        text += event.delta.text;
      } else if (event.type === "message_delta" && event.delta) {
        stopReason = event.delta.stop_reason || stopReason;
      } else if (event.type === "error") {
        console.error("stream error", JSON.stringify(event.error || {}));
        throw new Error("stream");
      }
    }
  }

  return { text, stopReason };
}

async function callClaude(env, { mode, userText, maxTokens, effort, schema }) {
  // 키를 등록할 때 줄바꿈이나 공백이 섞여 들어가는 경우가 있어 정리합니다.
  const apiKey = String(env.ANTHROPIC_API_KEY || "").trim();

  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText }],
    stream: true,
    fallbacks: "default",
    output_config: {
      effort,
      format: { type: "json_schema", schema },
    },
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey, // 키는 절대 코드에 쓰지 않습니다
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_BETA,
      // 워크스페이스에 소속되지 않은 키를 쓰는 경우에만 필요합니다.
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
      detail = "(본문 읽기 실패)";
    }
    console.error("anthropic error status=" + res.status + " body=" + detail.slice(0, 800));
    const error = new Error("upstream");
    error.upstreamStatus = res.status;
    throw error;
  }

  const { text, stopReason } = await readStream(res);

  // 모델이 요청을 거절한 경우
  if (stopReason === "refusal") {
    console.error("refusal mode=" + mode);
    const error = new Error("refusal");
    error.refusal = true;
    throw error;
  }

  // 분량 한도에 걸려 중간에 잘린 경우 (JSON 이 깨집니다)
  if (stopReason === "max_tokens") {
    console.error("truncated mode=" + mode + " len=" + text.length);
    const error = new Error("truncated");
    error.truncated = true;
    throw error;
  }

  const parsed = parseJson(text);
  if (!parsed) {
    console.error("json parse failed mode=" + mode + " head=" + text.slice(0, 300));
    throw new Error("badjson");
  }

  return parsed;
}

// 혹시 앞뒤에 설명 문장이 붙어 나와도 JSON 부분만 뽑아냅니다.
function parseJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // 계속 진행
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ---------- 요청 처리 ---------- */

const ROUTES = {
  "/free": {
    mode: "free",
    schema: SCHEMA_FREE,
    maxTokens: 4000,
    effort: "low", // 간이진단은 가볍고 빠르게
  },
  "/report": {
    mode: "paid",
    schema: SCHEMA_PAID,
    maxTokens: 48000, // A4 8~12장 분량을 담을 수 있는 크기
    effort: "high", // 상세 리포트는 충분히 깊게
  },
};

export default {
  async fetch(request, env) {
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
    const userText =
      `mode: "${route.mode}"\n` +
      `지원 직무: ${job || "(미입력 - IT 개발 직무 기준으로 판단할 것)"}\n\n` +
      `--- 자소서 ---\n${text}`;

    try {
      const result = await callClaude(env, {
        mode: route.mode,
        userText,
        maxTokens: route.maxTokens,
        effort: route.effort,
        schema: route.schema,
      });
      return json({ ok: true, result }, 200, origin);
    } catch (err) {
      // 내부 오류 내용은 로그로만 남기고, 사용자에게는 짧은 안내만 보냅니다.
      console.error("handler error", path, err?.message);

      if (err?.refusal) {
        return fail("이 내용은 처리할 수 없습니다. 자소서 본문만 입력해 주세요.", 422, origin);
      }
      if (err?.truncated) {
        return fail("자소서가 너무 길어 리포트를 완성하지 못했습니다. 조금 줄여서 다시 시도해 주세요.", 422, origin);
      }
      if (err?.upstreamStatus === 429) {
        return fail("지금 이용자가 많습니다. 잠시 뒤에 다시 시도해 주세요.", 503, origin);
      }
      return fail("처리 중 문제가 생겼습니다. 잠시 뒤에 다시 시도해 주세요.", 502, origin);
    }
  },
};

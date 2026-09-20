const { useState, useEffect, useRef, useMemo } = React;

/* 서버 주소 (Google Apps Script 웹 앱 URL). 비어 있으면 이 기기 안에서만 동작합니다. */
const SYNC_URL = window.EXAM_SYNC_URL || "";

/* ══════════════════════════════════════════════════════════════
   시험지 v2 — 문제를 만들어 코드로 나누고, 바로 채점 결과를 봅니다.

   v1 대비 개선점
   · Shell 을 컴포넌트 밖으로 이동 (매 렌더 리마운트 → 입력 포커스 상실 버그 수정)
   · 저장/공유 상태 추적: 저장 안 된 변경 경고, 공유본과 달라지면 배지 표시
   · 삭제 2단계 확인, 삭제 시 공유본·응시 기록도 함께 정리
   · 공유 코드 충돌 검사, 불러온 데이터 형식 검증
   · 문제별 해설, 문제 순서 이동, 시험지 복제, JSON 내보내기/가져오기
   · 응시: 이름 입력, 진행률 표시, 소요 시간, 미답 제출 확인
   · 결과: 해설 표시, 틀린 문제만 다시 풀기, 결과 텍스트 복사
   · 출제자용 응시 기록 보기, 홈에 최근 푼 시험지
   · 저장소 어댑터: claude.ai 저장소 → 브라우저 로컬 저장소 → 메모리 순으로 대체
   ══════════════════════════════════════════════════════════════ */

/* ── 색상 토큰 ───────────────────────────────── */
const C = {
  bg: "#EDF3FA",
  card: "#FFFFFF",
  ink: "#16325C",
  inkMid: "#38527D",
  sub: "#5C7092",
  line: "#D5E2F2",
  lineSoft: "#E8F0FA",
  accent: "#2F6FD0",
  accentSoft: "#E3EDFB",
  good: "#1C8A5E",
  goodSoft: "#E4F4EC",
  warn: "#A66A00",
  warnSoft: "#FFF4DD",
  bad: "#C4432C",
  badSoft: "#FBE9E5",
};

const FONT =
  "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

/* ── 저장소 어댑터 ───────────────────────────────
   claude.ai 아티팩트의 window.storage(개인/공유)를 우선 사용하고,
   없으면 localStorage, 그것도 안 되면 메모리에 보관합니다.
   shared=true 인 키는 코드 공유용(다른 사람이 읽음), false 는 내 것. */
const mem = {};
const LS_PREFIX = "exam-maker:";
const memKey = (k, shared) => (shared ? "s:" : "p:") + k;
const hasClaudeStorage = () =>
  typeof window !== "undefined" && window.storage && typeof window.storage.get === "function";
const hasLocal = () => {
  try {
    return typeof localStorage !== "undefined" && !!localStorage;
  } catch (e) {
    return false;
  }
};

const store = {
  mode() {
    return hasClaudeStorage() ? "claude" : hasLocal() ? "local" : "memory";
  },
  async get(key, shared = false) {
    if (hasClaudeStorage()) {
      try {
        const r = await window.storage.get(key, shared);
        return r && r.value != null ? r.value : null;
      } catch (e) {
        /* 아래 대체 저장소로 */
      }
    }
    if (hasLocal()) {
      try {
        const v = localStorage.getItem(LS_PREFIX + memKey(key, shared));
        if (v !== null) return v;
      } catch (e) {}
    }
    return mem[memKey(key, shared)] ?? null;
  },
  async set(key, value, shared = false) {
    mem[memKey(key, shared)] = value;
    let ok = false;
    if (hasClaudeStorage()) {
      try {
        await window.storage.set(key, value, shared);
        ok = true;
      } catch (e) {}
    }
    if (hasLocal()) {
      try {
        localStorage.setItem(LS_PREFIX + memKey(key, shared), value);
        ok = true;
      } catch (e) {}
    }
    return ok;
  },
  async del(key, shared = false) {
    delete mem[memKey(key, shared)];
    if (hasClaudeStorage()) {
      try {
        await window.storage.delete(key, shared);
      } catch (e) {}
    }
    if (hasLocal()) {
      try {
        localStorage.removeItem(LS_PREFIX + memKey(key, shared));
      } catch (e) {}
    }
  },
};


/* ── 서버 연동 (Apps Script) ─────────────────────
   서버 주소가 없으면 localStorage 로 같은 API 를 흉내 내어 한 기기 안에서 동작합니다. */
const syncUrl = () => {
  try { return localStorage.getItem(LS_PREFIX + "sync") || SYNC_URL; } catch (e) { return SYNC_URL; }
};
async function apiGet(params) {
  // 조회도 POST 로 보낸다: 토큰이 주소(브라우저 기록·로그)에 남지 않게
  return apiPost(params);
}
async function apiPost(body) {
  try {
    const a = authGet();
    const r = await fetch(syncUrl(), { method: "POST", body: JSON.stringify({ ...(a && a.token ? { token: a.token } : {}), ...body }) });
    return await r.json();
  } catch (e) { return { ok: false, error: "network" }; }
}
const serverRemote = {
  kind: "server",
  getQuiz: (code) => apiGet({ action: "quiz", code }),
  results: (code, key) => apiGet({ action: "results", code, key }),
  share: (code, key, quiz) => apiPost({ action: "share", code, key, quiz }),
  deleteQuiz: (code, key) => apiPost({ action: "delete", code, key }),
  submit: (code, entry) => apiPost({ action: "submit", code, entry }),
  clearResults: (code, key) => apiPost({ action: "clearResults", code, key }),
  generate: (params) => apiPost({ action: "generate", ...params }),
  genAvailable: async () => { const r = await apiGet({ action: "ping" }); return !!(r && r.ok && r.gen); },
  shList: (key) => apiGet({ action: "sh_list", key }),
  shDetail: (key, ws) => apiGet({ action: "sh_detail", key, ws }),
  shNote: (key, ws) => apiGet({ action: "sh_note", key, ws }),
  shUpload: (params) => apiPost({ action: "sh_upload", ...params }),
  shConfirm: (params) => apiPost({ action: "sh_confirm", ...params }),
  ping: () => apiGet({ action: "ping" }),
  setup: (b) => apiPost({ action: "setup", ...b }),
  login: (b) => apiPost({ action: "login", ...b }),
  logout: () => apiPost({ action: "logout" }),
  me: () => apiGet({ action: "me" }),
  changePw: (b) => apiPost({ action: "changePw", ...b }),
  userList: () => apiGet({ action: "userList" }),
  userCreate: (b) => apiPost({ action: "userCreate", ...b }),
  userUpdate: (b) => apiPost({ action: "userUpdate", ...b }),
  userDelete: (id) => apiPost({ action: "userDelete", id }),
  examList: () => apiGet({ action: "examList" }),
  examSave: (exam) => apiPost({ action: "examSave", exam }),
  examDelete: (id) => apiPost({ action: "examDelete", id }),
  myResults: () => apiGet({ action: "myResults" }),
  studentResults: (studentId) => apiGet({ action: "studentResults", studentId }),
  allResults: () => apiGet({ action: "allResults" }),
  resultDelete: (id) => apiPost({ action: "resultDelete", id }),
  reportGet: (studentId) => apiGet({ action: "reportGet", studentId }),
  reportRequest: (studentId) => apiPost({ action: "reportRequest", studentId }),
  workerKeySet: (key) => apiPost({ action: "workerKeySet", key }),
  usage: () => apiGet({ action: "usage" }),
};
const localRemote = {
  kind: "local",
  async getQuiz(code) {
    const raw = await store.get(`quiz:${code}`, true);
    if (!raw) return { ok: false, error: "not_found" };
    try { return { ok: true, code, quiz: JSON.parse(raw) }; } catch (e) { return { ok: false, error: "corrupt" }; }
  },
  async results(code) {
    const raw = await store.get(`results:${code}`, true);
    try { return { ok: true, items: raw ? JSON.parse(raw) : [] }; } catch (e) { return { ok: true, items: [] }; }
  },
  async share(code, key, quiz) {
    if (!code) { do { code = makeCode(); } while (await store.get(`quiz:${code}`, true)); key = uid() + uid(); }
    await store.set(`quiz:${code}`, JSON.stringify(quiz), true);
    return { ok: true, code, key };
  },
  async deleteQuiz(code) { await store.del(`quiz:${code}`, true); await store.del(`results:${code}`, true); return { ok: true }; },
  async submit(code, entry) {
    const r = await this.results(code);
    await store.set(`results:${code}`, JSON.stringify([{ id: uid(), ...entry, at: Date.now() }, ...r.items].slice(0, 300)), true);
    return { ok: true };
  },
  async clearResults(code) { await store.del(`results:${code}`, true); return { ok: true }; },
  async generate() { return { ok: false, error: "gen_local" }; },
  async genAvailable() { return false; },
  async shList() { return { ok: false, error: "sh_local" }; },
  async shDetail() { return { ok: false, error: "sh_local" }; },
  async shNote() { return { ok: false, error: "sh_local" }; },
  async shUpload() { return { ok: false, error: "sh_local" }; },
  async shConfirm() { return { ok: false, error: "sh_local" }; },
  // 로컬(서버 없음) 모드: 로그인 없이 관리자로 동작 — 개발·오프라인용
  async ping() { return { ok: true, gen: false, setup: false }; },
  async setup() { return { ok: false, error: "sh_local" }; },
  async login() { return { ok: true, token: "local", user: { id: "local", role: "admin", name: "로컬" } }; },
  async logout() { return { ok: true }; },
  async me() { return { ok: true, user: { id: "local", role: "admin", name: "로컬" } }; },
  async changePw() { return { ok: false, error: "sh_local" }; },
  async userList() { return { ok: true, users: [] }; },
  async userCreate() { return { ok: false, error: "sh_local" }; },
  async userUpdate() { return { ok: false, error: "sh_local" }; },
  async userDelete() { return { ok: false, error: "sh_local" }; },
  async examList() { return { ok: false, error: "sh_local" }; },
  async examSave() { return { ok: true }; },
  async examDelete() { return { ok: true }; },
  async myResults() { return { ok: true, items: [] }; },
  async studentResults() { return { ok: false, error: "sh_local" }; },
  async allResults() { return { ok: true, items: [] }; },
  async resultDelete() { return { ok: false, error: "sh_local" }; },
  async reportGet() { return { ok: false, error: "no_report" }; },
  async reportRequest() { return { ok: false, error: "sh_local" }; },
  async workerKeySet() { return { ok: false, error: "sh_local" }; },
  async usage() { return { ok: false, error: "sh_local" }; },
};
const remote = () => (syncUrl() ? serverRemote : localRemote);
const ERR = {
  network: "서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.",
  not_found: "그 코드로 등록된 시험지가 없습니다. 코드를 다시 확인해 주세요.",
  bad_key: "이 시험지를 고칠 권한이 없습니다. (다른 기기에서 만든 코드)",
  too_big: "시험지가 너무 큽니다. 문제 수를 줄여 주세요.",
  busy: "서버가 바쁩니다. 잠시 후 다시 시도해 주세요.",
  gen_disabled: "AI 생성 기능이 꺼져 있습니다. 관리자에게 문의하세요.",
  gen_not_configured: "서버에 AI 생성 설정(API 키·비밀번호)이 없습니다. 관리자에게 문의하세요.",
  gen_limit: "오늘 AI 생성 한도를 모두 썼습니다. 내일 다시 시도해 주세요.",
  gen_quota: "Gemini 무료 한도(분당·하루)를 넘었습니다. 잠시 뒤나 내일 다시 시도해 주세요.",
  refused: "이 범위로는 문제를 만들 수 없었습니다. 범위를 바꿔 보세요.",
  truncated: "결과가 너무 길어 잘렸습니다. 문제 수를 줄여 주세요.",
  gen_local: "서버가 연결되어 있어야 AI 생성을 쓸 수 있습니다.",
  sh_local: "서버가 연결되어 있어야 오답노트를 쓸 수 있습니다.",
  bad_login: "아이디 또는 비밀번호가 맞지 않습니다.",
  locked: "로그인 실패가 많아 15분 동안 잠겼습니다. 잠시 뒤 다시 시도해 주세요.",
  bad_pw: "비밀번호는 4자 이상이어야 합니다.",
  bad_token: "로그인이 풀렸습니다. 다시 들어와 주세요.",
  forbidden: "이 계정에는 권한이 없습니다.",
  bad_id: "아이디는 한글·영문·숫자·_ . - 로 2~30자입니다.",
  dup_id: "이미 있는 아이디입니다.",
  bad_teacher: "담당 선생 아이디가 없습니다.",
  self_delete: "자기 계정은 지울 수 없습니다(다른 관리자가 지워야 합니다).",
  self_demote: "자기 계정의 관리자 권한은 뺄 수 없습니다.",
  self_disable: "자기 계정은 정지할 수 없습니다.",
  already_setup: "이미 관리자가 있습니다. 로그인해 주세요.",
  no_report: "아직 리포트가 없습니다.",
  no_results: "응시 기록이 있어야 리포트를 만들 수 있습니다.",
  bad_key: "연결 코드가 올바르지 않습니다.",
  too_big: "사진이 너무 큽니다(9MB 이하).",
};
const errMsg = (r) => ERR[r && r.error] || (r && r.message ? `서버 오류: ${r.message}` : "요청에 실패했습니다. 잠시 후 다시 시도해 주세요.");

/* ── 유틸 ────────────────────────────────────── */
const uid = () => Math.random().toString(36).slice(2, 10);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeCode = () =>
  Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
const cleanCode = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
const range = (n) => [...Array(n).keys()];

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sameSet = (a, b) => {
  if (a.length !== b.length) return false;
  const s = new Set(b);
  return a.every((x) => s.has(x));
};

const fmtDate = (t) => {
  try {
    return new Date(t).toLocaleDateString("ko-KR", { year: "numeric", month: "short", day: "numeric" });
  } catch (e) {
    return "";
  }
};
const fmtDateTime = (t) => {
  try {
    return new Date(t).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return "";
  }
};
const fmtSec = (s) => {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${s % 60}초` : `${s}초`;
};

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫"];
const mark = (i) => CIRCLED[i] || `(${i + 1})`;

/* ── 데이터 정규화 ───────────────────────────── */
const asStr = (v) => (typeof v === "string" ? v : "");
const asIntList = (v, max) =>
  Array.isArray(v)
    ? [...new Set(v.filter((x) => Number.isInteger(x) && x >= 0 && x < max))].sort((a, b) => a - b)
    : [];

function normalizeQuestion(q, nOpt) {
  const src = q && typeof q === "object" ? q : {};
  const ownRaw = Array.isArray(src.options) ? src.options.map(asStr) : null;
  const own = ownRaw && ownRaw.length >= 2 ? ownRaw : null; // 문제별 보기 (없으면 공용 보기 사용)
  return {
    id: asStr(src.id) || uid(),
    text: asStr(src.text),
    explain: asStr(src.explain),
    options: own,
    answers: asIntList(src.answers, own ? own.length : nOpt),
  };
}

function normalizeExam(x) {
  const src = x && typeof x === "object" ? x : {};
  const options = Array.isArray(src.options) ? src.options.map(asStr) : [];
  while (options.length < 2) options.push("");
  const questionsRaw = Array.isArray(src.questions) && src.questions.length ? src.questions : [{}];
  return {
    id: asStr(src.id) || uid(),
    title: asStr(src.title),
    desc: asStr(src.desc),
    options,
    questions: questionsRaw.map((q) => normalizeQuestion(q, options.length)),
    shuffle: !!src.shuffle,
    code: asStr(src.code) || null,
    ownerKey: asStr(src.ownerKey) || null,
    sharedHash: asStr(src.sharedHash) || null,
    sharedAt: Number(src.sharedAt) || null,
    createdAt: Number(src.createdAt) || Date.now(),
    updatedAt: Number(src.updatedAt) || Date.now(),
  };
}

/* 공유 페이로드: 응시자가 받는 데이터 */
function payloadOf(exam) {
  return {
    v: 2,
    title: exam.title.trim(),
    desc: exam.desc.trim(),
    options: exam.options.map((o) => o.trim()),
    questions: exam.questions.map((q) => ({
      id: q.id,
      text: q.text.trim(),
      explain: q.explain.trim(),
      ...(q.options ? { options: q.options.map((o) => o.trim()) } : {}),
      answers: q.answers,
    })),
    shuffle: !!exam.shuffle,
  };
}
const hashOf = (exam) => JSON.stringify(payloadOf(exam));

function parsePayload(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const options = Array.isArray(data.options) ? data.options.map(asStr) : [];
  if (options.length < 2) return null;
  const questions = Array.isArray(data.questions) ? data.questions.map((q) => normalizeQuestion(q, options.length)) : [];
  if (!questions.length) return null;
  return {
    title: asStr(data.title) || "제목 없음",
    desc: asStr(data.desc),
    options,
    questions,
    shuffle: !!data.shuffle,
  };
}

function problemsOf(draft) {
  const out = [];
  if (!draft.title.trim()) out.push("시험지 제목을 적어 주세요.");
  const usesShared = draft.questions.some((q) => !q.options);
  if (usesShared && draft.options.some((o) => !o.trim())) out.push("비어 있는 보기가 있습니다.");
  const seen = new Set();
  if (usesShared) draft.options.forEach((o) => {
    const k = o.trim();
    if (k && seen.has(k)) out.push(`보기 “${k}”가 두 번 이상 있습니다.`);
    seen.add(k);
  });
  draft.questions.forEach((q, i) => {
    if (q.options && q.options.some((o) => !o.trim())) out.push(`${i + 1}번 문제의 보기 중 비어 있는 것이 있습니다.`);
    if (!q.text.trim()) out.push(`${i + 1}번 문제의 내용이 비어 있습니다.`);
    else if (q.answers.length === 0) out.push(`${i + 1}번 문제의 정답을 하나 이상 골라 주세요.`);
  });
  return out;
}

/* 응시 런타임 만들기: 문제마다 쓰는 보기를 확정하고(문제별 보기 또는 공용 보기),
   셔플이 켜져 있으면 보기·문제 순서를 섞은 뒤 정답 위치를 재계산합니다. */
function buildRun(src, code, onlyIds) {
  const shared = src.options;
  const sharedPerm = src.shuffle ? shuffled(range(shared.length)) : range(shared.length);
  let qs = src.questions.map((q) => {
    const own = Array.isArray(q.options) && q.options.length >= 2 ? q.options : null;
    const base = own || shared;
    const perm = own ? (src.shuffle ? shuffled(range(base.length)) : range(base.length)) : sharedPerm;
    const pos = {};
    perm.forEach((orig, disp) => (pos[orig] = disp));
    return {
      ...q,
      options: perm.map((i) => base[i]),
      answers: q.answers.map((a) => pos[a]).filter((x) => x != null).sort((x, y) => x - y),
    };
  });
  if (onlyIds) qs = qs.filter((q) => onlyIds.has(q.id));
  if (src.shuffle) qs = shuffled(qs);
  return {
    code,
    src,
    title: src.title,
    desc: src.desc,
    options: sharedPerm.map((i) => shared[i]),
    questions: qs,
    partial: !!onlyIds,
    startedAt: Date.now(),
  };
}

/* ── 공용 UI ─────────────────────────────────── */
function Btn({ children, onClick, kind = "primary", disabled, style, ariaLabel }) {
  const base = {
    fontFamily: FONT,
    fontSize: 16,
    fontWeight: 600,
    borderRadius: 12,
    padding: "13px 18px",
    cursor: disabled ? "default" : "pointer",
    border: "1px solid transparent",
    transition: "background .15s, border-color .15s",
    opacity: disabled ? 0.45 : 1,
    width: "100%",
  };
  const kinds = {
    primary: { background: C.accent, color: "#fff" },
    soft: { background: C.accentSoft, color: C.accent, border: `1px solid ${C.line}` },
    ghost: { background: "transparent", color: C.sub, border: `1px solid ${C.line}` },
    danger: { background: C.badSoft, color: C.bad, border: `1px solid ${C.badSoft}` },
  };
  return (
    <button
      className="em-btn"
      aria-label={ariaLabel}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{ ...base, ...kinds[kind], ...style }}
    >
      {children}
    </button>
  );
}

/* 테두리 없는 텍스트 버튼 */
function TextBtn({ children, onClick, disabled, style, ariaLabel, tone = "accent" }) {
  const color = disabled ? C.line : tone === "sub" ? C.sub : tone === "bad" ? C.bad : C.accent;
  return (
    <button
      className="em-btn"
      aria-label={ariaLabel}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        background: "none",
        border: "none",
        color,
        fontFamily: FONT,
        fontSize: 14.5,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        padding: 4,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function Field({ value, onChange, placeholder, multiline, style, maxLength, onEnter, ariaLabel, rows = 2, autoFocus, type = "text" }) {
  const s = {
    width: "100%",
    boxSizing: "border-box",
    fontFamily: FONT,
    fontSize: 16,
    color: C.ink,
    background: "#fff",
    border: `1px solid ${C.line}`,
    borderRadius: 10,
    padding: "12px 13px",
    outline: "none",
    resize: "vertical",
    lineHeight: 1.5,
    ...style,
  };
  const common = {
    className: "em-in",
    value,
    placeholder,
    maxLength,
    autoFocus,
    "aria-label": ariaLabel || placeholder,
    onChange: (e) => onChange(e.target.value),
    style: s,
  };
  if (multiline) return <textarea {...common} rows={rows} />;
  return (
    <input
      {...common}
      type={type}
      onKeyDown={(e) => {
        if (onEnter && e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

function Check({ on, size = 22 }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        borderRadius: 6,
        border: `1.5px solid ${on ? C.accent : C.line}`,
        background: on ? C.accent : "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontSize: size * 0.62,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {on ? "✓" : ""}
    </span>
  );
}

/* 체크박스처럼 동작하는 행 (키보드 접근 가능) */
function CheckRow({ on, onToggle, children, padding = "10px 12px", style }) {
  return (
    <div
      className="em-row"
      role="checkbox"
      aria-checked={on}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onToggle();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding,
        border: `1px solid ${on ? C.accent : C.line}`,
        background: on ? C.accentSoft : "#fff",
        borderRadius: 10,
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: 18, ...style }}>
      {children}
    </div>
  );
}

function Badge({ tone = "neutral", children }) {
  const tones = {
    neutral: { bg: C.lineSoft, fg: C.sub },
    accent: { bg: C.accentSoft, fg: C.accent },
    good: { bg: C.goodSoft, fg: C.good },
    warn: { bg: C.warnSoft, fg: C.warn },
    bad: { bg: C.badSoft, fg: C.bad },
  };
  const t = tones[tone];
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 12.5,
        fontWeight: 700,
        padding: "3px 9px",
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Modal({ title, children, onClose, wide }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(22,50,92,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 60,
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: wide ? 520 : 400 }}>
        <Card style={{ maxHeight: "86vh", overflowY: "auto" }}>
          {title && <h3 style={{ fontSize: 20, fontWeight: 800, margin: "0 0 10px" }}>{title}</h3>}
          {children}
        </Card>
      </div>
    </div>
  );
}

function ProgressBar({ value, max }) {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return (
    <div aria-label={`진행률 ${pct}%`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 6, background: C.lineSoft, borderRadius: 999, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: C.accent, transition: "width .2s" }} />
    </div>
  );
}

/* 화면 껍데기 — 반드시 컴포넌트 밖에 정의 (안에 두면 매 렌더마다 리마운트되어 입력 포커스가 사라짐) */
function Shell({ children, back, backTo, toast }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
      <style>{`
        .em-in:focus{border-color:${C.accent} !important;box-shadow:0 0 0 3px ${C.accentSoft};}
        .em-btn:focus-visible{outline:2px solid ${C.accent};outline-offset:2px;}
        .em-row:focus-visible{outline:2px solid ${C.accent};outline-offset:2px;}
        .em-row:hover{border-color:${C.accent};}
        @media (prefers-reduced-motion: reduce){*{transition:none !important;}}
      `}</style>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "22px 18px 60px" }}>
        {back && (
          <button
            className="em-btn"
            onClick={backTo}
            style={{ background: "none", border: "none", color: C.accent, fontFamily: FONT, fontSize: 15, fontWeight: 600, padding: "4px 0 14px", cursor: "pointer" }}
          >
            ← {back}
          </button>
        )}
        {children}
      </div>
      {toast && (
        <div
          role="status"
          style={{
            position: "fixed",
            left: "50%",
            bottom: 24,
            transform: "translateX(-50%)",
            background: C.ink,
            color: "#fff",
            padding: "12px 18px",
            borderRadius: 12,
            fontSize: 14.5,
            maxWidth: "88vw",
            textAlign: "center",
            zIndex: 70,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return false;
  }
}

/* ── 화면: 홈 ────────────────────────────────── */
function HomeScreen({ exams, recent, onNew, onList, onCode, onStudy, onOpenRecent, onSettings, mode, toast, user, onAdmin, onStudents, onMyResults, onAccount }) {
  const role = (user && user.role) || "admin";
  const items = [];
  items.push({ t: "새 시험지 만들기", d: "보기를 정하고 문제를 하나씩 추가합니다. AI로 만들 수도 있습니다.", go: onNew });
  items.push({ t: "내 시험지", d: exams.length ? `저장된 시험지 ${exams.length}개` : "아직 저장된 시험지가 없습니다.", go: onList });
  items.push({ t: "코드로 문제 풀기", d: role === "student" ? "선생님이 준 코드를 입력해 문제를 풉니다." : "받은 코드를 입력해 문제를 풉니다.", go: onCode });
  items.push({ t: "내 결과·리포트", d: "내가 푼 시험지의 점수·기록과 나의 분석 리포트를 봅니다.", go: onMyResults });
  if (role !== "student") items.push({ t: "내 학생", d: role === "admin" ? "모든 학생의 결과와 분석 리포트를 봅니다." : "담당 학생의 결과와 분석 리포트를 봅니다.", go: onStudents });
  items.push({ t: "오답노트", d: "푼 시험지 사진을 올리면 정답·해설·오답노트를 만들어 줍니다.", go: onStudy });
  if (role === "admin") items.push({ t: "관리자", d: "계정 등록·수정, 전체 기록 열람, 리포트 워커 연결.", go: onAdmin });
  return (
    <Shell toast={toast}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "16px 0 10px" }}>
        <h1 style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", margin: 0 }}>시험지</h1>
        {user && <TextBtn onClick={onAccount}>{user.name} · {ROLE_KO[user.role] || user.role}</TextBtn>}
      </div>
      <p style={{ fontSize: 16.5, lineHeight: 1.6, color: C.sub, margin: "0 0 6px" }}>
        문제를 만들어 코드로 나누고, 푼 사람은 바로 채점 결과를 봅니다.
      </p>
      <div style={{ height: 1, background: C.line, margin: "22px 0 24px" }} />
      <div style={{ display: "grid", gap: 12 }}>
        {items.map((it) => (
          <button
            key={it.t}
            className="em-btn em-row"
            onClick={it.go}
            style={{
              textAlign: "left",
              background: C.card,
              border: `1px solid ${C.line}`,
              borderRadius: 16,
              padding: "18px 18px",
              cursor: "pointer",
              fontFamily: FONT,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: C.ink, marginBottom: 5 }}>{it.t}</div>
            <div style={{ fontSize: 14.5, color: C.sub, lineHeight: 1.5 }}>{it.d}</div>
          </button>
        ))}
      </div>

      {recent.length > 0 && (
        <>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: "28px 0 10px", color: C.inkMid }}>최근 푼 시험지</h3>
          <Card style={{ padding: 6 }}>
            {recent.map((r) => (
              <button
                key={r.code}
                className="em-btn"
                onClick={() => onOpenRecent(r.code)}
                style={{
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  gap: 12,
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  borderRadius: 10,
                  padding: "10px 12px",
                  cursor: "pointer",
                  fontFamily: FONT,
                }}
              >
                <span style={{ fontWeight: 800, letterSpacing: "0.08em", color: C.accent, fontSize: 14, flex: "0 0 auto" }}>{r.code}</span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                <span style={{ fontSize: 13.5, color: C.sub, flex: "0 0 auto" }}>
                  {r.score}/{r.total}
                </span>
              </button>
            ))}
          </Card>
        </>
      )}

      <p style={{ fontSize: 12.5, color: C.sub, textAlign: "center", marginTop: 34, lineHeight: 1.6 }}>
        <a href="help.html" target="_blank" rel="noopener" style={{ color: C.sub }}>사용 설명서</a>
      </p>
    </Shell>
  );
}

/* ── 화면: 내 시험지 목록 ────────────────────── */
function ListScreen({ exams, onOpen, onNew, onDelete, onDuplicate, onImport, onExportAll, onBack, toast }) {
  const [confirmId, setConfirmId] = useState(null);
  return (
    <Shell back="처음으로" backTo={onBack} toast={toast}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <h2 style={{ fontSize: 25, fontWeight: 800, margin: 0 }}>내 시험지</h2>
        <div style={{ display: "flex", gap: 2 }}>
          <TextBtn onClick={onImport}>가져오기</TextBtn>
          {exams.length > 0 && <TextBtn onClick={onExportAll}>내보내기</TextBtn>}
        </div>
      </div>
      {exams.length === 0 ? (
        <Card>
          <p style={{ margin: "0 0 16px", color: C.sub, fontSize: 15.5, lineHeight: 1.6 }}>
            아직 만든 시험지가 없습니다. 새로 하나 만들거나, 내보낸 파일을 가져오세요.
          </p>
          <Btn onClick={onNew}>새 시험지 만들기</Btn>
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {exams.map((e) => {
            const stale = e.code && e.sharedHash !== hashOf(e);
            const confirming = confirmId === e.id;
            return (
              <Card key={e.id} style={{ padding: 16 }}>
                <button
                  className="em-btn"
                  onClick={() => onOpen(e.id)}
                  style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", fontFamily: FONT, width: "100%" }}
                >
                  <div style={{ fontSize: 17.5, fontWeight: 700, color: C.ink, marginBottom: 6 }}>{e.title || "제목 없음"}</div>
                  <div style={{ fontSize: 13.5, color: C.sub, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    <span>
                      문제 {e.questions.length}개 · 보기 {e.options.length}개 · {fmtDate(e.updatedAt)} 수정
                    </span>
                    {e.code && <Badge tone={stale ? "warn" : "good"}>{stale ? `코드 ${e.code} · 다시 공유 필요` : `코드 ${e.code}`}</Badge>}
                  </div>
                </button>
                <div style={{ display: "flex", gap: 4, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                  {confirming ? (
                    <>
                      <span style={{ fontSize: 14, color: C.bad, marginRight: 4 }}>
                        정말 삭제할까요?{e.code ? " 공유 코드도 사라집니다." : ""}
                      </span>
                      <TextBtn tone="bad" onClick={() => { setConfirmId(null); onDelete(e.id); }}>삭제</TextBtn>
                      <TextBtn tone="sub" onClick={() => setConfirmId(null)}>취소</TextBtn>
                    </>
                  ) : (
                    <>
                      <TextBtn onClick={() => onOpen(e.id)}>편집</TextBtn>
                      <TextBtn onClick={() => onDuplicate(e.id)}>복제</TextBtn>
                      <TextBtn tone="sub" onClick={() => setConfirmId(e.id)}>삭제</TextBtn>
                    </>
                  )}
                </div>
              </Card>
            );
          })}
          <Btn kind="soft" onClick={onNew}>새 시험지 만들기</Btn>
        </div>
      )}
    </Shell>
  );
}

/* ── 응시 기록 모달 (출제자용) ───────────────── */
function ResultsModal({ code, ownerKey, onClose, flash }) {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    const r = await remote().results(code, ownerKey);
    if (!r.ok) flash(errMsg(r));
    setItems(r.ok && Array.isArray(r.items) ? r.items : []);
    setBusy(false);
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const clear = async () => {
    const r = await remote().clearResults(code, ownerKey);
    if (!r.ok) return flash(errMsg(r));
    setItems([]);
    flash("응시 기록을 비웠습니다.");
  };

  const avg = items && items.length ? Math.round((items.reduce((s, r) => s + r.score / r.total, 0) / items.length) * 100) : 0;

  return (
    <Modal title={`응시 기록 · ${code}`} onClose={onClose} wide>
      {items === null ? (
        <p style={{ color: C.sub, fontSize: 15 }}>불러오는 중…</p>
      ) : items.length === 0 ? (
        <p style={{ color: C.sub, fontSize: 15, lineHeight: 1.6, margin: "0 0 14px" }}>
          아직 제출된 결과가 없습니다. 응시자가 문제를 제출하면 여기에 쌓입니다.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 14.5, color: C.sub, margin: "0 0 12px" }}>
            {items.length}명 응시 · 평균 {avg}점
          </p>
          <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
            {items.map((r) => (
              <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "9px 12px", background: C.lineSoft, borderRadius: 10, fontSize: 14.5 }}>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name || "이름 없음"}</span>
                <span style={{ color: C.inkMid, fontWeight: 700 }}>
                  {r.score}/{r.total}
                </span>
                <span style={{ color: C.sub, fontSize: 13 }}>{r.sec != null ? fmtSec(r.sec) : ""}</span>
                <span style={{ color: C.sub, fontSize: 13 }}>{fmtDateTime(r.at)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        <Btn kind="soft" onClick={load} disabled={busy}>새로고침</Btn>
        {items && items.length > 0 && <Btn kind="danger" onClick={clear}>기록 비우기</Btn>}
        <Btn kind="ghost" onClick={onClose}>닫기</Btn>
      </div>
    </Modal>
  );
}

/* ── 텍스트 보기/복사 모달 (내보내기) ────────── */
function ExportModal({ title, text, onClose, flash }) {
  return (
    <Modal title={title} onClose={onClose} wide>
      <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>
        아래 내용을 복사해 메모나 파일로 보관하세요. 다른 기기에서 “가져오기”에 붙여 넣으면 복원됩니다.
      </p>
      <textarea readOnly value={text} rows={8} className="em-in" aria-label="내보내기 데이터" style={{ width: "100%", boxSizing: "border-box", fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12.5, border: `1px solid ${C.line}`, borderRadius: 10, padding: 10, color: C.inkMid, resize: "vertical" }} />
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <Btn kind="soft" onClick={async () => flash((await copyText(text)) ? "복사했습니다." : "복사가 안 돼요. 직접 선택해서 복사해 주세요.")}>복사</Btn>
        <Btn kind="ghost" onClick={onClose}>닫기</Btn>
      </div>
    </Modal>
  );
}

function ImportModal({ onImport, onClose }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const go = () => {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      setErr("JSON 형식이 아닙니다. 내보내기로 만든 내용을 그대로 붙여 넣어 주세요.");
      return;
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.exams) ? data.exams : [data];
    const exams = list.filter((x) => x && typeof x === "object").map((x) => normalizeExam({ ...x, id: undefined }));
    if (!exams.length) {
      setErr("가져올 시험지를 찾지 못했습니다.");
      return;
    }
    onImport(exams);
  };
  return (
    <Modal title="시험지 가져오기" onClose={onClose} wide>
      <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>
        내보내기로 만든 내용을 붙여 넣으세요. 가져온 시험지는 새 항목으로 추가됩니다. 공유 코드와 수정 권한도 함께 옮겨집니다.
      </p>
      <Field multiline rows={7} value={text} onChange={(v) => { setText(v); setErr(""); }} placeholder='{"exams":[...]} 또는 시험지 하나' style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12.5 }} />
      {err && <p style={{ color: C.bad, fontSize: 14, margin: "10px 0 0", lineHeight: 1.5 }}>{err}</p>}
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <Btn onClick={go} disabled={!text.trim()}>가져오기</Btn>
        <Btn kind="ghost" onClick={onClose}>닫기</Btn>
      </div>
    </Modal>
  );
}


function SettingsModal({ onClose, flash }) {
  const [url, setUrl] = useState(() => { try { return localStorage.getItem(LS_PREFIX + "sync") || ""; } catch (e) { return ""; } });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const u = url.trim();
    if (u) {
      setBusy(true);
      const r = await fetch(u + "?action=ping", { cache: "no-store" }).then((x) => x.json()).catch(() => null);
      setBusy(false);
      if (!r || !r.ok) return flash("서버에 연결하지 못했습니다. 주소를 확인해 주세요.");
    }
    try { u ? localStorage.setItem(LS_PREFIX + "sync", u) : localStorage.removeItem(LS_PREFIX + "sync"); } catch (e) {}
    flash(u ? "서버를 연결했습니다." : "기본 서버 설정으로 돌아갑니다.");
    onClose();
  };
  return (
    <Modal title="서버 설정" onClose={onClose}>
      <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>
        {SYNC_URL ? "기본 서버가 이미 설정되어 있습니다. 다른 서버를 쓰려면 주소를 넣으세요." : "Apps Script 웹 앱 URL 을 넣으면 코드 공유가 켜집니다."}
      </p>
      <Field value={url} onChange={setUrl} placeholder="https://script.google.com/macros/s/…/exec" style={{ fontSize: 13 }} />
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <Btn onClick={save} disabled={busy}>{busy ? "확인 중…" : "저장"}</Btn>
        <Btn kind="ghost" onClick={onClose}>닫기</Btn>
      </div>
    </Modal>
  );
}


function Seg({ value, onChange, items }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {items.map(([v, label]) => {
        const on = value === v;
        return (
          <button
            key={v}
            className="em-btn"
            onClick={() => onChange(v)}
            aria-pressed={on}
            style={{ fontFamily: FONT, fontSize: 14, fontWeight: 600, padding: "7px 12px", borderRadius: 999, border: `1px solid ${on ? C.accent : C.line}`, background: on ? C.accentSoft : "#fff", color: on ? C.accent : C.sub, cursor: "pointer" }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/* ── AI 문제 생성 모달 ───────────────────────── */
function GenerateModal({ onClose, onAdd }) {
  const lsGet = (k) => { try { return localStorage.getItem(LS_PREFIX + k) || ""; } catch (e) { return ""; } };
  const [scope, setScope] = useState("");
  const [material, setMaterial] = useState("");
  const [count, setCount] = useState(10);
  const [difficulty, setDifficulty] = useState("중");
  const [kind, setKind] = useState("single");
  const [pw, setPw] = useState(() => lsGet("genpw"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);
  const [sel, setSel] = useState({});

  const run = async () => {
    if (!scope.trim() || busy) return;
    setBusy(true);
    setErr("");
    const r = await remote().generate({ scope: scope.trim(), material: material.trim(), count, difficulty, kind, pw });
    setBusy(false);
    if (!r.ok) {
      setErr(errMsg(r));
      return;
    }
    try { localStorage.setItem(LS_PREFIX + "genpw", pw); } catch (e) {}
    const qs = (r.questions || []).map((q) => normalizeQuestion(q, 0)).filter((q) => q.text && q.options && q.answers.length);
    if (!qs.length) {
      setErr("만들어진 문제가 없습니다. 범위를 조금 더 구체적으로 적어 보세요.");
      return;
    }
    setResult({ title: asStr(r.title), questions: qs, remaining: r.remaining });
    setSel(Object.fromEntries(qs.map((q) => [q.id, true])));
  };
  const chosen = result ? result.questions.filter((q) => sel[q.id]) : [];
  const label = (t) => <div style={{ fontSize: 13.5, color: C.sub, margin: "14px 0 6px" }}>{t}</div>;

  return (
    <Modal title="AI로 문제 만들기" onClose={onClose} wide>
      {!result ? (
        <>
          <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>
            범위를 적으면 그에 맞는 문제를 만들어 드립니다. 만든 문제는 편집 화면에서 자유롭게 고칠 수 있습니다. 무료 AI(Gemini)를 쓰므로 범위·자료에 이름, 학교, 연락처 같은 개인정보는 넣지 마세요.
          </p>
          <Field multiline rows={2} value={scope} onChange={setScope} placeholder="범위 (예: 중2 과학 광합성 단원, 영어 현재완료 시제)" maxLength={500} autoFocus />
          <Field multiline rows={4} value={material} onChange={setMaterial} placeholder="자료 붙여넣기 (선택) — 교과서 본문이나 수업 자료를 넣으면 그 내용에서만 출제합니다" maxLength={20000} style={{ marginTop: 10, fontSize: 14 }} />
          {label("문제 수")}
          <Seg value={count} onChange={setCount} items={[[5, "5개"], [10, "10개"], [15, "15개"], [20, "20개"]]} />
          {label("난이도")}
          <Seg value={difficulty} onChange={setDifficulty} items={[["하", "쉬움"], ["중", "보통"], ["상", "어려움"]]} />
          {label("유형")}
          <Seg value={kind} onChange={setKind} items={[["single", "객관식 (정답 1개)"], ["multi", "객관식 (복수 정답)"], ["tf", "참·거짓"]]} />

          {err && <p role="alert" style={{ color: C.bad, fontSize: 14, margin: "10px 0 0", lineHeight: 1.5 }}>{err}</p>}
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
            <Btn onClick={run} disabled={busy || !scope.trim()}>{busy ? "문제를 만드는 중… (최대 1분)" : "문제 만들기"}</Btn>
            <Btn kind="ghost" onClick={onClose}>닫기</Btn>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>
            문제 {result.questions.length}개를 만들었습니다. 추가할 문제를 고르세요. 정답은 초록색으로 표시됩니다.
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            {result.questions.map((q, i) => {
              const on = !!sel[q.id];
              return (
                <CheckRow key={q.id} on={on} onToggle={() => setSel((x) => ({ ...x, [q.id]: !x[q.id] }))} style={{ alignItems: "flex-start" }}>
                  <Check on={on} size={20} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{i + 1}. {q.text}</div>
                    {q.options.map((o, oi) => {
                      const ans = q.answers.includes(oi);
                      return (
                        <div key={oi} style={{ fontSize: 14, color: ans ? C.good : C.inkMid, fontWeight: ans ? 700 : 400, lineHeight: 1.5 }}>
                          {mark(oi)} {o}
                        </div>
                      );
                    })}
                    {q.explain && <div style={{ fontSize: 13, color: C.sub, marginTop: 4, lineHeight: 1.5 }}>해설 · {q.explain}</div>}
                  </div>
                </CheckRow>
              );
            })}
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
            <Btn onClick={() => onAdd(chosen, result.title)} disabled={!chosen.length}>선택한 문제 {chosen.length}개 추가</Btn>
            <Btn kind="soft" onClick={() => setResult(null)}>다시 만들기</Btn>
            <Btn kind="ghost" onClick={onClose}>닫기</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ── 화면: 편집 ──────────────────────────────── */
function EditorScreen({ draft, setDraft, dirty, busy, onSave, onShare, onBack, onExport, flash, toast }) {
  const [shareCode, setShareCode] = useState(null);
  const [showProblems, setShowProblems] = useState(false);
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genAvail, setGenAvail] = useState(false); // 서버가 생성 기능을 켰을 때만 버튼 표시(기본 숨김 = 비용 0)
  useEffect(() => { let alive = true; remote().genAvailable().then((v) => { if (alive) setGenAvail(v); }); return () => { alive = false; }; }, []);

  const upd = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const problems = useMemo(() => problemsOf(draft), [draft]);
  const stale = draft.code && draft.sharedHash !== hashOf(draft);

  const setOpt = (i, v) => {
    const options = [...draft.options];
    options[i] = v;
    upd({ options });
  };
  const addOpt = () => upd({ options: [...draft.options, ""] });
  const delOpt = (i) => {
    if (draft.options.length <= 2) return;
    const options = draft.options.filter((_, k) => k !== i);
    const questions = draft.questions.map((q) =>
      q.options ? q : { ...q, answers: q.answers.filter((a) => a !== i).map((a) => (a > i ? a - 1 : a)) }
    );
    upd({ options, questions });
  };

  const setQ = (qi, patch) => upd({ questions: draft.questions.map((q, k) => (k === qi ? { ...q, ...patch } : q)) });
  const toggleAns = (qi, oi) => {
    const q = draft.questions[qi];
    const answers = q.answers.includes(oi) ? q.answers.filter((a) => a !== oi) : [...q.answers, oi].sort((a, b) => a - b);
    setQ(qi, { answers });
  };
  const addQ = () => upd({ questions: [...draft.questions, { id: uid(), text: "", explain: "", options: null, answers: [] }] });
  /* 문제별 보기 */
  const useOwnOpts = (qi, on) => {
    const q = draft.questions[qi];
    if (on) setQ(qi, { options: [...draft.options] });
    else setQ(qi, { options: null, answers: q.answers.filter((a) => a < draft.options.length) });
  };
  const setQOpt = (qi, oi, v) => {
    const options = [...draft.questions[qi].options];
    options[oi] = v;
    setQ(qi, { options });
  };
  const addQOpt = (qi) => setQ(qi, { options: [...draft.questions[qi].options, ""] });
  const delQOpt = (qi, oi) => {
    const q = draft.questions[qi];
    if (q.options.length <= 2) return;
    setQ(qi, { options: q.options.filter((_, k) => k !== oi), answers: q.answers.filter((a) => a !== oi).map((a) => (a > oi ? a - 1 : a)) });
  };
  /* AI 생성 결과 병합 */
  const addGenerated = (qs, title) => {
    const fresh = qs.map((q) => ({ id: uid(), text: q.text, explain: q.explain || "", options: q.options, answers: q.answers }));
    const existing = draft.questions.filter((q) => q.text.trim() || q.answers.length);
    upd({ questions: [...existing, ...fresh], title: draft.title.trim() ? draft.title : title || "" });
    setGenOpen(false);
    flash(`문제 ${fresh.length}개를 추가했습니다.`);
  };
  const delQ = (qi) => {
    if (draft.questions.length <= 1) return;
    upd({ questions: draft.questions.filter((_, k) => k !== qi) });
  };
  const moveQ = (qi, dir) => {
    const to = qi + dir;
    if (to < 0 || to >= draft.questions.length) return;
    const qs = [...draft.questions];
    [qs[qi], qs[to]] = [qs[to], qs[qi]];
    upd({ questions: qs });
  };

  const tryShare = async () => {
    if (problems.length) {
      setShowProblems(true);
      flash(problems[0]);
      return;
    }
    const code = await onShare();
    if (code) setShareCode(code);
  };

  const back = () => (dirty ? setLeaveAsk(true) : onBack());

  return (
    <Shell back="처음으로" backTo={back} toast={toast}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {draft.code ? (
            <Badge tone={stale ? "warn" : "good"}>{stale ? `코드 ${draft.code} · 공유본과 다름` : `코드 ${draft.code} · 공유 중`}</Badge>
          ) : (
            <Badge>아직 공유 안 함</Badge>
          )}
          {dirty && <Badge tone="warn">저장 안 됨</Badge>}
        </div>
        <div style={{ display: "flex", gap: 2 }}>
          {genAvail && <TextBtn onClick={() => setGenOpen(true)}>AI로 문제 만들기</TextBtn>}
          {draft.code && <TextBtn onClick={() => setResultsOpen(true)}>응시 기록</TextBtn>}
          <TextBtn onClick={onExport}>내보내기</TextBtn>
        </div>
      </div>

      <Field value={draft.title} onChange={(v) => upd({ title: v })} placeholder="시험지 제목" maxLength={80} style={{ fontSize: 21, fontWeight: 700, padding: "14px 15px", marginBottom: 10 }} />
      <Field value={draft.desc} onChange={(v) => upd({ desc: v })} placeholder="안내문 (선택) — 응시자에게 첫 화면에서 보여줍니다" maxLength={300} multiline rows={2} style={{ marginBottom: 22, fontSize: 15 }} />

      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 4px" }}>보기</h3>
      <p style={{ fontSize: 13.5, color: C.sub, margin: "0 0 12px", lineHeight: 1.5 }}>여기서 정한 보기가 모든 문제에 똑같이 쓰입니다. 문제마다 다른 보기가 필요하면 문제 카드에서 따로 정할 수 있습니다.</p>
      <Card style={{ padding: 16, marginBottom: 26 }}>
        <div style={{ display: "grid", gap: 10 }}>
          {draft.options.map((o, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <span aria-hidden="true" style={{ width: 22, color: C.accent, fontSize: 18, flex: "0 0 22px" }}>{mark(i)}</span>
              <Field value={o} onChange={(v) => setOpt(i, v)} placeholder={`보기 ${i + 1}`} maxLength={120} />
              <TextBtn tone="sub" ariaLabel={`보기 ${i + 1} 삭제`} onClick={() => delOpt(i)} disabled={draft.options.length <= 2} style={{ fontSize: 19, padding: "0 2px" }}>
                ×
              </TextBtn>
            </div>
          ))}
        </div>
        <TextBtn onClick={addOpt} disabled={draft.options.length >= 12} style={{ marginTop: 12, padding: 0, fontSize: 15 }}>
          + 보기 추가
        </TextBtn>
      </Card>

      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 4px" }}>문제</h3>
      <p style={{ fontSize: 13.5, color: C.sub, margin: "0 0 12px", lineHeight: 1.5 }}>정답은 여러 개 고를 수 있습니다. 해설을 적으면 채점 결과에서 보여줍니다.</p>

      <div style={{ display: "grid", gap: 12 }}>
        {draft.questions.map((q, qi) => (
          <Card key={q.id} style={{ padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 14.5, fontWeight: 700, color: C.accent }}>{qi + 1}번</span>
              <div style={{ display: "flex", gap: 0 }}>
                <TextBtn tone="sub" ariaLabel="위로" onClick={() => moveQ(qi, -1)} disabled={qi === 0} style={{ fontSize: 15 }}>▲</TextBtn>
                <TextBtn tone="sub" ariaLabel="아래로" onClick={() => moveQ(qi, 1)} disabled={qi === draft.questions.length - 1} style={{ fontSize: 15 }}>▼</TextBtn>
                <TextBtn tone="sub" onClick={() => delQ(qi)} disabled={draft.questions.length <= 1} style={{ fontSize: 13.5 }}>삭제</TextBtn>
              </div>
            </div>
            <Field value={q.text} onChange={(v) => setQ(qi, { text: v })} placeholder="문제를 입력하세요" multiline />
            {q.options ? (
              <div style={{ marginTop: 12, padding: 12, background: C.lineSoft, borderRadius: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: C.inkMid }}>이 문제만의 보기</span>
                  <TextBtn tone="sub" onClick={() => useOwnOpts(qi, false)} style={{ fontSize: 13, padding: 0 }}>공용 보기로 되돌리기</TextBtn>
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {q.options.map((o, oi) => (
                    <div key={oi} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span aria-hidden="true" style={{ width: 20, color: C.accent, fontSize: 16, flex: "0 0 20px" }}>{mark(oi)}</span>
                      <Field value={o} onChange={(v) => setQOpt(qi, oi, v)} placeholder={`보기 ${oi + 1}`} maxLength={200} style={{ padding: "9px 11px", fontSize: 15 }} />
                      <TextBtn tone="sub" ariaLabel={`보기 ${oi + 1} 삭제`} onClick={() => delQOpt(qi, oi)} disabled={q.options.length <= 2} style={{ fontSize: 18, padding: "0 2px" }}>×</TextBtn>
                    </div>
                  ))}
                </div>
                <TextBtn onClick={() => addQOpt(qi)} disabled={q.options.length >= 12} style={{ marginTop: 8, padding: 0, fontSize: 14 }}>+ 보기 추가</TextBtn>
              </div>
            ) : (
              <TextBtn tone="sub" onClick={() => useOwnOpts(qi, true)} style={{ marginTop: 10, padding: 0, fontSize: 13 }}>이 문제만 다른 보기 쓰기</TextBtn>
            )}
            <div style={{ fontSize: 13.5, color: C.sub, margin: "14px 0 8px" }}>정답 고르기</div>
            <div style={{ display: "grid", gap: 7 }}>
              {(q.options || draft.options).map((o, oi) => {
                const on = q.answers.includes(oi);
                return (
                  <CheckRow key={oi} on={on} onToggle={() => toggleAns(qi, oi)}>
                    <Check on={on} size={20} />
                    <span style={{ color: C.accent, fontSize: 16 }}>{mark(oi)}</span>
                    <span style={{ fontSize: 15.5, color: o.trim() ? C.ink : C.sub, lineHeight: 1.45 }}>{o.trim() || "(보기가 비어 있음)"}</span>
                  </CheckRow>
                );
              })}
            </div>
            <Field value={q.explain} onChange={(v) => setQ(qi, { explain: v })} placeholder="해설 (선택)" multiline rows={1} maxLength={500} style={{ marginTop: 12, fontSize: 14.5, background: C.lineSoft }} />
          </Card>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <Btn kind="soft" onClick={addQ}>+ 문제 추가</Btn>
      </div>

      <CheckRow on={draft.shuffle} onToggle={() => upd({ shuffle: !draft.shuffle })} padding={16} style={{ alignItems: "flex-start", gap: 12, marginTop: 24, borderRadius: 14, background: C.card }}>
        <Check on={draft.shuffle} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>문제와 보기 순서 섞기</div>
          <div style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.5 }}>푸는 사람마다 순서가 달라집니다. 답을 외워서 찍는 것을 막고 싶을 때 켜세요.</div>
        </div>
      </CheckRow>

      {showProblems && problems.length > 0 && (
        <div style={{ marginTop: 18, padding: "12px 14px", background: C.warnSoft, border: `1px solid #F3DFB0`, borderRadius: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.warn, marginBottom: 6 }}>공유하기 전에 고쳐 주세요</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, color: C.inkMid, lineHeight: 1.7 }}>
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ display: "grid", gap: 10, marginTop: 26 }}>
        <Btn kind="ghost" onClick={onSave} disabled={!dirty || busy}>{dirty ? "저장하기" : "저장됨"}</Btn>
        <Btn onClick={tryShare} disabled={busy}>
          {busy ? "공유 코드 만드는 중…" : draft.code ? (stale ? "변경 내용 다시 공유하기" : "공유 코드 보기") : "공유하기"}
        </Btn>
      </div>

      {shareCode && (
        <Modal title="공유 코드" onClose={() => setShareCode(null)}>
          <p style={{ fontSize: 14.5, color: C.sub, lineHeight: 1.6, margin: "0 0 16px" }}>
            친구에게 이 페이지 주소와 아래 코드를 함께 보내세요. 친구는 “코드로 문제 풀기”에 코드를 넣으면 됩니다. 나중에 문제를 고치면 “다시 공유하기”를 눌러야 반영됩니다.
          </p>
          <div style={{ textAlign: "center", background: C.accentSoft, border: `1px solid ${C.line}`, borderRadius: 12, padding: "18px 12px", fontSize: 34, fontWeight: 800, letterSpacing: "0.14em", color: C.accent, marginBottom: 16 }}>
            {shareCode}
          </div>
          <div style={{ display: "grid", gap: 9 }}>
            <Btn kind="soft" onClick={async () => flash((await copyText(shareCode)) ? "코드를 복사했습니다." : "복사가 안 돼요. 코드를 직접 적어 주세요.")}>코드 복사</Btn>
            <Btn kind="ghost" onClick={() => setShareCode(null)}>닫기</Btn>
          </div>
        </Modal>
      )}

      {leaveAsk && (
        <Modal title="저장하지 않은 변경이 있습니다" onClose={() => setLeaveAsk(false)}>
          <p style={{ fontSize: 14.5, color: C.sub, lineHeight: 1.6, margin: "0 0 16px" }}>이대로 나가면 변경 내용이 사라집니다.</p>
          <div style={{ display: "grid", gap: 9 }}>
            <Btn onClick={async () => { const ok = await onSave(); if (ok) onBack(); }}>저장하고 나가기</Btn>
            <Btn kind="danger" onClick={onBack}>저장하지 않고 나가기</Btn>
            <Btn kind="ghost" onClick={() => setLeaveAsk(false)}>계속 편집</Btn>
          </div>
        </Modal>
      )}

      {resultsOpen && draft.code && <ResultsModal code={draft.code} ownerKey={draft.ownerKey} onClose={() => setResultsOpen(false)} flash={flash} />}
      {genOpen && <GenerateModal onClose={() => setGenOpen(false)} onAdd={addGenerated} />}
    </Shell>
  );
}

/* ── 화면: 코드 입력 ─────────────────────────── */
function CodeScreen({ codeInput, setCodeInput, codeErr, busy, onLoad, onBack, toast }) {
  return (
    <Shell back="처음으로" backTo={onBack} toast={toast}>
      <h2 style={{ fontSize: 25, fontWeight: 800, margin: "0 0 8px" }}>코드로 문제 풀기</h2>
      <p style={{ fontSize: 15.5, color: C.sub, lineHeight: 1.6, margin: "0 0 20px" }}>받은 다섯 자리 코드를 넣으면 시험지가 열립니다.</p>
      <Card>
        <Field
          value={codeInput}
          onChange={(v) => setCodeInput(cleanCode(v))}
          onEnter={() => codeInput.length === 5 && !busy && onLoad()}
          placeholder="예: 7F3KM"
          maxLength={5}
          autoFocus
          ariaLabel="공유 코드"
          style={{ fontSize: 26, fontWeight: 700, letterSpacing: "0.16em", textAlign: "center", padding: "16px 12px", textTransform: "uppercase" }}
        />
        {codeErr && <p role="alert" style={{ color: C.bad, fontSize: 14, margin: "12px 0 0", lineHeight: 1.5 }}>{codeErr}</p>}
        <div style={{ marginTop: 14 }}>
          <Btn onClick={onLoad} disabled={busy || codeInput.length !== 5}>
            {busy ? "여는 중…" : "시험지 열기"}
          </Btn>
        </div>
      </Card>
    </Shell>
  );
}

/* ── 화면: 응시 ──────────────────────────────── */
function TakeScreen({ run, picked, togglePick, name, setName, onSubmit, onExit, toast }) {
  const [confirm, setConfirm] = useState(false);
  const answered = run.questions.filter((q) => (picked[q.id] || []).length).length;
  const unanswered = run.questions.length - answered;

  const submit = () => (unanswered > 0 ? setConfirm(true) : onSubmit());

  return (
    <Shell back="나가기" backTo={onExit} toast={toast}>
      <h2 style={{ fontSize: 25, fontWeight: 800, margin: "0 0 6px" }}>{run.title}</h2>
      {run.desc && <p style={{ fontSize: 15, color: C.inkMid, lineHeight: 1.6, margin: "0 0 10px", whiteSpace: "pre-wrap" }}>{run.desc}</p>}
      <p style={{ fontSize: 14.5, color: C.sub, margin: "0 0 14px" }}>
        {run.partial ? "틀린 문제만 다시 풉니다 · " : ""}문제 {run.questions.length}개 · 정답이 여러 개일 수 있습니다
      </p>

      <div style={{ position: "sticky", top: 0, zIndex: 10, background: C.bg, padding: "8px 0 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, color: C.sub, marginBottom: 6 }}>
          <span>답한 문제</span>
          <span style={{ fontWeight: 700, color: C.inkMid }}>
            {answered} / {run.questions.length}
          </span>
        </div>
        <ProgressBar value={answered} max={run.questions.length} />
      </div>

      {!run.partial && !(authGet() && authGet().token) && (
        <Field value={name} onChange={(v) => setName(v)} placeholder="이름 (선택) — 출제자에게 결과가 전달됩니다" maxLength={20} style={{ marginBottom: 14, fontSize: 15 }} />
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {run.questions.map((q, qi) => {
          const mine = picked[q.id] || [];
          return (
            <Card key={q.id} style={{ padding: 16 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: C.accent, marginBottom: 8 }}>{qi + 1}번</div>
              <p style={{ fontSize: 16.5, lineHeight: 1.55, margin: "0 0 14px", whiteSpace: "pre-wrap" }}>{q.text}</p>
              <div style={{ display: "grid", gap: 7 }} role="group" aria-label={`${qi + 1}번 보기`}>
                {q.options.map((o, oi) => {
                  const on = mine.includes(oi);
                  return (
                    <CheckRow key={oi} on={on} onToggle={() => togglePick(q.id, oi)} padding="12px 13px">
                      <Check on={on} size={20} />
                      <span style={{ color: C.accent, fontSize: 16 }}>{mark(oi)}</span>
                      <span style={{ fontSize: 15.5, lineHeight: 1.45 }}>{o}</span>
                    </CheckRow>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
      <p style={{ fontSize: 14, color: unanswered ? C.bad : C.good, textAlign: "center", margin: "20px 0 10px" }}>
        {unanswered ? `아직 답을 고르지 않은 문제가 ${unanswered}개 있습니다.` : "모든 문제에 답했습니다."}
      </p>
      <Btn onClick={submit}>제출하고 채점 보기</Btn>

      {confirm && (
        <Modal title="그대로 제출할까요?" onClose={() => setConfirm(false)}>
          <p style={{ fontSize: 14.5, color: C.sub, lineHeight: 1.6, margin: "0 0 16px" }}>답하지 않은 문제 {unanswered}개는 오답으로 채점됩니다.</p>
          <div style={{ display: "grid", gap: 9 }}>
            <Btn onClick={() => { setConfirm(false); onSubmit(); }}>제출하기</Btn>
            <Btn kind="ghost" onClick={() => setConfirm(false)}>더 풀기</Btn>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

/* ── 화면: 결과 ──────────────────────────────── */
function ResultScreen({ run, result, onRetryWrong, onRetryAll, onHome, flash, toast }) {
  const [showAll, setShowAll] = useState(false);
  const wrong = result.rows.filter((r) => !r.ok);
  const rows = showAll || wrong.length === 0 ? result.rows : wrong;
  const pct = Math.round((result.score / result.total) * 100);
  const msg = pct === 100 ? "모두 맞혔습니다. 완벽해요!" : pct >= 80 ? "잘했어요. 조금만 더 다듬으면 만점입니다." : pct >= 50 ? "절반 이상 맞혔어요. 틀린 문제를 한 번 더 봐요." : "아직 익숙하지 않네요. 해설을 보고 다시 도전해요.";

  const copyResult = async () => {
    const text = `[${run.title}] ${result.score}/${result.total} (${pct}점) · ${fmtSec(result.sec)}${run.partial ? " · 틀린 문제만" : ""}`;
    flash((await copyText(text)) ? "결과를 복사했습니다." : "복사가 안 돼요.");
  };

  return (
    <Shell toast={toast}>
      <Card style={{ textAlign: "center", padding: 26, marginBottom: 22 }}>
        <div style={{ fontSize: 14.5, color: C.sub, marginBottom: 8 }}>
          {run.title}
          {run.partial ? " · 틀린 문제만" : ""}
        </div>
        <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
          {result.score}
          <span style={{ color: C.sub, fontSize: 26, fontWeight: 700 }}> / {result.total}</span>
        </div>
        <div style={{ fontSize: 15.5, color: C.sub, marginTop: 8 }}>
          {pct}점 · 틀린 문제 {wrong.length}개 · {fmtSec(result.sec)}
        </div>
        <div style={{ marginTop: 12 }}>
          <ProgressBar value={result.score} max={result.total} />
        </div>
        <p style={{ fontSize: 15, color: C.inkMid, margin: "14px 0 0", lineHeight: 1.6 }}>{msg}</p>
      </Card>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{showAll || wrong.length === 0 ? "전체 문제" : "틀린 문제"}</h3>
        {wrong.length > 0 && <TextBtn onClick={() => setShowAll((v) => !v)}>{showAll ? "틀린 것만 보기" : "전체 보기"}</TextBtn>}
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {rows.map(({ q, mine, ok }) => {
          const qi = result.rows.findIndex((r) => r.q.id === q.id);
          return (
            <Card key={q.id} style={{ padding: 16, borderColor: ok ? C.line : C.badSoft }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 14.5, fontWeight: 700, color: C.accent }}>{qi + 1}번</span>
                <Badge tone={ok ? "good" : "bad"}>{ok ? "정답" : "오답"}</Badge>
              </div>
              <p style={{ fontSize: 16.5, lineHeight: 1.55, margin: "0 0 14px", whiteSpace: "pre-wrap" }}>{q.text}</p>
              <div style={{ display: "grid", gap: 7 }}>
                {q.options.map((o, oi) => {
                  const isAns = q.answers.includes(oi);
                  const isMine = mine.includes(oi);
                  let bd = C.line, bg = "#fff", tx = C.inkMid, tag = null;
                  if (isAns) {
                    bd = C.good; bg = C.goodSoft; tx = C.ink;
                    tag = <span style={{ color: C.good, fontSize: 13, fontWeight: 700 }}>정답</span>;
                  }
                  if (isMine && !isAns) {
                    bd = C.bad; bg = C.badSoft; tx = C.ink;
                    tag = <span style={{ color: C.bad, fontSize: 13, fontWeight: 700 }}>내가 고름</span>;
                  }
                  if (isMine && isAns) tag = <span style={{ color: C.good, fontSize: 13, fontWeight: 700 }}>정답 · 내가 고름</span>;
                  return (
                    <div key={oi} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", border: `1px solid ${bd}`, background: bg, borderRadius: 10 }}>
                      <span style={{ color: C.accent, fontSize: 16 }}>{mark(oi)}</span>
                      <span style={{ fontSize: 15.5, color: tx, lineHeight: 1.45, flex: 1 }}>{o}</span>
                      {tag}
                    </div>
                  );
                })}
              </div>
              {mine.length === 0 && <p style={{ fontSize: 13.5, color: C.bad, margin: "10px 0 0" }}>답을 고르지 않았습니다.</p>}
              {q.explain && (
                <div style={{ marginTop: 12, padding: "10px 12px", background: C.lineSoft, borderRadius: 10, fontSize: 14.5, lineHeight: 1.6, color: C.inkMid, whiteSpace: "pre-wrap" }}>
                  <span style={{ fontWeight: 700, color: C.ink }}>해설 </span>
                  {q.explain}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <div style={{ display: "grid", gap: 10, marginTop: 22 }}>
        {wrong.length > 0 && <Btn onClick={() => onRetryWrong(wrong.map((r) => r.q.id))}>틀린 문제만 다시 풀기</Btn>}
        <Btn kind="soft" onClick={onRetryAll}>처음부터 다시 풀기</Btn>
        <Btn kind="ghost" onClick={copyResult}>결과 복사</Btn>
        <Btn kind="ghost" onClick={onHome}>처음으로</Btn>
      </div>
    </Shell>
  );
}

/* ── 앱 ──────────────────────────────────────── */
/* ── 화면: 오답노트(학습 도우미) ─────────────────
   사진을 서버(드라이브)에 올리면 PC 의 워커(Claude 예약 작업)가 가져가 분석하고 결과를 다시 올린다.
   연결 코드는 PC 의 study-helper\sync.json 에 있는 값. 이 브라우저에 저장된다. */
const SH_STATUS = { uploaded: ["대기 중", "neutral"], extracting: ["처리 중", "accent"], in_progress: ["처리 중", "accent"], needs_confirm: ["확인 필요", "warn"], done: ["완료", "good"] };
const shKeyGet = () => { try { return localStorage.getItem(LS_PREFIX + "sh_key") || ""; } catch (e) { return ""; } };
const shKeySet = (k) => { try { k ? localStorage.setItem(LS_PREFIX + "sh_key", k) : localStorage.removeItem(LS_PREFIX + "sh_key"); } catch (e) {} };
const fileToBase64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(file); });

function StudyScreen({ onBack, flash, toast }) {
  const [key, setKey] = useState(shKeyGet);
  const [keyInput, setKeyInput] = useState("");
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [wsName, setWsName] = useState("");
  const [files, setFiles] = useState([]);
  const [progress, setProgress] = useState("");
  const [detail, setDetail] = useState(null);      // 상세 화면 데이터
  const [answers, setAnswers] = useState({});
  const [noteHtml, setNoteHtml] = useState(null);  // 오답노트 HTML(iframe)
  const fileRef = useRef(null);
  const r = remote();

  const load = async () => {
    if (!key) return;
    setBusy(true);
    const res = await r.shList(key);
    setBusy(false);
    if (!res.ok) { flash(ERR[res.error] || "목록을 불러오지 못했습니다."); setList([]); return; }
    setList(res.worksheets);
  };
  useEffect(() => { load(); }, [key]);

  const connect = () => {
    const k = keyInput.trim();
    if (k.length < 8) return flash("연결 코드는 8자 이상입니다. PC 의 study-helper\\sync.json 에 있는 값을 넣으세요.");
    shKeySet(k); setKey(k);
  };
  const disconnect = () => { shKeySet(""); setKey(""); setList(null); setDetail(null); };

  const upload = async () => {
    const name = wsName.trim();
    if (!name) return flash("문제지 이름을 넣어 주세요.");
    if (!files.length) return flash("사진을 골라 주세요.");
    setBusy(true);
    let done = 0;
    for (const f of files) {
      setProgress(`${done + 1}/${files.length} 올리는 중…`);
      const data = await fileToBase64(f);
      const res = await r.shUpload({ key, worksheet: name, filename: f.name, mime: f.type, data });
      if (!res.ok) { setBusy(false); setProgress(""); return flash(ERR[res.error] || `업로드 실패(${res.error || "network"})`); }
      done++;
    }
    setBusy(false); setProgress("");
    setFiles([]); setWsName(""); if (fileRef.current) fileRef.current.value = "";
    flash(`사진 ${done}장을 올렸습니다. PC 가 켜져 있으면 10분 안에 처리됩니다.`);
    load();
  };

  const openDetail = async (name) => {
    setBusy(true);
    const res = await r.shDetail(key, name);
    setBusy(false);
    if (!res.ok) return flash(ERR[res.error] || "상세를 불러오지 못했습니다.");
    setAnswers({}); setNoteHtml(null); setDetail(res);
  };
  const openNote = async () => {
    setBusy(true);
    const res = await r.shNote(key, detail.name);
    setBusy(false);
    if (!res.ok) return flash(res.error === "no_note" ? "아직 오답노트가 만들어지지 않았습니다." : "오답노트를 불러오지 못했습니다.");
    setNoteHtml(res.html);
  };
  const saveConfirm = async () => {
    const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v && v.trim()));
    if (!Object.keys(filled).length) return flash("적은 답이 없습니다.");
    setBusy(true);
    const res = await r.shConfirm({ key, worksheet: detail.name, answers: filled });
    setBusy(false);
    if (!res.ok) return flash("저장하지 못했습니다.");
    flash(`답 ${res.saved}개를 저장했습니다. 다음 자동 처리 때 반영됩니다.`);
    openDetail(detail.name);
  };

  const statusBadge = (s) => { const [t, tone] = SH_STATUS[s] || [s || "대기 중", "neutral"]; return <Badge tone={tone}>{t}</Badge>; };

  /* 연결 전 */
  if (!key)
    return (
      <Shell back="처음으로" backTo={onBack} toast={toast}>
        <h2 style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 8px" }}>오답노트</h2>
        <p style={{ fontSize: 15, color: C.sub, lineHeight: 1.6, margin: "0 0 14px" }}>
          시험지 사진을 올리면 정답·해설·검증과 손글씨 메모를 반영한 오답노트가 만들어집니다. 처리는 내 PC 의 Claude 가 하므로 PC 가 켜져 있어야 합니다.
        </p>
        <Card>
          <div style={{ fontSize: 14, color: C.sub, marginBottom: 8 }}>연결 코드 (PC 의 study-helper\sync.json 에 있는 key)</div>
          <Field value={keyInput} onChange={setKeyInput} placeholder="연결 코드" onEnter={connect} ariaLabel="연결 코드" />
          <div style={{ marginTop: 10 }}><Btn onClick={connect}>연결</Btn></div>
        </Card>
      </Shell>
    );

  /* 오답노트 보기 */
  if (detail && noteHtml !== null)
    return (
      <Shell back={detail.name} backTo={() => setNoteHtml(null)} toast={toast}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <Btn kind="soft" onClick={() => { const w = window.open("", "_blank"); if (w) { w.document.write(noteHtml); w.document.close(); } }}>새 창에서 열기(인쇄·PDF)</Btn>
        </div>
        <iframe title="오답노트" srcDoc={noteHtml} sandbox="allow-popups" style={{ width: "100%", height: "78vh", border: `1px solid ${C.line}`, borderRadius: 12, background: "#fff" }} />
      </Shell>
    );

  /* 상세 */
  if (detail) {
    const pending = (detail.confirm || []).filter((c) => !c.answer);
    const answered = (detail.confirm || []).filter((c) => c.answer);
    return (
      <Shell back="오답노트 목록" backTo={() => setDetail(null)} toast={toast}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: "6px 0 6px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>{detail.name} {statusBadge(detail.status)}</h2>
        {detail.summary && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, margin: "10px 0 14px" }}>
            {[["문항", detail.summary.questions], ["틀림", detail.summary.wrong], ["오류 의심", detail.summary.suspect], ["확인 필요", detail.summary.confirm]].map(([t, v]) => (
              <Card key={t} style={{ padding: "10px 12px" }}><div style={{ fontSize: 20, fontWeight: 800 }}>{v ?? 0}</div><div style={{ fontSize: 12.5, color: C.sub }}>{t}</div></Card>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {detail.hasNote && <Btn onClick={openNote} disabled={busy}>오답노트 보기</Btn>}
          <Btn kind="soft" onClick={() => openDetail(detail.name)} disabled={busy}>새로고침</Btn>
        </div>
        {pending.length > 0 && (
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>확인 질문 {pending.length}개</div>
            <div style={{ fontSize: 13.5, color: C.sub, marginBottom: 10 }}>답을 저장하면 다음 자동 처리 때 오답노트에 반영됩니다. 모르면 비워 두세요.</div>
            {pending.map((c) => (
              <div key={c.id} style={{ borderTop: `1px solid ${C.line}`, padding: "10px 0" }}>
                <div style={{ fontSize: 14.5, marginBottom: 6 }}><Badge>{c.no}번</Badge> {c.question}</div>
                <Field value={answers[c.id] || ""} onChange={(v) => setAnswers({ ...answers, [c.id]: v })} placeholder={`추정: ${c.guess || ""}`} ariaLabel={`${c.no}번 확인 답`} />
              </div>
            ))}
            <div style={{ marginTop: 10 }}><Btn onClick={saveConfirm} disabled={busy}>답 저장</Btn></div>
          </Card>
        )}
        {answered.length > 0 && (
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>확인 완료</div>
            {answered.map((c) => <div key={c.id} style={{ fontSize: 14, padding: "4px 0", color: C.inkMid }}>{c.no}번 · {c.answer} <span style={{ color: C.sub }}>({c.applied ? "반영됨" : "반영 대기"})</span></div>)}
          </Card>
        )}
        {(detail.questions || []).length > 0 && (
          <Card style={{ padding: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead><tr>{["번호", "정답", "내 답", "결과", "검증"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
              <tbody>{detail.questions.map((q) => (
                <tr key={q.no}>
                  <td style={{ padding: "6px 8px" }}>{q.no}</td><td style={{ padding: "6px 8px" }}>{q.answer}</td><td style={{ padding: "6px 8px" }}>{q.mine || "?"}</td>
                  <td style={{ padding: "6px 8px", color: q.mine && q.mine !== q.answer ? C.bad : C.ink, fontWeight: q.mine && q.mine !== q.answer ? 700 : 400 }}>{q.mine ? (q.mine === q.answer ? "정답" : "오답") : "-"}</td>
                  <td style={{ padding: "6px 8px" }}>{q.verify === "ok" ? "일치" : q.verify === "suspect" ? "⚠ 의심" : "-"}</td>
                </tr>
              ))}</tbody>
            </table>
          </Card>
        )}
      </Shell>
    );
  }

  /* 목록 + 업로드 */
  return (
    <Shell back="처음으로" backTo={onBack} toast={toast}>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 8px" }}>오답노트</h2>
      <p style={{ fontSize: 14.5, color: C.sub, lineHeight: 1.6, margin: "0 0 14px" }}>사진을 올리면 PC 가 켜져 있을 때 10분 안에 정답·해설·오답노트가 만들어집니다.</p>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: C.sub, marginBottom: 6 }}>문제지 이름 (예: 통합과학_2학기_2차)</div>
        <Field value={wsName} onChange={setWsName} placeholder="과목_학기_회차" ariaLabel="문제지 이름" />
        <div style={{ fontSize: 14, color: C.sub, margin: "12px 0 6px" }}>사진 (여러 장, 페이지 순서대로)</div>
        <input ref={fileRef} type="file" accept="image/*" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} style={{ fontFamily: FONT, fontSize: 14 }} aria-label="사진 선택" />
        {files.length > 0 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>{files.map((f, i) => <img key={i} src={URL.createObjectURL(f)} alt={f.name} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}` }} />)}</div>}
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
          <Btn onClick={upload} disabled={busy}>{progress || "올리기"}</Btn>
          <TextBtn tone="sub" onClick={disconnect} style={{ fontSize: 12.5 }}>연결 해제</TextBtn>
        </div>
      </Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 8px" }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: C.inkMid }}>문제지 목록</h3>
        <TextBtn onClick={load} disabled={busy}>새로고침</TextBtn>
      </div>
      {list === null && <p style={{ color: C.sub, fontSize: 14 }}>불러오는 중…</p>}
      {list && list.length === 0 && <p style={{ color: C.sub, fontSize: 14 }}>아직 올린 문제지가 없습니다.</p>}
      {(list || []).map((w) => (
        <button key={w.name} className="em-btn em-row" onClick={() => openDetail(w.name)}
          style={{ display: "block", width: "100%", textAlign: "left", background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "14px 16px", marginBottom: 10, cursor: "pointer", fontFamily: FONT }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{w.name}</span>{statusBadge(w.status)}{w.pending > 0 && <Badge tone="warn">확인 질문 {w.pending}</Badge>}
          </div>
          <div style={{ fontSize: 13.5, color: C.sub, marginTop: 4 }}>
            사진 {w.photos}장{w.summary ? ` · ${w.summary.questions}문항 · 틀림 ${w.summary.wrong} · 의심 ${w.summary.suspect}` : ""}{w.hasNote ? " · 오답노트 있음" : ""}
          </div>
        </button>
      ))}
    </Shell>
  );
}

/* ── 계정: 로그인·역할별 화면 ─────────────────────
   토큰은 이 브라우저에 저장(localStorage). 서버가 역할(admin/teacher/student)을 판정한다. */
const authGet = () => { try { return JSON.parse(localStorage.getItem(LS_PREFIX + "auth") || "null"); } catch (e) { return null; } };
const authSet = (a) => { try { a ? localStorage.setItem(LS_PREFIX + "auth", JSON.stringify(a)) : localStorage.removeItem(LS_PREFIX + "auth"); } catch (e) {} };
const ROLE_KO = { admin: "관리자", teacher: "선생", student: "학생" };

function LoginScreen({ needSetup, onDone, toast, flash }) {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!id.trim() || !pw) return flash("아이디와 비밀번호를 넣어 주세요.");
    setBusy(true);
    const r = needSetup ? await remote().setup({ id: id.trim(), pw, name: name.trim() || id.trim() }) : await remote().login({ id: id.trim(), pw });
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    authSet({ token: r.token, user: r.user });
    onDone(r.user);
  };
  return (
    <Shell toast={toast}>
      <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em", margin: "26px 0 8px" }}>시험지</h1>
      <p style={{ fontSize: 15.5, color: C.sub, lineHeight: 1.6, margin: "0 0 20px" }}>
        {needSetup ? "처음 실행입니다. 관리자 계정을 만들어 주세요. 이 계정으로 선생·학생 계정을 등록합니다." : "아이디와 비밀번호로 들어갑니다. 계정이 없으면 관리자에게 문의하세요."}
      </p>
      <Card>
        <div style={{ display: "grid", gap: 10 }}>
          {needSetup && <Field value={name} onChange={setName} placeholder="이름 (표시용)" ariaLabel="이름" />}
          <Field value={id} onChange={setId} placeholder="아이디 (한글·영문·숫자 2~30자)" ariaLabel="아이디" autoFocus />
          <Field type="password" value={pw} onChange={setPw} placeholder="비밀번호" onEnter={go} ariaLabel="비밀번호" />
          <Btn onClick={go} disabled={busy}>{busy ? "확인 중…" : needSetup ? "관리자 계정 만들기" : "들어가기"}</Btn>
        </div>
      </Card>
    </Shell>
  );
}

function AccountModal({ user, onClose, onLogout, flash }) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [busy, setBusy] = useState(false);
  const change = async () => {
    if (newPw.length < 4) return flash("새 비밀번호는 4자 이상입니다.");
    setBusy(true);
    const r = await remote().changePw({ oldPw, newPw });
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    setOldPw(""); setNewPw(""); flash("비밀번호를 바꿨습니다.");
  };
  return (
    <Modal title="내 계정" onClose={onClose}>
      <p style={{ fontSize: 15, margin: "0 0 12px" }}><b>{user.name}</b> <Badge tone="accent">{ROLE_KO[user.role] || user.role}</Badge> <span style={{ color: C.sub, fontSize: 13.5 }}>· {user.id}</span></p>
      <div style={{ display: "grid", gap: 8 }}>
        <Field type="password" value={oldPw} onChange={setOldPw} placeholder="현재 비밀번호" ariaLabel="현재 비밀번호" />
        <Field type="password" value={newPw} onChange={setNewPw} placeholder="새 비밀번호 (4자 이상)" ariaLabel="새 비밀번호" onEnter={change} />
        <Btn kind="soft" onClick={change} disabled={busy}>비밀번호 변경</Btn>
        <Btn kind="ghost" onClick={onLogout}>로그아웃</Btn>
      </div>
    </Modal>
  );
}

/* 관리자: 계정 관리 + 전체 기록 */
function AdminScreen({ onBack, toast, flash }) {
  const [users, setUsers] = useState(null);
  const [tab, setTab] = useState("users");
  const [form, setForm] = useState({ id: "", pw: "", name: "", role: "student", teacherId: "" });
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [workerKey, setWorkerKey] = useState("");
  const [usage, setUsage] = useState(null);
  const loadUsage = async () => { const r = await remote().usage(); if (!r.ok) return flash(errMsg(r)); setUsage(r); };
  const teachers = (users || []).filter((u) => u.role === "teacher" || u.role === "admin");

  const load = async () => { const r = await remote().userList(); if (!r.ok) return flash(errMsg(r)); setUsers(r.users); };
  useEffect(() => { load(); }, []);
  const loadResults = async () => { const r = await remote().allResults(); if (!r.ok) return flash(errMsg(r)); setResults(r.items); };

  const create = async () => {
    if (!form.id.trim() || form.pw.length < 4) return flash("아이디와 4자 이상 비밀번호를 넣어 주세요.");
    setBusy(true);
    const r = await remote().userCreate({ ...form, id: form.id.trim(), name: form.name.trim() });
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    setForm({ id: "", pw: "", name: "", role: form.role, teacherId: form.teacherId });
    flash(`${r.user.name} (${ROLE_KO[r.user.role]}) 계정을 만들었습니다.`);
    load();
  };
  const save = async () => {
    setBusy(true);
    const body = { id: edit.id, name: edit.name, role: edit.role, teacherId: edit.role === "student" ? edit.teacherId : "", active: edit.active };
    if (edit.pw) body.pw = edit.pw;
    const r = await remote().userUpdate(body);
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    setEdit(null); flash("저장했습니다."); load();
  };
  const del = async () => {
    if (!confirm(`${edit.name} (${edit.id}) 계정을 지울까요? 이 계정의 응시 기록은 남습니다.`)) return;
    const r = await remote().userDelete(edit.id);
    if (!r.ok) return flash(errMsg(r));
    setEdit(null); flash("삭제했습니다."); load();
  };
  const delResult = async (it) => {
    if (!confirm(`${it.name}의 "${it.title || it.code}" 기록을 지울까요?`)) return;
    const r = await remote().resultDelete(it.id);
    if (!r.ok) return flash(errMsg(r));
    setResults(results.filter((x) => x.id !== it.id));
  };
  const setWorker = async () => {
    if (workerKey.trim().length < 8) return flash("연결 코드는 8자 이상입니다.");
    const r = await remote().workerKeySet(workerKey.trim());
    if (!r.ok) return flash(errMsg(r));
    setWorkerKey(""); flash("리포트 워커 연결 코드를 등록했습니다.");
  };
  const teacherName = (id) => (users || []).find((u) => u.id === id)?.name || id || "-";
  const sel = { fontFamily: FONT, fontSize: 15, padding: "10px 12px", border: `1px solid ${C.line}`, borderRadius: 10, background: "#fff", color: C.ink };

  return (
    <Shell back="처음으로" backTo={onBack} toast={toast}>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 12px" }}>관리자</h2>
      <Seg value={tab} onChange={(v) => { setTab(v); if (v === "results" && results === null) loadResults(); }} items={[["users", "계정"], ["results", "전체 기록"], ["worker", "리포트 워커"], ["usage", "AI 사용량"]]} />

      {tab === "users" && (
        <>
          <Card style={{ margin: "14px 0" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>계정 만들기</div>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field value={form.id} onChange={(v) => setForm({ ...form, id: v })} placeholder="아이디" ariaLabel="아이디" />
                <Field value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="이름" ariaLabel="이름" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field type="password" value={form.pw} onChange={(v) => setForm({ ...form, pw: v })} placeholder="비밀번호 (4자 이상)" ariaLabel="비밀번호" />
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={sel} aria-label="역할">
                  <option value="student">학생</option><option value="teacher">선생</option><option value="admin">관리자</option>
                </select>
              </div>
              {form.role === "student" && (
                <select value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })} style={sel} aria-label="담당 선생">
                  <option value="">담당 선생 없음</option>
                  {teachers.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
                </select>
              )}
              <Btn onClick={create} disabled={busy}>계정 만들기</Btn>
            </div>
          </Card>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: "18px 0 8px", color: C.inkMid }}>계정 목록 {users ? `(${users.length})` : ""}</h3>
          {users === null && <p style={{ color: C.sub }}>불러오는 중…</p>}
          {(users || []).map((u) => (
            <button key={u.id} className="em-btn em-row" onClick={() => setEdit({ ...u, pw: "" })}
              style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, textAlign: "left", background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8, cursor: "pointer", fontFamily: FONT, opacity: u.active ? 1 : 0.55 }}>
              <span style={{ fontWeight: 700, color: C.ink }}>{u.name}</span>
              <Badge tone={u.role === "admin" ? "accent" : u.role === "teacher" ? "good" : "neutral"}>{ROLE_KO[u.role]}</Badge>
              <span style={{ color: C.sub, fontSize: 13.5 }}>{u.id}{u.role === "student" && u.teacherId ? ` · 담당 ${teacherName(u.teacherId)}` : ""}{u.active ? "" : " · 정지"}</span>
            </button>
          ))}
        </>
      )}

      {tab === "results" && (
        <div style={{ marginTop: 14 }}>
          {results === null ? <p style={{ color: C.sub }}>불러오는 중…</p> : results.length === 0 ? <p style={{ color: C.sub }}>아직 기록이 없습니다.</p> : (
            <Card style={{ padding: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr>{["때", "이름", "시험지", "점수", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
                <tbody>{results.map((it) => (
                  <tr key={it.id}>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtDate(it.at)}</td>
                    <td style={{ padding: "6px 8px" }}>{it.name}{it.userId ? "" : <span style={{ color: C.sub }}> (비회원)</span>}</td>
                    <td style={{ padding: "6px 8px" }}>{it.title || it.code}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{it.score}/{it.total}</td>
                    <td style={{ padding: "6px 8px" }}><TextBtn tone="sub" onClick={() => delResult(it)} style={{ fontSize: 13 }}>삭제</TextBtn></td>
                  </tr>
                ))}</tbody>
              </table>
            </Card>
          )}
        </div>
      )}

      {tab === "usage" && (
        <Card style={{ marginTop: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>AI 문제 생성 사용량</div>
          <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>Gemini 무료 등급이라 요금은 0원이지만, 하루 한도 관리를 위해 호출 수를 기록합니다.</p>
          {usage === null ? <Btn kind="soft" onClick={loadUsage}>불러오기</Btn> : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead><tr>{["모델", "호출", "성공", "입력 토큰", "출력 토큰"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
              <tbody>{Object.entries(usage.byModel || {}).map(([m, v]) => <tr key={m}><td style={{ padding: "6px 8px" }}>{m}</td><td style={{ padding: "6px 8px" }}>{v.calls}</td><td style={{ padding: "6px 8px" }}>{v.ok}</td><td style={{ padding: "6px 8px" }}>{v.inputTokens}</td><td style={{ padding: "6px 8px" }}>{v.outputTokens}</td></tr>)}</tbody>
            </table>
          )}
          {usage && <div style={{ fontSize: 13, color: C.sub, marginTop: 8 }}>기록 {usage.rows}건 · <TextBtn tone="sub" onClick={loadUsage} style={{ fontSize: 13 }}>새로고침</TextBtn></div>}
        </Card>
      )}

      {tab === "worker" && (
        <Card style={{ marginTop: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>분석 리포트 워커 연결</div>
          <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>학생 분석 리포트는 관리자 PC 의 Claude 예약 작업이 만듭니다. PC 의 study-helper\sync.json 에 있는 연결 코드를 등록하면 그 PC 만 기록을 읽고 리포트를 올릴 수 있습니다.</p>
          <Field value={workerKey} onChange={setWorkerKey} placeholder="연결 코드" ariaLabel="연결 코드" onEnter={setWorker} />
          <div style={{ marginTop: 10 }}><Btn kind="soft" onClick={setWorker}>등록</Btn></div>
        </Card>
      )}

      {edit && (
        <Modal title={`계정 수정 · ${edit.id}`} onClose={() => setEdit(null)}>
          <div style={{ display: "grid", gap: 8 }}>
            <Field value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder="이름" ariaLabel="이름" />
            <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} style={sel} aria-label="역할">
              <option value="student">학생</option><option value="teacher">선생</option><option value="admin">관리자</option>
            </select>
            {edit.role === "student" && (
              <select value={edit.teacherId || ""} onChange={(e) => setEdit({ ...edit, teacherId: e.target.value })} style={sel} aria-label="담당 선생">
                <option value="">담당 선생 없음</option>
                {teachers.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
              </select>
            )}
            <Field type="password" value={edit.pw} onChange={(v) => setEdit({ ...edit, pw: v })} placeholder="새 비밀번호 (바꿀 때만)" ariaLabel="새 비밀번호" />
            <CheckRow on={edit.active !== false} onToggle={() => setEdit({ ...edit, active: edit.active === false })}>로그인 허용</CheckRow>
            <Btn onClick={save} disabled={busy}>저장</Btn>
            <Btn kind="danger" onClick={del}>계정 삭제</Btn>
          </div>
        </Modal>
      )}
    </Shell>
  );
}

/* 결과 표 + 리포트 (선생·관리자가 학생을 볼 때, 학생이 자기 기록을 볼 때 공용) */
function ResultsTable({ items }) {
  if (!items.length) return <p style={{ color: C.sub, fontSize: 14.5 }}>아직 응시 기록이 없습니다.</p>;
  const avg = Math.round((items.reduce((s, r) => s + r.score / r.total, 0) / items.length) * 100);
  return (
    <>
      <p style={{ fontSize: 14.5, color: C.sub, margin: "0 0 8px" }}>{items.length}회 응시 · 평균 {avg}점</p>
      <Card style={{ padding: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead><tr>{["때", "시험지", "점수", "시간"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
          <tbody>{items.map((it) => (
            <tr key={it.id}><td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtDate(it.at)}</td><td style={{ padding: "6px 8px" }}>{it.title || it.code}</td><td style={{ padding: "6px 8px", whiteSpace: "nowrap", fontWeight: 700, color: it.score === it.total ? C.good : C.ink }}>{it.score}/{it.total}</td><td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtSec(it.sec)}</td></tr>
          ))}</tbody>
        </table>
      </Card>
    </>
  );
}

function StudentsScreen({ user, onBack, toast, flash }) {
  const [students, setStudents] = useState(null);
  const [detail, setDetail] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { (async () => { const r = await remote().userList(); if (!r.ok) return flash(errMsg(r)); setStudents(r.users.filter((u) => u.role === "student")); })(); }, []);
  const open = async (st) => {
    setBusy(true);
    const r = await remote().studentResults(st.id);
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    setReport(null); setDetail(r);
  };
  const openReport = async () => {
    setBusy(true);
    const r = await remote().reportGet(detail.student.id);
    setBusy(false);
    if (!r.ok) return flash(r.error === "no_report" ? "아직 리포트가 만들어지지 않았습니다. 관리자 PC 가 켜져 있으면 응시 후 10분 안에 만들어집니다." : errMsg(r));
    setReport(r.html);
  };
  if (detail && report !== null)
    return (
      <Shell back={detail.student.name} backTo={() => setReport(null)} toast={toast}>
        <div style={{ marginBottom: 10 }}><Btn kind="soft" onClick={() => { const w = window.open("", "_blank"); if (w) { w.document.write(report); w.document.close(); } }}>새 창에서 열기(인쇄·PDF)</Btn></div>
        <iframe title="분석 리포트" srcDoc={report} sandbox="allow-popups" style={{ width: "100%", height: "78vh", border: `1px solid ${C.line}`, borderRadius: 12, background: "#fff" }} />
      </Shell>
    );
  if (detail)
    return (
      <Shell back="학생 목록" backTo={() => setDetail(null)} toast={toast}>
        <h2 style={{ fontSize: 22, fontWeight: 800, margin: "6px 0 4px" }}>{detail.student.name} <span style={{ color: C.sub, fontSize: 14, fontWeight: 500 }}>{detail.student.id}</span></h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 14px" }}>
          <Btn onClick={openReport} disabled={busy}>분석 리포트 보기</Btn>
          <Btn kind="soft" onClick={async () => { const r = await remote().reportRequest(detail.student.id); flash(r.ok ? "요청했습니다. 관리자 PC 가 켜져 있으면 10분 안에 새 리포트가 만들어집니다." : errMsg(r)); }} disabled={busy}>리포트 새로 만들기</Btn>
          <Btn kind="soft" onClick={() => open(detail.student)} disabled={busy}>새로고침</Btn>
        </div>
        {detail.report && (
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13.5, color: C.sub }}>리포트 요약 · {fmtDate(detail.report.updatedAt)} 기준 {detail.report.basis}회</div>
            {detail.report.summary && detail.report.summary.headline && <div style={{ fontSize: 15, marginTop: 4 }}>{detail.report.summary.headline}</div>}
            {detail.report.summary && Array.isArray(detail.report.summary.weak) && detail.report.summary.weak.length > 0 && <div style={{ fontSize: 14, marginTop: 6 }}>취약: {detail.report.summary.weak.join(" · ")}</div>}
          </Card>
        )}
        <ResultsTable items={detail.items} />
      </Shell>
    );
  return (
    <Shell back="처음으로" backTo={onBack} toast={toast}>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 12px" }}>내 학생</h2>
      {students === null && <p style={{ color: C.sub }}>불러오는 중…</p>}
      {students && students.length === 0 && <p style={{ color: C.sub, fontSize: 14.5 }}>{user.role === "admin" ? "등록된 학생이 없습니다. 관리자 화면에서 계정을 만드세요." : "담당 학생이 없습니다. 관리자에게 학생 등록을 요청하세요."}</p>}
      {(students || []).map((st) => (
        <button key={st.id} className="em-btn em-row" onClick={() => open(st)} disabled={busy}
          style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, textAlign: "left", background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8, cursor: "pointer", fontFamily: FONT }}>
          <span style={{ fontWeight: 700, color: C.ink }}>{st.name}</span><span style={{ color: C.sub, fontSize: 13.5 }}>{st.id}{user.role === "admin" && st.teacherId ? ` · 담당 ${st.teacherId}` : ""}</span>
        </button>
      ))}
    </Shell>
  );
}

function MyResultsScreen({ user, onBack, toast, flash }) {
  const [detail, setDetail] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { const r = await remote().studentResults(user.id); if (!r.ok) return flash(errMsg(r)); setDetail(r); };
  useEffect(() => { load(); }, []);
  const openReport = async () => {
    setBusy(true);
    const r = await remote().reportGet(user.id);
    setBusy(false);
    if (!r.ok) return flash(r.error === "no_report" ? "아직 리포트가 없습니다. '리포트 새로 만들기'를 누르면 관리자 PC 가 켜져 있을 때 10분 안에 만들어집니다." : errMsg(r));
    setReport(r.html);
  };
  const request = async () => { const r = await remote().reportRequest(); flash(r.ok ? "요청했습니다. 관리자 PC 가 켜져 있으면 10분 안에 만들어집니다." : errMsg(r)); };
  if (report !== null)
    return (
      <Shell back="내 결과" backTo={() => setReport(null)} toast={toast}>
        <div style={{ marginBottom: 10 }}><Btn kind="soft" onClick={() => { const w = window.open("", "_blank"); if (w) { w.document.write(report); w.document.close(); } }}>새 창에서 열기(인쇄·PDF)</Btn></div>
        <iframe title="분석 리포트" srcDoc={report} sandbox="allow-popups" style={{ width: "100%", height: "78vh", border: `1px solid ${C.line}`, borderRadius: 12, background: "#fff" }} />
      </Shell>
    );
  return (
    <Shell back="처음으로" backTo={onBack} toast={toast}>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 12px" }}>내 결과·리포트</h2>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 14px" }}>
        <Btn onClick={openReport} disabled={busy}>분석 리포트 보기</Btn>
        <Btn kind="soft" onClick={request} disabled={busy}>리포트 새로 만들기</Btn>
        <Btn kind="soft" onClick={load} disabled={busy}>새로고침</Btn>
      </div>
      {detail && detail.report && (
        <Card style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13.5, color: C.sub }}>리포트 요약 · {fmtDate(detail.report.updatedAt)} 기준 {detail.report.basis}회</div>
          {detail.report.summary && detail.report.summary.headline && <div style={{ fontSize: 15, marginTop: 4 }}>{detail.report.summary.headline}</div>}
          {detail.report.summary && Array.isArray(detail.report.summary.weak) && detail.report.summary.weak.length > 0 && <div style={{ fontSize: 14, marginTop: 6 }}>취약: {detail.report.summary.weak.join(" · ")}</div>}
        </Card>
      )}
      {detail === null ? <p style={{ color: C.sub }}>불러오는 중…</p> : <ResultsTable items={detail.items} />}
    </Shell>
  );
}

function ExamMaker() {
  const [screen, setScreen] = useState("home");
  const [exams, setExams] = useState([]);
  const [recent, setRecent] = useState([]);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState(null);
  const [savedSnap, setSavedSnap] = useState(null);
  const [exportText, setExportText] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [codeInput, setCodeInput] = useState("");
  const [codeErr, setCodeErr] = useState("");

  const [run, setRun] = useState(null);
  const [picked, setPicked] = useState({});
  const [name, setName] = useState("");
  const [result, setResult] = useState(null);

  /* 계정 */
  const [user, setUser] = useState(null);
  const [needSetup, setNeedSetup] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const examsRef = useRef([]);
  useEffect(() => { examsRef.current = exams; }, [exams]);
  const loadServerExams = async () => {
    const r = await remote().examList();
    if (!r.ok) return false;
    const local = examsRef.current;
    if (r.exams.length === 0 && local.length > 0) {
      /* 계정 도입 전 이 브라우저에만 저장돼 있던 시험지를 서버로 한 번 옮긴다 */
      for (const e of local) await remote().examSave(e);
      setExams(local);
      await store.del("exams");   // 옮긴 뒤 브라우저 사본은 지운다(다른 계정에 섞이지 않게)
      return true;
    }
    setExams(r.exams.map(normalizeExam));
    return true;
  };
  const afterLogin = async (u) => {
    setNeedSetup(false);
    setUser(u);
    if (u.name) setName(u.name);
    await loadServerExams();
    setScreen("home");
  };
  const logoutNow = async () => {
    await remote().logout();
    authSet(null); setUser(null); setExams([]); setAcctOpen(false); setScreen("home");
    const pg = await remote().ping(); setNeedSetup(!!(pg && pg.setup));
  };

  /* 초기 로드 */
  useEffect(() => {
    (async () => {
      const [rawExams, rawRecent, rawName] = await Promise.all([store.get("exams"), store.get("recent"), store.get("name")]);
      try {
        const list = rawExams ? JSON.parse(rawExams) : [];
        setExams(Array.isArray(list) ? list.map(normalizeExam) : []);
      } catch (e) {
        setExams([]);
      }
      try {
        const list = rawRecent ? JSON.parse(rawRecent) : [];
        setRecent(Array.isArray(list) ? list : []);
      } catch (e) {
        setRecent([]);
      }
      if (rawName) setName(rawName);
      /* 계정 확인: 저장된 토큰이 살아 있으면 자동 로그인, 아니면 로그인 화면(관리자가 없으면 설정 화면) */
      if (remote().kind === "server") {
        const a = authGet();
        const meR = a && a.token ? await remote().me() : { ok: false };
        if (meR.ok) { authSet({ token: a.token, user: meR.user }); setUser(meR.user); if (meR.user.name) setName(meR.user.name); await loadServerExams(); }
        else { authSet(null); const pg = await remote().ping(); setNeedSetup(!!(pg && pg.setup)); }
      } else {
        setUser({ id: "local", role: "admin", name: "로컬" });
      }
      setReady(true);
    })();
  }, []);

  const flash = (m) => {
    setToast(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2400);
  };

  const persist = async (list) => {
    const prev = examsRef.current;
    setExams(list);
    let ok = true;
    if (remote().kind !== "server") ok = await store.set("exams", JSON.stringify(list));
    if (remote().kind === "server" && user) {
      for (const e of list) {
        const p = prev.find((x) => x.id === e.id);
        if (!p || p.updatedAt !== e.updatedAt || p.code !== e.code) { const r = await remote().examSave(e); if (!r.ok) { ok = false; flash(errMsg(r)); } }
      }
      for (const p of prev) if (!list.some((x) => x.id === p.id)) remote().examDelete(p.id);
    } else if (!ok) flash("저장에 실패했어요. 잠시 후 다시 시도해 주세요.");
    return ok;
  };

  const snapOf = (e) => JSON.stringify({ ...e, updatedAt: 0 });
  const dirty = draft ? snapOf(draft) !== savedSnap : false;

  /* 편집 */
  const openEditor = (exam, isNew) => {
    setDraft(exam);
    setSavedSnap(isNew ? null : snapOf(exam));
    setScreen("editor");
  };
  const newExam = () => openEditor(normalizeExam({ id: uid() }), true);
  const openExam = (id) => {
    const e = exams.find((x) => x.id === id);
    if (e) openEditor(JSON.parse(JSON.stringify(e)), false);
  };

  const upsert = (list, item) => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list]);

  const saveDraft = async (silent) => {
    if (!draft) return false;
    const next = { ...draft, updatedAt: Date.now() };
    setDraft(next);
    const ok = await persist(upsert(exams, next));
    if (ok) {
      setSavedSnap(snapOf(next));
      if (!silent) flash("저장했습니다.");
    }
    return ok;
  };

  const shareDraft = async () => {
    if (!draft) return null;
    setBusy(true);
    const payload = { ...payloadOf(draft), sharedAt: Date.now() };
    let r = await remote().share(draft.code, draft.ownerKey, payload);
    if (!r.ok && r.error === "bad_key") {
      flash("수정 권한이 없어 새 코드로 공유합니다.");
      r = await remote().share(null, null, payload);
    }
    if (!r.ok) {
      setBusy(false);
      flash(errMsg(r));
      return null;
    }
    const next = { ...draft, code: r.code, ownerKey: r.key || draft.ownerKey, sharedHash: hashOf(draft), sharedAt: payload.sharedAt, updatedAt: Date.now() };
    setDraft(next);
    await persist(upsert(exams, next));
    setSavedSnap(snapOf(next));
    setBusy(false);
    return r.code;
  };

  const removeExam = async (id) => {
    const e = exams.find((x) => x.id === id);
    await persist(exams.filter((x) => x.id !== id));
    if (e && e.code) remote().deleteQuiz(e.code, e.ownerKey);
    flash("삭제했습니다.");
  };

  const duplicateExam = async (id) => {
    const e = exams.find((x) => x.id === id);
    if (!e) return;
    const copy = normalizeExam({ ...JSON.parse(JSON.stringify(e)), id: uid(), title: `${e.title || "제목 없음"} (복사본)`, code: null, ownerKey: null, sharedHash: null, sharedAt: null, createdAt: Date.now(), updatedAt: Date.now() });
    copy.questions = copy.questions.map((q) => ({ ...q, id: uid() }));
    await persist([copy, ...exams]);
    flash("복제했습니다.");
  };

  const importExams = async (list) => {
    await persist([...list, ...exams]);
    setImportOpen(false);
    flash(`시험지 ${list.length}개를 가져왔습니다.`);
  };

  const exportOne = () => draft && setExportText(JSON.stringify({ exams: [draft] }, null, 2));
  const exportAll = () => setExportText(JSON.stringify({ exams }, null, 2));

  /* 응시 */
  const loadByCode = async (codeArg) => {
    const code = cleanCode(codeArg || codeInput);
    if (code.length !== 5) return;
    setBusy(true);
    setCodeErr("");
    const r = await remote().getQuiz(code);
    setBusy(false);
    if (!r.ok) {
      setCodeErr(errMsg(r));
      return;
    }
    const src = parsePayload(JSON.stringify(r.quiz));
    if (!src) {
      setCodeErr("시험지 데이터가 손상되어 열 수 없습니다. 출제자에게 다시 공유해 달라고 해 주세요.");
      return;
    }
    setRun(buildRun(src, code));
    setPicked({});
    setResult(null);
    setScreen("take");
    window.scrollTo(0, 0);
  };

  const togglePick = (qid, oi) =>
    setPicked((p) => {
      const cur = p[qid] || [];
      const next = cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi].sort((a, b) => a - b);
      return { ...p, [qid]: next };
    });

  const submit = async () => {
    const rows = run.questions.map((q) => {
      const mine = picked[q.id] || [];
      return { q, mine, ok: mine.length > 0 && sameSet(mine, q.answers) };
    });
    const score = rows.filter((r) => r.ok).length;
    const total = rows.length;
    const sec = (Date.now() - run.startedAt) / 1000;
    setResult({ rows, score, total, sec });
    setScreen("result");
    window.scrollTo(0, 0);

    if (run.partial) return;
    const trimmed = name.trim().slice(0, 20);
    /* 최근 목록 + 이름 기억 (내 저장소) */
    const nextRecent = [{ code: run.code, title: run.title, score, total, at: Date.now() }, ...recent.filter((r) => r.code !== run.code)].slice(0, 8);
    setRecent(nextRecent);
    store.set("recent", JSON.stringify(nextRecent));
    if (trimmed) store.set("name", trimmed);
    /* 출제자에게 결과 전달 */
    remote().submit(run.code, { name: trimmed, score, total, sec: Math.round(sec), detail: rows.map((r) => ({ q: r.q.id, m: r.mine, ok: r.ok })) });
  };

  const retryWrong = (ids) => {
    setRun(buildRun(run.src, run.code, new Set(ids)));
    setPicked({});
    setResult(null);
    setScreen("take");
    window.scrollTo(0, 0);
  };
  const retryAll = () => {
    setRun(buildRun(run.src, run.code));
    setPicked({});
    setResult(null);
    setScreen("take");
    window.scrollTo(0, 0);
  };

  const goHome = () => {
    setDraft(null);
    setSavedSnap(null);
    setScreen("home");
  };

  /* ── 렌더 ──────────────────────────────────── */
  if (!ready)
    return (
      <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.sub, display: "flex", alignItems: "center", justifyContent: "center" }}>
        불러오는 중…
      </div>
    );

  if (remote().kind === "server" && !user)
    return <LoginScreen needSetup={needSetup} onDone={afterLogin} toast={toast} flash={flash} />;

  if (screen === "admin") return <AdminScreen onBack={goHome} toast={toast} flash={flash} />;
  if (screen === "students") return <StudentsScreen user={user} onBack={goHome} toast={toast} flash={flash} />;
  if (screen === "myresults") return <MyResultsScreen user={user} onBack={goHome} toast={toast} flash={flash} />;

  const overlays = (
    <>
      {acctOpen && user && <AccountModal user={user} onClose={() => setAcctOpen(false)} onLogout={logoutNow} flash={flash} />}
      {exportText !== null && <ExportModal title="내보내기" text={exportText} onClose={() => setExportText(null)} flash={flash} />}
      {importOpen && <ImportModal onImport={importExams} onClose={() => setImportOpen(false)} />}
    </>
  );

  if (screen === "home")
    return (
      <>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} flash={flash} />}
      {overlays}
      <HomeScreen
        exams={exams}
        recent={recent}
        mode={remote().kind}
        toast={toast}
        onSettings={() => setSettingsOpen(true)}
        onNew={newExam}
        onList={() => setScreen("list")}
        onStudy={() => setScreen("study")}
        user={user}
        onAdmin={() => setScreen("admin")}
        onStudents={() => setScreen("students")}
        onMyResults={() => setScreen("myresults")}
        onAccount={() => setAcctOpen(true)}
        onCode={() => {
          setCodeInput("");
          setCodeErr("");
          setScreen("code");
        }}
        onOpenRecent={(code) => {
          setCodeInput(code);
          setCodeErr("");
          setScreen("code");
          loadByCode(code);
        }}
      />
      </>
    );

  if (screen === "study") return <StudyScreen onBack={() => setScreen("home")} flash={flash} toast={toast} />;

  if (screen === "list")
    return (
      <>
        <ListScreen
          exams={exams}
          toast={toast}
          onOpen={openExam}
          onNew={newExam}
          onDelete={removeExam}
          onDuplicate={duplicateExam}
          onImport={() => setImportOpen(true)}
          onExportAll={exportAll}
          onBack={goHome}
        />
        {overlays}
      </>
    );

  if (screen === "editor" && draft)
    return (
      <>
        <EditorScreen
          draft={draft}
          setDraft={setDraft}
          dirty={dirty}
          busy={busy}
          onSave={() => saveDraft(false)}
          onShare={shareDraft}
          onBack={goHome}
          onExport={exportOne}
          flash={flash}
          toast={toast}
        />
        {overlays}
      </>
    );

  if (screen === "code")
    return <CodeScreen codeInput={codeInput} setCodeInput={setCodeInput} codeErr={codeErr} busy={busy} onLoad={() => loadByCode()} onBack={goHome} toast={toast} />;

  if (screen === "take" && run)
    return <TakeScreen run={run} picked={picked} togglePick={togglePick} name={name} setName={setName} onSubmit={submit} onExit={goHome} toast={toast} />;

  if (screen === "result" && result && run)
    return <ResultScreen run={run} result={result} onRetryWrong={retryWrong} onRetryAll={retryAll} onHome={goHome} flash={flash} toast={toast} />;

  return (
    <Shell back="처음으로" backTo={goHome} toast={toast}>
      <Card>화면을 불러오지 못했습니다. 처음으로 돌아가 주세요.</Card>
    </Shell>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<ExamMaker />);

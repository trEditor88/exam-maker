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

/* ── 색상 토큰 (CSS 변수 → 밝게/어둡게 전환) ───── */
const C = {
  bg: "var(--em-bg)", card: "var(--em-card)", field: "var(--em-field)",
  ink: "var(--em-ink)", inkMid: "var(--em-inkMid)", sub: "var(--em-sub)",
  line: "var(--em-line)", lineSoft: "var(--em-lineSoft)",
  accent: "var(--em-accent)", accentSoft: "var(--em-accentSoft)",
  good: "var(--em-good)", goodSoft: "var(--em-goodSoft)",
  warn: "var(--em-warn)", warnSoft: "var(--em-warnSoft)",
  bad: "var(--em-bad)", badSoft: "var(--em-badSoft)",
  shadow: "var(--em-shadow)", dim: "var(--em-dim)",
  onAccent: "var(--em-onAccent)",   // 액센트 배경 위 글자색(다크에서는 어두운 글자로 대비 확보)
  warnLine: "var(--em-warnLine)",   // 경고 상자 테두리
};
/* Light 하우스 팔레트(설명서·리포트·오답노트와 같은 얼굴) */
const THEME_LIGHT = { bg: "#FFFFFF", card: "#F5F5F7", field: "#FFFFFF", ink: "#1D1D1F", inkMid: "#3A3A3C", sub: "#6E6E73", line: "#E0E0E0", lineSoft: "#ECECEF", accent: "#0066CC", accentSoft: "#E8F1FB", good: "#15803D", goodSoft: "#E6F4EA", warn: "#9A6700", warnSoft: "#FFF4DD", bad: "#C0392B", badSoft: "#FBE9E7", shadow: "0 4px 20px rgba(0,0,0,.05)", dim: "rgba(29,29,31,.45)", onAccent: "#FFFFFF", warnLine: "#F3DFB0" };
const THEME_DARK = { bg: "#0B0B0D", card: "#1C1C1E", field: "#2C2C2E", ink: "#F5F5F7", inkMid: "#D1D1D6", sub: "#98989D", line: "#3A3A3C", lineSoft: "#2C2C2E", accent: "#4A9EFF", accentSoft: "#17304B", good: "#4CC38A", goodSoft: "#143021", warn: "#E0A526", warnSoft: "#3A2E10", bad: "#FF6B5B", badSoft: "#3B1A17", shadow: "none", dim: "rgba(0,0,0,.6)", onAccent: "#0B0B0D", warnLine: "#5A4A1E" };   // 다크 primary 버튼: 흰 글자(2.9:1) 대신 어두운 글자(7:1)

const FONT =
  "'Pretendard','Apple SD Gothic Neo','Malgun Gothic',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

/* ── 저장소 어댑터 ───────────────────────────────
   claude.ai 아티팩트의 window.storage(개인/공유)를 우선 사용하고,
   없으면 localStorage, 그것도 안 되면 메모리에 보관합니다.
   shared=true 인 키는 코드 공유용(다른 사람이 읽음), false 는 내 것. */
const mem = {};
const LS_PREFIX = "exam-maker:";

/* ── 테마(밝게/어둡게/기기 설정) + 전역 CSS ───────
   C 의 값이 CSS 변수라 화면 코드는 그대로 두고 :root 변수만 바꾸면 테마가 바뀐다. */
/* 학교·학년·학년도(이 브라우저에 저장). 기본 상현고 1학년 2026 — AI 문제 만들기의 교과서 자동 선택에 쓴다 */
const SCHOOL_DEFAULT = { school: "상현고", grade: 1, year: 2026 };
const schoolGet = () => { try { return Object.assign({}, SCHOOL_DEFAULT, JSON.parse(localStorage.getItem(LS_PREFIX + "school") || "{}")); } catch (e) { return { ...SCHOOL_DEFAULT }; } };
const schoolSet = (v) => { try { localStorage.setItem(LS_PREFIX + "school", JSON.stringify(v)); } catch (e) {} };
const tbLabel = (t) => t ? `${t.publisher ? t.publisher + " " : ""}${t.subject}${t.author ? " (" + t.author + ")" : ""}` : "";
/* 과목 글자(예: "통합과학", "한국사 1단원")로 교과서 목록에서 가장 맞는 것을 고른다 */
function pickTextbook(tbs, text, grade) {
  const norm = (v) => String(v || "").replace(/[\s·]/g, "");
  const t = norm(text); if (!t || !tbs.length) return -1;
  let best = -1, bestScore = 0;
  tbs.forEach((tb, i) => {
    if (grade && tb.grade && tb.grade !== grade) return;   // 다른 학년 과목은 고르지 않는다
    const base = norm(tb.subject).replace(/\d+$/, ""); if (!base) return;
    let sc = 0;
    if (t.startsWith(norm(tb.subject))) sc = 3; else if (t.includes(base) || base.includes(t)) sc = 2;
    if (sc && grade && tb.grade === grade) sc += 0.5;
    if (sc > bestScore) { bestScore = sc; best = i; }
  });
  return best;
}
const themeGet = () => { try { return localStorage.getItem(LS_PREFIX + "theme") || "auto"; } catch (e) { return "auto"; } };
function applyTheme() {
  const pref = themeGet();
  let dark = pref === "dark";
  if (pref === "auto") { try { dark = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) {} }
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}
const themeSet = (v) => { try { v === "auto" ? localStorage.removeItem(LS_PREFIX + "theme") : localStorage.setItem(LS_PREFIX + "theme", v); } catch (e) {} applyTheme(); };
const themeVars = (t) => Object.keys(t).map((k) => `--em-${k}:${t[k]};`).join("");
const UI_CSS = `
:root{${themeVars(THEME_LIGHT)}color-scheme:light;}
:root[data-theme="dark"]{${themeVars(THEME_DARK)}color-scheme:dark;}
html,body{background:${C.bg};}
@keyframes emIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.em-page{animation:emIn .25s ease-out;}
.em-in:focus{border-color:${C.accent} !important;box-shadow:0 0 0 3px ${C.accentSoft};}
.em-btn:focus-visible{outline:2px solid ${C.accent};outline-offset:2px;}
.em-row{transition:border-color .15s,background .15s,transform .15s;}
.em-row:focus-visible{outline:2px solid ${C.accent};outline-offset:2px;}
.em-row:hover{border-color:${C.accent};}
.em-stat:hover{transform:translateY(-1px);}
.em-stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:0 0 18px;}
@media (min-width:600px){.em-stats{grid-template-columns:repeat(4,1fr);}}
.em-nav{position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:space-around;border-top:1px solid ${C.line};background:${C.bg};backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);z-index:50;padding:6px 4px calc(6px + env(safe-area-inset-bottom));box-sizing:border-box;}
.em-nav-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:none;border:none;font-family:inherit;font-size:11.5px;font-weight:600;color:${C.sub};padding:6px 2px;border-radius:12px;cursor:pointer;min-height:48px;transition:background .15s,color .15s;}
.em-nav-item[aria-current="page"]{color:${C.accent};}
.em-nav-item svg{width:22px;height:22px;flex:0 0 auto;}
.em-nav-logo{display:none;}
.em-nav-item.em-nav-more{display:none;}
.em-nav-profile{display:none;}
.em-fig svg{max-width:100%;height:auto;display:block;background:#fff;border-radius:10px;}
.em-tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;}
.em-tbl td,.em-tbl th{min-width:60px;box-sizing:border-box;}
.em-tbl td.em-wrap{min-width:160px;word-break:keep-all;}
@media (max-width:639px){.em-tbl{min-width:560px;}}
.em-modal{--em-modal-max:calc(100vh - 40px);--em-modal-max:calc(100dvh - 40px);}
body.em-has-nav .em-modal{padding-bottom:calc(84px + env(safe-area-inset-bottom)) !important;--em-modal-max:calc(100vh - 124px - env(safe-area-inset-bottom));--em-modal-max:calc(100dvh - 124px - env(safe-area-inset-bottom));}
.em-toast{bottom:24px;}
body.em-has-nav .em-toast{bottom:calc(84px + env(safe-area-inset-bottom));}
.em-jump{position:fixed;right:14px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:40;}
.em-jump button{width:36px;height:36px;border-radius:999px;border:none;background:${C.lineSoft};color:${C.inkMid};padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:${C.shadow};}
.em-jump button svg{width:20px;height:20px;display:block;}
.em-jump button:hover{background:${C.line};}
@media (min-width:1024px){.em-jump{right:max(14px, calc(50% - 584px));}}
.em-nav-dot{position:absolute;top:-6px;right:-10px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:999px;background:${C.bad};color:#fff;font-size:10px;font-weight:800;display:flex;align-items:center;justify-content:center;line-height:1;}
.em-hero:hover{filter:brightness(1.04);} .em-hero:focus-visible{outline:2px solid ${C.ink};outline-offset:2px;}
body.em-has-nav .em-page{padding-bottom:104px !important;}
.em-split-side{display:none;}
@media (min-width:1024px){
  .em-nav{left:0;top:0;bottom:0;right:auto;width:220px;flex-direction:column;justify-content:flex-start;border-top:none;border-right:1px solid ${C.line};padding:22px 12px;gap:4px;}
  .em-nav-logo{display:block;font-size:20px;font-weight:800;padding:6px 12px 18px;color:${C.ink};letter-spacing:-0.02em;}
  .em-nav-item{flex:0 0 auto;flex-direction:row;justify-content:flex-start;gap:10px;font-size:15px;padding:10px 12px;width:100%;box-sizing:border-box;min-height:44px;}
  .em-nav-item[aria-current="page"]{background:${C.card};color:${C.ink};}
  .em-nav-item:hover{background:${C.card};}
  .em-nav-item.em-nav-more{display:flex;}
  .em-nav-item.em-nav-acct{display:none;}
  .em-nav-profile{display:flex;align-items:center;gap:10px;margin-top:auto;width:100%;box-sizing:border-box;background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:12px;cursor:pointer;font-family:inherit;text-align:left;}
  .em-nav-profile:hover{border-color:${C.accent};}
  body.em-has-nav .em-root{padding-left:220px;}
  body.em-has-nav .em-page{padding-bottom:60px !important;}
  body.em-has-nav .em-toast{bottom:24px;}
  body.em-has-nav .em-modal{padding-bottom:20px !important;--em-modal-max:calc(100vh - 40px);--em-modal-max:calc(100dvh - 40px);}
  .em-split{display:grid;grid-template-columns:300px minmax(0,1fr);gap:22px;align-items:start;}
  .em-split-side{display:block;}
}
.em-only-d{display:none;}
/* 하위 화면: PC 에선 옆 메뉴가 있으니 "← 홈으로"를 숨기고 본문을 넓힌다 */
@media (min-width:1024px){body.em-has-nav .em-back-home{display:none;} body.em-has-nav .em-page.em-narrow{max-width:760px !important;}}
/* 휴대폰: 위/아래 이동 버튼이 보기를 가리지 않게 숨김(손가락으로 스크롤) */
@media (max-width:639px){.em-jump{display:none;}}
/* 문제지 편집(종이 모양): 테마와 무관하게 흰 종이 */
.em-ebar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:6px;background:${C.bg};padding:8px 0;margin-bottom:12px;border-bottom:1px solid ${C.line};}
.em-ebar .eb{width:40px;height:40px;border-radius:10px;border:1px solid ${C.line};background:${C.card};color:${C.ink};display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;}
.em-ebar .eb:disabled{opacity:.35;cursor:default;} .em-ebar .eb svg{width:20px;height:20px;display:block;}
.eb-add{position:relative;display:inline-flex;} .eb-add .eb.main{border-radius:10px 0 0 10px;background:${C.accent};border-color:${C.accent};color:#fff;} .eb-add .eb.caret{width:28px;border-radius:0 10px 10px 0;border-left:none;}
.em-paper{background:#fff;color:#1D1D1F;border-radius:6px;box-shadow:0 2px 14px rgba(0,0,0,.12);padding:26px 28px 40px;font-size:15px;line-height:1.6;}
@media (max-width:639px){.em-paper{padding:16px 14px 28px;}}
.pp-hd{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;border:2px solid var(--pac);border-radius:14px;padding:12px 14px;margin:0 0 14px;}
.pp-tag{display:flex;flex-direction:column;gap:3px;font-size:12px;font-weight:800;} .pp-tag span{border-radius:6px;padding:1px 8px;text-align:center;} .pp-tag span:first-child{background:var(--pacs);color:var(--pac);} .pp-tag span:last-child{background:var(--pac);color:#fff;}
.pp-ttl{text-align:center;font-size:20px;font-weight:800;min-width:0;} .pp-kind{font-size:12px;font-weight:800;color:var(--pac);border:1.5px solid var(--pac);border-radius:999px;padding:2px 10px;white-space:nowrap;}
@media (max-width:639px){.pp-hd{grid-template-columns:1fr;text-align:center;} .pp-tag{flex-direction:row;justify-content:center;} .pp-kind{justify-self:center;white-space:normal;}}
.pp-box{border:1.5px solid var(--pac);border-radius:10px;padding:8px 12px;margin:0 0 14px;font-size:14px;white-space:pre-wrap;}
.pp-pill{display:inline-block;border:1.5px solid var(--pac);color:var(--pac);font-weight:800;font-size:13.5px;border-radius:999px;padding:3px 16px;margin:0 0 10px;}
.pp-cols{columns:2;column-gap:30px;column-rule:1px dashed #E5E5EA;} @media (max-width:760px){.pp-cols{columns:1;}}
.em-pq{position:relative;break-inside:avoid;padding:10px 12px;margin:0 -12px 6px;border:2px solid transparent;border-radius:10px;cursor:pointer;}
.em-pq:hover{border-color:#E3F1FC;} .em-pq.on{border-color:#8CCBF5;background:#F6FBFF;cursor:default;}
.pq-dots{position:absolute;top:4px;right:4px;width:32px;height:32px;border:none;border-radius:8px;background:#E3F1FC;color:#1A8FE0;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;} .pq-dots svg{width:20px;height:20px;}
.pq-menu{position:absolute;top:40px;right:4px;z-index:25;background:#fff;color:#1D1D1F;border:1px solid #D5D5DA;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.16);padding:6px;min-width:180px;display:grid;}
.pq-menu button{text-align:left;font:inherit;font-size:14.5px;padding:9px 12px;border:none;background:none;border-radius:8px;cursor:pointer;color:inherit;} .pq-menu button:hover{background:#F2F2F5;} .pq-menu button.danger{color:#C0392B;}
.eb-types{top:46px;right:0;}
.pq-h{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;padding-right:32px;} .pq-n{font-weight:800;font-size:16px;white-space:nowrap;} .pq-t{font-weight:700;white-space:pre-wrap;flex:1;min-width:0;} .pq-sub{color:#6E6E73;font-weight:400;font-size:13px;}
.pq-src{flex:0 0 auto;font-size:12px;font-weight:700;color:#6E6E73;border:1px solid #D5D5DA;border-radius:99px;padding:1px 8px;white-space:nowrap;}
.em-pq.on .pq-ed{cursor:text;border-radius:4px;} .em-pq.on .pq-ed:hover,.pp-ttl .pq-ed:hover,.pp-box .pq-ed:hover{background:#E3F1FC;cursor:text;} .pq-ph{color:#A1A1A6;font-weight:400;}
.pq-in{width:100%;box-sizing:border-box;font:inherit;color:inherit;background:#fff;border:1.5px solid #1A8FE0;border-radius:6px;padding:2px 6px;resize:none;overflow:hidden;outline:none;display:block;}
.pq-opts{display:grid;gap:4px 14px;margin:0 0 4px 2px;} .pq-opts.two{grid-template-columns:1fr 1fr;} .pq-o{display:flex;gap:6px;min-width:0;} .pq-ot{flex:1;min-width:0;} .pq-m{color:var(--pac);font-weight:700;}
.pq-o.ans .pq-m{text-decoration:underline 2px;text-underline-offset:3px;}
.pq-pas{border:1px solid #D5D5DA;border-radius:6px;padding:8px 10px;margin:0 0 8px;font-size:14px;white-space:pre-wrap;background:#FAFAFA;}
.pq-fig{position:relative;display:block;width:100%;max-width:420px;margin:2px 0 8px;} .pq-fig.on{outline:2px dashed #8CCBF5;outline-offset:3px;border-radius:4px;}
.pq-trash{position:absolute;top:-12px;right:-12px;width:32px;height:32px;border-radius:999px;border:none;background:#C0392B;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;box-shadow:0 2px 6px rgba(0,0,0,.2);} .pq-trash svg{width:18px;height:18px;}
.pq-figph{border:1.5px dashed #C7C7CC;border-radius:8px;padding:16px;text-align:center;color:#8E8E93;font-size:13px;margin:2px 0 8px;}
.pq-short{margin:4px 0;font-size:14px;} .pq-short i{display:inline-block;width:60%;border-bottom:1px solid #1D1D1F;vertical-align:-3px;} .pq-essay{border:1px solid #D5D5DA;border-radius:6px;height:80px;margin:4px 0;}
input[aria-label="공유 코드"]::placeholder{font-size:17px;font-weight:500;letter-spacing:0.02em;color:${C.sub};}
.em-filepick{position:relative;display:inline-flex;align-items:center;gap:8px;padding:10px 16px;border-radius:999px;border:1px solid ${C.line};background:${C.field};color:${C.accent};font-size:15px;font-weight:700;cursor:pointer;min-height:44px;box-sizing:border-box;}
.em-filepick:hover{border-color:${C.accent};} .em-filepick:focus-within{outline:2px solid ${C.accent};outline-offset:2px;}
.em-filepick input{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;}
.em-filepick svg{width:20px;height:20px;}
/* 응시 기록: 휴대폰은 카드, 그 이상은 표 */
.em-rt-cards{display:none;}
@media (max-width:639px){.em-rt-table{display:none;} .em-rt-cards{display:grid;gap:8px;}}
.em-quick{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.em-quick .em-quick-wide{grid-column:1 / -1;}
.em-ico svg{width:100%;height:100%;display:block;}
.em-btn-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;}
@media (max-width:639px){.em-btn-grid{grid-template-columns:1fr 1fr;} .em-btn-grid > :last-child:nth-child(odd){grid-column:1 / -1;}}
/* 내 시험지: 휴대폰은 카드, PC(1024px+)는 한 줄 목록 */
.em-exam-list{display:grid;gap:12px;}
.em-exam-item{background:${C.card};border:1px solid ${C.line};border-radius:18px;padding:14px 16px;box-shadow:${C.shadow};}
.em-exam-item .em-exam-act{margin-top:8px;}
@media (min-width:1024px){
  .em-exam-list{gap:0;border:1px solid ${C.line};border-radius:18px;background:${C.card};overflow:hidden;box-shadow:${C.shadow};}
  .em-exam-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;border:none;border-radius:0;border-bottom:1px solid ${C.line};padding:10px 16px;box-shadow:none;background:transparent;}
  .em-exam-item:last-child{border-bottom:none;} .em-exam-item:hover{background:${C.accentSoft};}
  .em-exam-item .em-exam-act{margin-top:0;white-space:nowrap;}
}
@media (min-width:1024px){
  .em-only-d{display:block;} .em-only-m{display:none;}
  .em-home{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:28px;align-items:start;}
}
@media (prefers-reduced-motion: reduce){*{transition:none !important;animation:none !important;}}
.m-rt{white-space:nowrap;} .m-rad{border-top:1.5px solid currentColor;padding:0 2px 0 1px;margin-left:1px;}
.m-frac{display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;font-size:.88em;line-height:1.15;margin:0 2px;}
.m-frac>span:first-child{border-bottom:1.5px solid currentColor;padding:0 3px 1px;} .m-frac>span:last-child{padding:1px 3px 0;}
.m-txt sup,.m-txt sub{font-size:.72em;line-height:0;}
`;
(function installTheme() {
  const st = document.createElement("style"); st.textContent = UI_CSS; document.head.appendChild(st);
  applyTheme();
  try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme); } catch (e) {}
})();
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
  let r;
  try {
    const a = authGet();
    /* 서버가 응답하지 않으면 무한 "불러오는 중" 대신 시간 초과로 끝낸다(AI 생성·사진 올리기는 넉넉히) */
    const long = /^(generate|aiEdit|jobCreate|jobPhoto|sh_upload|sh_confirm|reportRequest|reportGet|sh_note|sh_detail|jobFile)$/.test(String(body.action || ""));
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), long ? 150000 : 35000) : null;
    try {
      r = await fetch(syncUrl(), { method: "POST", body: JSON.stringify({ ...(a && a.token ? { token: a.token } : {}), ...body }), ...(ctl ? { signal: ctl.signal } : {}) });
    } finally { if (timer) clearTimeout(timer); }
  } catch (e) { return { ok: false, error: e && e.name === "AbortError" ? "timeout" : "network" }; }
  let j;
  try { j = await r.json(); } catch (e) { return { ok: false, error: "server", message: `HTTP ${r.status}` }; }   // 로그인 페이지·502 같은 HTML 응답은 "인터넷 연결" 이 아니라 서버 오류
  if (j && j.ok === false && j.error === "bad_token" && body.action !== "logout") {
    /* 토큰이 죽었으면 저장된 로그인 정보를 지우고 앱(ExamMaker)에 알려 로그인 화면으로 보낸다 */
    authSet(null);
    try { window.dispatchEvent(new Event("em-logout")); } catch (e) {}
  }
  return j;
}
const serverRemote = {
  kind: "server",
  getQuiz: (code) => apiGet({ action: "quiz", code }),
  itemReport: (code, qid, reason, note) => apiPost({ action: "itemReport", code, qid, reason, note: note || "" }),
  quizReview: (code, studentId) => apiGet({ action: "quizReview", code, ...(studentId ? { studentId } : {}) }),
  results: (code, key) => apiGet({ action: "results", code, key }),
  share: (code, key, quiz) => apiPost({ action: "share", code, key, quiz }),
  deleteQuiz: (code, key) => apiPost({ action: "delete", code, key }),
  submit: (code, entry) => apiPost({ action: "submit", code, entry }),
  clearResults: (code, key) => apiPost({ action: "clearResults", code, key }),
  generate: (params) => apiPost({ action: "generate", ...params }),
  aiEdit: (params) => apiPost({ action: "aiEdit", ...params }),
  genAvailable: async () => { const r = await apiGet({ action: "ping" }); return !!(r && r.ok && r.gen); },
  shList: () => apiGet({ action: "sh_list" }),
  shDetail: (ws) => apiGet({ action: "sh_detail", ws }),
  shNote: (ws) => apiGet({ action: "sh_note", ws }),
  shUpload: (params) => apiPost({ action: "sh_upload", ...params }),
  shConfirm: (params) => apiPost({ action: "sh_confirm", ...params }),
  ping: () => apiGet({ action: "ping" }),
  setup: (b) => apiPost({ action: "setup", ...b }),
  login: (b) => apiPost({ action: "login", ...b }),
  signup: (b) => apiPost({ action: "signup", ...b }),
  permRequest: (b) => apiPost({ action: "permRequest", ...b }),
  adminNotify: (b) => apiPost({ action: "adminNotify", ...b }),
  examListAll: () => apiGet({ action: "examList", all: "1" }),
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
  resultUpdate: (b) => apiPost({ action: "resultUpdate", ...b }),
  graderCheck: (b) => apiPost({ action: "graderCheck", ...b }),
  resultManual: (b) => apiPost({ action: "resultManual", ...b }),
  activityList: (params) => apiGet({ action: "activityList", ...(params || {}) }),
  reportGet: (studentId) => apiGet({ action: "reportGet", studentId }),
  reportRequest: (studentId) => apiPost({ action: "reportRequest", studentId }),
  workerKeySet: (key) => apiPost({ action: "workerKeySet", key }),
  assignList: (code) => apiGet(code ? { action: "assignList", code } : { action: "assignList" }),
  assignListMany: (codes) => apiGet({ action: "assignList", codes }),
  assignSet: (code, studentIds, dueAt, memo, purgeDays) => apiPost({ action: "assignSet", code, studentIds, dueAt: dueAt || 0, memo: memo || "", purgeDays: purgeDays == null ? 30 : purgeDays }),
  assignUpdate: (code, dueAt, memo, purgeDays) => apiPost({ action: "assignUpdate", code, dueAt: dueAt || 0, memo: memo || "", purgeDays: purgeDays == null ? 30 : purgeDays }),
  examTrashList: (all) => apiGet({ action: "examTrashList", ...(all ? { all: "1" } : {}) }),
  examTrash: (id) => apiPost({ action: "examTrash", id }),
  examRestore: (id) => apiPost({ action: "examRestore", id }),
  pushKey: () => apiGet({ action: "pushKey" }),
  pushSubscribe: (sub) => apiPost({ action: "pushSubscribe", sub }),
  pushUnsubscribe: (endpoint) => apiPost({ action: "pushUnsubscribe", endpoint }),
  assignRemind: (code) => apiPost({ action: "assignRemind", code }),
  assignRemove: (code, studentId) => apiPost({ action: "assignRemove", code, studentId }),
  profileUpdate: (b) => apiPost({ action: "profileUpdate", ...b }),
  jobCreate: (params, type, pending) => apiPost({ action: "jobCreate", params, type: type || "gen", pending: pending || 0 }),
  jobPhoto: (id, filename, mime, data) => apiPost({ action: "jobPhoto", id, filename, mime, data }),
  jobReady: (id) => apiPost({ action: "jobReady", id }),
  jobList: () => apiGet({ action: "jobList" }),
  jobCancel: (id) => apiPost({ action: "jobCancel", id }),
  noteList: () => apiGet({ action: "noteList" }),
  noteSeen: (ids) => apiPost({ action: "noteSeen", ids }),
  textbookGet: (school, year) => apiGet({ action: "textbookGet", school, year }),
  textbookSet: (b) => apiPost({ action: "textbookSet", ...b }),
  schoolLookup: (b) => apiPost({ action: "schoolLookup", ...b }),
  usage: () => apiGet({ action: "usage" }),
};
const localBase = {
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
  async aiEdit() { return { ok: false, error: "gen_local" }; },
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
  /* 목록을 그리는 화면은 빈 목록을 받아 "없음" 으로 보이게 */
  async examListAll() { return { ok: true, exams: [] }; },
  async activityList() { return { ok: true, items: [], total: 0 }; },
  async assignList() { return { ok: true, mine: [], forCode: [] }; },
  async assignListMany() { return { ok: true, forCodes: {} }; },
  async noteList() { return { ok: true, notes: [], unseen: 0 }; },
  async noteSeen() { return { ok: true }; },
  async jobList() { return { ok: true, jobs: [] }; },
  async textbookGet() { return { ok: true, items: [] }; },
  async resultUpdate() { return { ok: false, error: "offline" }; },
};
/* 서버 없는(로컬) 모드: serverRemote 에만 있는 메서드를 불러도 크래시 대신 offline 오류를 돌려준다 */
const localRemote = new Proxy(localBase, { get: (t, k) => (k in t ? t[k] : async () => ({ ok: false, error: "offline" })) });
const remote = () => (syncUrl() ? serverRemote : localRemote);
const ERR = {
  network: "서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.",
  not_found: "그 코드로 등록된 시험지가 없습니다. 코드를 다시 확인해 주세요.",
  bad_key: "이 시험지를 고칠 권한이 없습니다. (다른 기기에서 만든 코드)",
  too_big: "시험지가 너무 큽니다. 문제 수를 줄여 주세요.",
  busy: "서버가 바쁩니다. 잠시 후 다시 시도해 주세요.",
  gen_empty: "만든 문제가 모두 정답 검증에서 걸러졌습니다. 범위를 더 구체적으로 적거나 참고 자료를 넣어 다시 시도해 주세요.",
  report_limit: "오늘은 문항 신고를 더 할 수 없습니다(하루 20건).",
  timeout: "서버 응답이 너무 늦습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.",
  trashed: "휴지통으로 옮겨진 시험지입니다. 출제자에게 문의하세요.",
  push_off: "서버에 알림(푸시) 설정이 아직 없습니다.",
  bad_id_chars: "아이디는 한글·영문·숫자·밑줄(_)만 쓸 수 있습니다(2~30자).",
  weak_pw: "비밀번호는 4자 이상으로 정해 주세요.",
  ip_limit: "이 기기(네트워크)에서는 오늘 더 가입할 수 없습니다. 내일 다시 시도하거나 관리자에게 문의하세요.",
  gen_user_limit: "오늘 이 계정의 AI 문제 생성 횟수를 모두 썼습니다. 내일 다시 이용해 주세요.",
  bad_origin: "허용되지 않은 주소에서 연 페이지입니다. 사이트 주소로 다시 열어 주세요.",
  length_required: "요청 형식이 올바르지 않습니다. 새로고침한 뒤 다시 시도해 주세요.",
  gen_disabled: "AI 생성 기능이 꺼져 있습니다. 관리자에게 문의하세요.",
  gen_not_configured: "서버에 AI 생성 설정(API 키·비밀번호)이 없습니다. 관리자에게 문의하세요.",
  gen_limit: "오늘 AI 생성 한도를 모두 썼습니다. 내일 다시 시도해 주세요.",
  gen_quota: "Gemini 무료 한도(분당·하루)를 넘었습니다. 잠시 뒤나 내일 다시 시도해 주세요.",
  refused: "이 범위로는 문제를 만들 수 없었습니다. 범위를 바꿔 보세요.",
  truncated: "결과가 너무 길어 잘렸습니다. 문제 수를 줄여 주세요.",
  gen_local: "서버가 연결되어 있어야 AI 생성을 쓸 수 있습니다.",
  sh_local: "서버가 연결되어 있어야 쓸 수 있는 기능입니다.",
  sh_forbidden: "오답노트 사용 권한이 없습니다. 관리자에게 문의하세요.",
  rep_forbidden: "이 계정은 아직 분석 리포트를 받을 수 없습니다. 관리자에게 문의하세요.",
  job_limit: "이미 요청한 작업이 3개 있습니다. 끝난 뒤 다시 요청해 주세요.",
  perm_share: "이 계정은 문제 공유 권한이 없습니다. 내 계정에서 관리자에게 권한을 요청하세요.",
  perm_gen: "이 계정은 문제 생성 권한이 없습니다. 내 계정에서 관리자에게 권한을 요청하세요.",
  perm_solve: "이 계정은 문제 풀기 권한이 없습니다. 내 계정에서 관리자에게 권한을 요청하세요.",
  perm_rename: "이 계정은 이름·아이디·비밀번호 변경 권한이 없습니다. 관리자에게 권한을 요청하세요.",
  perm_custom: "이 계정은 맞춤 설정 권한이 없습니다. 관리자에게 권한을 요청하세요.",
  req_limit: "오늘 보낼 수 있는 요청 수를 넘었습니다(권한 요청은 하루 한 번). 내일 다시 시도해 주세요.",
  need_setup: "아직 관리자 계정이 없습니다. 관리자가 먼저 만들어야 합니다.",
  no_admin: "알림을 받을 관리자 계정이 없습니다.",
  bad_note: "알림 제목이나 내용을 적어 주세요.",
  job_started: "이미 처리가 시작된 작업이라 취소할 수 없습니다.",
  bad_scope: "범위를 적어 주세요.",
  no_photo: "사진을 한 장 이상 골라 주세요.",
  too_many: "사진 수 한도를 넘었습니다(기본 10장, 확장 생성 권한은 30장).",
  no_detail: "문항별 기록이 없는 결과라 오답노트를 만들 수 없습니다.",
  no_wrong: "틀린 문제가 없어 오답노트를 만들 필요가 없습니다.",
  job_dup: "이 결과의 오답노트는 이미 요청했습니다. 완료되면 알림이 뜹니다.",
  sh_not_ready: "오답노트 서버가 아직 준비되지 않았습니다. 관리자에게 문의하세요.",
  bad_login: "아이디 또는 비밀번호가 맞지 않습니다.",
  locked: "로그인 실패가 많아 15분 동안 잠겼습니다. 잠시 뒤 다시 시도해 주세요.",
  bad_pw: "비밀번호는 4자 이상이어야 합니다.",
  bad_token: "로그인이 풀렸습니다. 다시 들어와 주세요.",
  forbidden: "이 계정에는 권한이 없습니다.",
  bad_id: "아이디는 한글·영문·숫자·_ . - 로 2~30자입니다.",
  dup_id: "이미 있는 아이디입니다.",
  bad_teacher: "담당 선생님 아이디가 없습니다.",
  self_delete: "자기 계정은 지울 수 없습니다(다른 관리자가 지워야 합니다).",
  self_demote: "자기 계정의 관리자 권한은 뺄 수 없습니다.",
  self_disable: "자기 계정은 정지할 수 없습니다.",
  already_setup: "이미 관리자가 있습니다. 로그인해 주세요.",
  no_report: "아직 리포트가 없습니다.",
  no_results: "응시 기록이 있어야 리포트를 만들 수 있습니다.",
  not_open: "아직 응시 시작 전입니다.",
  closed: "응시가 마감된 시험지입니다.",
  /* 서버(worker/src/index.js) 가 내는 나머지 코드 */
  corrupt: "시험지 데이터가 손상되어 열 수 없습니다.",
  bad_quiz: "시험지 형식이 올바르지 않습니다(문제·보기를 확인해 주세요).",
  bad_exam: "시험지 데이터가 비어 있습니다.",
  bad_entry: "채점 결과가 올바르지 않습니다.",
  bad_worksheet: "문제지 이름은 한글·영문·숫자·_ 로 적어 주세요.",
  has_real_users: "이미 실제 계정이 있어 초기화할 수 없습니다.",
  no_note: "아직 오답노트가 없습니다.",
  bad_action: "서버와 통신 형식이 맞지 않습니다. 새로고침해 주세요.",
  bad_json: "서버와 통신 형식이 맞지 않습니다. 새로고침해 주세요.",
  fs_bad_response: "파일 서버 응답이 올바르지 않습니다. 잠시 후 다시 시도해 주세요.",
  bad_code: "코드는 영문·숫자 5자입니다.",
  offline: "서버가 연결되어 있어야 쓸 수 있는 기능입니다.",
};
/* 오류 코드 → 문구. 같은 코드가 상황마다 다른 뜻이면(사진 too_big, 워커 bad_key) 호출처가 over 로 덮는다 */
const errMsg = (r, over) => (over && r && over[r.error]) || ERR[r && r.error] || (r && r.message ? `서버 오류: ${r.message}` : "요청에 실패했습니다. 잠시 후 다시 시도해 주세요.");

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

const fmtClock = (s) => { s = Math.max(0, Math.floor(s)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, "0")}`; };
/* datetime-local ↔ ms (기기 시간대 기준) */
const toLocalInput = (ms) => { if (!ms) return ""; const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocalInput = (s) => { if (!s) return 0; const t = new Date(s).getTime(); return Number.isFinite(t) ? t : 0; };
const splitTags = (s) => String(s || "").split(/[,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
/* 배정 상태 */
function assignStatus(a) {
  const now = Date.now();
  if (a.done) return { t: `완료 ${a.score}/${a.total}`, tone: "good", open: true };
  if (a.openAt && now < a.openAt) return { t: `${fmtDateTime(a.openAt)} 시작`, tone: "neutral", open: false };
  if (a.closeAt && now > a.closeAt) return { t: "마감", tone: "bad", open: false };
  const dl = a.dueAt || a.closeAt;   // 배정 마감이 우선, 없으면 응시 마감
  if (a.dueAt && now > a.dueAt) return { t: `기한 지남 · ${fmtDateTime(a.dueAt)}`, tone: "bad", open: true };
  if (dl && dl - now < 86400000) return { t: `곧 마감 · ${fmtDateTime(dl)}`, tone: "warn", open: true };
  if (dl) return { t: `${fmtDateTime(dl)} 마감`, tone: "accent", open: true };
  return { t: "열림", tone: "accent", open: true };
}
const assignDeadline = (a) => a.dueAt || a.closeAt || 0;
/* 기록을 과목·태그별로 집계 (quizzes: 서버가 준 code → {subject, tags:{문항id:[태그]}}) */
function aggregateResults(items, quizzes) {
  const bySub = {}, byTag = {};
  (items || []).forEach((it) => {
    const q = (quizzes || {})[it.code] || {};
    const sub = q.subject || "(과목 없음)";
    const s = (bySub[sub] = bySub[sub] || { c: 0, t: 0, n: 0 });
    s.c += it.score; s.t += it.total; s.n++;
    if (Array.isArray(it.detail) && q.tags) it.detail.forEach((d) => (q.tags[d.q] || []).forEach((tag) => { const g = (byTag[tag] = byTag[tag] || { c: 0, t: 0 }); g.t++; if (d.ok) g.c++; }));
  });
  const pct = (v) => (v.t ? Math.round((v.c / v.t) * 100) : 0);
  return {
    subs: Object.entries(bySub).map(([k, v]) => ({ k, pct: pct(v), n: v.t, runs: v.n })).sort((a, b) => a.pct - b.pct),
    tags: Object.entries(byTag).filter(([, v]) => v.t >= 2).map(([k, v]) => ({ k, pct: pct(v), n: v.t })).sort((a, b) => a.pct - b.pct),
  };
}
/* 난이도: 기초 → 기본 → 발전 → 심화. 인쇄 양식 색(초록·파랑·노랑·빨강)에 쓰인다 */
const LEVELS = ["기초", "기본", "발전", "심화"];
const QTYPES = ["mc", "short", "essay"];
/* 문항 그림: inline SVG 만 허용. 스크립트·이벤트·외부 참조를 지운다 */
const SVG_TAGS = new Set(["svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "tspan", "defs", "marker", "clippath", "lineargradient", "radialgradient", "stop", "title", "desc"]);
const SVG_ATTRS = new Set(["d", "points", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "dx", "dy", "width", "height", "viewbox", "transform", "fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline", "id", "marker-end", "marker-start", "marker-mid", "clip-path", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "preserveaspectratio", "xmlns", "refx", "refy", "markerwidth", "markerheight", "orient", "fx", "fy"]);
/* 속성값: javascript: 금지, url(...) 은 문서 안 참조(url(#id))만 허용 */
const svgValueOk = (v) => { const t = String(v).replace(/\s+/g, "").toLowerCase(); if (/javascript:|&#|<|expression\(/.test(t)) return false; if (t.includes("url(") && !/^url\(#[\w-]+\)$/.test(t)) return false; return true; };
function sanitizeSvg(v) {
  const t = String(v || "").trim().slice(0, 20000);
  if (!/^<svg[\s>]/i.test(t) || typeof DOMParser === "undefined") return "";
  let doc;
  try { doc = new DOMParser().parseFromString(t, "image/svg+xml"); } catch (e) { return ""; }
  if (!doc || doc.getElementsByTagName("parsererror").length) return "";   // 형식이 깨진 SVG 는 버린다
  const root = doc.documentElement;
  if (!root || root.localName.toLowerCase() !== "svg") return "";
  /* 요소는 허용 목록만 남기고(자식까지 통째로 제거), 속성도 허용 목록·안전한 값만 남긴다 */
  const walk = (el) => {
    [...el.childNodes].forEach((c) => {
      if (c.nodeType === 1) { if (!SVG_TAGS.has(c.localName.toLowerCase())) el.removeChild(c); else walk(c); }
      else if (c.nodeType !== 3) el.removeChild(c);   // 주석·CDATA·처리 지시문 제거
    });
    [...el.attributes].forEach((a) => {
      const nm = a.name.toLowerCase();
      if (nm.startsWith("on") || nm === "style" || nm.includes("href") || !SVG_ATTRS.has(nm) || !svgValueOk(a.value)) el.removeAttribute(a.name);
    });
  };
  walk(root);
  try { return new XMLSerializer().serializeToString(root); } catch (e) { return ""; }
}
/* ── 수식 표시: 글자 표기(x^2, √(x+1), (a+b)/(c+d), x_1, <=)를 손글씨처럼(위첨자·근호 막대·세로 분수) 바꾼 HTML.
   먼저 글자를 이스케이프해 만들므로 dangerouslySetInnerHTML 에 써도 안전하다. 수식 기호가 없으면 그대로 */
const MATH_HINT = /[√^_\/<>!=*]|sqrt\(/;
const escHtml = (v) => String(v == null ? "" : v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function mathHtml(raw) {
  const t = String(raw == null ? "" : raw);
  if (!MATH_HINT.test(t)) return escHtml(t);
  const close = (i, open, shut) => { let d = 0; for (let j = i; j < t.length; j++) { if (t[j] === open) d++; else if (t[j] === shut && --d === 0) return j; } return -1; };
  const tokenAt = (i) => { const m = /^-?[0-9A-Za-z.]+/.exec(t.slice(i)); return m ? m[0] : ""; };
  const isWord = (c) => !!c && /[0-9A-Za-z가-힣]/.test(c);
  const frac = (a, b) => `<span class="m-frac"><span>${a}</span><span>${b}</span></span>`;
  let out = "", i = 0;
  while (i < t.length) {
    const c = t[i];
    // 근호: √( … ) / sqrt( … ) / √토큰
    if (c === "√" || t.startsWith("sqrt(", i)) {
      const st = c === "√" ? i + 1 : i + 4;
      if (t[st] === "(") { const e = close(st, "(", ")"); if (e > 0) { out += `<span class="m-rt">√<span class="m-rad">${mathHtml(t.slice(st + 1, e))}</span></span>`; i = e + 1; continue; } }
      const tk = c === "√" ? /^[0-9A-Za-z.]+/.exec(t.slice(st)) : null;
      if (tk) { out += `<span class="m-rt">√<span class="m-rad">${escHtml(tk[0])}</span></span>`; i = st + tk[0].length; continue; }
      out += escHtml(c); i++; continue;
    }
    // 괄호 분수: (A)/(B)
    if (c === "(") {
      const e = close(i, "(", ")");
      if (e > 0 && t[e + 1] === "/" && t[e + 2] === "(") { const e2 = close(e + 2, "(", ")"); if (e2 > 0) { out += frac(mathHtml(t.slice(i + 1, e)), mathHtml(t.slice(e + 3, e2))); i = e2 + 1; continue; } }
      if (e > 0 && t[e + 1] === "/") { const m = /^[0-9A-Za-z]{1,4}(?![0-9A-Za-z가-힣\/])/.exec(t.slice(e + 2)); if (m) { out += frac(mathHtml(t.slice(i + 1, e)), escHtml(m[0])); i = e + 2 + m[0].length; continue; } }
    }
    // 짧은 토큰 분수: 1/2, a/b (앞뒤가 글자에 붙어 있지 않을 때, 각 4자 이하)
    if (/[0-9A-Za-z]/.test(c) && !isWord(t[i - 1]) && t[i - 1] !== "/" && t[i - 1] !== ".") {
      const m = /^([0-9A-Za-z]{1,4})\/([0-9A-Za-z]{1,4})(?![0-9A-Za-z가-힣\/])/.exec(t.slice(i));
      if (m) { out += frac(escHtml(m[1]), escHtml(m[2])); i += m[0].length; continue; }
      const m2 = /^([0-9A-Za-z]{1,4})\/\(/.exec(t.slice(i));
      if (m2) { const st = i + m2[0].length - 1, e2 = close(st, "(", ")"); if (e2 > 0) { out += frac(escHtml(m2[1]), mathHtml(t.slice(st + 1, e2))); i = e2 + 1; continue; } }
    }
    // 위첨자·아래첨자: x^2, x^(n+1), x^{2}, x_1, a_(n+1)
    if ((c === "^" || (c === "_" && /[A-Za-z)]/.test(t[i - 1] || ""))) && i > 0) {
      const tag = c === "^" ? "sup" : "sub", n1 = t[i + 1];
      if (n1 === "(" || n1 === "{") { const e = close(i + 1, n1, n1 === "(" ? ")" : "}"); if (e > 0) { out += `<${tag}>${mathHtml(t.slice(i + 2, e))}</${tag}>`; i = e + 1; continue; } }
      const tk = tokenAt(i + 1);
      if (tk) { out += `<${tag}>${escHtml(tk)}</${tag}>`; i += 1 + tk.length; continue; }
    }
    // 부등호·기호
    const two = t.slice(i, i + 2);
    if (two === "<=") { out += "≤"; i += 2; continue; }
    if (two === ">=") { out += "≥"; i += 2; continue; }
    if (two === "!=") { out += "≠"; i += 2; continue; }
    if (two === "+-") { out += "±"; i += 2; continue; }
    if (c === "*" && /[0-9A-Za-z)\s]/.test(t[i - 1] || "") && /[0-9A-Za-z(\s]/.test(t[i + 1] || "")) { out += "×"; i++; continue; }
    out += escHtml(c); i++;
  }
  return out;
}
/* 수식이 들어간 글을 손글씨처럼 보여 주는 span (부모의 pre-wrap 줄바꿈은 그대로) */
function M({ t }) {
  const html = useMemo(() => mathHtml(t), [t]);
  return <span className="m-txt" dangerouslySetInnerHTML={{ __html: html }} />;
}
/* 원본 문제 번호 알약(문제 오른쪽 위) */
function SrcPill({ src }) {
  if (!src) return null;
  return <span title="원본 문제 번호" style={{ marginLeft: "auto", flex: "0 0 auto", fontSize: 12.5, fontWeight: 700, color: C.inkMid, background: C.lineSoft, border: `1px solid ${C.line}`, borderRadius: 999, padding: "3px 10px", whiteSpace: "nowrap" }}>원본 {src}</span>;
}

function PassageBox({ text }) {
  if (!text) return null;
  return (
    <div style={{ border: `1px solid ${C.line}`, background: C.card, borderRadius: 14, padding: "12px 14px", margin: "4px 0 10px" }}>
      <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.06em", color: C.sub, marginBottom: 4 }}>지문</div>
      <div style={{ fontSize: 15, lineHeight: 1.7, whiteSpace: "pre-wrap" }}><M t={text} /></div>
    </div>
  );
}
function Figure({ svg, style }) {
  const safe = useMemo(() => sanitizeSvg(svg), [svg]);   // 어떤 경로로 들어온 SVG 든 그리기 직전에 한 번 더 정화
  if (!safe) return null;
  return <div className="em-fig" role="img" aria-label="문항 그림" style={{ margin: "6px 0 12px", maxWidth: 420, ...style }} dangerouslySetInnerHTML={{ __html: safe }} />;
}
const QTYPE_KO = { mc: "객관식", short: "주관식", essay: "서술형" };
const DEFAULT_OPTS = () => ["", "", "", "", ""];   // 새 문항의 보기는 5개
const normAns = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[.。]$/, "");
const maxMulti = (n) => Math.max(1, Math.floor(n / 2));   // 복수 정답은 보기 수의 절반까지
/* 편집 화면은 공용 보기 없이 문항마다 보기를 가진다. 옛 시험지(공용 보기 사용)는 열 때 문항별 보기로 복사한다 */
const withOwnOptions = (exam) => ({ ...exam, questions: exam.questions.map((q) => (q.options || (q.type && q.type !== "mc") ? q : { ...q, options: exam.options.some((o) => o.trim()) ? [...exam.options] : DEFAULT_OPTS() })) });
const LEVEL_COLOR = { 기초: "#15803D", 기본: "#0066CC", 발전: "#D4A017", 심화: "#C0392B" };
const LEVEL_SOFT = { 기초: "#E6F4EA", 기본: "#E8F1FB", 발전: "#FBF3D6", 심화: "#FBE9E7" };
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
    type: QTYPES.indexOf(src.type) >= 0 ? src.type : "mc",     // mc 객관식 / short 주관식 / essay 서술형
    svg: sanitizeSvg(src.svg),                                   // 그림(도형·그래프·표) inline SVG
    passage: asStr(src.passage).slice(0, 4000),                  // 세트형 지문(같은 지문을 이어지는 문항에 두면 한 번만 표시)
    answerText: asStr(src.answerText),                          // 주관식 정답(| 로 여러 개) / 서술형 모범 답안
    tags: Array.isArray(src.tags) ? src.tags.map(asStr).map((t) => t.trim()).filter(Boolean).slice(0, 8) : [],
    src: asStr(src.src).slice(0, 20),                            // 원본 문제 번호(변형 문제). 문제 글에 넣지 않고 오른쪽 위 알약으로 표시
  };
}

/* 옛 "[변형]" 시험지는 문제 글 앞에 원본 번호("08 ", "01 (2) ")가 붙어 있었다 → src 로 옮긴다 */
function legacySrc(q, title) {
  if (q.src || !/^\[변형\]/.test(title || "")) return q;
  const m = /^(\d{2,3}(?:\s*\(\d{1,2}\))?)\s+(?=\S)/.exec(q.text);
  return m ? { ...q, src: m[1].replace(/\s+/g, " "), text: q.text.slice(m[0].length) } : q;
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
    questions: questionsRaw.map((q) => legacySrc(normalizeQuestion(q, options.length), asStr(src.title))),
    shuffle: !!src.shuffle,
    subject: asStr(src.subject),
    level: LEVELS.indexOf(src.level) >= 0 ? src.level : "기본",
    timeLimit: Math.max(0, Math.min(300, Math.floor(Number(src.timeLimit) || 0))),
    openAt: Number(src.openAt) || 0,
    closeAt: Number(src.closeAt) || 0,
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
      ...(q.tags && q.tags.length ? { tags: q.tags } : {}),
      ...(q.type && q.type !== "mc" ? { type: q.type, answerText: q.answerText || "" } : {}),
      ...(q.svg ? { svg: q.svg } : {}),
      ...(q.passage ? { passage: q.passage } : {}),
      ...(q.src ? { src: q.src } : {}),
    })),
    shuffle: !!exam.shuffle,
    /* 아래는 값이 있을 때만 넣어 기존 공유본의 해시가 바뀌지 않게 한다 */
    ...(exam.subject && exam.subject.trim() ? { subject: exam.subject.trim() } : {}),
    ...(exam.timeLimit ? { timeLimit: exam.timeLimit } : {}),
    ...(exam.openAt ? { openAt: exam.openAt } : {}),
    ...(exam.closeAt ? { closeAt: exam.closeAt } : {}),
    ...(exam.level && exam.level !== "기본" ? { level: exam.level } : {}),
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
  const questions = Array.isArray(data.questions) ? data.questions.map((q) => legacySrc(normalizeQuestion(q, options.length), asStr(data.title))) : [];
  if (!questions.length) return null;
  return {
    title: asStr(data.title) || "제목 없음",
    desc: asStr(data.desc),
    options,
    questions,
    shuffle: !!data.shuffle,
    subject: asStr(data.subject),
    timeLimit: Math.max(0, Math.min(300, Math.floor(Number(data.timeLimit) || 0))),
    openAt: Number(data.openAt) || 0,
    closeAt: Number(data.closeAt) || 0,
    level: LEVELS.indexOf(data.level) >= 0 ? data.level : "기본",
  };
}

function problemsOf(draft) {
  const out = [];
  if (!draft.title.trim()) out.push("시험지 제목을 적어 주세요.");
  const usesShared = draft.questions.some((q) => (q.type || "mc") === "mc" && !q.options);
  if (usesShared && draft.options.some((o) => !o.trim())) out.push("비어 있는 보기가 있습니다.");
  const seen = new Set();
  if (usesShared) draft.options.forEach((o) => {
    const k = o.trim();
    if (k && seen.has(k)) out.push(`보기 “${k}”가 두 번 이상 있습니다.`);
    seen.add(k);
  });
  draft.questions.forEach((q, i) => {
    if (!q.text.trim()) { out.push(`${i + 1}번 문제의 내용이 비어 있습니다.`); return; }
    if (q.type === "short") { if (!(q.answerText || "").trim()) out.push(`${i + 1}번(주관식)의 정답을 적어 주세요.`); return; }
    if (q.type === "essay") return;
    if (q.options && q.options.some((o) => !o.trim())) out.push(`${i + 1}번 문제의 보기 중 비어 있는 것이 있습니다.`);
    if (q.answers.length === 0) out.push(`${i + 1}번 문제의 정답을 하나 이상 골라 주세요.`);
    else if (q.answers.length > maxMulti((q.options || draft.options).length)) out.push(`${i + 1}번 문제의 정답이 너무 많습니다(보기의 절반까지).`);
  });
  return out;
}

/* 같은 지문(세트형)으로 이어지는 문항은 한 묶음으로 섞어 지문이 흩어져 여러 번 보이지 않게 한다 */
function shuffleGroups(qs) {
  const groups = [];
  qs.forEach((q) => { const g = groups[groups.length - 1]; if (q.passage && g && g[0].passage === q.passage) g.push(q); else groups.push([q]); });
  return shuffled(groups).flat();
}
/* 응시 런타임 만들기: 문제마다 쓰는 보기를 확정하고(문제별 보기 또는 공용 보기),
   셔플이 켜져 있으면 보기·문제 순서를 섞은 뒤 정답 위치를 재계산합니다. */
const SCREENS = ["home", "list", "editor", "code", "take", "result", "study", "myresults", "students", "admin"];
const INITIAL_HASH = typeof location !== "undefined" ? location.hash : "";   // 첫 화면 효과가 주소를 #/home 으로 바꾸기 전에 기억
const RESTORE_SCREENS = ["list", "study", "myresults", "code"];   // 새로고침해도 그대로 여는 화면(따로 불러올 상태가 없는 것)
const TAKE_KEEP_MS = 24 * 3600 * 1000;
/* 이어 풀기 저장본이 같은 시험지 모양일 때만 되살린다(문항 id·보기 수) */
const takeSig = (src) => src.questions.map((q) => `${q.id}:${(Array.isArray(q.options) && q.options.length >= 2 ? q.options : src.options || []).length}`).join(",");   // 이어 풀기 저장은 하루만 유지
function buildRun(src, code, onlyIds, fixed) {
  const shared = src.options;
  /* fixed: 새로고침 뒤 이어 풀기용으로 저장해 둔 { at, sp, perm, order } — 같은 섞기·시작 시각을 되살린다 */
  const okPerm = (p, n) => Array.isArray(p) && p.length === n && range(n).every((i) => p.includes(i));
  const sharedPerm = fixed && okPerm(fixed.sp, shared.length) ? fixed.sp : src.shuffle ? shuffled(range(shared.length)) : range(shared.length);
  let qs = src.questions.map((q) => {
    const own = Array.isArray(q.options) && q.options.length >= 2 ? q.options : null;
    const base = own || shared;
    const saved = fixed && fixed.perm ? fixed.perm[q.id] : null;
    const perm = own ? (okPerm(saved, base.length) ? saved : src.shuffle ? shuffled(range(base.length)) : range(base.length)) : sharedPerm;
    const pos = {};
    perm.forEach((orig, disp) => (pos[orig] = disp));
    return {
      ...q,
      options: perm.map((i) => base[i]),
      answers: q.answers.map((a) => pos[a]).filter((x) => x != null).sort((x, y) => x - y),
      perm,   // perm[표시 위치] = 원본 위치. 제출 때 고른 보기를 원본 번호로 되돌린다(결과 v:2)
    };
  });
  if (onlyIds) qs = qs.filter((q) => onlyIds.has(q.id));
  if (fixed && Array.isArray(fixed.order)) {
    const at = {}; fixed.order.forEach((id, i) => (at[id] = i));
    qs = [...qs].sort((a, b) => (at[a.id] ?? 1e9) - (at[b.id] ?? 1e9));
  } else if (src.shuffle) qs = shuffleGroups(qs);
  return {
    code,
    src,
    title: src.title,
    desc: src.desc,
    options: sharedPerm.map((i) => shared[i]),
    questions: qs,
    partial: !!onlyIds,
    sharedPerm,
    startedAt: fixed && fixed.at > 0 ? fixed.at : Date.now(),
    subject: src.subject || "",
    timeLimit: src.timeLimit || 0,
    openAt: src.openAt || 0,
    closeAt: src.closeAt || 0,
    level: src.level || "기본",
  };
}

/* ── 공용 UI ─────────────────────────────────── */
function Btn({ children, onClick, kind = "primary", disabled, style, ariaLabel }) {
  const base = {
    fontFamily: FONT,
    fontSize: 16,
    fontWeight: 600,
    borderRadius: 999,
    padding: "13px 20px",
    cursor: disabled ? "default" : "pointer",
    border: "1px solid transparent",
    transition: "background .15s, border-color .15s",
    opacity: disabled ? 0.45 : 1,
    width: "100%",
  };
  const kinds = {
    primary: { background: C.accent, color: C.onAccent },
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
        padding: "5px 8px",
        minHeight: 44, margin: "-6px 0",   // 터치 타깃 44px(휴대폰 오터치 방지). 음수 여백으로 보이는 간격은 그대로
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
    background: C.field,
    border: `1px solid ${C.line}`,
    borderRadius: 12,
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
        background: on ? C.accent : C.field,
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
        background: on ? C.accentSoft : C.field,
        borderRadius: 12,
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Card({ children, style, className }) {
  return (
    <div className={"em-card" + (className ? " " + className : "")} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 18, padding: 18, boxShadow: C.shadow, ...style }}>
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

function Modal({ title, children, onClose, wide, closeOnBackdrop = true }) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const boxRef = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;   // 닫힐 때 원래 자리로 포커스 복귀
    const focusables = () => (boxRef.current ? [...boxRef.current.querySelectorAll('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')] : []);
    const inBox = () => !!(boxRef.current && boxRef.current.contains(document.activeElement));
    if (!inBox()) { const f = focusables()[0]; if (f) f.focus(); }   // autoFocus 입력칸이 없으면 첫 요소로
    const onKey = (e) => {
      if (e.key === "Escape") return closeRef.current();
      if (e.key !== "Tab") return;   // Tab 은 모달 안에서만 돈다
      const f = focusables(); if (!f.length) return;
      const a = document.activeElement;
      if (e.shiftKey && (a === f[0] || !inBox())) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (a === f[f.length - 1] || !inBox())) { e.preventDefault(); f[0].focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); try { prev && prev.focus && prev.focus(); } catch (e) {} };
  }, []);
  return (
    <div
      className="em-modal"
      onClick={closeOnBackdrop ? onClose : undefined}
      style={{
        position: "fixed",
        inset: 0,
        background: C.dim,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 60,
      }}
    >
      <div ref={boxRef} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: wide ? 520 : 400 }}>
        <Card style={{ maxHeight: "var(--em-modal-max, 86vh)", overflowY: "auto" }}>
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
function Shell({ children, back, backTo, toast, wide }) {
  return (
    <div className="em-root" style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.ink }}>
      <div className={"em-page" + (wide ? "" : " em-narrow")} style={{ maxWidth: wide ? 1040 : 560, margin: "0 auto", padding: "22px 18px 60px" }}>
        {back && (
          <button
            className={"em-btn" + (back === "홈으로" ? " em-back-home" : "")}
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
          className="em-toast"
          style={{
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            background: C.ink,
            color: C.bg,
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

/* ── 이미지 자산 (인라인 SVG, 외부 파일 없음) ────────
   과목 썸네일·아바타·AI 마스코트·QR 아이콘·히어로 배너. 그라데이션은 이미지 안에서만 쓴다. */
const SUBJ_ICON = {
  math: <><path d="M20 75 55 25v50Z" fill="none" stroke="#fff" strokeWidth="7" strokeLinejoin="round" /><path d="M66 40h18M66 56h14M66 72h18" stroke="#fff" strokeWidth="7" strokeLinecap="round" /></>,
  eng: <><path d="M50 30c-8-6-19-8-29-6v46c10-2 21 0 29 6 8-6 19-8 29-6V24c-10-2-21 0-29 6Z" fill="none" stroke="#fff" strokeWidth="7" strokeLinejoin="round" /><path d="M50 30v46" stroke="#fff" strokeWidth="7" /></>,
  sci: <><path d="M40 20h20M45 20v22L29 71a8 8 0 0 0 7 12h28a8 8 0 0 0 7-12L55 42V20" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" /><circle cx="45" cy="66" r="4" fill="#fff" /><circle cx="58" cy="73" r="3" fill="#fff" /></>,
  book: <><rect x="25" y="18" width="50" height="64" rx="6" fill="none" stroke="#fff" strokeWidth="7" /><path d="M39 18v64M50 38h14M50 52h14" stroke="#fff" strokeWidth="7" strokeLinecap="round" /></>,
  ai: <><rect x="20" y="28" width="60" height="46" rx="12" fill="none" stroke="#fff" strokeWidth="7" /><circle cx="38" cy="50" r="5" fill="#fff" /><circle cx="62" cy="50" r="5" fill="#fff" /><path d="M40 62c6 5 14 5 20 0" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" /><path d="M50 28V12M30 32 20 20M70 32l10-12" stroke="#fff" strokeWidth="6" strokeLinecap="round" /></>,
};
const SUBJ_GRAD = {
  math: "linear-gradient(120deg,#4D9FFF,#0066CC)", eng: "linear-gradient(120deg,#34C759,#15803D)",
  sci: "linear-gradient(120deg,#F5A623,#E67E22)", book: "linear-gradient(120deg,#9A9AA0,#5C5C60)", ai: "linear-gradient(120deg,#4D9FFF,#0066CC)",
};
const SUBJ_LABEL = { math: "수학", eng: "영어", sci: "과학", book: "시험지", ai: "AI" };
function subjKind(subject) {
  const t = String(subject || "");
  if (/수학|math/i.test(t)) return "math";
  if (/영어|english|eng/i.test(t)) return "eng";
  if (/과학|화학|물리|생명|지구|sci/i.test(t)) return "sci";
  return "book";
}
function SubjThumb({ subject, kind, size = 48 }) {
  const k = kind || subjKind(subject);
  return (
    <span role="img" aria-label={subject || SUBJ_LABEL[k]} style={{ width: size, height: size, flex: `0 0 ${size}px`, borderRadius: Math.round(size * 0.27), background: SUBJ_GRAD[k], display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg viewBox="0 0 100 100" aria-hidden="true" style={{ width: size * 0.66, height: size * 0.66, display: "block" }}>{SUBJ_ICON[k]}</svg>
    </span>
  );
}
function Avatar({ size = 40 }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size, flex: `0 0 ${size}px`, borderRadius: 999, overflow: "hidden", display: "block" }}>
      <svg viewBox="0 0 100 100" style={{ width: "100%", height: "100%", display: "block" }}>
        <defs><linearGradient id="emAvG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4D9FFF" /><stop offset="1" stopColor="#0066CC" /></linearGradient></defs>
        <circle cx="50" cy="50" r="50" fill="url(#emAvG)" />
        <circle cx="50" cy="38" r="16" fill="#fff" opacity=".92" />
        <path d="M20 84c5-17 16-25 30-25s25 8 30 25" fill="#fff" opacity=".92" />
      </svg>
    </span>
  );
}
function QrIcon({ size = 26, color }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" style={{ width: size, height: size, display: "block", color: color || C.ink }}>
      <g fill="currentColor"><rect x="5" y="5" width="26" height="26" rx="4" /><rect x="69" y="5" width="26" height="26" rx="4" /><rect x="5" y="69" width="26" height="26" rx="4" /><rect x="40" y="40" width="10" height="10" /><rect x="58" y="58" width="10" height="10" /><rect x="76" y="76" width="10" height="10" /><rect x="58" y="76" width="10" height="10" /><rect x="76" y="58" width="10" height="10" /><rect x="40" y="58" width="10" height="10" /></g>
      <g fill="currentColor" opacity=".35"><rect x="40" y="76" width="10" height="10" /><rect x="58" y="40" width="10" height="10" /><rect x="76" y="40" width="10" height="10" /></g>
    </svg>
  );
}
/* 앱 아이콘(겹친 시험지 + 체크). bare 면 파란 바탕 없이 그림만(파란 배너 위) */
function AppMark({ size = 28, bare }) {
  return (
    <svg viewBox={bare ? "120 100 272 320" : "0 0 512 512"} aria-hidden="true" style={{ width: size, height: size, display: "block", flex: `0 0 ${size}px` }}>
      {!bare && <rect width="512" height="512" rx="112" fill="#267DD4" />}
      <rect x="196" y="118" width="176" height="236" rx="26" fill="#fff" opacity=".75" />
      <rect x="140" y="154" width="196" height="248" rx="26" fill="#fff" />
      <path d="M172 206h128M172 238h112M172 270h78" stroke="#5C9DE0" strokeWidth="14" strokeLinecap="round" />
      <path d="M176 342l30 30 56-62" fill="none" stroke="#2FA866" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
/* 사진 고르기: 브라우저 기본 파일 버튼(영어) 대신 한국어 버튼 + 고른 장수 */
function FilePick({ onFiles, count, inputRef, label = "사진 고르기" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <label className="em-filepick">
        <input ref={inputRef} type="file" accept="image/*" multiple onChange={(e) => { onFiles(Array.from(e.target.files || [])); e.target.value = ""; }} aria-label={label} />
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
        {label}
      </label>
      <span style={{ fontSize: 13.5, color: C.sub }}>{count ? `${count}장 골랐어요` : "아직 고른 사진이 없어요"}</span>
    </div>
  );
}
/* 홈 히어로: 가장 가까운 마감 → 남은 배정 → 확인 질문 → 인사, 순서로 실제 데이터를 보여 준다 */
function HomeHero({ d, user, onOpen, onAssign, onStudy, onCode }) {
  const now = Date.now();
  const todo = ((d && d.assigns) || []).filter((a) => !a.done && (!a.openAt || now >= a.openAt) && !(a.closeAt && now > a.closeAt));
  const next = todo.filter(assignDeadline).sort((a, b) => assignDeadline(a) - assignDeadline(b))[0];
  let title, sub, go;
  if (d === null) { title = `안녕하세요, ${user.name} 👋`; sub = "오늘 할 일을 불러오는 중…"; go = null; }
  else if (next) { const dl = assignDeadline(next); const days = Math.ceil((dl - now) / 86400000); title = days < 0 ? `${next.title} 기한 지남` : `${next.title} D-${Math.max(0, days)}`; sub = `${fmtDateTime(dl)} 마감 · 눌러서 바로 풀기`; go = () => onOpen(next.code); }
  else if (todo.length) { title = `풀어야 할 시험 ${todo.length}개`; sub = "마감은 없지만 미리 끝내 두면 마음이 편해요."; go = onAssign; }
  else if (d.pending) { title = `확인 질문 ${d.pending}개가 기다려요`; sub = "오답노트에서 답해 주면 다음 처리 때 반영됩니다."; go = onStudy; }
  else { title = `안녕하세요, ${user.name} 👋`; sub = "오늘도 화이팅! 코드를 넣거나 새 시험지를 만들어 보세요."; go = onCode; }
  return (
    <button className="em-btn em-hero" onClick={go || undefined} disabled={!go} aria-label={`${title}. ${sub}`}
      style={{ position: "relative", overflow: "hidden", width: "100%", textAlign: "left", border: "none", borderRadius: 20, padding: "18px 22px", margin: "0 0 18px", color: "#fff", background: "linear-gradient(120deg,#0066CC,#4D9FFF)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, cursor: go ? "pointer" : "default", fontFamily: FONT, boxShadow: "0 8px 24px rgba(0,102,204,.18)" }}>
      <span aria-hidden="true" style={{ position: "absolute", width: 180, height: 180, borderRadius: 999, background: "rgba(255,255,255,.12)", right: -40, top: -70 }} />
      <span aria-hidden="true" style={{ position: "absolute", width: 90, height: 90, borderRadius: 999, background: "rgba(255,255,255,.10)", left: "38%", bottom: -50 }} />
      <span style={{ position: "relative", minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 19, fontWeight: 800, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        <span style={{ display: "block", fontSize: 13.5, opacity: .9, marginTop: 5, fontWeight: 500, lineHeight: 1.4 }}>{sub}</span>
      </span>
      <span style={{ position: "relative" }}><AppMark size={72} bare /></span>
    </button>
  );
}

/* ── 홈 요약 카드 ─────────────────────────────── */
function StatCard({ label, value, sub, pct, tone = "accent", onClick }) {
  const col = { accent: C.accent, good: C.good, warn: C.warn, bad: C.bad }[tone] || C.accent;
  return (
    <button className="em-btn em-row em-stat" onClick={onClick} aria-label={`${label} ${value}${sub ? ", " + sub : ""}`}
      style={{ display: "block", width: "100%", textAlign: "left", background: C.card, border: `1px solid ${C.line}`, borderRadius: 18, padding: "14px 16px", cursor: "pointer", fontFamily: FONT, boxShadow: C.shadow }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", color: C.sub }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: tone === "warn" ? C.warn : C.ink, margin: "4px 0 2px", letterSpacing: "-0.02em", lineHeight: 1.15 }}>{value}</div>
      <div style={{ fontSize: 12.5, color: C.sub, minHeight: 18, lineHeight: 1.4 }}>{sub || ""}</div>
      <div aria-hidden="true" style={{ height: 5, background: C.lineSoft, borderRadius: 999, overflow: "hidden", marginTop: 8 }}>
        <div style={{ width: `${pct == null ? 0 : pct}%`, height: "100%", background: col, transition: "width .6s ease" }} />
      </div>
    </button>
  );
}

let homeCache = null;   // 홈에 다시 올 때 깜빡임 없이 이전 값을 먼저 보여 준다
function useHomeData(user, mode) {
  const [d, setD] = useState(homeCache && user && homeCache.uid === user.id ? homeCache : null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (mode !== "server" || !user) return;
    let alive = true;
    (async () => {
      const shOn = user.role === "admin" || !!user.shOn;
      const [res, sh, asg] = await Promise.all([remote().studentResults(user.id), shOn ? remote().shList() : Promise.resolve(null), remote().assignList()]);
      if (!alive) return;
      const items = res.ok ? res.items : [];
      const avg = items.length ? Math.round((items.reduce((s, r) => s + (r.total ? r.score / r.total : 0), 0) / items.length) * 100) : null;
      const ws = sh && sh.ok ? sh.worksheets : null;
      const mine = asg && asg.ok ? asg.mine : [];
      homeCache = {
        uid: user.id, err: !res.ok, latest: items[0] || null, avg, count: items.length,
        shOn, repOn: user.role === "admin" || !!user.repOn, pending: ws ? ws.reduce((s, w) => s + (w.pending || 0), 0) : 0, shErr: sh && !sh.ok ? sh.error : null,
        processing: ws ? ws.filter((w) => w.status !== "done" && w.status !== "needs_confirm").length : 0,
        rep: res.ok ? res.report : null,
        assigns: mine, asgTotal: mine.length, asgDone: mine.filter((a) => a.done).length,
      };
      setD(homeCache);
    })();
    return () => { alive = false; };
  }, [user && user.id, mode, tick]);
  return [d, () => setTick((t) => t + 1)];
}
function HomeStats({ d, onMyResults, onStudy, onAssign, onRefresh }) {
  const L = d === null;
  const latest = d && d.latest;
  const pctOf = (r) => (r && r.total ? Math.round((r.score / r.total) * 100) : 0);
  const repNew = d && d.rep && Date.now() - d.rep.updatedAt < 7 * 86400000;
  const asgPct = d && d.asgTotal ? Math.round((d.asgDone / d.asgTotal) * 100) : 0;
  return (
    <div className="em-stats" aria-busy={L}>
      <StatCard label="최근 점수" value={L ? "…" : latest ? `${latest.score}/${latest.total}` : "—"} sub={L ? "불러오는 중" : latest ? latest.title || latest.code : "아직 응시 기록이 없음"} pct={latest ? pctOf(latest) : null} tone={latest && pctOf(latest) < 60 ? "bad" : "accent"} onClick={onMyResults} />
      <StatCard label="평균 정답률" value={L ? "…" : d.avg == null ? "—" : `${d.avg}%`} sub={L ? "" : `${d.count}회 응시`} pct={d && d.avg} tone="good" onClick={onMyResults} />
      <StatCard label="완료율" value={L ? "…" : d.asgTotal ? `${asgPct}%` : "—"} sub={L ? "" : d.asgTotal ? `배정 ${d.asgTotal}개 중 ${d.asgDone}개 완료` : "배정된 시험 없음"} pct={asgPct} tone="accent" onClick={onAssign} />
      {/* 네 번째 칸: 오답노트를 쓰면 확인 질문(답할 게 있을 때만 경고색), 아니면 분석 리포트 */}
      {L || d.shOn
        ? <StatCard label="확인 질문" value={L ? "…" : `${d.pending || 0}개`} sub={L ? "" : d.shErr ? "목록을 불러오지 못함" : d.processing ? `처리 중 ${d.processing}개` : d.pending ? "답을 기다리는 질문" : "기다리는 질문 없음"} pct={d && d.pending ? 100 : 0} tone={d && d.pending ? "warn" : "accent"} onClick={onStudy} />
        : <StatCard label="분석 리포트" value={!d.repOn ? "—" : d.rep ? (repNew ? "새 리포트" : fmtDate(d.rep.updatedAt)) : "없음"} sub={!d.repOn ? "리포트 권한 없음" : d.rep ? `기록 ${d.rep.basis}회 기준` : "분석 리포트에서 요청"} pct={d.rep ? 100 : 0} tone="accent" onClick={onMyResults} />}
      {d && d.err && <p style={{ gridColumn: "1 / -1", fontSize: 13.5, color: C.bad, margin: 0, display: "flex", alignItems: "center", gap: 4 }}>기록을 불러오지 못했습니다. {onRefresh && <TextBtn onClick={onRefresh} style={{ fontSize: 13.5 }}>다시 시도</TextBtn>}</p>}
    </div>
  );
}

/* ── 하단 탭(휴대폰) / 왼쪽 사이드바(PC) ─────────── */
const NAV_ICON = {
  home: <path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  play: <><circle cx="12" cy="12" r="9" /><path d="M10 8l6 4-6 4z" /></>,
  chart: <path d="M4 20h16M7 16v-5M12 16V6M17 16v-8" />,
  note: <path d="M6 3h9l4 4v14H6zM15 3v4h4M9 13h6M9 17h6" />,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3 19a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 19a6 6 0 0 0-5-5.9" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  doc: <path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
};
function NavIcon({ name }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{NAV_ICON[name]}</svg>;
}
function NavBar({ screen, role, go, onAccount, user, badge }) {
  const items = [
    { k: "home", t: "홈", i: "home" },
    { k: "list", t: "시험지", i: "doc" },
    { k: "myresults", t: "분석 리포트", i: "chart" },
    ...(user && remote().kind === "server" && !can(user, "solve") ? [] : [{ k: "code", t: "풀기", i: "play" }]),
    { k: "study", t: "오답노트", i: "note", more: true },   // 휴대폰 하단바: 홈·시험지·분석 리포트·풀기·계정(나머지는 홈 메뉴·PC 옆 메뉴)
  ];
  if (role !== "student") items.push({ k: "students", t: "내 학생", i: "people", more: true });
  if (role === "admin" || (user && isLite(user))) items.push({ k: "admin", t: "관리자", i: "gear", more: true });
  items.push({ k: "account", t: "계정", i: "user", acct: true });
  return (
    <nav className="em-nav" aria-label="주요 메뉴">
      <div className="em-nav-logo"><span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}><AppMark size={30} />시험지</span></div>
      {items.map((it) => (
        <button key={it.k} className={"em-nav-item" + (it.more ? " em-nav-more" : "") + (it.acct ? " em-nav-acct" : "")} aria-current={screen === it.k ? "page" : undefined}
          onClick={() => (it.k === "account" ? onAccount() : go(it.k))}>
          <span style={{ position: "relative", display: "inline-flex" }}>
            <NavIcon name={it.i} />
            {it.k === "home" && badge > 0 && <span className="em-nav-dot" aria-label={`새 알림 ${badge}개`}>{badge > 9 ? "9+" : badge}</span>}
          </span>
          <span>{it.t}</span>
        </button>
      ))}
      {user && (
        <button className="em-btn em-nav-profile" onClick={onAccount} aria-label="내 계정">
          <Avatar size={38} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.name}</span>
            <span style={{ display: "block", fontSize: 12.5, color: C.sub }}>{ROLE_KO[user.role] || user.role}</span>
          </span>
        </button>
      )}
    </nav>
  );
}

/* ── 주간 정답률 차트 (인라인 SVG, 최근 8주) ─────── */
function TrendChart({ items }) {
  const monday = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  const weeks = [];
  const start = monday(new Date());
  for (let i = 7; i >= 0; i--) { const s = new Date(start); s.setDate(s.getDate() - i * 7); weeks.push({ s: s.getTime(), e: s.getTime() + 7 * 86400000, c: 0, t: 0, n: 0 }); }
  (items || []).forEach((it) => { const w = weeks.find((x) => it.at >= x.s && it.at < x.e); if (w && it.total) { w.c += it.score; w.t += it.total; w.n++; } });
  if (!weeks.some((w) => w.n)) return null;
  const W = 320, H = 120, bw = W / 8, gap = 14;
  const desc = weeks.filter((w) => w.n).map((w) => `${new Date(w.s).getMonth() + 1}/${new Date(w.s).getDate()}주 ${Math.round((w.c / w.t) * 100)}%`).join(", ");
  return (
    <Card style={{ padding: "14px 16px 6px", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "2px 10px", marginBottom: 2 }}>
        <span style={{ fontSize: 14.5, fontWeight: 700 }}>주간 정답률</span><span style={{ fontSize: 12.5, color: C.sub }}>최근 8주 · 진한 막대가 이번 주 · 빈 칸은 기록 없음</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`주간 정답률: ${desc}`} style={{ display: "block", maxWidth: 480, margin: "0 auto" }}>
        {weeks.map((w, i) => {
          const pct = w.t ? Math.round((w.c / w.t) * 100) : null;
          const h = pct == null ? 0 : Math.max(2, (pct / 100) * (H - 44));
          const x = i * bw + gap / 2, bwid = bw - gap;
          return (
            <g key={i}>
              {pct == null && <rect x={x} y={H - 25} width={bwid} height={3} rx={1.5} fill={C.line} />}
              {pct != null && <rect x={x} y={H - 22 - h} width={bwid} height={h} rx={4} fill={C.accent} opacity={i === 7 ? 1 : 0.55} style={{ transition: "height .6s ease" }} />}
              {pct != null && <text x={x + bwid / 2} y={H - 26 - h} textAnchor="middle" fontSize="10" fontWeight="700" fill={C.ink}>{pct}</text>}
              <text x={x + bwid / 2} y={H - 7} textAnchor="middle" fontSize="9" fill={C.sub}>{`${new Date(w.s).getMonth() + 1}/${new Date(w.s).getDate()}`}</text>
            </g>
          );
        })}
      </svg>
    </Card>
  );
}

/* ── 과목별 정답률 · 취약 태그 ─────────────────── */
function BreakdownChart({ items, quizzes }) {
  const agg = aggregateResults(items, quizzes);
  if (!agg.subs.length) return null;
  const Bar = ({ label, pct, n }) => (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, gap: 8 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ fontWeight: 700, color: pct < 60 ? C.bad : C.ink, flex: "0 0 auto" }}>{pct}% <span style={{ color: C.sub, fontWeight: 400, fontSize: 12 }}>· {n}문항</span></span>
      </div>
      <div aria-hidden="true" style={{ height: 6, background: C.lineSoft, borderRadius: 999, overflow: "hidden", marginTop: 4 }}><div style={{ width: `${pct}%`, height: "100%", background: pct < 60 ? C.bad : C.accent, transition: "width .6s ease" }} /></div>
    </div>
  );
  const onlyNone = agg.subs.length === 1 && agg.subs[0].k === "(과목 없음)";
  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 8 }}>과목별 정답률</div>
      {agg.subs.map((s) => <Bar key={s.k} label={s.k} pct={s.pct} n={s.n} />)}
      {agg.tags.length > 0 && (
        <>
          <div style={{ fontSize: 14.5, fontWeight: 700, margin: "14px 0 8px" }}>취약 태그 <span style={{ fontSize: 12.5, color: C.sub, fontWeight: 400 }}>정답률 낮은 순</span></div>
          {agg.tags.slice(0, 6).map((s) => <Bar key={s.k} label={s.k} pct={s.pct} n={s.n} />)}
        </>
      )}
      {(onlyNone || !agg.tags.length) && <p style={{ fontSize: 12.5, color: C.sub, margin: "6px 0 0", lineHeight: 1.5 }}>시험지에 과목과 문항 태그를 적어 두면 과목·태그별로 나눠 보여 줍니다.</p>}
    </Card>
  );
}

/* ── 배정 창: 공유 코드를 학생에게 배정 + 마감·안내문·진행 현황·미완료 독촉 ─────────── */
function AssignModal({ exam, onClose, flash }) {
  const [students, setStudents] = useState(null);
  const [cur, setCur] = useState(null);
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(false);
  const [dueAt, setDueAt] = useState(0);
  const [memo, setMemo] = useState("");
  const [remindAt, setRemindAt] = useState(0);
  const [purgeDays, setPurgeDays] = useState(30);   // 마감 뒤 이 날짜가 지나면 시험지를 휴지통으로(기본 30일)
  const load = async () => {
    const [u, a] = await Promise.all([remote().userList(), remote().assignList(exam.code)]);
    if (u.ok) setStudents(u.users.filter((x) => x.role === "student" && x.active !== false)); else { setStudents([]); flash(errMsg(u)); }
    const rows = a.ok ? a.forCode || [] : [];
    setCur(rows);
    if (rows.length) { setDueAt(rows[0].dueAt || 0); setMemo(rows[0].memo || ""); setPurgeDays(rows[0].purgeDays != null ? rows[0].purgeDays : 30); setRemindAt(Math.max(0, ...rows.map((x) => x.remindAt || 0))); }
  };
  useEffect(() => { load(); }, []);
  const assigned = new Set((cur || []).map((x) => x.studentId));
  const meUser = (authGet() || {}).user || null;   // 본인이 만든 시험지는 본인에게도 배정할 수 있다(코드를 만들 때 자동 배정되지만 해제했다면 다시)
  const rest = [...(meUser && !assigned.has(meUser.id) ? [{ id: meUser.id, name: `${meUser.name} (나)`, me: true }] : []), ...(students || []).filter((s) => !assigned.has(s.id) && !(meUser && s.id === meUser.id))];
  const add = async () => {
    const ids = rest.filter((s) => sel[s.id]).map((s) => s.id);
    if (!ids.length) return flash("배정할 학생을 고르세요.");
    if (dueAt && dueAt < Date.now()) return flash("마감이 이미 지난 시각입니다. 마감을 고치거나 비워 주세요.");
    setBusy(true);
    const r = await remote().assignSet(exam.code, ids, dueAt, memo.trim(), purgeDays);
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    flash(`${r.added}명에게 배정하고 알림을 보냈습니다.`); setSel({}); load();
  };
  const saveCond = async () => {
    setBusy(true);
    const r = await remote().assignUpdate(exam.code, dueAt, memo.trim(), purgeDays);
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    flash(r.notified ? `조건을 저장하고 아직 안 푼 ${r.notified}명에게 알렸습니다.` : "배정 조건을 저장했습니다."); load();
  };
  const remind = async () => {
    setBusy(true);
    const r = await remote().assignRemind(exam.code);
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    flash(r.sent ? `${r.sent}명에게 알림을 보냈습니다.${r.skipped ? ` (${r.skipped}명은 6시간 안에 이미 보냄)` : ""}` : r.skipped ? "6시간 안에 이미 알림을 보낸 학생뿐입니다." : "아직 안 푼 학생이 없습니다."); load();
  };
  const removeOne = async (sid) => { const r = await remote().assignRemove(exam.code, sid); if (!r.ok) return flash(errMsg(r)); load(); };
  const doneN = (cur || []).filter((x) => x.done).length, todoN = (cur || []).length - doneN;
  const now = Date.now(), late = dueAt && now > dueAt;
  const condChanged = cur && cur.length > 0 && ((cur[0].dueAt || 0) !== dueAt || (cur[0].memo || "") !== memo.trim() || (cur[0].purgeDays != null ? cur[0].purgeDays : 30) !== purgeDays);
  const labStyle = { display: "block", fontSize: 13, color: C.sub, marginBottom: 4 };
  return (
    <Modal title={`배정 · ${exam.title || "제목 없음"}`} onClose={onClose}>
      <p style={{ fontSize: 13.5, color: C.sub, margin: "0 0 12px", lineHeight: 1.5 }}>코드 <b>{exam.code}</b>. 배정한 학생에게 알림이 가고, 홈 "풀어야 할 시험"에 마감·안내문과 함께 나타나며 완료율에 들어갑니다.</p>
      <div style={{ background: C.field, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 14px", marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>배정 조건 <span style={{ color: C.sub, fontWeight: 400, fontSize: 13 }}>(선택 · 배정된 학생 모두에게 같이 적용)</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
          <label style={labStyle}>마감<input type="datetime-local" className="em-in" style={{ width: "100%", boxSizing: "border-box", marginTop: 4 }} value={toLocalInput(dueAt)} onChange={(e) => setDueAt(fromLocalInput(e.target.value))} /></label>
          <label style={labStyle}>안내문<input className="em-in" style={{ width: "100%", boxSizing: "border-box", marginTop: 4 }} maxLength={200} placeholder="예: 2단원 복습, 금요일까지" value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
          <label style={labStyle}>마감 뒤 자동 정리(일)<input type="number" min="0" max="365" className="em-in" style={{ width: "100%", boxSizing: "border-box", marginTop: 4 }} value={purgeDays} onChange={(e) => setPurgeDays(Math.max(0, Math.min(365, parseInt(e.target.value, 10) || 0)))} aria-describedby="purge-help" /></label>
        </div>
        <div id="purge-help" style={{ fontSize: 12.5, color: C.sub, marginTop: 6, lineHeight: 1.45 }}>마감이 지나면 학생과 선생님께 알림이 가고, 마감 {purgeDays}일 뒤 시험지가 휴지통으로 옮겨집니다(휴지통에서 30일 안에 되살릴 수 있음, 응시 기록은 남음).</div>
        <div style={{ fontSize: 12.5, color: late ? C.bad : C.sub, marginTop: 6, lineHeight: 1.45 }}>{dueAt ? `${fmtDateTime(dueAt)} 마감${late ? " · 이미 지난 시각입니다" : ""}. 지나도 풀 수는 있고 "기한 지남"으로 표시됩니다.` : "마감을 비우면 기한 없이 배정됩니다."}{exam.closeAt ? ` 응시 마감(${fmtDateTime(exam.closeAt)})이 지나면 열 수 없습니다.` : ""}</div>
        {condChanged && <div style={{ marginTop: 8 }}><Btn kind="ghost" onClick={saveCond} disabled={busy}>배정된 {cur.length}명에게 조건 저장</Btn></div>}
      </div>
      {cur && cur.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>배정됨 {cur.length}명 <span style={{ color: C.sub, fontWeight: 400, fontSize: 13 }}>· 완료 {doneN}명 · 미완료 {todoN}명</span></span>
            <span style={{ flex: 1 }} />
            {todoN > 0 && <TextBtn onClick={remind} disabled={busy} style={{ fontSize: 13 }}>미완료 {todoN}명에게 알림</TextBtn>}
          </div>
          {remindAt > 0 && <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 6 }}>마지막 알림 {fmtDateTime(remindAt)}</div>}
          {cur.map((x) => (
            <div key={x.studentId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: `1px solid ${C.line}`, fontSize: 14 }}>
              <span style={{ flex: 1, minWidth: 0 }}>{x.name} <span style={{ color: C.sub, fontSize: 12.5 }}>{x.studentId}</span>{x.done && x.doneAt && <span style={{ display: "block", color: C.sub, fontSize: 12 }}>{fmtDateTime(x.doneAt)} 제출{x.dueAt && x.doneAt > x.dueAt ? " · 늦음" : ""}</span>}</span>
              <Badge tone={x.done ? "good" : x.dueAt && now > x.dueAt ? "bad" : "neutral"}>{x.done ? `완료 ${x.score}/${x.total}` : x.dueAt && now > x.dueAt ? "기한 지남" : "아직"}</Badge>
              <TextBtn tone="sub" onClick={() => removeOne(x.studentId)} style={{ fontSize: 13 }}>해제</TextBtn>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>학생 고르기</span>
        {rest.length > 1 && <TextBtn onClick={() => setSel(Object.fromEntries(rest.map((s) => [s.id, true])))} style={{ fontSize: 13 }}>모두 선택</TextBtn>}
      </div>
      {students === null && <p style={{ color: C.sub, fontSize: 14 }}>불러오는 중…</p>}
      {students && rest.length === 0 && <p style={{ color: C.sub, fontSize: 14 }}>{students.length ? "모든 학생에게 배정했습니다." : "더 배정할 사람이 없습니다. 담당 학생이 등록되면 여기에 나타납니다."}</p>}
      <div style={{ display: "grid", gap: 6, maxHeight: "34vh", overflowY: "auto" }}>
        {rest.map((s) => (
          <CheckRow key={s.id} on={!!sel[s.id]} onToggle={() => setSel({ ...sel, [s.id]: !sel[s.id] })} padding="9px 11px">
            <Check on={!!sel[s.id]} size={20} /><span style={{ fontSize: 14.5 }}>{s.name}</span><span style={{ color: C.sub, fontSize: 12.5 }}>{s.id}</span>
          </CheckRow>
        ))}
      </div>
      {rest.length > 0 && <div style={{ marginTop: 12 }}><Btn onClick={add} disabled={busy}>선택한 학생에게 배정</Btn></div>}
    </Modal>
  );
}

/* ── 홈: 알림(워커가 끝낸 일) ───────────────────── */
const NOTE_ICON = { gen: "ai", note: "book", report: "book", perm: "book", admin: "book", assign: "book" };
function NoteList({ notes, onOpen, onSeenAll }) {
  const [showAll, setShowAll] = useState(false);
  const unseen = notes.filter((n) => !n.seen);
  const rows = showAll ? notes.slice(0, 10) : unseen;
  if (!rows.length && !notes.length) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: C.inkMid }}>알림{unseen.length ? ` ${unseen.length}` : ""}</h3>
        <div style={{ display: "flex", gap: 2 }}>
          {unseen.length > 0 && <TextBtn tone="sub" onClick={onSeenAll} style={{ fontSize: 13 }}>모두 읽음</TextBtn>}
          {notes.length > unseen.length && <TextBtn tone="sub" onClick={() => setShowAll((v) => !v)} style={{ fontSize: 13 }}>{showAll ? "새 알림만" : "지난 알림"}</TextBtn>}
        </div>
      </div>
      {rows.length === 0 && <p style={{ color: C.sub, fontSize: 14, margin: 0 }}>새 알림이 없습니다.</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((n) => (
          <button key={n.id} className="em-btn em-row" onClick={() => onOpen(n)}
            style={{ display: "flex", alignItems: "center", gap: 12, textAlign: "left", background: n.seen ? C.card : C.accentSoft, border: `1px solid ${n.seen ? C.line : C.accent}`, borderRadius: 14, padding: "11px 14px", cursor: "pointer", fontFamily: FONT }}>
            <SubjThumb kind={NOTE_ICON[n.kind] || "book"} size={40} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 15, fontWeight: 700, color: C.ink }}>{n.title}</span>
              <span style={{ display: "block", fontSize: 13, color: C.sub, marginTop: 2, lineHeight: 1.45 }}>{n.body} <span style={{ opacity: .8 }}>· {fmtDateTime(n.at)}</span></span>
            </span>
            {!n.seen && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: C.accent, flex: "0 0 8px" }} />}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── 홈: 풀어야 할 시험(배정) ─────────────────── */
function AssignList({ d, onOpen }) {
  const [showDone, setShowDone] = useState(false);
  const all = (d && d.assigns) || [];
  const todo = all.filter((a) => !a.done), done = all.filter((a) => a.done);
  const rows = showDone ? all : todo;
  return (
    <div className="em-assign" style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: C.inkMid }}>풀어야 할 시험</h3>
        {done.length > 0 && <TextBtn tone="sub" onClick={() => setShowDone((v) => !v)} style={{ fontSize: 13 }}>{showDone ? "완료한 것 숨기기" : `완료 ${done.length}개 보기`}</TextBtn>}
      </div>
      {d === null && <p style={{ color: C.sub, fontSize: 14, margin: 0 }}>불러오는 중…</p>}
      {d && rows.length === 0 && <p style={{ color: C.sub, fontSize: 14, margin: 0, lineHeight: 1.5 }}>{all.length ? "배정된 시험을 모두 풀었습니다." : "배정된 시험이 없습니다. 선생님이 배정하면 여기에 나타납니다."}</p>}
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((a) => {
          const st = assignStatus(a);
          return (
            <button key={a.id} className="em-btn em-row" onClick={() => st.open && !a.done ? onOpen(a.code) : a.done ? onOpen(a.code) : null} disabled={!st.open && !a.done}
              style={{ textAlign: "left", background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 14px", cursor: st.open || a.done ? "pointer" : "default", fontFamily: FONT, boxShadow: C.shadow, opacity: st.open || a.done ? 1 : 0.7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <SubjThumb subject={a.subject} size={46} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15.5, fontWeight: 700, color: C.ink }}>{a.title || a.code}</div>
                  <div style={{ marginTop: 4 }}><Badge tone={st.tone}>{st.t}</Badge></div>
                  <div style={{ fontSize: 13, color: C.sub, marginTop: 3 }}>
                    {a.owner ? `${a.owner} 출제 · ` : ""}{a.subject ? `${a.subject} · ` : ""}문제 {a.questions || 0}개{a.timeLimit ? ` · ${a.timeLimit}분` : ""} · 코드 {a.code}
                  </div>
                  {a.memo && <div style={{ fontSize: 13, color: C.inkMid, marginTop: 4, lineHeight: 1.45 }}>안내: {a.memo}</div>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── 화면: 홈 ────────────────────────────────── */
function HomeScreen({ exams, recent, onNew, onList, onCode, onStudy, onOpenRecent, onSettings, mode, toast, user, onAdmin, onStudents, onMyResults, onAccount, notes, onOpenNote, onSeenAll }) {
  const role = (user && user.role) || "admin";
  const [d, refreshHome] = useHomeData(user, mode);
  const items = [];
  const server = mode === "server" && !!user;
  const allow = (k) => !server || can(user, k);
  /* 메뉴(하단 탭·옆 메뉴)에 이미 있는 화면은 다시 보여 주지 않는다: 새 시험지는 항상, 오답노트·내 학생·관리자는 휴대폰(하단 탭에 없음)에서만 */
  const hasNav = !!user;   // 로그인하면 메뉴가 보인다(App 의 navOn)
  if (allow("gen")) items.push({ t: "새 시험지 만들기", d: "AI로 문제를 만들거나 직접 입력합니다.", go: onNew, wide: true });
  if (!hasNav) {
    items.push({ t: "시험지", d: exams.length ? `저장된 시험지 ${exams.length}개` : "아직 저장된 시험지가 없습니다.", go: onList });
    items.push({ t: "풀기", d: "받은 코드로 문제 풀기", go: onCode });
    items.push({ t: "분석 리포트", d: "내 점수·기록 보기", go: onMyResults });
  }
  items.push({ t: "오답노트", d: "사진으로 정답·해설 받기", go: onStudy, mOnly: hasNav });
  if (role !== "student") items.push({ t: "내 학생", d: "결과·리포트 보기", go: onStudents, mOnly: hasNav });
  if (role === "admin" || (server && isLite(user))) items.push({ t: "관리자", d: role === "admin" ? "계정·기록·알림" : "계정·기록 열람", go: onAdmin, mOnly: hasNav });
  const scrollAssign = () => { const el = [...document.querySelectorAll(".em-assign")].find((x) => x.offsetParent !== null); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const assignEl = server ? <AssignList d={d} onOpen={onOpenRecent} /> : null;
  const recentEl = recent.length > 0 ? (
    <>
      <h3 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px", color: C.inkMid }}>최근 푼 시험지</h3>
      <Card style={{ padding: 6, marginBottom: 22 }}>
        {recent.map((r) => (
          <button key={r.code} className="em-btn" onClick={() => onOpenRecent(r.code)}
            style={{ display: "flex", width: "100%", alignItems: "center", gap: 12, textAlign: "left", background: "none", border: "none", borderRadius: 10, padding: "10px 12px", cursor: "pointer", fontFamily: FONT }}>
            <SubjThumb subject={r.subject} size={34} />
            <span style={{ fontWeight: 800, letterSpacing: "0.08em", color: C.accent, fontSize: 14, flex: "0 0 auto" }}>{r.code}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}{r.owner ? <span style={{ color: C.sub, fontSize: 12.5 }}> · {r.owner}</span> : null}</span>
            <span style={{ fontSize: 13.5, color: C.sub, flex: "0 0 auto" }}>{r.score}/{r.total}</span>
          </button>
        ))}
      </Card>
    </>
  ) : null;
  return (
    <Shell toast={toast} wide>
      <div className="em-home">
        <div className="em-home-main">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "16px 0 10px" }}>
            <h1 style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.02em", margin: 0 }}>시험지</h1>
            {user && (
              <div className="em-only-m">   {/* PC 는 옆 메뉴 아래에 같은 계정 버튼이 있다 */}
                <button className="em-btn" onClick={onAccount} aria-label="내 계정" style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", padding: 4, cursor: "pointer", fontFamily: FONT, color: C.accent, fontSize: 14.5, fontWeight: 600 }}>
                  <span>{user.name} · {ROLE_KO[user.role] || user.role}</span><Avatar size={34} />
                </button>
              </div>
            )}
          </div>
          <p style={{ fontSize: 16.5, lineHeight: 1.6, color: C.sub, margin: "0 0 6px" }}>문제를 만들어 코드로 나누고, 푼 사람은 바로 채점 결과를 봅니다.</p>
          <div style={{ height: 1, background: C.line, margin: "22px 0 20px" }} />
          {server && <HomeHero d={d} user={user} onOpen={onOpenRecent} onAssign={scrollAssign} onStudy={onStudy} onCode={onCode} />}
          {server && <NoteList notes={notes || []} onOpen={onOpenNote} onSeenAll={onSeenAll} />}
          {server && <HomeStats d={d} onMyResults={onMyResults} onStudy={onStudy} onAssign={scrollAssign} onRefresh={refreshHome} />}
          {server && <div className="em-only-m">{assignEl}</div>}
          <div className="em-quick">
            {items.map((it) => (
              <button key={it.t} className={"em-btn em-row" + (it.wide ? " em-quick-wide" : "") + (it.mOnly ? " em-only-m" : "")} onClick={it.go}
                style={{ textAlign: "left", background: it.wide ? C.accentSoft : C.card, border: `1px solid ${it.wide ? C.accent : C.line}`, borderRadius: 16, padding: "14px 16px", cursor: "pointer", fontFamily: FONT, boxShadow: C.shadow }}>
                <div style={{ fontSize: 16.5, fontWeight: 700, color: it.wide ? C.accent : C.ink, marginBottom: 3 }}>{it.wide ? "+ " : ""}{it.t}</div>
                <div style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.45 }}>{it.d}</div>
              </button>
            ))}
          </div>
          {recentEl && <div className="em-only-m" style={{ marginTop: 28 }}>{recentEl}</div>}
          <p style={{ fontSize: 12.5, color: C.sub, textAlign: "center", marginTop: 34, lineHeight: 1.6 }}>
            <a href="help.html" target="_blank" rel="noopener" style={{ color: C.sub }}>사용 설명서</a>
          </p>
        </div>
        {(server || recentEl) && (
          <aside className="em-home-side em-only-d" style={{ paddingTop: 24 }}>
            {assignEl}
            {recentEl}
          </aside>
        )}
      </div>
    </Shell>
  );
}

/* ── 화면: 내 시험지 목록 ────────────────────── */
/* 휴지통: 1달 동안 쓰지 않았거나 배정 마감 뒤 정리 기한이 지난 시험지. 30일 안에 되살릴 수 있다 */
function TrashModal({ onClose, onRestored, flash }) {
  const [items, setItems] = useState(null);
  const load = async () => { const r = await remote().examTrashList(); if (!r.ok) { flash(errMsg(r)); setItems([]); return; } setItems(r.items || []); };
  useEffect(() => { load(); }, []);
  const restore = async (it) => { const r = await remote().examRestore(it.id); if (!r.ok) return flash(errMsg(r)); flash(`"${it.title || "제목 없음"}"을(를) 되살렸습니다.`); load(); onRestored && onRestored(); };
  return (
    <Modal title="휴지통" onClose={onClose}>
      <p style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.55, margin: "0 0 12px" }}>한 달 동안 쓰지 않았거나 배정 마감 뒤 정리 기한이 지난 시험지가 여기로 옵니다. 30일이 지나면 완전히 지워지고(응시 기록은 남음), 그 전에는 되살릴 수 있습니다. 휴지통에 있는 동안에는 공유 코드로 풀 수 없습니다.</p>
      {items === null && <p style={{ color: C.sub }}>불러오는 중…</p>}
      {items && items.length === 0 && <p style={{ color: C.sub, fontSize: 14.5 }}>휴지통이 비어 있습니다.</p>}
      <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
        {(items || []).map((it) => (
          <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: C.lineSoft, borderRadius: 12 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title || "제목 없음"}</span>
              <span style={{ display: "block", fontSize: 12.5, color: C.sub }}>{it.code ? `코드 ${it.code} · ` : ""}{it.purgeAt ? `${fmtDate(it.purgeAt)} 완전 삭제` : ""}</span>
            </span>
            <Btn kind="soft" onClick={() => restore(it)} style={{ width: "auto", padding: "8px 14px", fontSize: 14 }}>되살리기</Btn>
          </div>
        ))}
      </div>
      <Btn kind="ghost" onClick={onClose}>닫기</Btn>
    </Modal>
  );
}
function ListScreen({ exams, onOpen, onNew, onDelete, onDuplicate, onImport, onExportAll, onBack, toast, user, flash, onReload }) {
  const [confirmId, setConfirmId] = useState(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [assign, setAssign] = useState(null);
  const canAssign = remote().kind === "server" && user && user.role !== "student";
  const staleMap = useMemo(() => Object.fromEntries(exams.map((e) => [e.id, !!(e.code && e.sharedHash !== hashOf(e))])), [exams]);   // 매 렌더마다 시험지 수만큼 직렬화하지 않게
  return (
    <Shell back="홈으로" backTo={onBack} toast={toast}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 25, fontWeight: 800, margin: 0 }}>시험지</h2>
        <div style={{ display: "flex", gap: 2 }}>
          <TextBtn onClick={onImport}>가져오기</TextBtn>
          {exams.length > 0 && <TextBtn onClick={onExportAll}>내보내기</TextBtn>}
          {remote().kind === "server" && user && <TextBtn tone="sub" onClick={() => setTrashOpen(true)}>휴지통</TextBtn>}
        </div>
      </div>
      {trashOpen && <TrashModal onClose={() => setTrashOpen(false)} onRestored={onReload} flash={flash} />}
      <div style={{ marginBottom: 16 }}><Btn onClick={onNew}>새 시험지 만들기</Btn></div>
      {exams.length === 0 ? (
        <Card>
          <p style={{ margin: 0, color: C.sub, fontSize: 15.5, lineHeight: 1.6 }}>
            아직 만든 시험지가 없습니다. 위의 버튼으로 새로 하나 만들거나, 내보낸 파일을 가져오세요.
          </p>
        </Card>
      ) : (
        <div className="em-exam-list">
          {exams.map((e) => {
            const stale = staleMap[e.id];
            const confirming = confirmId === e.id;
            return (
              <div key={e.id} className="em-exam-item">
                <button className="em-btn em-exam-main" onClick={() => onOpen(e.id)} style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", fontFamily: FONT, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                    <SubjThumb subject={e.subject} size={40} />
                    <div style={{ minWidth: 0 }}>
                      <div className="em-exam-title" style={{ fontSize: 17, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.title || "제목 없음"}</div>
                      <div className="em-exam-meta" style={{ fontSize: 13, color: C.sub, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 3 }}>
                        <span>{e.subject ? `${e.subject} · ` : ""}문제 {e.questions.length}개 · {fmtDate(e.updatedAt)} 수정{e.level && e.level !== "기본" ? ` · ${e.level}` : ""}</span>
                        {e.code && <Badge tone={stale ? "warn" : "good"}>{stale ? `코드 ${e.code} · 다시 공유 필요` : `코드 ${e.code}`}</Badge>}
                      </div>
                    </div>
                  </div>
                </button>
                <div className="em-exam-act" style={{ display: "flex", gap: 2, alignItems: "center", flexWrap: "wrap" }}>
                  {confirming ? (
                    <>
                      <span style={{ fontSize: 13.5, color: C.bad, marginRight: 4 }}>정말 삭제할까요?{e.code ? " 공유 코드도 사라집니다." : ""}</span>
                      <TextBtn tone="bad" onClick={() => { setConfirmId(null); onDelete(e.id); }}>삭제</TextBtn>
                      <TextBtn tone="sub" onClick={() => setConfirmId(null)}>취소</TextBtn>
                    </>
                  ) : (
                    <>
                      <TextBtn onClick={() => onOpen(e.id)}>편집</TextBtn>
                      <TextBtn onClick={() => onDuplicate(e.id)}>복제</TextBtn>
                      {canAssign && e.code && <TextBtn onClick={() => setAssign(e)}>배정</TextBtn>}
                      <TextBtn tone="sub" onClick={() => setConfirmId(e.id)}>삭제</TextBtn>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {assign && <AssignModal exam={assign} onClose={() => setAssign(null)} flash={flash} />}
    </Shell>
  );
}

/* ── 응시 기록 모달 (출제자용) ───────────────── */
/* 결과 한 건의 detail 을 문항 id → 기록 Map 으로(문항 × 응시자마다 find 하지 않게) */
const detailMap = (r) => new Map((Array.isArray(r.detail) ? r.detail : []).map((d) => [String(d.q), d]));
/* 문항 분석: 문항별 정답률, 가장 많이 고른 오답, 변별도(점수 상위 27% 정답률 − 하위 27% 정답률) */
function itemStats(exam, items) {
  const qs = (exam && exam.questions) || [];
  const scored = items.filter((r) => Array.isArray(r.detail)).map((r) => ({ ...r, dm: detailMap(r) }));
  const ratio = (r) => (r.total ? r.score / r.total : 0);
  const sorted = [...scored].sort((a, b) => ratio(b) - ratio(a));
  const k = Math.max(1, Math.round(sorted.length * 0.27));
  const hi = new Set(sorted.slice(0, k).map((r) => r.id));
  const lo = new Set(sorted.slice(-k).map((r) => r.id));
  return qs.map((q, qi) => {
    let n = 0, ok = 0, hiN = 0, hiOk = 0, loN = 0, loOk = 0;
    const pick = {};
    scored.forEach((r) => {
      const d = r.dm.get(String(q.id));
      if (!d || d.p) return;   // 안 푼 문항·채점 대기(서술형)는 뺀다
      n++; if (d.ok) ok++;
      if (hi.has(r.id)) { hiN++; if (d.ok) hiOk++; }
      if (lo.has(r.id)) { loN++; if (d.ok) loOk++; }
      /* v:2 기록은 원본 보기 번호, 옛 기록은 섞기가 꺼진 시험지일 때만 믿을 수 있다 */
      if ((r.v === 2 || !exam.shuffle) && Array.isArray(d.m)) d.m.forEach((i) => (pick[i] = (pick[i] || 0) + 1));
    });
    const wrong = Object.keys(pick).map(Number).filter((i) => !(q.answers || []).includes(i)).sort((a, b) => pick[b] - pick[a])[0];
    return { qi, q, n, rate: n ? ok / n : null, disc: scored.length >= 6 && hiN && loN ? hiOk / hiN - loOk / loN : null, wrong: wrong != null ? { i: wrong, c: pick[wrong] } : null };
  });
}
function ItemAnalysis({ exam, items, reports }) {
  const rows = useMemo(() => itemStats(exam, items), [exam, items]);
  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 800, margin: "4px 0 4px" }}>문항 분석</div>
      <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.55, margin: "0 0 8px" }}>정답률이 낮은 문항은 다시 설명하거나 문항을 고쳐 보세요. 변별도는 점수 상위 27%와 하위 27%의 정답률 차이입니다(0.3 이상 좋음, 6명 이상일 때 표시).</p>
      <div style={{ display: "grid", gap: 4 }}>
        {rows.map((r) => {
          const pct = r.rate == null ? null : Math.round(r.rate * 100);
          const low = pct != null && pct < 40;
          const rep = (reports || {})[String(r.q.id)];
          /* 정답 오류 의심: 정답률이 매우 낮은데 상위권이 하위권보다 더 틀리거나(변별도 음수), 많이 고른 오답이 정답 수보다 많음 */
          const suspect = pct != null && r.n >= 4 && pct < 25 && ((r.disc != null && r.disc < 0) || (r.wrong && r.wrong.c > Math.round(r.rate * r.n)));
          return (
            <div key={r.q.id} style={{ display: "grid", gridTemplateColumns: "44px 1fr auto", gap: 10, alignItems: "center", padding: "8px 12px", background: C.lineSoft, borderRadius: 10, fontSize: 14 }}>
              <span style={{ fontWeight: 800 }}>{r.qi + 1}번</span>
              <div style={{ minWidth: 0 }}>
                <div role="img" aria-label={pct == null ? "응답 없음" : `정답률 ${pct}%`} style={{ height: 8, borderRadius: 4, background: C.line, overflow: "hidden" }}>
                  <div style={{ width: `${pct || 0}%`, height: "100%", background: low ? C.bad : C.accent }} />
                </div>
                <div style={{ fontSize: 13, color: C.sub, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.wrong ? `많이 고른 오답 ${CIRCLED[r.wrong.i] || r.wrong.i + 1} (${r.wrong.c}명)` : `${r.n}명 응답`}
                  {r.disc != null && ` · 변별도 ${r.disc.toFixed(2)}${r.disc < 0.1 ? " (낮음)" : ""}`}
                </div>
                {(suspect || rep) && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                    {suspect && <Badge tone="bad">정답 오류 의심 — 정답 확인</Badge>}
                    {rep && <Badge tone="warn">{`신고 ${rep.n}건${rep.reasons && rep.reasons.answer ? ` (정답 ${rep.reasons.answer})` : ""}`}</Badge>}
                  </div>
                )}
              </div>
              <span style={{ fontWeight: 800, color: low ? C.bad : C.inkMid }}>{pct == null ? "–" : `${pct}%`}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
/* 응시 기록을 CSV(엑셀)로 내려받기: 이름·점수·시간·제출 시각 + 문항별 O/X */
function resultsCsv(exam, items) {
  const qs = (exam && exam.questions) || [];
  const cell = (v) => { const t = String(v == null ? "" : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ["이름", "점수", "만점", "걸린 시간(초)", "제출 시각", ...qs.map((_, i) => `${i + 1}번`)];
  const lines = items.map((r) => {
    const dm = detailMap(r);
    return [r.name || "", r.score, r.total, r.sec || "", fmtDateTime(r.at), ...qs.map((q) => { const x = dm.get(String(q.id)); return !x ? "" : x.p ? "대기" : x.ok ? "O" : "X"; })];
  });
  return "\uFEFF" + [head, ...lines].map((row) => row.map(cell).join(",")).join("\r\n");
}
function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ResultsModal({ code, ownerKey, onClose, flash, exam }) {
  const [items, setItems] = useState(null);
  const [reports, setReports] = useState({});
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    const r = await remote().results(code, ownerKey);
    if (!r.ok) flash(errMsg(r));
    setItems(r.ok && Array.isArray(r.items) ? r.items : []);
    setReports(r.ok && r.reports ? r.reports : {});
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
          {exam && <ItemAnalysis exam={exam} items={items} reports={reports} />}
          <div style={{ fontSize: 15, fontWeight: 800, margin: "4px 0 6px" }}>응시자</div>
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
        {items && items.length > 0 && <Btn kind="soft" onClick={() => downloadFile(`응시기록_${code}.csv`, resultsCsv(exam, items), "text/csv;charset=utf-8")}>CSV로 내려받기(엑셀)</Btn>}
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
      const r = await fetch(u, { method: "POST", body: JSON.stringify({ action: "ping" }) }).then((x) => x.json()).catch(() => null);   // apiPost 와 같은 방식(워커는 GET 거절)
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
        {SYNC_URL ? "기본 서버가 이미 설정되어 있습니다. 다른 서버를 쓰려면 주소를 넣으세요." : "서버(Worker) 주소를 넣으면 코드 공유가 켜집니다."}
      </p>
      <Field value={url} onChange={setUrl} placeholder="https://exam-api.….workers.dev" style={{ fontSize: 13 }} />
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <Btn onClick={save} disabled={busy}>{busy ? "확인 중…" : "저장"}</Btn>
        <Btn kind="ghost" onClick={onClose}>닫기</Btn>
      </div>
    </Modal>
  );
}


/* ── 인쇄·PDF: A4 한 장에 3~4문항, 마지막에 해설지. 브라우저 인쇄 창에서 "PDF로 저장" ── */
function printableItems(src) {
  const shared = src.options || [];
  const strip = (t) => String(t || "").replace(/\s*[\(（]\s*정답\s*\d+\s*개\s*[\)）]\s*$/, "");   // 본문 끝의 "(정답 N개)"는 지우고 양식이 한 번만 붙인다
  return (src.questions || []).map((q, i, arr) => ({ no: i + 1, type: q.type || "mc", answerText: q.answerText || "", svg: sanitizeSvg(q.svg), passage: q.passage && (i === 0 || (arr[i - 1].passage || "") !== q.passage) ? q.passage : "", text: strip(q.text), options: (q.type && q.type !== "mc") ? [] : (Array.isArray(q.options) && q.options.length >= 2 ? q.options : shared), answers: q.answers || [], explain: q.explain || "", src: q.src || "" }));
}
function quizKindLabel(items) {
  const mc = items.filter((q) => q.type === "mc");
  const kinds = [];
  if (mc.length && mc.every((q) => q.options.length === 2 && /^(참|거짓|O|X|맞다|틀리다)$/i.test(String(q.options[0]).trim()))) kinds.push("참·거짓");
  else if (mc.length) kinds.push(mc.some((q) => q.answers.length > 1) ? "객관식 · 복수 정답" : "객관식");
  if (items.some((q) => q.type === "short")) kinds.push("주관식");
  if (items.some((q) => q.type === "essay")) kinds.push("서술형");
  return kinds.join(" · ") || "객관식";
}
/* 인쇄 양식: 헤더 띠(과목·난이도 태그, 제목, 문제 유형) → 이름 칸 → 개념 상자(안내문) → 2단 문항을 왼쪽 단부터 세로로 채움(1 4 / 2 5 / 3), 한 장에 들어가는 만큼 → 마지막에 정답표 + 해설(해설도 장을 나눔).
   페이지 나눔은 새 창에서 글꼴이 로드된 뒤 실제 높이를 재서 한다. 색은 난이도(기초 초록·기본 파랑·발전 노랑·심화 빨강). */
function buildPrintHtml(src, opts) {
  opts = opts || {};
  const noKey = !!opts.noKey;   // 학생 인쇄: 정답표·해설 별지 없이 문제지만
  const esc = (v) => String(v || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const items = printableItems(src);
  const level = LEVELS.indexOf(src.level) >= 0 ? src.level : "기본";
  const ac = LEVEL_COLOR[level], acSoft = LEVEL_SOFT[level];
  const title = src.title || "시험지", subject = src.subject || "", desc = src.desc || "", code = src.code || "";
  const head = `<header class="hd"><div class="tag"><span class="tag1">${esc(subject || "시험지")}</span><span class="tag2">${level}</span></div><div class="ttl">${esc(title)}</div><div class="logo">${quizKindLabel(items)}</div></header>`;
  let first = "";
  if (opts.nameLine) first += `<div class="name">이름 <span class="blank"></span> 날짜 <span class="blank"></span> 점수 <span class="blank sm"></span> / ${items.length}</div>`;
  if (desc) first += `<div class="sec">안내 · 개념 정리</div><div class="box"><div class="boxh">읽고 시작하기</div><p>${esc(desc)}</p></div>`;
  first += `<div class="pill">확인 문제</div>`;
  const optHtml = (o) => `<div class="opts ${o.every((x) => String(x).length <= 14) ? "two" : "one"}">${o.map((x, i) => `<div class="o"><span class="m">${mark(i)}</span><span>${mathHtml(x)}</span></div>`).join("")}</div>`;
  const bodyHtml = (q) => q.type === "short" ? `<div class="short">답: <span class="line"></span></div>` : q.type === "essay" ? `<div class="essay"><i></i><i></i><i></i><i></i><i></i></div>` : optHtml(q.options) + `<div class="space"></div>`;
  const qHtml = (q) => `<div class="q">${q.passage ? `<div class="pas">${mathHtml(q.passage)}</div>` : ""}<div class="qh"><span class="qn">Q${q.no}.</span><span class="qt">${mathHtml(q.text)}${q.type === "short" ? ` <span class="sub">(주관식)</span>` : q.type === "essay" ? ` <span class="sub">(서술형)</span>` : q.answers.length > 1 ? ` <span class="sub">(정답 ${q.answers.length}개)</span>` : ""}</span>${q.src ? `<span class="srcp">원본 ${esc(q.src)}</span>` : ""}</div>${q.svg ? `<div class="fig">${q.svg}</div>` : ""}${bodyHtml(q)}</div>`;
  let tbl = "";
  for (let i = 0; i < items.length; i += 10) {
    const ch = items.slice(i, i + 10);
    tbl += `<table class="anst"><tr>${ch.map((q) => `<th>${q.no}</th>`).join("")}</tr><tr>${ch.map((q) => `<td>${q.type === "short" ? "주" : q.type === "essay" ? "서" : q.answers.map(mark).join("")}</td>`).join("")}</tr></table>`;
  }
  const keyFirst = noKey ? "" : `<div class="pill">정답 및 해설</div><div class="tbls">${tbl}</div>`;
  const ansOf = (q) => q.type === "short" ? esc(String(q.answerText || "").split("|").join(" / ")) : q.type === "essay" ? "모범 답안" : q.answers.map(mark).join("");
  // 객관식: 배지·정답·해설을 한 줄에. 주관식·서술형: 정답(모범 답안)은 첫 줄, 해설은 줄을 바꿔 아래에
  const kxHtml = noKey ? "" : items.filter((q) => q.explain || q.type !== "mc").map((q) => q.type === "mc"
    ? `<div class="kx"><span class="badge">Q${q.no}</span><span class="av">${ansOf(q)}</span><span class="ex">${esc(q.explain)}</span></div>`
    : `<div class="kx kx-txt"><div class="kh"><span class="badge">Q${q.no}</span><span class="av">${ansOf(q)}</span></div>${q.type === "essay" && q.answerText ? `<div class="ex">${esc(q.answerText)}</div>` : ""}${q.explain ? `<div class="ex"><span class="exl">해설</span>${esc(q.explain)}</div>` : ""}</div>`).join("");
  const css = `
@page{size:A4;margin:0}
:root{--ac:${ac};--acSoft:${acSoft};--ink:#1D1D1F;--sub:#6E6E73;--line:#D5D5DA}
html,body{margin:0;background:#fff;color:var(--ink);font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:11pt;line-height:1.55}
.page{position:relative;width:210mm;height:297mm;box-sizing:border-box;padding:12mm 13mm 16mm;page-break-after:always;break-after:page;overflow:hidden}
.page:last-child{page-break-after:auto;break-after:auto}
.hd{display:grid;grid-template-columns:auto 1fr auto;align-items:center;border:2px solid var(--ac);border-radius:14px;padding:5mm 6mm;margin:0 0 6mm}
.tag{display:flex;flex-direction:column;gap:1mm;font-size:8.5pt;font-weight:800} .tag1{background:var(--acSoft);color:var(--ac);border-radius:6px;padding:1mm 3mm} .tag2{background:var(--ac);color:#fff;border-radius:6px;padding:1mm 3mm}
.ttl{text-align:center;font-size:15pt;font-weight:800;letter-spacing:-.01em} .logo{font-size:9pt;font-weight:800;color:var(--ac);border:1.5px solid var(--ac);border-radius:999px;padding:1mm 3mm;white-space:nowrap}
.name{font-size:10.5pt;margin:0 0 5mm} .blank{display:inline-block;width:32mm;height:1.1em;border-bottom:1px solid var(--ink);margin:0 4mm 0 2mm;vertical-align:-0.25em} .blank.sm{width:14mm}
.sec{display:inline-block;background:var(--ac);color:#fff;font-weight:800;font-size:10.5pt;border-radius:999px 999px 999px 0;padding:1.5mm 6mm;margin:0 0 2mm}
.box{border:1.5px solid var(--ac);border-radius:0 10px 10px 10px;padding:3mm 5mm;margin:0 0 5mm;font-size:10pt} .boxh{font-weight:800;border-left:3px solid var(--ac);padding-left:2mm;margin-bottom:1.5mm} .box p{margin:0;white-space:pre-wrap}
.pill{display:inline-block;border:1.5px solid var(--ac);color:var(--ac);font-weight:800;font-size:10.5pt;border-radius:999px;padding:1.2mm 6mm;margin:0 0 4mm}
.cols{display:flex;gap:7mm;align-items:flex-start} .col{flex:1 1 0;min-width:0}
.q{border-top:1px dashed var(--line);padding-top:3mm;margin-top:4mm} .col .q:first-child{border-top:none;padding-top:0;margin-top:0}
.qh{display:flex;gap:2.5mm;margin:0 0 2.5mm;align-items:flex-start} .srcp{margin-left:auto;flex:0 0 auto;font-size:8.5pt;font-weight:700;color:var(--sub);border:0.3mm solid var(--line);border-radius:99px;padding:0.4mm 2.4mm;white-space:nowrap}
.m-rt{white-space:nowrap} .m-rad{border-top:0.3mm solid currentColor;padding:0 0.4mm} .m-frac{display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;font-size:.88em;line-height:1.1;margin:0 0.5mm} .m-frac>span:first-child{border-bottom:0.3mm solid currentColor;padding:0 0.8mm} sup,sub{font-size:.72em;line-height:0} .qn{font-weight:800;font-size:12pt;white-space:nowrap} .qt{font-weight:700;white-space:pre-wrap} .sub{color:var(--sub);font-weight:400;font-size:9.5pt}
.opts{display:grid;gap:1.2mm 4mm;margin:0 0 3mm 1mm} .opts.two{grid-template-columns:1fr 1fr} .opts.one{grid-template-columns:1fr} .o{display:flex;gap:1.5mm} .m{color:var(--ac);font-weight:700}
.space{height:14mm}
.pas{border:1px solid var(--line);border-radius:6px;padding:2.5mm 3mm;margin:0 0 3mm;font-size:10pt;line-height:1.5;white-space:pre-wrap;background:#FAFAFA}
.fig{margin:1mm 0 3mm} .fig svg{max-width:100%;max-height:60mm;height:auto;display:block}
.short{margin:2mm 0 4mm 1mm;font-size:10.5pt} .short .line{display:inline-block;width:70mm;border-bottom:1px solid var(--ink);vertical-align:-1mm}
.essay{margin:2mm 0 4mm;border:1px solid var(--line);border-radius:6px;padding:2mm 3mm} .essay i{display:block;height:7mm;border-bottom:1px dashed var(--line)} .essay i:last-child{border-bottom:none}
.badge{flex:0 0 auto;background:var(--ac);color:#fff;font-size:8pt;font-weight:800;border-radius:999px;padding:.6mm 2.5mm;margin-top:.6mm} .av{font-weight:800;flex:0 0 auto} .ex{white-space:pre-wrap;color:#3A3A3C}
.tbls{margin:0 0 4mm} .anst{border-collapse:collapse;margin:0 0 3mm;font-size:10.5pt} .anst th,.anst td{border:1px solid var(--line);padding:1.2mm 2.6mm;text-align:center;min-width:6mm} .anst th{background:#F5F5F7}
.kx{display:flex;gap:2mm;align-items:flex-start;margin:0 0 2.5mm;font-size:10pt}
.kx-txt{flex-direction:column;gap:1mm} .kx-txt .kh{display:flex;gap:2mm;align-items:center} .kx-txt .ex{padding-left:1mm} .exl{display:inline-block;color:var(--sub);font-size:8.5pt;font-weight:800;margin-right:1.5mm}
.ft{position:absolute;left:13mm;right:13mm;bottom:8mm;display:flex;justify-content:space-between;font-size:8.5pt;color:var(--sub);border-top:1px solid var(--line);padding-top:2mm} .mono{font-family:ui-monospace,Consolas,monospace;letter-spacing:.06em}
@media screen{body{background:#EEE;padding:14mm 0 10mm} .page{background:#fff;margin:0 auto 10mm;box-shadow:0 2px 12px rgba(0,0,0,.12)} .bar{position:fixed;top:0;left:0;right:0;background:#1D1D1F;color:#fff;font-size:13px;padding:8px 14px;text-align:center;z-index:9} .bar button{margin-left:10px;font:inherit;padding:4px 12px;border-radius:999px;border:none;background:${ac};color:#fff;cursor:pointer}}
@media print{.bar{display:none}}`;
  const script = `
function paginate(){
  var hd=document.getElementById('hd').innerHTML, first=document.getElementById('first').innerHTML, keyFirst=document.getElementById('keyfirst').innerHTML, code=${JSON.stringify(code)}, noKey=${noKey ? "true" : "false"};
  var pagesEl=document.getElementById('pages');
  function newPage(n, cls, top){ var s=document.createElement('section'); s.className='page'+(cls?' '+cls:''); s.innerHTML=hd+(n===1?top:'')+'<div class="cols"><div class="col"></div><div class="col"></div></div><footer class="ft"><span class="mono">'+code+'</span><span class="pn"></span></footer>'; pagesEl.appendChild(s); return s; }
  function fits(p){ return p.scrollHeight<=p.clientHeight+1; }
  /* 왼쪽 단부터 세로로 채우고, 안 들어가면 오른쪽 단, 그것도 차면 새 장 */
  function fill(pool, cls, top){
    var n=0, page=null, col=0;
    while(pool.length){
      if(!page){ page=newPage(++n, cls, top); col=0; }
      var cols=page.querySelectorAll('.col'); var it=pool.shift(); cols[col].appendChild(it);
      if(fits(page)) continue;
      cols[col].removeChild(it); pool.unshift(it);
      if(cols[col].children.length===0){ cols[col].appendChild(pool.shift()); }   /* 항목 하나가 단보다 커도 잘리지 않게 그대로 둔다 */
      if(col===0) col=1; else page=null;
    }
  }
  fill(Array.prototype.slice.call(document.querySelectorAll('#pool .q')), '', first);
  if(!noKey){
    fill(Array.prototype.slice.call(document.querySelectorAll('#kpool .kx')), 'key', keyFirst);
    if(!document.querySelector('.page.key')) newPage(1, 'key', keyFirst);
  }
  var all=document.querySelectorAll('.page'); all.forEach(function(p,i){ p.querySelector('.pn').textContent='- '+(i+1)+' / '+all.length+' -'; });
  document.getElementById('pool').remove(); document.getElementById('kpool').remove();
  setTimeout(function(){ window.print(); }, 300);
}
(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(paginate);`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"><style>${css}</style></head><body><div class="bar">인쇄 창에서 대상을 "PDF로 저장"으로 고르면 파일이 됩니다.<button onclick="window.print()">인쇄 / PDF 저장</button></div><template id="hd">${head}</template><template id="first">${first}</template><template id="keyfirst">${keyFirst}</template><div id="pool" hidden>${items.map(qHtml).join("")}</div><div id="kpool" hidden>${kxHtml}</div><div id="pages"></div><script>${script}</script></body></html>`;
}
function PrintModal({ src, onClose, flash }) {
  const [nameLine, setNameLine] = useState(true);
  const n = (src.questions || []).length;
  const level = LEVELS.indexOf(src.level) >= 0 ? src.level : "기본";
  const go = () => {
    const w = window.open("", "_blank");
    if (!w) return flash("팝업이 막혀 있습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.");
    w.document.write(buildPrintHtml(src, { nameLine, noKey: !!src.noKey }));
    w.document.close();
    onClose();
  };
  const lab = (t) => <div style={{ fontSize: 13.5, color: C.sub, margin: "12px 0 6px" }}>{t}</div>;
  return (
    <Modal title="인쇄 · PDF 저장" onClose={onClose}>
      <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: 0 }}>A4 시험지로 만듭니다. 문제는 2단(왼쪽 단부터 세로로)에 잘리지 않는 만큼 채우고, 안내문은 첫 장 개념 상자에{src.noKey ? " 들어갑니다. 정답표·해설은 포함되지 않습니다(문제지만)" : ", 정답표와 해설은 뒤쪽 별지에 들어갑니다"}. 열리는 인쇄 창에서 프린터 대신 <b>PDF로 저장</b>을 고르면 파일로 받을 수 있습니다.</p>
      <p style={{ fontSize: 13.5, margin: "10px 0 0", display: "flex", alignItems: "center", gap: 8 }}>양식 색 <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 4, background: LEVEL_COLOR[level] }} /> <b>{level}</b> <span style={{ color: C.sub }}>— 편집 화면 "응시 조건"의 난이도로 바뀝니다 (기초 초록 · 기본 파랑 · 발전 노랑 · 심화 빨강)</span></p>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <CheckRow on={nameLine} onToggle={() => setNameLine((v) => !v)}><Check on={nameLine} size={20} /><span style={{ fontSize: 14.5 }}>첫 장에 이름·날짜·점수 칸</span></CheckRow>
      </div>
      <p style={{ fontSize: 13.5, color: C.sub, margin: "12px 0 0" }}>문제 {n}개{n === 0 ? " — 문제가 없습니다" : ""}</p>
      <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
        <Btn onClick={go} disabled={n === 0}>인쇄 창 열기</Btn>
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
            style={{ fontFamily: FONT, fontSize: 14, fontWeight: 600, padding: "7px 12px", borderRadius: 999, border: `1px solid ${on ? C.accent : C.line}`, background: on ? C.accentSoft : C.field, color: on ? C.accent : C.sub, cursor: "pointer" }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/* 파일 미리 보기용 Blob URL: 파일 목록이 바뀔 때만 만들고, 바뀌면 이전 URL 을 해제한다(메모리 누수 방지) */
function useObjectUrls(files) {
  const urls = useMemo(() => (files || []).map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} }), [urls]);
  return urls;
}
/* 서버가 준 HTML(리포트·오답노트)을 새 창에 쓸 때 스크립트 실행을 막는 CSP 를 앞에 붙인다(같은 origin 이라 토큰 접근 차단) */
function openHtmlWindow(html, flash) {
  const w = window.open("", "_blank");
  if (!w) { flash && flash("팝업이 막혀 있습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요."); return; }
  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`;
  const h = String(html || "");
  const m = /<head[^>]*>/i.exec(h);
  w.document.write(m ? h.slice(0, m.index + m[0].length) + csp + h.slice(m.index + m[0].length) : csp + h);
  w.document.close();
}

/* ── AI 문제 생성 모달 ───────────────────────── */
function GenerateModal({ onClose, onAdd, initScope, genAvail, subject, onQueue, manual }) {
  const me = (authGet() || {}).user;
  const lim = genLimitsOf(me);   // 기본 사진 10장·문제 50개, 확장 생성 권한이면 30장·100개
  const server = remote().kind === "server";
  const [mode, setModeRaw] = useState(genAvail ? "fast" : "pro");   // fast = Gemini 즉시, pro = Claude 워커(고급)
  const modeTouched = useRef(false);
  const setMode = (v) => { modeTouched.current = true; setModeRaw(v); };
  useEffect(() => { if (genAvail && !modeTouched.current) setModeRaw("fast"); }, [genAvail]);   // ping 이 늦게 와도 사용자가 고르기 전이면 기본(빠른) 방식으로
  const [photos, setPhotos] = useState([]);   // 고급: 사진으로 만들기
  const [explainLen, setExplainLen] = useState("normal");
  const [tbs, setTbs] = useState([]);          // 학교 교과서 목록
  const [tbSel, setTbSel] = useState("auto");   // auto | 번호 | none
  const sc = schoolGet();
  useEffect(() => { if (!server) return; let alive = true; remote().textbookGet(sc.school, sc.year).then((r) => { if (alive && r.ok) setTbs(r.items || []); }); return () => { alive = false; }; }, []);
  const [prog, setProg] = useState("");
  const [scope, setScope] = useState(initScope || "");
  const [material, setMaterial] = useState("");
  const [count, setCount] = useState(10);
  const [countStr, setCountStr] = useState("10");   // 직접 입력 중 문자열(비워도 바로 1 로 바뀌지 않게)
  const [custom, setCustom] = useState(false);
  const [difficulty, setDifficulty] = useState("기본");
  const [kind, setKind] = useState("single");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState(null);
  const [sel, setSel] = useState({});

  const sugIdx = pickTextbook(tbs, subject || scope, sc.grade);
  const tbIdx = tbSel === "auto" ? sugIdx : tbSel === "none" ? -1 : Number(tbSel);
  const textbook = tbIdx >= 0 && tbs[tbIdx] ? tbLabel(tbs[tbIdx]) : "";
  const run = async () => {
    if (busy || (!scope.trim() && !(mode === "pro" && photos.length))) return;
    setBusy(true);
    setErr("");
    if (mode === "pro") {
      const type = photos.length ? "photo" : "gen";
      const rq = await remote().jobCreate({ scope: scope.trim(), material: material.trim(), count, difficulty, kind, subject: subject || "", textbook, explainLen }, type, photos.length);
      if (!rq.ok) { setBusy(false); setErr(errMsg(rq)); return; }
      /* 사진 업로드가 중간에 실패하면 만들어 둔 작업을 취소해 uploading 상태로 남지 않게 한다(3개 한도 소진 방지) */
      const fail = (msg) => { setBusy(false); setProg(""); setErr(msg); remote().jobCancel(rq.job.id).catch(() => {}); };
      if (type === "photo") {
        for (let i = 0; i < photos.length; i++) {
          setProg(`사진 올리는 중 ${i + 1}/${photos.length}`);
          let b64 = "";
          try { b64 = await shrinkImage(photos[i]); } catch (e) { b64 = ""; }
          if (!b64) return fail("사진을 읽지 못했습니다. 다른 사진으로 해 보세요.");
          const up = await remote().jobPhoto(rq.job.id, `p${i + 1}.jpg`, "image/jpeg", b64);
          if (!up.ok) return fail(errMsg(up, { too_big: "사진이 너무 큽니다(9MB 이하)." }));
        }
        const rd = await remote().jobReady(rq.job.id);
        if (!rd.ok) return fail(errMsg(rd));
      }
      setBusy(false); setProg("");
      onQueue && onQueue(rq.job);
      return;
    }
    const r = await remote().generate({ scope: scope.trim(), material: material.trim(), count, difficulty, kind, textbook, explainLen, subject: subject || "" });
    setBusy(false);
    if (!r.ok) {
      setErr(errMsg(r));
      return;
    }
    const qs = (r.questions || []).map((q) => normalizeQuestion(q, 0)).filter((q) => q.text && (q.type === "essay" ? true : q.type === "short" ? !!q.answerText : q.options && q.answers.length));
    if (!qs.length) {
      setErr("만들어진 문제가 없습니다. 범위를 조금 더 구체적으로 적어 보세요.");
      return;
    }
    setResult({ title: asStr(r.title), questions: qs, remaining: r.remaining, quality: r.quality || null, want: count });
    setSel(Object.fromEntries(qs.map((q) => [q.id, true])));
  };
  /* 검증에서 빠져 모자란 문항만 다시 만들어 뒤에 붙인다 */
  const more = async () => {
    const need = result.want - result.questions.length;
    if (need <= 0) return;
    setBusy(true); setErr("");
    const r = await remote().generate({ scope: scope.trim(), material: material.trim(), count: need, difficulty, kind, textbook, explainLen, subject: subject || "" });
    setBusy(false);
    if (!r.ok) return setErr(errMsg(r));
    const qs = (r.questions || []).map((q) => normalizeQuestion(q, 0)).filter((q) => q.text && (q.type === "essay" ? true : q.type === "short" ? !!q.answerText : q.options && q.answers.length));
    setResult((x) => ({ ...x, questions: [...x.questions, ...qs], quality: r.quality || x.quality }));
    setSel((x) => ({ ...x, ...Object.fromEntries(qs.map((q) => [q.id, true])) }));
  };
  const GEN_WHY = { verify: "다른 풀이와 정답 불일치", self_mismatch: "정답 표시 불일치", calc: "계산 불일치", format: "형식 오류", no_material: "자료·지문 없이 자료 언급", hanja: "한자", artifact: "정답 끼워 맞춤" };
  const chosen = result ? result.questions.filter((q) => sel[q.id]) : [];
  const label = (t) => <div style={{ fontSize: 13.5, color: C.sub, margin: "14px 0 6px" }}>{t}</div>;
  const photoUrls = useObjectUrls(photos);

  return (
    <Modal title="AI로 문제 만들기" onClose={onClose} wide closeOnBackdrop={!busy}>
      {!result ? (
        <>
          {label("방식")}
          <Seg value={mode} onChange={setMode} items={[["fast", "기본 (바로 만들기)"], ["pro", "고급 (Claude · 10분 안에)"]]} />
          <p style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.6, margin: "8px 0 12px" }}>
            {mode === "pro"
              ? "서버의 Claude가 문제를 만들고, 다른 AI가 정답을 한 번 더 풀어 검증한 문항만 남깁니다. 완료되면 알림이 뜨고 새 시험지가 '내 시험지'에 추가됩니다(서버가 켜져 있을 때 보통 10분 안). 범위·자료에 이름, 학교, 연락처 같은 개인정보는 넣지 마세요."
              : genAvail
                ? "무료 AI(Gemini)가 바로 만들어 줍니다. 만든 문제는 고른 것만 이 시험지에 들어가고, 편집 화면에서 자유롭게 고칠 수 있습니다. 범위·자료에 이름, 학교, 연락처 같은 개인정보는 넣지 마세요."
                : "기본 방식은 지금 쓸 수 없습니다(서버에 Gemini 설정 없음). 고급 방식을 골라 주세요."}
          </p>
          <Field multiline rows={2} value={scope} onChange={setScope} placeholder={mode === "pro" ? "범위 또는 시험지 제목 (사진을 올리면 비워도 됩니다)" : "범위 (예: 중2 과학 광합성 단원, 영어 현재완료 시제)"} maxLength={500} autoFocus />
          {mode === "pro" && server && (
            <>
              {label(`사진으로 만들기 (선택, 최대 ${lim.photos}장) — 교과서·프린트·시험지를 찍어 올리면 그 내용으로 문제를 냅니다`)}
              <FilePick count={photos.length} onFiles={(fs) => { const all = [...photos, ...fs]; setErr(all.length > lim.photos ? `사진은 ${lim.photos}장까지 넣을 수 있어 앞의 ${lim.photos}장만 넣었습니다.` : ""); setPhotos(all.slice(0, lim.photos)); }} />
              {photos.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  {photos.map((f, i) => (
                    <span key={i} style={{ position: "relative", display: "inline-block" }}>
                      <img src={photoUrls[i]} alt={`사진 ${i + 1}`} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}`, display: "block" }} />
                      <button className="em-btn" aria-label={`사진 ${i + 1} 빼기`} onClick={() => setPhotos(photos.filter((_, k) => k !== i))} style={{ position: "absolute", top: -8, right: -8, width: 28, height: 28, borderRadius: 999, border: `2px solid ${C.bg}`, background: C.ink, color: C.bg, fontSize: 15, cursor: "pointer", lineHeight: 1, padding: 0 }}>×</button>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
          <Field multiline rows={4} value={material} onChange={setMaterial} placeholder="자료 붙여넣기 (선택) — 교과서 본문이나 수업 자료를 넣으면 그 내용에서만 출제합니다" maxLength={20000} style={{ marginTop: 10, fontSize: 14 }} />
          {label("문제 수")}
          <Seg value={custom ? "custom" : count} onChange={(v) => { if (v === "custom") { setCustom(true); setCountStr(String(count)); } else { setCustom(false); setCount(v); } }} items={[[10, "10개"], [25, "25개"], ["custom", "직접 입력"]]} />
          {custom && <input type="number" min="1" max={lim.count} placeholder={`1~${lim.count}`} value={countStr} onChange={(e) => { setCountStr(e.target.value); const n = parseInt(e.target.value, 10); if (n >= 1 && n <= lim.count) setCount(n); }} onBlur={() => setCountStr(String(count))} className="em-in" aria-label="문제 수" style={{ marginTop: 8, width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 15, color: C.ink, background: C.field, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 12px" }} />}
          {label("난이도 (인쇄 색: 기초 초록 · 기본 파랑 · 발전 노랑 · 심화 빨강)")}
          <Seg value={difficulty} onChange={setDifficulty} items={[["기초", "기초"], ["기본", "기본"], ["발전", "발전"], ["심화", "심화"]]} />
          {label("유형")}
          <Seg value={kind} onChange={setKind} items={[["single", "객관식 (정답 1개)"], ["multi", "객관식 (복수 정답)"], ["tf", "참·거짓"], ["real", "실전형 (5지선다·ㄱㄴㄷ 조합)"], ["short", "주관식"], ["essay", "서술형"]]} />
          {label("해설 길이")}
          <Seg value={explainLen} onChange={setExplainLen} items={[["short", "짧게 (한 문장)"], ["normal", "보통 (2~3문장)"], ["long", "자세히 (오답 이유까지)"]]} />
          {server && (
            <>
              {label(`교과서 (${sc.school} ${sc.grade}학년 ${sc.year}학년도 기준 · 계정 창에서 학교를 바꿀 수 있음)`)}
              {tbs.length === 0 ? (
                <p style={{ fontSize: 13.5, color: C.sub, margin: 0 }}>이 학교의 교과서 목록이 아직 없습니다. 계정 창에서 학교를 저장하면 찾아 둡니다.</p>
              ) : (
                <select value={tbSel} onChange={(e) => setTbSel(e.target.value)} className="em-in" aria-label="교과서" style={{ width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 14.5, color: C.ink, background: C.field, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 12px" }}>
                  <option value="auto">{sugIdx >= 0 ? `자동 · ${tbLabel(tbs[sugIdx])}` : "자동 (과목을 적으면 고릅니다)"}</option>
                  {tbs.map((t, i) => (!t.grade || !sc.grade || t.grade === sc.grade) && <option key={i} value={String(i)}>{tbLabel(t)}</option>)}
                  <option value="none">교과서 지정 안 함</option>
                </select>
              )}
            </>
          )}

          {err && <p role="alert" style={{ color: C.bad, fontSize: 14, margin: "10px 0 0", lineHeight: 1.5 }}>{err}</p>}
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
            <Btn onClick={run} disabled={busy || (!scope.trim() && !(mode === "pro" && photos.length)) || (mode === "fast" && !genAvail) || (mode === "pro" && !server)}>{busy ? (mode === "pro" ? prog || "요청하는 중…" : "문제를 만드는 중… (최대 1분)") : mode === "pro" ? (photos.length ? `사진 ${photos.length}장으로 Claude에게 요청하기` : "Claude에게 요청하기") : "문제 만들기"}</Btn>
            <Btn kind={manual ? "soft" : "ghost"} onClick={onClose}>{manual ? "직접 문제 만들기" : "닫기"}</Btn>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>
            문제 {result.questions.length}개를 만들었습니다. 추가할 문제를 고르세요. 정답은 초록색으로 표시됩니다.
          </p>
          {result.quality && (
            <div style={{ fontSize: 13.5, color: C.sub, lineHeight: 1.6, margin: "-4px 0 10px", padding: "8px 12px", background: C.lineSoft, borderRadius: 10 }}>
              {result.quality.verified === false ? "정답 자동 검증을 하지 못했습니다. 추가하기 전에 정답을 꼭 확인하세요." : `정답 자동 검증 통과 ${result.questions.length}/${result.want}`}
              {result.quality.verified !== false && result.quality.verifyLevel === "weak" && <b style={{ color: C.warn }}> · 약한 검증(상위 검증 모델 한도 초과) — 정답을 꼭 확인하세요</b>}
              {Object.keys(result.quality.dropped || {}).length > 0 && ` · 걸러낸 문항: ${Object.entries(result.quality.dropped).map(([k, n]) => `${GEN_WHY[k] || k} ${n}`).join(", ")}`}
              {result.questions.length < result.want && <div style={{ marginTop: 6 }}><Btn kind="soft" onClick={more} disabled={busy}>{busy ? "만드는 중…" : `부족한 ${result.want - result.questions.length}문항 다시 만들기`}</Btn></div>}
            </div>
          )}
          <div style={{ display: "grid", gap: 8 }}>
            {result.questions.map((q, i) => {
              const on = !!sel[q.id];
              return (
                <CheckRow key={q.id} on={on} onToggle={() => setSel((x) => ({ ...x, [q.id]: !x[q.id] }))} style={{ alignItems: "flex-start" }}>
                  <Check on={on} size={20} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{i + 1}. {q.text}</div>
                    <Figure svg={q.svg} style={{ maxWidth: 300 }} />
                    {(q.options || []).map((o, oi) => {
                      const ans = q.answers.includes(oi);
                      return (
                        <div key={oi} style={{ fontSize: 14, color: ans ? C.good : C.inkMid, fontWeight: ans ? 700 : 400, lineHeight: 1.5 }}>
                          {mark(oi)} {o}
                        </div>
                      );
                    })}
                    {q.type && q.type !== "mc" && <div style={{ fontSize: 14, color: C.good, fontWeight: 700, lineHeight: 1.5 }}>{QTYPE_KO[q.type]} · {q.type === "short" ? `정답: ${q.answerText}` : q.answerText ? `모범 답안: ${q.answerText}` : "모범 답안 없음"}</div>}
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
/* ── 문제지 편집(종이 모양) ── 문항을 누르면 하늘색 테두리 + ⋮, 고른 문항의 글·보기를 누르면 그 자리에서 고친다 */
const PP_ICONS = {
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  caret: <path d="m7 10 5 5 5-5" />,
  dots: <><circle cx="12" cy="5" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="19" r="1.6" fill="currentColor" /></>,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
};
const PpIco = ({ n }) => <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{PP_ICONS[n]}</svg>;
const blankQ = (kind) => ({ id: uid(), text: "", explain: "", options: kind === "tf" ? ["참", "거짓"] : kind === "essay" ? null : DEFAULT_OPTS(), answers: [], type: kind === "essay" ? "essay" : "mc", answerText: "", tags: [], svg: "", passage: "", src: "" });
/* 가지형: 마지막 문장(구하는 것)은 "(1) …" 문제로, 그 앞의 조건은 지문(단락)으로. 소수점(1.5)에서 끊기지 않게 문장부호 뒤 공백에서만 나눈다.
   한 문장이면 마지막 쉼표("…일 때, …")에서 나눈다. 나눌 곳이 없으면 null. (lookbehind 정규식은 옛 iOS 사파리에서 번들 전체가 깨져 쓰지 않음) */
function branchOf(q) {
  const t = String(q.text || "").trim();
  const parts = []; let cur = "";
  for (let i = 0; i < t.length; i++) { cur += t[i]; if (/[.?!。]/.test(t[i]) && (i === t.length - 1 || /\s/.test(t[i + 1]))) { parts.push(cur.trim()); cur = ""; } }
  if (cur.trim()) parts.push(cur.trim());
  let cond = "", ask = "";
  if (parts.length >= 2) { ask = parts.pop(); cond = parts.join(" "); }
  else { const k = t.lastIndexOf(","); if (k > 0 && k < t.length - 1) { cond = t.slice(0, k + 1).trim(); ask = t.slice(k + 1).trim(); } }
  if (!cond || !ask) return null;
  return { passage: [q.passage, cond].filter((x) => String(x || "").trim()).join("\n"), text: "(1) " + ask };
}
function PaperText({ value, editing, onStart, onChange, onDone, placeholder, oneLine, maxLength = 3000 }) {
  const ref = useRef(null);
  const fit = () => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; } };
  useEffect(() => { const el = ref.current; if (editing && el) { fit(); el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, [editing]);
  if (editing) return <textarea ref={ref} className="pq-in" value={value || ""} rows={1} maxLength={maxLength} placeholder={placeholder} aria-label={placeholder}
    onClick={(e) => e.stopPropagation()} onChange={(e) => { onChange(e.target.value); fit(); }} onBlur={onDone}
    onKeyDown={(e) => { if (e.key === "Escape" || (oneLine && e.key === "Enter" && !e.nativeEvent.isComposing)) { e.preventDefault(); onDone(); } }} />;
  return <span className="pq-ed" onClick={onStart ? (e) => { e.stopPropagation(); onStart(); } : undefined}>{String(value || "").trim() ? <M t={value} /> : <span className="pq-ph">{placeholder}</span>}</span>;
}
function PaperAnswerModal({ q, opts, patch, onClose, flash }) {
  const type = q.type || "mc";
  const toggle = (oi) => {
    const on = q.answers.includes(oi);
    if (!on && q.answers.length >= maxMulti(opts.length)) return flash(`복수 정답은 보기 ${opts.length}개 중 ${maxMulti(opts.length)}개까지입니다. 다른 정답을 먼저 해제하세요.`);
    patch({ answers: on ? q.answers.filter((a) => a !== oi) : [...q.answers, oi].sort((a, b) => a - b) });
  };
  return (
    <Modal title="정답 수정" onClose={onClose}>
      {type === "mc" && <div style={{ display: "grid", gap: 7 }}>
        {opts.map((o, oi) => { const on = q.answers.includes(oi); return (
          <CheckRow key={oi} on={on} onToggle={() => toggle(oi)}><Check on={on} size={20} /><span style={{ color: C.accent, fontSize: 16 }}>{mark(oi)}</span><span style={{ fontSize: 15.5, color: o.trim() ? C.ink : C.sub }}>{o.trim() || "(보기가 비어 있음)"}</span></CheckRow>
        ); })}
      </div>}
      {type === "short" && <Field value={q.answerText || ""} onChange={(v) => patch({ answerText: v })} placeholder="정답 (여러 개를 인정하면 | 로 구분)" maxLength={300} ariaLabel="정답" autoFocus />}
      {type === "essay" && <Field value={q.answerText || ""} onChange={(v) => patch({ answerText: v })} placeholder="모범 답안·채점 기준 (선택)" multiline rows={3} maxLength={1000} ariaLabel="모범 답안" />}
      <Field value={q.explain || ""} onChange={(v) => patch({ explain: v })} placeholder="해설 (선택)" multiline rows={2} maxLength={500} style={{ marginTop: 10, fontSize: 14.5 }} ariaLabel="해설" />
      <div style={{ display: "grid", marginTop: 14 }}><Btn onClick={onClose}>완료</Btn></div>
    </Modal>
  );
}
function PaperAiModal({ q, onClose, onApply }) {
  const [mode, setMode] = useState(q.svg ? "edit" : "figure");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const go = async () => {
    if (!prompt.trim()) return setErr(mode === "figure" ? "어떤 그림을 그릴지 적어 주세요." : "어떻게 고칠지 적어 주세요.");
    setBusy(true); setErr("");
    const r = await remote().aiEdit({ mode, prompt: prompt.trim(), question: { type: q.type || "mc", text: q.text, passage: q.passage || "", options: q.options || [], answers: q.answers || [], answerText: q.answerText || "", explain: q.explain || "", svg: q.svg || "" } });
    setBusy(false);
    if (!r || !r.ok) return setErr(errMsg(r));
    const e = onApply(mode, r);
    if (e) setErr(e);
  };
  return (
    <Modal title="AI 사용" onClose={busy ? () => {} : onClose}>
      <Seg value={mode} onChange={(v) => { setMode(v); setErr(""); }} items={[["figure", q.svg ? "그림 다시 그리기" : "그림 생성"], ["edit", "문제 수정"]]} />
      <Field value={prompt} onChange={setPrompt} multiline rows={3} maxLength={1000} autoFocus ariaLabel="AI 에게 시킬 일" style={{ marginTop: 12, fontSize: 15 }}
        placeholder={mode === "figure" ? "예: 빗변이 5, 밑변이 3인 직각삼각형. 각 변에 길이 표시" : "예: 숫자를 바꿔 난이도를 조금 올려 줘 / 보기를 4개로 줄여 줘"} />
      <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.55, margin: "8px 0 0" }}>무료 AI(Gemini)가 이 문항을 보고 바로 반영합니다. 마음에 안 들면 편집 바의 ↶(실행 취소)로 되돌리세요. 개인정보는 넣지 마세요.</p>
      {err && <p role="alert" style={{ fontSize: 14, color: C.bad, margin: "10px 0 0" }}>{err}</p>}
      <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
        <Btn onClick={go} disabled={busy}>{busy ? "AI가 작업하는 중…" : "실행"}</Btn>
        <Btn kind="ghost" onClick={onClose} disabled={busy}>닫기</Btn>
      </div>
    </Modal>
  );
}
function PaperEditor({ draft, setDraft, flash, aiOk, hist }) {
  const [sel, setSel] = useState(null);         // 고른 문항 id
  const [edit, setEdit] = useState(null);       // 고치는 칸: "title" | "desc" | "<id>:text" | "<id>:passage" | "<id>:o2"
  const [figOn, setFigOn] = useState(false);    // 고른 문항의 그림을 눌렀는지(휴지통 표시)
  const [menu, setMenu] = useState(false);      // ⋮ 메뉴
  const [typesOpen, setTypesOpen] = useState(false);
  const [ansId, setAnsId] = useState(null);
  const [aiId, setAiId] = useState(null);
  const [figWant, setFigWant] = useState({});   // 자료형으로 만든 문항: 그림이 없으면 그림 자리 표시
  const qs = draft.questions;
  const level = LEVELS.indexOf(draft.level) >= 0 ? draft.level : "기본";
  const kindLabel = useMemo(() => quizKindLabel(printableItems(draft)), [draft]);
  /* id 로 고친다(AI 응답을 기다리는 동안 순서가 바뀌어도 맞는 문항에 들어가게) */
  const patchQ = (id, patch) => setDraft((d) => ({ ...d, questions: d.questions.map((x) => (x.id === id ? { ...x, ...(typeof patch === "function" ? patch(x) : patch) } : x)) }));
  const pick = (id) => { setSel(id); setEdit(null); setFigOn(false); setMenu(false); setTypesOpen(false); };
  const clear = () => pick(null);
  useEffect(() => {
    if (!menu && !typesOpen) return;
    const h = () => { setMenu(false); setTypesOpen(false); };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, [menu, typesOpen]);
  const scrollTo = (id) => setTimeout(() => { const el = document.getElementById("pq-" + id); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); }, 60);
  const addQ = (kind) => {
    const q = blankQ(kind);
    setDraft((d) => ({ ...d, questions: [...d.questions, q] }));
    if (kind === "fig") setFigWant((w) => ({ ...w, [q.id]: true }));
    pick(q.id); scrollTo(q.id);
  };
  /* 지문은 같은 지문으로 이어진 문항 묶음 전체를 함께 고친다(묶음이 갈라지지 않게) */
  const setPassage = (id, v) => setDraft((d) => {
    const i = d.questions.findIndex((x) => x.id === id); if (i < 0) return d;
    const old = d.questions[i].passage || "";
    let a = i, b = i;
    if (old) { while (a > 0 && d.questions[a - 1].passage === old) a--; while (b < d.questions.length - 1 && d.questions[b + 1].passage === old) b++; }
    return { ...d, questions: d.questions.map((x, k) => (k >= a && k <= b ? { ...x, passage: v } : x)) };
  });
  const toBranch = (id) => {
    const q = qs.find((x) => x.id === id); if (!q) return;
    if (/^\(1\)/.test(q.text.trim())) return flash("이미 가지형 문제입니다. 복제하면 (2) 문제가 아래에 생깁니다.");
    const b = branchOf(q); setMenu(false);
    if (!b) return flash("조건과 구하는 것을 나눌 곳(문장 끝이나 쉼표)이 없습니다. 조건 문장과 묻는 문장을 나눠 쓴 뒤 다시 눌러 주세요.");
    patchQ(id, b);
    flash("조건은 단락으로, 구하는 것은 (1) 문제로 바꿨습니다. 복제로 (2)를 만들 수 있습니다.");
  };
  const dup = (id) => {
    const nid = uid();
    setDraft((d) => {
      const i = d.questions.findIndex((x) => x.id === id); if (i < 0) return d;
      const s = d.questions[i], m = /^\((\d{1,2})\)\s*/.exec(s.text);
      const copy = { ...JSON.parse(JSON.stringify(s)), id: nid, text: m ? `(${Number(m[1]) + 1}) ` + s.text.slice(m[0].length) : s.text };
      const next = [...d.questions]; next.splice(i + 1, 0, copy);
      return { ...d, questions: next };
    });
    pick(nid); scrollTo(nid); flash("아래에 복제했습니다.");
  };
  const del = (id) => {
    if (qs.length <= 1) return flash("문항이 하나뿐이라 지울 수 없습니다.");
    setDraft((d) => ({ ...d, questions: d.questions.filter((x) => x.id !== id) }));
    clear(); flash("문항을 지웠습니다. 되돌리려면 ↶(실행 취소)");
  };
  const applyAi = (id, mode, r) => {
    if (mode === "figure") {
      const svg = sanitizeSvg(r.svg);
      if (!svg) return "그림을 만들지 못했습니다. 설명을 조금 바꿔 다시 시도해 주세요.";
      patchQ(id, { svg });
    } else {
      const n = normalizeQuestion(r.question, draft.options.length);
      if (!n.text.trim()) return "AI가 문제를 돌려주지 않았습니다. 다시 시도해 주세요.";
      patchQ(id, { text: n.text, passage: n.passage || (qs.find((x) => x.id === id) || {}).passage || "", explain: n.explain, type: n.type, options: n.type === "mc" ? n.options || DEFAULT_OPTS() : null, answers: n.answers, answerText: n.answerText });
    }
    setAiId(null);
    flash("AI 결과를 반영했습니다. 마음에 안 들면 ↶(실행 취소)");
    return "";
  };
  const ansQ = ansId && qs.find((x) => x.id === ansId);
  const aiQ = aiId && qs.find((x) => x.id === aiId);
  return (
    <>
      <div className="em-ebar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="eb" onClick={hist.undo} disabled={!hist.canUndo} aria-label="실행 취소" title="실행 취소 (Ctrl+Z)"><PpIco n="undo" /></button>
        <button type="button" className="eb" onClick={hist.redo} disabled={!hist.canRedo} aria-label="다시 실행" title="다시 실행 (Ctrl+Y)"><PpIco n="redo" /></button>
        <span style={{ flex: 1, fontSize: 12.5, color: C.sub, padding: "0 6px", lineHeight: 1.4 }}>문항을 눌러 고르고, 고른 문항의 글·보기를 누르면 고칩니다</span>
        <div className="eb-add">
          <button type="button" className="eb main" onClick={() => addQ("mc")} aria-label="문제 추가" title="문제 추가 (객관식)"><PpIco n="plus" /></button>
          <button type="button" className="eb caret" onClick={() => { setMenu(false); setTypesOpen((v) => !v); }} aria-label="문제 유형 골라 추가" aria-expanded={typesOpen} title="문제 유형 골라 추가"><PpIco n="caret" /></button>
          {typesOpen && <div className="pq-menu eb-types" role="menu">
            {[["tf", "참·거짓"], ["mc", "객관식"], ["essay", "서술형"], ["fig", "자료형 (그림 있는 문제)"]].map(([k, l]) => <button key={k} type="button" role="menuitem" onClick={() => addQ(k)}>{l}</button>)}
          </div>}
        </div>
      </div>
      <div className="em-paper" style={{ "--pac": LEVEL_COLOR[level], "--pacs": LEVEL_SOFT[level] }} onClick={clear}>
        <div className="pp-hd">
          <div className="pp-tag"><span>{draft.subject || "시험지"}</span><span>{level}</span></div>
          <div className="pp-ttl"><PaperText value={draft.title} editing={edit === "title"} onStart={() => { pick(null); setEdit("title"); }} onChange={(v) => setDraft((d) => ({ ...d, title: v }))} onDone={() => setEdit(null)} placeholder="시험지 제목" oneLine maxLength={80} /></div>
          <div className="pp-kind">{kindLabel}</div>
        </div>
        {(draft.desc || edit === "desc") && <div className="pp-box"><PaperText value={draft.desc} editing={edit === "desc"} onStart={() => { pick(null); setEdit("desc"); }} onChange={(v) => setDraft((d) => ({ ...d, desc: v }))} onDone={() => setEdit(null)} placeholder="안내문" maxLength={300} /></div>}
        <div className="pp-pill">확인 문제</div>
        <div className="pp-cols">
          {qs.map((q, i) => {
            const on = sel === q.id, type = q.type || "mc", opts = type === "mc" ? (q.options || draft.options) : [];
            const key = (f) => q.id + ":" + f;
            const ed = (f) => on && edit === key(f);
            const start = (f) => (on ? () => { setEdit(key(f)); setFigOn(false); setMenu(false); } : undefined);
            const done = () => setEdit(null);
            const showPas = ed("passage") || (!!q.passage && (i === 0 || qs[i - 1].passage !== q.passage));
            return (
              <div key={q.id} id={"pq-" + q.id} className={"em-pq" + (on ? " on" : "")} onClick={(e) => { e.stopPropagation(); if (!on) pick(q.id); else { setFigOn(false); setMenu(false); } }}>
                {on && <button type="button" className="pq-dots" aria-label={`${i + 1}번 문항 메뉴`} aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setEdit(null); setTypesOpen(false); setMenu((v) => !v); }}><PpIco n="dots" /></button>}
                {on && menu && <div className="pq-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                  <button type="button" role="menuitem" onClick={() => toBranch(q.id)}>가지형 문제로 전환</button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); dup(q.id); }}>복제</button>
                  <button type="button" role="menuitem" onClick={() => { setMenu(false); setAnsId(q.id); }}>정답 수정</button>
                  {aiOk && <button type="button" role="menuitem" onClick={() => { setMenu(false); setAiId(q.id); }}>AI 사용</button>}
                  <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(false); del(q.id); }}>삭제</button>
                </div>}
                {showPas && <div className="pq-pas"><PaperText value={q.passage} editing={ed("passage")} onStart={start("passage")} onChange={(v) => setPassage(q.id, v)} onDone={done} placeholder="지문" maxLength={4000} /></div>}
                <div className="pq-h">
                  <span className="pq-n">Q{i + 1}.</span>
                  <span className="pq-t"><PaperText value={q.text} editing={ed("text")} onStart={start("text")} onChange={(v) => patchQ(q.id, { text: v })} onDone={done} placeholder="문제를 입력하세요" />{!ed("text") && (type === "short" ? <span className="pq-sub"> (주관식)</span> : type === "essay" ? <span className="pq-sub"> (서술형)</span> : q.answers.length > 1 ? <span className="pq-sub"> (정답 {q.answers.length}개)</span> : null)}</span>
                  {q.src && <span className="pq-src">원본 {q.src}</span>}
                </div>
                {q.svg ? (
                  <div className={"pq-fig" + (on && figOn ? " on" : "")} onClick={on ? (e) => { e.stopPropagation(); setFigOn(true); setEdit(null); setMenu(false); } : undefined}>
                    <Figure svg={q.svg} style={{ margin: 0 }} />
                    {on && figOn && <button type="button" className="pq-trash" aria-label="그림 지우기" title="그림 지우기" onClick={(e) => { e.stopPropagation(); patchQ(q.id, { svg: "" }); setFigOn(false); flash("그림을 지웠습니다. 되돌리려면 ↶(실행 취소)"); }}><PpIco n="trash" /></button>}
                  </div>
                ) : figWant[q.id] ? <div className="pq-figph">그림 자리 — {aiOk ? "⋮ › AI 사용 › 그림 생성" : "'자세히 편집'에서 그림(SVG) 넣기"}</div> : null}
                {type === "mc" && <div className={"pq-opts " + (opts.every((o) => String(o).length <= 14) ? "two" : "one")}>
                  {opts.map((o, oi) => (
                    <div key={oi} className={"pq-o" + (q.answers.includes(oi) ? " ans" : "")}>
                      <span className="pq-m">{mark(oi)}</span>
                      <span className="pq-ot"><PaperText value={o} editing={ed("o" + oi)} onStart={start("o" + oi)} onChange={(v) => patchQ(q.id, (x) => ({ options: (x.options || draft.options).map((y, k) => (k === oi ? v : y)) }))} onDone={done} placeholder={`보기 ${oi + 1}`} oneLine maxLength={200} /></span>
                    </div>
                  ))}
                </div>}
                {type === "short" && <div className="pq-short">답: <i /></div>}
                {type === "essay" && <div className="pq-essay" />}
              </div>
            );
          })}
        </div>
      </div>
      {ansQ && <PaperAnswerModal q={ansQ} opts={(ansQ.type || "mc") === "mc" ? (ansQ.options || draft.options) : []} patch={(p) => patchQ(ansQ.id, p)} onClose={() => setAnsId(null)} flash={flash} />}
      {aiQ && <PaperAiModal q={aiQ} onClose={() => setAiId(null)} onApply={(mode, r) => applyAi(aiQ.id, mode, r)} />}
    </>
  );
}

function EditorScreen({ draft, setDraft, dirty, busy, onSave, onShare, onBack, onExport, flash, toast, genInit, genAuto, onGenInitUsed, onPrint }) {
  const [shareCode, setShareCode] = useState(null);
  const [showProblems, setShowProblems] = useState(false);
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(!!genInit || !!genAuto);
  const [manualMode] = useState(!!genAuto && !genInit);   // 새 시험지: 닫기 대신 "직접 문제 만들기"
  useEffect(() => { if ((genInit || genAuto) && onGenInitUsed) onGenInitUsed(); }, []);
  const [tagsRaw, setTagsRaw] = useState({});   // 문항별 태그 입력 중 문자열(쉼표 입력 중에도 유지)
  const [figOpen, setFigOpen] = useState({});   // 문항별 그림(SVG) 입력칸 열림
  const [pasOpen, setPasOpen] = useState({});   // 문항별 지문 입력칸 열림
  const inStyle = { width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 15, color: C.ink, background: C.field, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 11px", outline: "none", marginTop: 4 };
  const labStyle = { display: "block", fontSize: 12.5, color: C.sub, fontWeight: 600 };
  const [genAvail, setGenAvail] = useState(false); // 서버가 생성 기능을 켰을 때만 버튼 표시(기본 숨김 = 비용 0)
  useEffect(() => { let alive = true; remote().genAvailable().then((v) => { if (alive) setGenAvail(v); }); return () => { alive = false; }; }, []);

  const [view, setView] = useState("paper");   // paper = 문제지(인쇄 모양)에서 바로 고치기(기본) / form = 자세히 편집
  /* 실행 취소·다시 실행: 내용 칸만 기억한다(저장·공유로 바뀌는 code·ownerKey 등은 되돌리지 않음). 0.8초 안의 연속 입력은 한 단계로 묶음 */
  const HIST_KEYS = ["title", "desc", "subject", "questions", "options", "shuffle", "level", "timeLimit", "openAt", "closeAt"];
  const hist = useRef({ past: [], future: [], prev: draft, last: 0, skip: false });
  const [, setHv] = useState(0);
  useEffect(() => {
    const h = hist.current, prev = h.prev;
    h.prev = draft;
    if (h.skip) { h.skip = false; return; }
    if (prev === draft || HIST_KEYS.every((k) => prev[k] === draft[k])) return;
    const now = Date.now();
    if (now - h.last > 800 || !h.past.length) { h.past.push(prev); if (h.past.length > 100) h.past.shift(); }
    h.last = now; h.future = []; setHv((v) => v + 1);
  }, [draft]);
  const pickContent = (d) => Object.fromEntries(HIST_KEYS.map((k) => [k, d[k]]));
  const histGo = (from, to) => {
    const h = hist.current; if (!h[from].length) return;
    const snap = h[from].pop(); h[to].push(draft); h.skip = true; h.last = 0;
    setDraft((d) => ({ ...d, ...pickContent(snap) })); setHv((v) => v + 1);
  };
  const undo = () => histGo("past", "future"), redo = () => histGo("future", "past");
  const undoRef = useRef(null); undoRef.current = { undo, redo };
  useEffect(() => {
    const h = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target, tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable) || document.querySelector('[role="dialog"]')) return;   // 모달이 열려 있을 때도 무시   // 입력칸 안에서는 브라우저 기본 되돌리기
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undoRef.current.undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); undoRef.current.redo(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const upd = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const problems = useMemo(() => problemsOf(draft), [draft]);
  const stale = useMemo(() => !!(draft.code && draft.sharedHash !== hashOf(draft)), [draft]);   // 키 입력마다 전체 직렬화하지 않게

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
    const n = (q.options || draft.options).length;
    if (!q.answers.includes(oi) && q.answers.length >= maxMulti(n)) return flash(`복수 정답은 보기 ${n}개 중 ${maxMulti(n)}개까지입니다. 다른 정답을 먼저 해제하세요.`);
    const answers = q.answers.includes(oi) ? q.answers.filter((a) => a !== oi) : [...q.answers, oi].sort((a, b) => a - b);
    setQ(qi, { answers });
  };
  const setQType = (qi, type) => {
    const q = draft.questions[qi];
    setQ(qi, { type, options: type === "mc" ? (q.options && q.options.length >= 2 ? q.options : DEFAULT_OPTS()) : null, answers: type === "mc" ? q.answers : [] });
  };
  const addQ = () => upd({ questions: [...draft.questions, { id: uid(), text: "", explain: "", options: DEFAULT_OPTS(), answers: [], type: "mc", answerText: "", tags: [], svg: "", passage: "" }] });
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
    const fresh = qs.map((q) => ({ id: uid(), text: q.text, explain: q.explain || "", options: q.type && q.type !== "mc" ? null : q.options, answers: q.answers, type: q.type || "mc", answerText: q.answerText || "", tags: q.tags || [], svg: q.svg || "", passage: q.passage || "" }));   // 그림·지문도 함께(빠지면 도형 문항이 그림 없이 들어감)
    const existing = draft.questions.filter((q) => q.text.trim() || q.answers.length);
    upd({ questions: [...existing, ...fresh], title: draft.title.trim() ? draft.title : title || "" });
    setGenOpen(false);
    flash(`문제 ${fresh.length}개를 추가했습니다.`);
  };
  /* 문항 삭제는 6초 동안 되돌릴 수 있다 */
  const [undoDel, setUndoDel] = useState(null);   // { q, qi }
  const undoTimer = useRef(null);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  const delQ = (qi) => {
    if (draft.questions.length <= 1) return;
    setUndoDel({ q: draft.questions[qi], qi });
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndoDel(null), 6000);
    upd({ questions: draft.questions.filter((_, k) => k !== qi) });
  };
  const undoDelete = () => {
    if (!undoDel) return;
    const qs = [...draft.questions];
    qs.splice(Math.min(undoDel.qi, qs.length), 0, undoDel.q);
    upd({ questions: qs });
    setUndoDel(null);
  };
  /* 저장하지 않은 채 탭을 닫거나 새로고침하면 브라우저 경고 */
  useEffect(() => {
    if (!dirty) return;
    const h = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
  const moveQ = (qi, dir) => {
    setUndoDel(null);
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
    <Shell back="홈으로" backTo={back} toast={toast} wide={view === "paper"}>
      {undoDel && (
        <div className="em-toast" role="status" style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", marginBottom: toast ? 56 : 0, background: C.ink, color: C.bg, padding: "4px 8px 4px 18px", borderRadius: 12, fontSize: 14.5, maxWidth: "88vw", zIndex: 71, display: "flex", alignItems: "center", gap: 8 }}>
          <span>{undoDel.qi + 1}번 문항을 지웠습니다.</span>
          <button type="button" className="em-btn" onClick={undoDelete} style={{ background: "none", border: 0, color: "inherit", fontWeight: 800, textDecoration: "underline", cursor: "pointer", minHeight: 44, padding: "0 6px", font: "inherit" }}>되돌리기</button>
        </div>
      )}
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
          {(genAvail || remote().kind === "server") && <TextBtn onClick={() => setGenOpen(true)}>AI로 문제 만들기</TextBtn>}
          {draft.code && <TextBtn onClick={() => setResultsOpen(true)}>응시 기록</TextBtn>}
          <TextBtn onClick={onExport}>내보내기</TextBtn>
          {onPrint && <TextBtn onClick={() => onPrint(draft)}>인쇄·PDF</TextBtn>}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <Seg value={view} onChange={setView} items={[["paper", "문제지"], ["form", "자세히 편집"]]} />
        {view === "paper" && <span style={{ fontSize: 12.5, color: C.sub }}>과목·난이도·응시 조건·태그·문항 유형 바꾸기는 '자세히 편집'에서</span>}
      </div>
      {view === "paper" ? <PaperEditor draft={draft} setDraft={setDraft} flash={flash} aiOk={genAvail} hist={{ undo, redo, canUndo: hist.current.past.length > 0, canRedo: hist.current.future.length > 0 }} /> : <>
      <Field value={draft.title} onChange={(v) => upd({ title: v })} placeholder="시험지 제목" maxLength={80} style={{ fontSize: 21, fontWeight: 700, padding: "14px 15px", marginBottom: 10 }} />
      <Field value={draft.desc} onChange={(v) => upd({ desc: v })} placeholder="안내문 (선택) — 응시자에게 첫 화면에서 보여줍니다" maxLength={300} multiline rows={2} style={{ marginBottom: 10, fontSize: 15 }} />
      <Field value={draft.subject || ""} onChange={(v) => upd({ subject: v })} placeholder="과목 (선택) 예: 통합과학 — 결과 화면에서 과목별 정답률에 쓰입니다" maxLength={20} style={{ marginBottom: 10, fontSize: 15 }} ariaLabel="과목" />
      <Card style={{ padding: "12px 14px", marginBottom: 22 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: C.inkMid, marginBottom: 6 }}>응시 조건 (선택)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
          <label style={labStyle}>제한 시간(분)<input type="number" min="0" max="300" className="em-in" style={inStyle} value={draft.timeLimit || ""} placeholder="없음" onChange={(e) => upd({ timeLimit: Math.max(0, Math.min(300, parseInt(e.target.value, 10) || 0)) })} /></label>
          <label style={labStyle}>응시 시작<input type="datetime-local" className="em-in" style={inStyle} value={toLocalInput(draft.openAt)} onChange={(e) => upd({ openAt: fromLocalInput(e.target.value) })} /></label>
          <label style={labStyle}>응시 마감<input type="datetime-local" className="em-in" style={inStyle} value={toLocalInput(draft.closeAt)} onChange={(e) => upd({ closeAt: fromLocalInput(e.target.value) })} /></label>
          <label style={labStyle}>난이도 (인쇄 색)<select className="em-in" style={inStyle} value={draft.level || "기본"} onChange={(e) => upd({ level: e.target.value })} aria-label="난이도">{LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
        </div>
        <div style={{ fontSize: 12.5, color: C.sub, marginTop: 8, lineHeight: 1.5 }}>비워 두면 제한 없음. 시작 전·마감 뒤에는 코드로 열 수 없습니다(출제자는 언제나 열림). 시간이 끝나면 자동 제출됩니다.</div>
      </Card>

      <h3 style={{ fontSize: 17, fontWeight: 700, margin: "0 0 4px" }}>문제</h3>
      <p style={{ fontSize: 13.5, color: C.sub, margin: "0 0 12px", lineHeight: 1.5 }}>문항마다 유형(객관식·주관식·서술형)을 고릅니다. 객관식 보기는 기본 5개이고 복수 정답은 보기의 절반까지입니다. 해설을 적으면 채점 결과에서 보여줍니다.</p>

      <div style={{ display: "grid", gap: 12 }}>
        {draft.questions.map((q, qi) => (
          <Card key={q.id} style={{ padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 14.5, fontWeight: 700, color: C.accent }}>{qi + 1}번</span><SrcPill src={q.src} /></span>
              <div style={{ display: "flex", gap: 0 }}>
                <TextBtn tone="sub" ariaLabel="위로" onClick={() => moveQ(qi, -1)} disabled={qi === 0} style={{ fontSize: 15 }}>▲</TextBtn>
                <TextBtn tone="sub" ariaLabel="아래로" onClick={() => moveQ(qi, 1)} disabled={qi === draft.questions.length - 1} style={{ fontSize: 15 }}>▼</TextBtn>
                <TextBtn tone="sub" onClick={() => delQ(qi)} disabled={draft.questions.length <= 1} style={{ fontSize: 13.5 }}>삭제</TextBtn>
              </div>
            </div>
            <div style={{ margin: "0 0 10px" }}><Seg value={q.type || "mc"} onChange={(v) => setQType(qi, v)} items={[["mc", "객관식"], ["short", "주관식"], ["essay", "서술형"]]} /></div>
            {(q.passage || pasOpen[q.id]) && (
              <Field value={q.passage || ""} onChange={(v) => setQ(qi, { passage: v })} placeholder="지문 (같은 지문을 이어지는 문항에도 넣으면 화면·인쇄에서 한 번만 보입니다)" multiline rows={4} maxLength={4000} style={{ marginBottom: 8, fontSize: 14.5, background: C.lineSoft }} ariaLabel={`${qi + 1}번 지문`} />
            )}
            <Field value={q.text} onChange={(v) => setQ(qi, { text: v })} placeholder="문제를 입력하세요" multiline />
            {q.svg && !figOpen[q.id] && <Figure svg={q.svg} />}
            <div style={{ marginTop: 6 }}><TextBtn tone="sub" onClick={() => setFigOpen({ ...figOpen, [q.id]: !figOpen[q.id] })} style={{ padding: 0, fontSize: 13 }}>{figOpen[q.id] ? "그림 코드 닫기" : q.svg ? "그림(SVG) 고치기" : "그림(SVG) 넣기"}</TextBtn>{!q.passage && !pasOpen[q.id] && <TextBtn tone="sub" onClick={() => { setPasOpen({ ...pasOpen, [q.id]: true }); if (qi > 0 && draft.questions[qi - 1].passage) setQ(qi, { passage: draft.questions[qi - 1].passage }); }} style={{ padding: 0, fontSize: 13, marginLeft: 10 }}>지문 넣기{qi > 0 && draft.questions[qi - 1].passage ? " (앞 문항과 같은 지문)" : ""}</TextBtn>}</div>
            {figOpen[q.id] && (
              <div style={{ marginTop: 6 }}>
                <Field value={q.svg || ""} onChange={(v) => setQ(qi, { svg: sanitizeSvg(v) || (v.trim() ? q.svg : "") })} placeholder={'<svg viewBox="0 0 320 200" ...> … </svg>  (도형·그래프·표. AI가 만든 문제는 자동으로 들어옵니다)'} multiline rows={4} maxLength={20000} style={{ fontSize: 12.5, fontFamily: "ui-monospace, Consolas, monospace" }} ariaLabel={`${qi + 1}번 그림 코드`} />
                <Figure svg={q.svg} />
              </div>
            )}
            {(q.type || "mc") === "short" && (
              <Field value={q.answerText || ""} onChange={(v) => setQ(qi, { answerText: v })} placeholder="정답 (여러 개를 인정하면 | 로 구분) 예: 이온 결합|이온결합" maxLength={300} style={{ marginTop: 10, fontSize: 15 }} ariaLabel={`${qi + 1}번 정답`} />
            )}
            {q.type === "essay" && (
              <Field value={q.answerText || ""} onChange={(v) => setQ(qi, { answerText: v })} placeholder="모범 답안·채점 기준 (선택) — 학생에게는 채점 후 보입니다" multiline rows={3} maxLength={1000} style={{ marginTop: 10, fontSize: 14.5 }} ariaLabel={`${qi + 1}번 모범 답안`} />
            )}
            {(q.type || "mc") === "mc" && q.options && (
              <div style={{ marginTop: 12, padding: 12, background: C.lineSoft, borderRadius: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: C.inkMid }}>보기 {q.options.length}개</span>
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
            )}
            {(q.type || "mc") === "mc" && <div style={{ fontSize: 13.5, color: C.sub, margin: "14px 0 8px" }}>정답 고르기 <span style={{ fontSize: 12.5 }}>(여러 개면 보기의 절반까지)</span></div>}
            {(q.type || "mc") === "mc" && <div style={{ display: "grid", gap: 7 }}>
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
            </div>}
            <Field value={q.explain} onChange={(v) => setQ(qi, { explain: v })} placeholder="해설 (선택)" multiline rows={1} maxLength={500} style={{ marginTop: 12, fontSize: 14.5, background: C.lineSoft }} />
            <Field value={tagsRaw[q.id] !== undefined ? tagsRaw[q.id] : (q.tags || []).join(", ")} onChange={(v) => { setTagsRaw({ ...tagsRaw, [q.id]: v }); setQ(qi, { tags: splitTags(v) }); }} placeholder="태그 (선택, 쉼표로) 예: 이온, 화학 반응식" maxLength={120} style={{ marginTop: 8, fontSize: 13.5, padding: "9px 11px" }} ariaLabel={`${qi + 1}번 태그`} />
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
      </>}

      {showProblems && problems.length > 0 && (
        <div style={{ marginTop: 18, padding: "12px 14px", background: C.warnSoft, border: `1px solid ${C.warnLine}`, borderRadius: 12 }}>
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

      {resultsOpen && draft.code && <ResultsModal code={draft.code} ownerKey={draft.ownerKey} exam={draft} onClose={() => setResultsOpen(false)} flash={flash} />}
      <div className="em-jump" aria-label="화면 이동">
        <button className="em-btn" aria-label="맨 위로" title="맨 위로" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14.5 L12 9.5 L17 14.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        <button className="em-btn" aria-label="맨 아래로" title="맨 아래로" onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9.5 L12 14.5 L17 9.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      </div>
      {genOpen && <GenerateModal onClose={() => setGenOpen(false)} onAdd={addGenerated} initScope={genInit || ""} genAvail={genAvail} subject={draft.subject} manual={manualMode} onQueue={() => { setGenOpen(false); flash("Claude에게 요청했습니다. 완료되면 알림이 뜨고 내 시험지에 새 시험지로 추가됩니다."); }} />}
    </Shell>
  );
}

/* ── 화면: 코드 입력 ─────────────────────────── */
function CodeScreen({ codeInput, setCodeInput, codeErr, busy, onLoad, onBack, toast, user, onOpenCode }) {
  const server = remote().kind === "server" && !!user;
  const [d] = useHomeData(server ? user : null, server ? "server" : "local");   // 배정된 시험지(홈과 같은 캐시)
  return (
    <Shell back="홈으로" backTo={onBack} toast={toast}>
      <h2 style={{ fontSize: 25, fontWeight: 800, margin: "0 0 8px" }}>풀기</h2>
      <p style={{ fontSize: 15.5, color: C.sub, lineHeight: 1.6, margin: "0 0 20px" }}>받은 다섯 자리 코드(예: 7F3KM)를 넣으면 시험지가 열립니다.</p>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: "0.12em", color: C.accent }}>시험 코드 입력</span>
          <QrIcon size={24} color={C.sub} />
        </div>
        <Field
          value={codeInput}
          onChange={(v) => setCodeInput(cleanCode(v))}
          onEnter={() => codeInput.length === 5 && !busy && onLoad()}
          placeholder="코드 다섯 자리"
          maxLength={5}
          ariaLabel="공유 코드"
          style={{ fontSize: 30, fontWeight: 800, letterSpacing: "0.32em", textIndent: "0.32em", textAlign: "center", padding: "16px 12px", textTransform: "uppercase", borderRadius: 14 }}
        />
        <div aria-hidden="true" style={{ display: "flex", justifyContent: "center", gap: 10, margin: "12px 0 2px" }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} style={{ width: 10, height: 10, borderRadius: 999, background: i < codeInput.length ? C.accent : C.lineSoft, border: `1px solid ${i < codeInput.length ? C.accent : C.line}`, transition: "background .15s" }} />
          ))}
        </div>
        {codeErr && <p role="alert" style={{ color: C.bad, fontSize: 14, margin: "12px 0 0", lineHeight: 1.5 }}>{codeErr}</p>}
        <div style={{ marginTop: 14 }}>
          <Btn onClick={onLoad} disabled={busy || codeInput.length !== 5}>
            {busy ? "여는 중…" : "시험지 열기"}
          </Btn>
        </div>
      </Card>
      {server && <div style={{ marginTop: 18 }}><AssignList d={d} onOpen={onOpenCode} /></div>}
    </Shell>
  );
}

/* ── 화면: 응시 ──────────────────────────────── */
/* ── 풀기 화면: 결과 직접 입력 ──────────────────────
   1) 채점자(출제자·관리자·제한 관리자) 아이디/비밀번호 확인 → 2) 모든 문항이 정답으로 체크된 상태에서 틀린 문항만 고쳐 기록.
   기록은 지금 응시 중인 계정의 결과로 남고, 활동 기록에는 채점자가 남는다. 비밀번호는 저장하지 않고 요청에만 쓴다. */
function ManualResultModal({ run, onClose, onDone }) {
  const [gid, setGid] = useState("");
  const [gpw, setGpw] = useState("");
  const [grader, setGrader] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(() => run.questions.map((q) => ({ q, ok: true, m: (q.type || "mc") === "mc" ? [...(q.answers || [])] : [], t: "" })));
  const check = async () => {
    if (!gid.trim() || !gpw) return setErr("아이디와 비밀번호를 넣어 주세요.");
    setBusy(true); setErr("");
    const r = await remote().graderCheck({ code: run.code, graderId: gid.trim(), graderPw: gpw });
    setBusy(false);
    if (!r.ok) return setErr(r.error === "forbidden" ? "이 시험지를 만든 계정이나 관리자 계정만 결과를 직접 입력할 수 있습니다." : errMsg(r));
    setGrader(r.grader);
  };
  const save = async () => {
    setBusy(true); setErr("");
    const toOrig = (q, arr) => arr.map((i) => (q.perm && q.perm[i] != null ? q.perm[i] : i)).sort((a, b) => a - b);
    const detail = rows.map((r) => ({ q: r.q.id, m: toOrig(r.q, r.m), ok: r.ok, ...((r.q.type || "mc") !== "mc" ? { t: r.t.slice(0, 500) } : {}) }));
    const r = await remote().resultManual({ code: run.code, graderId: gid.trim(), graderPw: gpw, entry: { v: 2, detail } });
    setBusy(false);
    if (!r.ok) return setErr(errMsg(r));
    setGpw("");
    onDone(r);
  };
  const okCount = rows.filter((r) => r.ok).length;
  const setRow = (i, patch) => setRows(rows.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return (
    <Modal title={grader ? `결과 직접 입력 · 채점 ${grader.name}` : "결과 직접 입력 · 계정 확인"} onClose={onClose} wide={!!grader} closeOnBackdrop={false}>
      {!grader ? (
        <>
          <p style={{ fontSize: 14, color: C.inkMid, margin: "0 0 12px", lineHeight: 1.55 }}>이 시험지를 만든 계정이나 관리자 계정으로 확인하면, 종이로 푼 결과 등을 문항별로 직접 입력해 응시 기록으로 남길 수 있습니다. 기록은 지금 로그인한 계정의 결과로 저장됩니다.</p>
          <div style={{ display: "grid", gap: 8 }}>
            <Field value={gid} onChange={setGid} placeholder="채점자 아이디" ariaLabel="채점자 아이디" autoFocus />
            <Field value={gpw} onChange={setGpw} placeholder="비밀번호" type="password" ariaLabel="채점자 비밀번호" onEnter={check} />
          </div>
          {err && <p role="alert" style={{ color: C.bad, fontSize: 13.5, margin: "8px 0 0" }}>{err}</p>}
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
            <Btn onClick={check} disabled={busy}>확인</Btn>
            <Btn kind="ghost" onClick={onClose}>닫기</Btn>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 14, margin: "0 0 8px", lineHeight: 1.5 }}>모든 문항이 <b>정답</b>으로 체크되어 있습니다. 틀린 문항의 배지를 누르거나 학생이 고른 보기를 눌러 고치세요. <b>{okCount}/{rows.length}</b></p>
          <div style={{ display: "grid", gap: 8, maxHeight: "55vh", overflowY: "auto" }}>
            {rows.map((r, i) => {
              const q = r.q, textQ = (q.type || "mc") !== "mc", answers = q.answers || [];
              const pick = (oi) => { const m = r.m.includes(oi) ? r.m.filter((x) => x !== oi) : [...r.m, oi].sort((a, b) => a - b); setRow(i, { m, ok: m.length > 0 && sameSet(m, answers) }); };
              return (
                <div key={q.id} style={{ border: `1px solid ${r.ok ? C.good : C.line}`, background: r.ok ? C.goodSoft : C.card, borderRadius: 12, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <button className="em-btn" onClick={() => setRow(i, { ok: !r.ok })} aria-pressed={r.ok} title="정답/오답 바꾸기" style={{ flex: "0 0 auto", border: "none", background: "none", padding: 0, cursor: "pointer", minHeight: 32 }}><Badge tone={r.ok ? "good" : "bad"}>{r.ok ? "정답" : "오답"}</Badge></button>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.45 }}>{i + 1}. {q.text}{textQ && <span style={{ color: C.sub, fontWeight: 400 }}> · {QTYPE_KO[q.type]}</span>}</div>
                  </div>
                  {!textQ && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }} role="group" aria-label={`${i + 1}번 고른 보기`}>
                      {(q.options || []).map((o, oi) => {
                        const on = r.m.includes(oi), isAns = answers.includes(oi);
                        return (
                          <button key={oi} className="em-btn" onClick={() => pick(oi)} aria-pressed={on}
                            style={{ fontFamily: FONT, fontSize: 13.5, padding: "6px 10px", borderRadius: 999, cursor: "pointer", border: `1.5px solid ${on ? C.accent : isAns ? C.good : C.line}`, background: on ? C.accentSoft : C.field, color: on ? C.accent : C.ink, maxWidth: "100%", textAlign: "left" }}>
                            <span style={{ fontWeight: 800, marginRight: 4 }}>{mark(oi)}</span>{o}{isAns ? <span style={{ color: C.good, fontSize: 11.5, marginLeft: 4 }}>정답</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {textQ && <Field value={r.t} onChange={(v) => setRow(i, { t: v })} placeholder={q.type === "short" ? "학생이 적은 답 (선택)" : "학생이 적은 서술 (선택)"} multiline={q.type === "essay"} rows={q.type === "essay" ? 3 : 1} maxLength={500} style={{ marginTop: 8, fontSize: 14 }} ariaLabel={`${i + 1}번 학생 답`} />}
                  {textQ && q.type === "short" && <div style={{ fontSize: 12.5, color: C.sub, marginTop: 6 }}>정답 {String(q.answerText || "").split("|").join(" / ")}</div>}
                </div>
              );
            })}
          </div>
          {err && <p role="alert" style={{ color: C.bad, fontSize: 13.5, margin: "8px 0 0" }}>{err}</p>}
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
            <Btn onClick={save} disabled={busy}>{okCount}/{rows.length} 로 기록</Btn>
            <Btn kind="ghost" onClick={onClose}>닫기</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

function TakeScreen({ run, picked, togglePick, typed, setTyped, name, setName, onSubmit, onExit, toast, onPrint, user, onManualDone }) {
  const [confirm, setConfirm] = useState(false);
  const [manual, setManual] = useState(false);   // 결과 직접 입력 창(채점자 계정 확인 → 문항별 정오)
  const loggedIn = useMemo(() => !!(authGet() && authGet().token), []);   // 렌더마다 localStorage 를 읽지 않게
  const multi = run.questions.some((q) => (q.answers || []).length > 1);
  /* 인쇄: 출제자 미리 보기·선생님·관리자는 정답·해설 포함, 학생 응시는 정답표·해설 없는 문제지만 */
  const printFull = !!run.preview || (user && user.role !== "student");
  /* 제한 시간: 0.5초마다 남은 시간을 계산하고 0이 되면 한 번만 자동 제출 */
  const submitRef = useRef(onSubmit); submitRef.current = onSubmit;
  const limitSec = (run.timeLimit || 0) * 60;
  const calcLeft = () => Math.max(0, limitSec - Math.floor((Date.now() - run.startedAt) / 1000));
  const [left, setLeft] = useState(limitSec ? calcLeft() : null);
  useEffect(() => {
    if (!limitSec) return;
    let fired = false;
    const id = setInterval(() => { const l = calcLeft(); setLeft(l); if (l <= 0 && !fired) { fired = true; clearInterval(id); submitRef.current(); } }, 500);
    return () => clearInterval(id);
  }, [run]);
  const answered = run.questions.filter((q) => ((q.type || "mc") === "mc" ? (picked[q.id] || []).length : ((typed || {})[q.id] || "").trim())).length;
  const unanswered = run.questions.length - answered;

  const submit = () => (unanswered > 0 ? setConfirm(true) : onSubmit());

  return (
    <Shell back="나가기" backTo={onExit} toast={toast}>
      <h2 style={{ fontSize: 25, fontWeight: 800, margin: "0 0 6px" }}>{run.title}</h2>
      {run.desc && <p style={{ fontSize: 15, color: C.inkMid, lineHeight: 1.6, margin: "0 0 10px", whiteSpace: "pre-wrap" }}>{run.desc}</p>}
      <p style={{ fontSize: 14.5, color: C.sub, margin: "0 0 14px" }}>
        {run.owner ? `${run.owner} 출제 · ` : ""}{run.partial ? "틀린 문제만 다시 풉니다 · " : ""}문제 {run.questions.length}개{run.timeLimit ? ` · 제한 ${run.timeLimit}분` : ""}{multi ? " · 정답이 여러 개인 문제가 있습니다" : ""}{run.preview ? " · 응시 기간 밖(출제자 미리 보기)" : ""}
        {onPrint && !run.partial && <> · <TextBtn onClick={() => onPrint({ title: run.title, desc: run.desc, subject: run.subject, code: run.code, level: run.level, options: run.options, questions: run.questions }, !printFull)} style={{ padding: "10px 0", margin: "-10px 0", minHeight: 0, fontSize: 14 }}>{printFull ? "인쇄·PDF" : "문제지 인쇄·PDF (정답 없음)"}</TextBtn></>}
        {loggedIn && onManualDone && !run.partial && !run.preview && <> · <TextBtn onClick={() => setManual(true)} style={{ padding: "10px 0", margin: "-10px 0", minHeight: 0, fontSize: 14 }}>결과 직접 입력</TextBtn></>}
      </p>
      {manual && <ManualResultModal run={run} onClose={() => setManual(false)} onDone={(r) => { setManual(false); onManualDone(r); }} />}

      <div style={{ position: "sticky", top: 0, zIndex: 10, background: C.bg, padding: "8px 0 12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, color: C.sub, marginBottom: 6 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {left != null && <Badge tone={left < 60 ? "bad" : left < 300 ? "warn" : "accent"}>⏱ {fmtClock(left)}</Badge>}
            <span>답한 문제</span>
          </span>
          <span style={{ fontWeight: 700, color: C.inkMid }}>
            {answered} / {run.questions.length}
          </span>
        </div>
        <ProgressBar value={answered} max={run.questions.length} />
      </div>

      {!run.partial && !loggedIn && (
        <Field value={name} onChange={(v) => setName(v)} placeholder="이름 (선택) — 출제자에게 결과가 전달됩니다" maxLength={20} style={{ marginBottom: 14, fontSize: 15 }} />
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {run.questions.map((q, qi) => {
          const mine = picked[q.id] || [];
          const prev = run.questions[qi - 1];
          return (
            <React.Fragment key={q.id}>
            {q.passage && (!prev || prev.passage !== q.passage) && <PassageBox text={q.passage} />}
            <Card style={{ padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><span style={{ fontSize: 14.5, fontWeight: 700, color: C.accent }}>{qi + 1}번</span><SrcPill src={q.src} /></div>
              <p style={{ fontSize: 16.5, lineHeight: 1.55, margin: "0 0 14px", whiteSpace: "pre-wrap" }}><M t={q.text} />{q.type && q.type !== "mc" && <span style={{ fontSize: 13, color: C.sub, fontWeight: 600 }}> · {QTYPE_KO[q.type]}</span>}</p>
              <Figure svg={q.svg} />
              {(q.type || "mc") !== "mc" && (
                <Field value={(typed || {})[q.id] || ""} onChange={(v) => setTyped((t) => ({ ...(t || {}), [q.id]: v }))} placeholder={q.type === "essay" ? "답을 문장으로 적어 주세요" : "답을 적어 주세요"} multiline={q.type === "essay"} rows={q.type === "essay" ? 5 : 2} maxLength={q.type === "essay" ? 2000 : 200} ariaLabel={`${qi + 1}번 답`} />
              )}
              {(q.type || "mc") === "mc" && <div style={{ display: "grid", gap: 7 }} role="group" aria-label={`${qi + 1}번 보기`}>
                {q.options.map((o, oi) => {
                  const on = mine.includes(oi);
                  return (
                    <CheckRow key={oi} on={on} onToggle={() => togglePick(q.id, oi)} padding="10px 12px" style={{ minHeight: 52, borderRadius: 14, boxSizing: "border-box" }}>
                      <span aria-hidden="true" style={{ width: 30, height: 30, flex: "0 0 30px", borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14.5, fontWeight: 800, border: `1.5px solid ${on ? C.accent : C.line}`, background: on ? C.accent : C.field, color: on ? C.onAccent : C.accent, transition: "background .15s" }}>{oi + 1}</span>
                      <span style={{ fontSize: 16, lineHeight: 1.45, color: on ? C.ink : C.inkMid, fontWeight: on ? 600 : 400, flex: 1 }}><M t={o} /></span>
                      {on && <span aria-hidden="true" style={{ color: C.accent, fontWeight: 800, fontSize: 16, flex: "0 0 auto" }}>✓</span>}
                    </CheckRow>
                  );
                })}
              </div>}
            </Card>
            </React.Fragment>
          );
        })}
      </div>
      <p style={{ fontSize: 14, color: unanswered ? C.bad : C.good, textAlign: "center", margin: "20px 0 10px" }}>
        {unanswered ? `아직 답을 고르지 않은 문제가 ${unanswered}개 있습니다.` : "모든 문제에 답했습니다."}
      </p>
      <Btn onClick={submit}>제출하고 채점 보기</Btn>

      <div className="em-jump" aria-label="화면 이동">
        <button className="em-btn" aria-label="맨 위로" title="맨 위로" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14.5 L12 9.5 L17 14.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        <button className="em-btn" aria-label="맨 아래로" title="맨 아래로" onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9.5 L12 14.5 L17 9.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      </div>
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
function ResultScreen({ run, result, onRetryWrong, onRetryAll, onHome, flash, toast, onMyResults, onStudy, loggedIn, resultId, canNote, onMakeNote, saveState, onResend }) {
  const [reported, setReported] = useState({});   // 문항 id → 신고함
  const report = async (qid) => {
    const pick = window.prompt("어떤 문제가 있나요? 번호를 적어 주세요.\n1 정답이 틀린 것 같아요\n2 문제나 보기에 오류가 있어요\n3 기타", "1");
    if (pick === null) return;
    const reason = { 1: "answer", 2: "broken", 3: "other" }[String(pick).trim()] || "other";
    const r = await remote().itemReport(run.code, qid, reason);
    if (!r.ok) return flash(errMsg(r));
    setReported((x) => ({ ...x, [qid]: true }));
    flash(r.dup ? "이미 신고한 문항입니다." : "신고했습니다. 출제자에게 알림이 갑니다.");
  };
  const [noteAsked, setNoteAsked] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [explOpen, setExplOpen] = useState({});
  const [allExpl, setAllExpl] = useState(false);
  const isOpen = (id) => (explOpen[id] !== undefined ? explOpen[id] : allExpl);
  const pendingN = result.rows.filter((r) => r.pending).length;   // 서술형: 선생님 채점 대기 — 오답도 점수 분모도 아니다
  const wrong = result.rows.filter((r) => !r.ok && !r.pending);
  const rows = showAll || wrong.length === 0 ? result.rows : wrong;
  const pct = result.total ? Math.round((result.score / result.total) * 100) : 0;
  const msg = !result.total ? "서술형만 있는 시험지입니다. 선생님이 채점하면 분석 리포트에서 볼 수 있어요." : pct === 100 ? "모두 맞혔습니다. 완벽해요!" : pct >= 80 ? "잘했어요. 조금만 더 다듬으면 만점입니다." : pct >= 50 ? "절반 이상 맞혔어요. 틀린 문제를 한 번 더 봐요." : "아직 익숙하지 않네요. 해설을 보고 다시 도전해요.";
  const saveFail = saveState && saveState !== "ok" && saveState !== "saving";
  const tone = !result.total ? C.sub : pct >= 80 ? C.good : pct >= 50 ? C.accent : C.warn;   // 점수 구간 색

  const copyResult = async () => {
    const text = `[${run.title}] ${result.score}/${result.total} (${pct}점)${pendingN ? ` · 채점 대기 ${pendingN}문항` : ""} · ${fmtSec(result.sec)}${run.partial ? " · 틀린 문제만" : ""}`;
    flash((await copyText(text)) ? "결과를 복사했습니다." : "복사가 안 돼요.");
  };

  return (
    <Shell toast={toast}>
      {saveFail && (
        <div role="alert" style={{ border: `1px solid ${C.bad}`, background: C.badSoft, color: C.ink, borderRadius: 14, padding: "12px 14px", marginBottom: 14, fontSize: 14.5, lineHeight: 1.55 }}>
          <div style={{ fontWeight: 800, color: C.bad, marginBottom: 4 }}>서버에 저장되지 않았습니다</div>
          <div style={{ color: C.inkMid, marginBottom: 10 }}>{saveState.msg}{saveState.error === "bad_token" ? " 다시 로그인하면 이 결과를 이어서 보냅니다." : " 이 화면을 벗어나지 말고 다시 보내 주세요."}</div>
          {onResend && saveState.error !== "bad_token" && <Btn kind="danger" onClick={onResend} style={{ width: "auto", padding: "9px 16px", fontSize: 14.5 }}>다시 보내기</Btn>}
        </div>
      )}
      {saveState === "saving" && <p role="status" style={{ fontSize: 13.5, color: C.sub, margin: "0 0 10px", textAlign: "center" }}>결과를 서버에 저장하는 중…</p>}
      <Card style={{ textAlign: "center", padding: 26, marginBottom: 22, borderTop: `5px solid ${tone}` }}>
        <div style={{ fontSize: 14.5, color: C.sub, marginBottom: 8 }}>
          {run.title}
          {run.partial ? " · 틀린 문제만" : ""}
        </div>
        <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1, color: tone }}>
          {result.score}
          <span style={{ color: C.sub, fontSize: 26, fontWeight: 700 }}> / {result.total}</span>
        </div>
        <div style={{ fontSize: 15.5, color: C.sub, marginTop: 8 }}>
          {pct}점 · 틀린 문제 {wrong.length}개{pendingN ? ` · 채점 대기 ${pendingN}문항` : ""} · {fmtSec(result.sec)}
        </div>
        <div style={{ marginTop: 12 }}>
          <ProgressBar value={result.score} max={result.total} />
        </div>
        <p style={{ fontSize: 15.5, fontWeight: 600, color: C.ink, margin: "14px 0 0", lineHeight: 1.6 }}>{msg}</p>
      </Card>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h3 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{showAll || wrong.length === 0 ? "전체 문제" : "틀린 문제"}</h3>
        <div style={{ display: "flex", gap: 2 }}>
          {rows.some((r) => r.q.explain) && <TextBtn tone="sub" onClick={() => { setAllExpl((v) => !v); setExplOpen({}); }}>{allExpl ? "해설 모두 닫기" : "해설 모두 보기"}</TextBtn>}
          {wrong.length > 0 && <TextBtn onClick={() => setShowAll((v) => !v)}>{showAll ? "틀린 것만 보기" : "전체 보기"}</TextBtn>}
        </div>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        {rows.map(({ q, mine, ok, typed: t, pending }, ri) => {
          const qi = result.rows.findIndex((r) => r.q.id === q.id);
          const textQ = q.type === "short" || q.type === "essay";
          const prevQ = ri > 0 ? rows[ri - 1].q : null;
          return (
            <React.Fragment key={q.id}>
            {q.passage && (!prevQ || prevQ.passage !== q.passage) && <PassageBox text={q.passage} />}
            <Card style={{ padding: 16, borderColor: ok ? C.line : C.badSoft }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 14.5, fontWeight: 700, color: C.accent }}>{qi + 1}번</span>
                <Badge tone={pending ? "warn" : ok ? "good" : "bad"}>{pending ? "채점 대기 (서술형)" : ok ? "정답" : "오답"}</Badge>
                {textQ && <Badge>{QTYPE_KO[q.type]}</Badge>}
                <SrcPill src={q.src} />
              </div>
              <p style={{ fontSize: 16.5, lineHeight: 1.55, margin: "0 0 14px", whiteSpace: "pre-wrap" }}><M t={q.text} /></p>
              <Figure svg={q.svg} />
              {textQ && (
                <div style={{ display: "grid", gap: 8, marginBottom: 6 }}>
                  <div style={{ padding: "10px 12px", border: `1px solid ${pending ? C.line : ok ? C.good : C.bad}`, background: pending ? C.field : ok ? C.goodSoft : C.badSoft, borderRadius: 10, fontSize: 15, whiteSpace: "pre-wrap" }}><span style={{ fontSize: 12.5, color: C.sub, display: "block" }}>내 답</span>{t || "(비어 있음)"}</div>
                  {q.type === "short" && <div style={{ padding: "10px 12px", border: `1px solid ${C.good}`, background: C.goodSoft, borderRadius: 10, fontSize: 15 }}><span style={{ fontSize: 12.5, color: C.sub, display: "block" }}>정답</span>{String(q.answerText || "").split("|").join(" / ")}</div>}
                  {q.type === "essay" && q.answerText && <div style={{ padding: "10px 12px", background: C.lineSoft, borderRadius: 10, fontSize: 14.5, whiteSpace: "pre-wrap" }}><span style={{ fontSize: 12.5, color: C.sub, display: "block" }}>모범 답안</span><M t={q.answerText} /></div>}
                </div>
              )}
              {!textQ && <div style={{ display: "grid", gap: 7 }}>
                {q.options.map((o, oi) => {
                  const isAns = q.answers.includes(oi);
                  const isMine = mine.includes(oi);
                  let bd = C.line, bg = C.field, tx = C.inkMid, tag = null;
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
                      <span aria-hidden="true" style={{ width: 26, height: 26, flex: "0 0 26px", borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13.5, fontWeight: 800, border: `1.5px solid ${isAns ? C.good : isMine ? C.bad : C.line}`, background: C.field, color: isAns ? C.good : isMine ? C.bad : C.accent }}>{oi + 1}</span>
                      <span style={{ fontSize: 15.5, color: tx, lineHeight: 1.45, flex: 1 }}><M t={o} /></span>
                      {tag}
                    </div>
                  );
                })}
              </div>}
              {!textQ && mine.length === 0 && <p style={{ fontSize: 13.5, color: C.bad, margin: "10px 0 0" }}>답을 고르지 않았습니다.</p>}
              {(q.explain && !isOpen(q.id) || loggedIn && run.code) && (
                <div style={{ marginTop: 10, display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {q.explain && !isOpen(q.id) && <TextBtn onClick={() => setExplOpen({ ...explOpen, [q.id]: true })} style={{ padding: 0, fontSize: 14 }}>해설 보기</TextBtn>}
                  {loggedIn && run.code && <TextBtn tone="sub" onClick={() => report(q.id)} disabled={!!reported[q.id]} style={{ padding: 0, fontSize: 13 }}>{reported[q.id] ? "신고함" : "문항 신고"}</TextBtn>}
                </div>
              )}
              {q.explain && isOpen(q.id) && (
                <div style={{ marginTop: 12, padding: "10px 12px", background: C.lineSoft, borderRadius: 10, fontSize: 14.5, lineHeight: 1.6, color: C.inkMid, whiteSpace: "pre-wrap" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 700, color: C.ink }}>해설</span>
                    <TextBtn tone="sub" onClick={() => setExplOpen({ ...explOpen, [q.id]: false })} style={{ padding: 0, fontSize: 13 }}>닫기</TextBtn>
                  </div>
                  <M t={q.explain} />
                </div>
              )}
            </Card>
            </React.Fragment>
          );
        })}
      </div>

      <div style={{ display: "grid", gap: 10, marginTop: 22 }}>
        {wrong.length > 0 ? <Btn onClick={() => onRetryWrong(wrong.map((r) => r.q.id))}>틀린 문제만 다시 풀기</Btn> : <Btn onClick={onHome}>홈으로</Btn>}
        <div style={{ display: "grid", gridTemplateColumns: loggedIn && onMyResults ? "1fr 1fr" : "1fr", gap: 10 }}>
          <Btn kind="soft" onClick={onRetryAll}>처음부터 다시</Btn>
          {loggedIn && onMyResults && <Btn kind="soft" onClick={onMyResults}>분석 리포트</Btn>}
        </div>
        {loggedIn && canNote && resultId && wrong.length > 0 && !run.partial && (
          <Btn kind="ghost" onClick={async () => { if (await onMakeNote(resultId)) setNoteAsked(true); }} disabled={noteAsked}>{noteAsked ? "오답노트 요청됨 · 완료되면 알림" : "이 결과로 오답노트 만들기"}</Btn>
        )}
        <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "0 18px", marginTop: 4 }}>
          {loggedIn && onStudy && <TextBtn tone="sub" onClick={onStudy}>오답노트 보기</TextBtn>}
          <TextBtn tone="sub" onClick={copyResult}>결과 복사</TextBtn>
          {wrong.length > 0 && <TextBtn tone="sub" onClick={onHome}>홈으로</TextBtn>}
        </div>
      </div>
    </Shell>
  );
}

/* ── 앱 ──────────────────────────────────────── */
/* ── 화면: 오답노트(학습 도우미) ─────────────────
   사진을 서버(드라이브)에 올리면 PC 의 워커(Claude 예약 작업)가 가져가 분석하고 결과를 다시 올린다.
   연결 코드는 PC 의 study-helper\sync.json 에 있는 값. 이 브라우저에 저장된다. */
const SH_STATUS = { uploaded: ["대기 중", "neutral"], extracting: ["처리 중", "accent"], in_progress: ["처리 중", "accent"], needs_confirm: ["확인 필요", "warn"], done: ["완료", "good"] };
/* 사진을 긴 변 1600px JPEG(base64)로 줄인다 — 업로드 크기·워커 읽기 부담을 줄임 */
async function shrinkImage(file, max = 1600) {
  let bmp = null;
  try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { bmp = null; }
  const src = bmp || (await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); }));
  const w = src.width, h = src.height, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85).split(",")[1] || "";
}
const fileToBase64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(file); });

function StudyScreen({ onBack, flash, toast, user }) {
  const allowed = !!user && (user.role === "admin" || !!user.shOn);   // 관리자가 계정에 준 오답노트 권한
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [wsName, setWsName] = useState("");
  const [files, setFiles] = useState([]);
  const fileUrls = useObjectUrls(files);
  const [progress, setProgress] = useState("");
  const [detail, setDetail] = useState(null);      // 상세 화면 데이터
  const [answers, setAnswers] = useState({});
  const [noteHtml, setNoteHtml] = useState(null);  // 오답노트 HTML(iframe)
  const fileRef = useRef(null);
  const r = remote();

  const load = async () => {
    if (!allowed) return;
    setBusy(true);
    const res = await r.shList();
    setBusy(false);
    if (!res.ok) { flash(ERR[res.error] || "목록을 불러오지 못했습니다."); setList([]); return; }
    setList(res.worksheets);
  };
  useEffect(() => { load(); }, []);


  const upload = async () => {
    const name = wsName.trim();
    if (!name) return flash("문제지 이름을 넣어 주세요.");
    if (!files.length) return flash("사진을 골라 주세요.");
    setBusy(true);
    let done = 0;
    for (const f of files) {
      setProgress(`${done + 1}/${files.length} 올리는 중…`);
      const data = await shrinkImage(f, 2200).catch(() => fileToBase64(f));   // 긴 변 2200px JPEG 로 줄여 전송(서버 한도·워커 읽기 부담)
      const res = await r.shUpload({ worksheet: name, filename: f.name, mime: "image/jpeg", data });
      if (!res.ok) { setBusy(false); setProgress(""); return flash(errMsg(res, { too_big: "사진이 너무 큽니다(9MB 이하)." })); }
      done++;
    }
    setBusy(false); setProgress("");
    setFiles([]); setWsName(""); if (fileRef.current) fileRef.current.value = "";
    flash(`사진 ${done}장을 올렸습니다. PC가 켜져 있으면 10분 안에 처리됩니다.`);
    load();
  };

  const openDetail = async (name) => {
    setBusy(true);
    const res = await r.shDetail(name);
    setBusy(false);
    if (!res.ok) return flash(ERR[res.error] || "상세를 불러오지 못했습니다.");
    setAnswers({}); setNoteHtml(null); setDetail(res);
  };
  const openNote = async () => {
    setBusy(true);
    const res = await r.shNote(detail.name);
    setBusy(false);
    if (!res.ok) return flash(res.error === "no_note" ? "아직 오답노트가 만들어지지 않았습니다." : "오답노트를 불러오지 못했습니다.");
    setNoteHtml(res.html);
  };
  const saveConfirm = async () => {
    const filled = Object.fromEntries(Object.entries(answers).filter(([, v]) => v && v.trim()));
    if (!Object.keys(filled).length) return flash("적은 답이 없습니다.");
    setBusy(true);
    const res = await r.shConfirm({ worksheet: detail.name, answers: filled });
    setBusy(false);
    if (!res.ok) return flash("저장하지 못했습니다.");
    flash(`답 ${res.saved}개를 저장했습니다. 다음 자동 처리 때 반영됩니다.`);
    openDetail(detail.name);
  };

  const statusBadge = (s) => { const [t, tone] = SH_STATUS[s] || [s || "대기 중", "neutral"]; return <Badge tone={tone}>{t}</Badge>; };

  /* 문제지 목록 (목록 화면과 PC 상세 화면의 왼쪽 열에서 같이 쓴다) */
  const listEl = (
    <>
      {list === null && <p style={{ color: C.sub, fontSize: 14 }}>불러오는 중…</p>}
      {list && list.length === 0 && <p style={{ color: C.sub, fontSize: 14 }}>아직 올린 문제지가 없습니다.</p>}
      {(list || []).map((w) => {
        const active = !!detail && detail.name === w.name;
        return (
          <button key={w.name} className="em-btn em-row" onClick={() => openDetail(w.name)} aria-current={active ? "true" : undefined}
            style={{ display: "block", width: "100%", textAlign: "left", background: active ? C.accentSoft : C.card, border: `1px solid ${active ? C.accent : C.line}`, borderRadius: 14, padding: "14px 16px", marginBottom: 10, cursor: "pointer", fontFamily: FONT, boxShadow: C.shadow }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: C.ink }}>{w.name}</span>{statusBadge(w.status)}{w.pending > 0 && <Badge tone="warn">확인 질문 {w.pending}</Badge>}
            </div>
            <div style={{ fontSize: 13.5, color: C.sub, marginTop: 4 }}>
              사진 {w.photos}장{w.summary ? ` · ${w.summary.questions}문항 · 틀림 ${w.summary.wrong} · 의심 ${w.summary.suspect}` : ""}{w.hasNote ? " · 오답노트 있음" : ""}
            </div>
          </button>
        );
      })}
    </>
  );

  /* 권한 없음 */
  if (!allowed)
    return (
      <Shell back="홈으로" backTo={onBack} toast={toast}>
        <h2 style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 8px" }}>오답노트</h2>
        <Card>
          <p style={{ fontSize: 15, color: C.inkMid, lineHeight: 1.6, margin: 0 }}>이 계정은 아직 오답노트를 쓸 수 없습니다. 관리자에게 문의하세요.</p>
        </Card>
      </Shell>
    );

  /* 오답노트 보기 */
  if (detail && noteHtml !== null)
    return (
      <Shell back={detail.name} backTo={() => setNoteHtml(null)} toast={toast}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <Btn kind="soft" onClick={() => openHtmlWindow(noteHtml, flash)}>새 창에서 열기(인쇄·PDF)</Btn>
        </div>
        <iframe title="오답노트" srcDoc={noteHtml} sandbox="allow-popups" style={{ width: "100%", height: "78vh", border: `1px solid ${C.line}`, borderRadius: 12, background: "#fff" }} />
      </Shell>
    );

  /* 상세 */
  if (detail) {
    const pending = (detail.confirm || []).filter((c) => !c.answer);
    const answered = (detail.confirm || []).filter((c) => c.answer);
    return (
      <Shell back="오답노트 목록" backTo={() => setDetail(null)} toast={toast} wide>
       <div className="em-split">
        <aside className="em-split-side" aria-label="문제지 목록">
          <h3 style={{ fontSize: 15, fontWeight: 700, margin: "6px 0 10px", color: C.inkMid }}>문제지 목록</h3>
          {listEl}
        </aside>
        <div style={{ minWidth: 0 }}>
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
            <div className="em-tbl-wrap"><table className="em-tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead><tr>{["번호", "정답", "내 답", "결과", "검증"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
              <tbody>{detail.questions.map((q) => (
                <tr key={q.no}>
                  <td style={{ padding: "6px 8px" }}>{q.no}</td><td style={{ padding: "6px 8px" }}>{q.answer}</td><td style={{ padding: "6px 8px" }}>{q.mine || "?"}</td>
                  <td style={{ padding: "6px 8px", color: q.mine && q.mine !== q.answer ? C.bad : C.ink, fontWeight: q.mine && q.mine !== q.answer ? 700 : 400 }}>{q.mine ? (q.mine === q.answer ? "정답" : "오답") : "-"}</td>
                  <td style={{ padding: "6px 8px" }}>{q.verify === "ok" ? "일치" : q.verify === "suspect" ? "⚠ 의심" : "-"}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Card>
        )}
        </div>
       </div>
      </Shell>
    );
  }

  /* 목록 + 업로드 */
  return (
    <Shell back="홈으로" backTo={onBack} toast={toast}>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 8px" }}>오답노트</h2>
      <p style={{ fontSize: 14.5, color: C.sub, lineHeight: 1.6, margin: "0 0 14px" }}>사진을 올리면 PC가 켜져 있을 때 10분 안에 정답·해설·오답노트가 만들어집니다.</p>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 14, color: C.sub, marginBottom: 6 }}>문제지 이름 (예: 통합과학_2학기_2차)</div>
        <Field value={wsName} onChange={setWsName} placeholder="과목_학기_회차" ariaLabel="문제지 이름" />
        <div style={{ fontSize: 14, color: C.sub, margin: "12px 0 6px" }}>사진 (여러 장, 페이지 순서대로)</div>
        <FilePick inputRef={fileRef} count={files.length} onFiles={setFiles} />
        {files.length > 0 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>{files.map((f, i) => <img key={i} src={fileUrls[i]} alt={f.name} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}` }} />)}</div>}
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
          <Btn onClick={upload} disabled={busy}>{progress || "올리기"}</Btn>
        </div>
      </Card>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "0 0 8px" }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: C.inkMid }}>문제지 목록</h3>
        <TextBtn onClick={load} disabled={busy}>새로고침</TextBtn>
      </div>
      {listEl}
    </Shell>
  );
}

/* ── 계정: 로그인·역할별 화면 ─────────────────────
   토큰은 이 브라우저에 저장(localStorage). 서버가 역할(admin/teacher/student)을 판정한다. */
const authGet = () => { try { return JSON.parse(localStorage.getItem(LS_PREFIX + "auth") || "null"); } catch (e) { return null; } };
const authSet = (a) => { try { a ? localStorage.setItem(LS_PREFIX + "auth", JSON.stringify(a)) : localStorage.removeItem(LS_PREFIX + "auth"); } catch (e) {} idbPut("auth", a && a.token ? { api: syncUrl(), token: a.token } : null); };
/* 서비스 워커(sw.js)와 같은 IndexedDB "exam-maker" / store "kv" */
function idbPut(key, val) {
  try {
    if (typeof indexedDB === "undefined") return;
    const req = indexedDB.open("exam-maker", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => { try { const tx = req.result.transaction("kv", "readwrite"); val == null ? tx.objectStore("kv").delete(key) : tx.objectStore("kv").put(val, key); } catch (e) {} };
  } catch (e) {}
}
/* ── 웹 푸시: 이 기기로 알림 받기 ── */
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const b64uToU8 = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return isIOS() && !isStandalone() ? "ios-home" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  try { const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && (await reg.pushManager.getSubscription()); return sub ? "on" : "off"; } catch (e) { return "off"; }
}
async function pushEnable() {
  const st = await pushState();
  if (st === "ios-home" || st === "unsupported" || st === "denied") return { ok: false, state: st };
  const k = await remote().pushKey();
  if (!k.ok) return { ok: false, msg: errMsg(k) };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, state: "denied" };
  const reg = await navigator.serviceWorker.register("sw.js");
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToU8(k.key) });
  const a = authGet(); idbPut("auth", a && a.token ? { api: syncUrl(), token: a.token } : null);
  const r = await remote().pushSubscribe(sub.toJSON());
  return r.ok ? { ok: true } : { ok: false, msg: errMsg(r) };
}
async function pushDisable() {
  try { const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && (await reg.pushManager.getSubscription()); if (sub) { await remote().pushUnsubscribe(sub.endpoint); await sub.unsubscribe(); } } catch (e) {}
}
const PUSH_MSG = { "ios-home": "아이폰·아이패드는 Safari 의 공유 → \"홈 화면에 추가\"로 앱을 깔고, 그 아이콘으로 연 뒤에 알림을 켤 수 있습니다.", unsupported: "이 브라우저는 알림을 지원하지 않습니다. 크롬·엣지·삼성 인터넷이나 홈 화면 앱에서 켜 주세요.", denied: "알림이 차단돼 있습니다. 브라우저 주소창의 자물쇠(사이트 설정)에서 알림을 허용한 뒤 다시 눌러 주세요." };
const ROLE_KO = { admin: "관리자", teacher: "선생님", student: "학생" };
/* 계정 권한: 관리자는 전부, 그 외는 서버가 준 perms */
const PERM_KO = { custom: "맞춤 설정(범위·프롬프트)", gen: "문제 생성", solve: "문제 풀기", share: "문제 공유", rename: "이름·아이디·비밀번호 변경", genPlus: "확장 생성(사진 30장·문제 100개)", adminLite: "제한 관리자(열람)", liteResults: "제한: 결과 수정·삭제", liteAssign: "제한: 배정", liteUsers: "제한: 학생·선생님 계정", liteCopy: "제한: 시험지 복제", liteNotify: "제한: 개인 알림" };
/* 제한 관리자 세부 권한: adminLite 가 켜져 있을 때만 의미 있음(관리자는 전부) */
const LITE_KEYS = ["liteResults", "liteAssign", "liteUsers", "liteCopy", "liteNotify"];
const PERM_KEYS = Object.keys(PERM_KO);
const BASE_KEYS = PERM_KEYS.filter((k) => !LITE_KEYS.includes(k));   // 잠김 개수 셀 때 쓰는 일반 기능 권한
const can = (u, k) => !!u && (u.role === "admin" || !!((u.perms || {})[k]));
const isLite = (u) => !!u && (u.role === "admin" || !!((u.perms || {}).adminLite));
/* 출제 한도(서버 genLimits 와 같은 규칙) */
const genLimitsOf = (u) => (u && (u.role === "admin" || (u.perms || {}).genPlus) ? { count: 100, photos: 30 } : { count: 50, photos: 10 });
const isLiteCan = (u, k) => !!u && (u.role === "admin" || (!!((u.perms || {}).adminLite) && !!((u.perms || {})[k])));
function PermPicker({ value, onChange, hideLite }) {
  const v = value || {};
  const pill = (k, on, disabled) => <button key={k} type="button" className="em-btn" aria-pressed={on} disabled={disabled} onClick={() => onChange({ ...v, [k]: !on })} style={{ fontFamily: FONT, fontSize: 13, fontWeight: 600, padding: "6px 10px", borderRadius: 999, cursor: disabled ? "default" : "pointer", border: `1.5px solid ${on ? C.accent : C.line}`, background: on ? C.accentSoft : C.field, color: on ? C.accent : C.sub, opacity: disabled ? 0.45 : 1 }}>{on ? "✓ " : ""}{PERM_KO[k]}</button>;
  return (
    <div style={{ display: "grid", gap: 6 }} role="group" aria-label="권한">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{BASE_KEYS.filter((k) => !(hideLite && k === "adminLite")).map((k) => pill(k, !!v[k], false))}</div>
      {!hideLite && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 14, borderLeft: `2px solid ${C.line}` }} aria-label="제한 관리자 세부 권한">
          {LITE_KEYS.map((k) => pill(k, !!v.adminLite && !!v[k], !v.adminLite))}
        </div>
      )}
    </div>
  );
}
const PERMS_ALL = { custom: true, gen: true, solve: true, share: true, rename: true, genPlus: false, adminLite: false, liteResults: false, liteAssign: false, liteUsers: false, liteCopy: false, liteNotify: false };

function LoginScreen({ needSetup, onDone, toast, flash }) {
  const [mode, setMode] = useState("login");   // login | signup
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup" && !needSetup;
  const go = async () => {
    if (!id.trim() || !pw) return flash("아이디와 비밀번호를 넣어 주세요.");
    if (signup && pw.length < 4) return flash(ERR.weak_pw);
    if (signup && pw !== pw2) return flash("비밀번호 확인이 다릅니다.");
    if (signup && !name.trim()) return flash("이름을 넣어 주세요.");
    setBusy(true);
    const r = needSetup ? await remote().setup({ id: id.trim(), pw, name: name.trim() || id.trim() })
      : signup ? await remote().signup({ id: id.trim(), pw, name: name.trim() })
      : await remote().login({ id: id.trim(), pw });
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    authSet({ token: r.token, user: r.user });
    onDone(r.user);
  };
  return (
    <Shell toast={toast}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "26px 0 10px" }}>
        <AppMark size={56} />
        <div>
          <h1 style={{ fontSize: 30, fontWeight: 800, letterSpacing: "-0.02em", margin: 0, lineHeight: 1.15 }}>시험지</h1>
          <div style={{ fontSize: 14, color: C.sub, marginTop: 2 }}>문제 만들기 · 풀기 · 바로 채점</div>
        </div>
      </div>
      <p style={{ fontSize: 15.5, color: C.sub, lineHeight: 1.6, margin: "0 0 20px" }}>
        {needSetup ? "처음 실행입니다. 관리자 계정을 만들어 주세요. 이 계정으로 선생님·학생 계정을 등록합니다." : signup ? "회원가입 뒤 바로 문제를 풀 수 있습니다. 문제 만들기·공유 같은 기능은 관리자가 권한을 열어 주면 쓸 수 있습니다(내 계정에서 요청)." : "아이디와 비밀번호로 들어갑니다. 계정이 없으면 회원가입하세요."}
      </p>
      <Card>
        <div style={{ display: "grid", gap: 10 }}>
          {(needSetup || signup) && <Field value={name} onChange={setName} placeholder="이름 (표시용)" ariaLabel="이름" autoFocus />}
          <Field value={id} onChange={setId} placeholder="아이디 (한글·영문·숫자 2~30자)" ariaLabel="아이디" autoFocus={!signup && !needSetup} />
          <Field type="password" value={pw} onChange={setPw} placeholder={signup ? "비밀번호 (4자 이상)" : "비밀번호"} onEnter={signup ? undefined : go} ariaLabel="비밀번호" />
          {signup && <Field type="password" value={pw2} onChange={setPw2} placeholder="비밀번호 확인" onEnter={go} ariaLabel="비밀번호 확인" />}
          <Btn onClick={go} disabled={busy}>{busy ? "확인 중…" : needSetup ? "관리자 계정 만들기" : signup ? "회원가입" : "들어가기"}</Btn>
          {!needSetup && <Btn kind="ghost" onClick={() => { setMode(signup ? "login" : "signup"); setPw2(""); }}>{signup ? "이미 계정이 있어요 · 로그인" : "회원가입"}</Btn>}
        </div>
      </Card>
      {!needSetup && !signup && (
        <ul style={{ listStyle: "none", padding: 0, margin: "22px 4px 0", display: "grid", gap: 10 }}>
          {[["선생님이 준 5자리 코드로 바로 풀기", "play"], ["제출하면 바로 채점하고 해설 보기", "note"], ["틀린 문제와 분석 리포트로 복습", "chart"]].map(([t, i]) => (
            <li key={t} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14.5, color: C.inkMid }}>
              <span className="em-ico" style={{ width: 22, height: 22, color: C.accent, display: "inline-flex", flex: "0 0 22px" }}><NavIcon name={i} /></span>{t}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function PushCard({ flash }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setSt); }, []);
  if (remote().kind !== "server" || st === null) return null;
  const on = st === "on";
  const toggle = async () => {
    setBusy(true);
    try {
      if (on) { await pushDisable(); setSt("off"); flash("이 기기의 알림을 껐습니다."); return; }
      const r = await pushEnable();
      if (r.ok) { setSt("on"); flash("이 기기로 알림을 받습니다. 배정·마감·결과 알림이 휴대폰·컴퓨터 알림으로 옵니다."); }
      else { if (r.state) setSt(r.state); flash(r.msg || PUSH_MSG[r.state] || "알림을 켜지 못했습니다."); }
    } finally { setBusy(false); }
  };
  return (
    <div style={{ background: C.field, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 14px", margin: "4px 0 12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 14.5, fontWeight: 700 }}>이 기기로 알림 받기</span>
          <span style={{ display: "block", fontSize: 12.5, color: C.sub, lineHeight: 1.45 }}>{on ? "켜져 있음 · 앱을 닫아도 알림이 옵니다" : PUSH_MSG[st] || "배정·마감·결과 알림을 휴대폰·컴퓨터 알림으로 받습니다"}</span>
        </span>
        {st !== "unsupported" && st !== "ios-home" && <Btn kind={on ? "ghost" : "soft"} onClick={toggle} disabled={busy} style={{ width: "auto", padding: "9px 14px", fontSize: 14, flexShrink: 0 }}>{busy ? "…" : on ? "끄기" : "켜기"}</Btn>}
      </div>
    </div>
  );
}
function AccountModal({ user, onClose, onLogout, flash, onUser }) {
  const [theme, setTheme] = useState(themeGet);
  const [subj, setSubj] = useState((user.subjects || []).join(", "));
  const [sch, setSch] = useState(schoolGet);
  const [schMsg, setSchMsg] = useState("");
  const saveSchool = async () => {
    const v = { school: String(sch.school || "").trim() || SCHOOL_DEFAULT.school, grade: Number(sch.grade) || 1, year: Number(sch.year) || SCHOOL_DEFAULT.year };
    schoolSet(v); setSch(v);
    if (remote().kind !== "server") return flash("저장했습니다.");
    const r = await remote().schoolLookup({ school: v.school, year: v.year, grade: v.grade });
    if (!r.ok) return flash(errMsg(r));
    setSchMsg(r.found ? `교과서 ${r.items.length}과목 있음` : "교과서 목록을 찾는 중 — 찾으면 알림이 옵니다 (서버가 켜져 있을 때)");
    flash(r.found ? `저장했습니다. 교과서 ${r.items.length}과목이 등록되어 있습니다.` : "저장했습니다. 이 학교의 교과서 목록을 찾아 두겠습니다.");
  };
  const [subjBusy, setSubjBusy] = useState(false);
  const saveSubj = async () => {
    setSubjBusy(true);
    const r = await remote().profileUpdate({ subjects: splitTags(subj).slice(0, 10) });
    setSubjBusy(false);
    if (!r.ok) return flash(errMsg(r));
    if (onUser && r.user) onUser(r.user);
    flash("수강 과목을 저장했습니다.");
  };
  const [pname, setPname] = useState(user.name || "");
  const [pid, setPid] = useState(user.id || "");
  const [pscope, setPscope] = useState(user.scope || "");
  const [pprompt, setPprompt] = useState(user.prompt || "");
  const [pproof, setPproof] = useState(!!(user.prefs || {}).proof);   // 서술형 증명·설명 문제(기본 끔)
  const [reqMsg, setReqMsg] = useState("");
  const [reqSel, setReqSel] = useState({});
  const [pBusy, setPBusy] = useState(false);
  const locked = BASE_KEYS.filter((k) => k !== "adminLite" && !can(user, k)).concat(user.role === "admin" ? [] : [!user.shOn ? "shOn" : null, !user.repOn ? "repOn" : null].filter(Boolean));
  const lockKo = { ...PERM_KO, shOn: "오답노트", repOn: "분석 리포트" };
  const saveProfile = async () => {
    const body = {};
    if (pname.trim() && pname.trim() !== user.name) body.name = pname.trim();
    if (pid.trim() && pid.trim() !== user.id) body.newId = pid.trim();
    if (!Object.keys(body).length) return flash("바뀐 내용이 없습니다.");
    if (body.newId && !confirm(`아이디를 "${body.newId}"(으)로 바꿀까요? 기록·시험지·배정이 모두 새 아이디로 옮겨집니다.`)) return;
    setPBusy(true);
    const r = await remote().profileUpdate(body);
    setPBusy(false);
    if (!r.ok) return flash(errMsg(r));
    if (onUser && r.user) onUser(r.user);
    flash("저장했습니다." + (body.newId ? ` 아이디가 ${r.user.id}(으)로 바뀌었습니다.` : ""));
  };
  const saveCustom = async () => {
    setPBusy(true);
    const r = await remote().profileUpdate({ scope: pscope, prompt: pprompt, proof: pproof });
    setPBusy(false);
    if (!r.ok) return flash(errMsg(r));
    if (onUser && r.user) onUser(r.user);
    flash("맞춤 설정을 저장했습니다. AI 문제 만들기에 반영됩니다.");
  };
  const sendReq = async () => {
    const perms = Object.keys(reqSel).filter((k) => reqSel[k]);
    if (!perms.length && !reqMsg.trim()) return flash("요청할 권한을 고르거나 한 줄을 적어 주세요.");
    setPBusy(true);
    const r = await remote().permRequest({ perms, message: reqMsg.trim() });
    setPBusy(false);
    if (!r.ok) return flash(errMsg(r));
    setReqMsg(""); setReqSel({});
    flash("관리자에게 요청을 보냈습니다. 하루에 한 번만 보낼 수 있습니다.");
  };
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
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "0 0 14px" }}>
        <Avatar size={52} />
        <p style={{ fontSize: 15, margin: 0, lineHeight: 1.5 }}><b>{user.name}</b> <Badge tone="accent">{ROLE_KO[user.role] || user.role}</Badge><br /><span style={{ color: C.sub, fontSize: 13.5 }}>{user.id}</span></p>
      </div>
      <div style={{ fontSize: 13.5, color: C.sub, margin: "4px 0 6px" }}>학교 · 학년 · 학년도 <span style={{ fontSize: 12 }}>(AI 문제의 교과서 자동 선택에 쓰임)</span></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 72px 84px auto", gap: 6, marginBottom: schMsg ? 4 : 12 }}>
        <Field value={sch.school} onChange={(v) => setSch({ ...sch, school: v })} placeholder="학교 (예: 상현고)" ariaLabel="학교" maxLength={40} style={{ fontSize: 14.5 }} onEnter={saveSchool} />
        <select value={sch.grade} onChange={(e) => setSch({ ...sch, grade: Number(e.target.value) })} className="em-in" aria-label="학년" style={{ fontFamily: FONT, fontSize: 14.5, color: C.ink, background: C.field, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 8px" }}>{[1, 2, 3].map((g) => <option key={g} value={g}>{g}학년</option>)}</select>
        <input type="number" min="2020" max="2040" value={sch.year} onChange={(e) => setSch({ ...sch, year: Number(e.target.value) || SCHOOL_DEFAULT.year })} className="em-in" aria-label="학년도" style={{ fontFamily: FONT, fontSize: 14.5, color: C.ink, background: C.field, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 8px", width: "100%", boxSizing: "border-box" }} />
        <Btn kind="soft" onClick={saveSchool} style={{ width: "auto", padding: "10px 14px", fontSize: 14, whiteSpace: "nowrap", flexShrink: 0 }}>저장</Btn>
      </div>
      {schMsg && <div style={{ fontSize: 12.5, color: C.sub, marginBottom: 12 }}>{schMsg}</div>}
      {remote().kind === "server" && (
        <>
          <div style={{ fontSize: 13.5, color: C.sub, margin: "4px 0 6px" }}>수강 과목 <span style={{ fontSize: 12 }}>(쉼표로 구분)</span></div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <Field value={subj} onChange={setSubj} placeholder="예: 통합과학, 수학" ariaLabel="수강 과목" maxLength={200} style={{ fontSize: 14.5 }} onEnter={saveSubj} />
            <Btn kind="soft" onClick={saveSubj} disabled={subjBusy} style={{ width: "auto", padding: "10px 14px", fontSize: 14, whiteSpace: "nowrap", flexShrink: 0 }}>저장</Btn>
          </div>
        </>
      )}
      {remote().kind === "server" && (
        <>
          <div style={{ fontSize: 13.5, color: C.sub, margin: "4px 0 6px" }}>이름 · 아이디{can(user, "rename") ? "" : " (변경 권한 없음)"}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 6, marginBottom: 12 }}>
            <Field value={pname} onChange={setPname} placeholder="이름" ariaLabel="이름" maxLength={20} style={{ fontSize: 14.5 }} />
            <Field value={pid} onChange={setPid} placeholder="아이디" ariaLabel="아이디" maxLength={30} style={{ fontSize: 14.5 }} />
            <Btn kind="soft" onClick={saveProfile} disabled={pBusy || !can(user, "rename")} style={{ width: "auto", padding: "10px 14px", fontSize: 14, whiteSpace: "nowrap", flexShrink: 0 }}>저장</Btn>
          </div>
          <PushCard flash={flash} />
          <div style={{ fontSize: 13.5, color: C.sub, margin: "4px 0 6px" }}>학습 범위 · 개인 맞춤 지시{can(user, "custom") ? "" : " (권한 없음)"} <span style={{ fontSize: 12 }}>(AI 문제 만들기에 자동으로 반영)</span></div>
          <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
            <Field value={pscope} onChange={setPscope} placeholder="범위 예: 고1 통합과학 2단원, 한국사 1-1" ariaLabel="학습 범위" maxLength={200} style={{ fontSize: 14.5 }} />
            <Field value={pprompt} onChange={setPprompt} placeholder="맞춤 지시 예: 해설은 쉬운 말로 길게, 계산 문제는 풀이 과정까지, 영어 지시문은 한국어로" ariaLabel="개인 맞춤 지시" multiline rows={3} maxLength={1000} style={{ fontSize: 14 }} />
            <CheckRow on={pproof} onToggle={() => can(user, "custom") && setPproof(!pproof)} padding="10px 12px"><span style={{ fontSize: 14.5, lineHeight: 1.45 }}>서술형에 "증명하시오·설명하시오" 문제도 내기 <span style={{ color: C.sub, fontSize: 13 }}>(끄면 값·식·용어를 쓰는 서술형만)</span></span></CheckRow>
            <Btn kind="soft" onClick={saveCustom} disabled={pBusy || !can(user, "custom")} style={{ fontSize: 14 }}>맞춤 설정 저장</Btn>
          </div>
          {locked.length > 0 && (
            <>
              <div style={{ fontSize: 13.5, color: C.sub, margin: "4px 0 6px" }}>관리자에게 권한 요청 <span style={{ fontSize: 12 }}>(하루 1회, 관리자에게 알림이 갑니다)</span></div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                {locked.map((k) => <button key={k} type="button" className="em-btn" aria-pressed={!!reqSel[k]} onClick={() => setReqSel({ ...reqSel, [k]: !reqSel[k] })} style={{ fontFamily: FONT, fontSize: 13, fontWeight: 600, padding: "6px 10px", borderRadius: 999, cursor: "pointer", border: `1.5px solid ${reqSel[k] ? C.accent : C.line}`, background: reqSel[k] ? C.accentSoft : C.field, color: reqSel[k] ? C.accent : C.sub }}>{reqSel[k] ? "✓ " : "🔒 "}{lockKo[k]}</button>)}
              </div>
              <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
                <Field value={reqMsg} onChange={setReqMsg} placeholder="한 줄 메모 (선택) 예: 수행평가 문제를 만들어야 해요" ariaLabel="요청 메모" maxLength={200} style={{ fontSize: 14 }} onEnter={sendReq} />
                <Btn kind="soft" onClick={sendReq} disabled={pBusy} style={{ width: "auto", padding: "10px 14px", fontSize: 14 }}>요청</Btn>
              </div>
            </>
          )}
        </>
      )}
      <div style={{ fontSize: 13.5, color: C.sub, margin: "4px 0 6px" }}>화면 색</div>
      <div role="radiogroup" aria-label="화면 색" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, marginBottom: 14 }}>
        {[["auto", "기기 설정"], ["light", "밝게"], ["dark", "어둡게"]].map(([k, t]) => (
          <button key={k} role="radio" aria-checked={theme === k} className="em-btn" onClick={() => { themeSet(k); setTheme(k); }}
            style={{ fontFamily: FONT, fontSize: 14, fontWeight: 600, padding: "10px 6px", borderRadius: 999, border: `1px solid ${theme === k ? C.accent : C.line}`, background: theme === k ? C.accentSoft : C.field, color: theme === k ? C.accent : C.sub, cursor: "pointer" }}>{t}</button>
        ))}
      </div>
      <div style={{ fontSize: 13.5, color: C.sub, margin: "4px 0 6px" }}>비밀번호 변경{can(user, "rename") ? " (현재 비밀번호 확인 후)" : " (권한 없음 · 관리자에게 요청)"}</div>
      <div style={{ display: "grid", gap: 8 }}>
        <Field type="password" value={oldPw} onChange={setOldPw} placeholder="현재 비밀번호" ariaLabel="현재 비밀번호" />
        <Field type="password" value={newPw} onChange={setNewPw} placeholder="새 비밀번호 (4자 이상)" ariaLabel="새 비밀번호" onEnter={change} />
        <Btn kind="soft" onClick={change} disabled={busy}>비밀번호 변경</Btn>
        <Btn kind="ghost" onClick={onLogout}>로그아웃</Btn>
      </div>
    </Modal>
  );
}

const ACT_KO = { login: "로그인", setup: "관리자 생성", share: "시험지 공유", quiz_delete: "공유 코드 삭제", exam_delete: "시험지 삭제", submit: "응시 제출", results_clear: "응시 기록 비우기", result_update: "결과 수정", result_manual: "결과 직접 입력", result_delete: "결과 삭제", sh_upload: "오답노트 사진 올림", sh_confirm: "확인 질문 답", assign: "배정", unassign: "배정 해제", assign_update: "배정 조건 변경", remind: "미완료 독촉", job_create: "작업 요청(AI·사진·오답노트)", job_done: "작업 완료", job_error: "작업 실패", report_request: "리포트 요청", report_put: "리포트 생성", user_create: "계정 만들기", user_update: "계정 수정", user_delete: "계정 삭제", pw_change: "비밀번호 변경", profile: "프로필 수정", gen: "AI 기본 생성" };

/* 관리자: 응시 결과의 문항별 정오를 고친다(점수는 자동 계산). 문항별 기록이 없으면 점수만 고친다. */
function ResultEditModal({ item, onClose, onSaved, flash }) {
  const [quiz, setQuiz] = useState(null);
  const [rows, setRows] = useState(Array.isArray(item.detail) ? item.detail.map((d) => ({ ...d })) : null);
  const [score, setScore] = useState(String(item.score));
  const [busy, setBusy] = useState(false);
  useEffect(() => { (async () => { const r = await remote().getQuiz(item.code); setQuiz(r.ok ? r.quiz : {}); })(); }, []);
  const qOf = (id) => ((quiz && quiz.questions) || []).find((q) => q.id === id);
  const save = async () => {
    setBusy(true);
    const r = await remote().resultUpdate(rows ? { id: item.id, detail: rows } : { id: item.id, score: Math.max(0, Math.min(item.total, parseInt(score, 10) || 0)) });
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    onSaved({ ...item, score: r.score, detail: rows || item.detail });
    flash(`저장했습니다. ${r.score}/${r.total}`);
  };
  const okCount = rows ? rows.filter((d) => d.ok).length : null;
  const pendingN = rows ? rows.filter((d) => d.p).length : 0;
  /* v:2 기록은 고른 보기가 원본 번호. 섞기 시험지의 옛 기록(v 없음)은 표시 순서 번호라 보기 번호가 어긋날 수 있다 */
  const legacyShuffle = !!(quiz && quiz.shuffle && Number(item.v) !== 2 && rows && rows.some((d) => d.m && d.m.length));
  return (
    <Modal title={`결과 수정 · ${item.name}`} onClose={onClose} wide>
      <p style={{ fontSize: 13.5, color: C.sub, margin: "0 0 10px", lineHeight: 1.5 }}>{item.title || item.code} · {fmtDateTime(item.at)} · 지금 {item.score}/{item.total}{pendingN ? ` · 채점 대기 ${pendingN}문항` : ""}</p>
      {legacyShuffle && <p role="note" style={{ fontSize: 13, color: C.warn, background: C.warnSoft, border: `1px solid ${C.warnLine}`, borderRadius: 10, padding: "8px 10px", margin: "0 0 10px", lineHeight: 1.5 }}>섞기 시험지의 옛 기록은 보기 번호가 다를 수 있습니다. 고른 보기를 누르지 말고 배지로만 정오를 바꿔 주세요.</p>}
      {rows ? (
        <>
          <p style={{ fontSize: 14, margin: "0 0 8px" }}>문항을 눌러 정답/오답을 바꿉니다. 점수는 정답 수로 다시 계산됩니다. <b>{okCount}/{item.total}</b>{pendingN ? <span style={{ color: C.sub }}> · 서술형 {pendingN}문항은 배지를 눌러 채점</span> : null}</p>
          <div style={{ display: "grid", gap: 8, maxHeight: "55vh", overflowY: "auto" }}>
            {rows.map((d, i) => {
              const q = qOf(d.q);
              const textQ = q && (q.type === "short" || q.type === "essay");
              const opts = q && !textQ ? (Array.isArray(q.options) && q.options.length >= 2 ? q.options : (quiz.options || [])) : [];
              const answers = (q && q.answers) || [];
              const setRow = (patch) => setRows(rows.map((x, k) => (k === i ? { ...x, ...patch } : x)));
              /* 고른 보기를 바꾸면 정오는 정답과 비교해 자동으로 다시 정해진다(직접 토글도 가능). 채점 대기(p) 는 해제 */
              const pick = (oi) => { const m = (d.m || []).includes(oi) ? d.m.filter((x) => x !== oi) : [...(d.m || []), oi].sort((a, b) => a - b); setRow({ m, ok: m.length > 0 && sameSet(m, answers), p: undefined }); };
              return (
                <div key={d.q + i} style={{ border: `1px solid ${d.ok ? C.good : C.line}`, background: d.ok ? C.goodSoft : C.card, borderRadius: 12, padding: "10px 12px" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <button className="em-btn" onClick={() => setRow({ ok: !d.ok, p: undefined })} aria-pressed={!!d.ok} title="정답/오답 바꾸기" style={{ flex: "0 0 auto", border: "none", background: "none", padding: 0, cursor: "pointer", minHeight: 32 }}><Badge tone={d.p ? "warn" : d.ok ? "good" : "bad"}>{d.p ? "채점 대기" : d.ok ? "정답" : "오답"}</Badge></button>
                    <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.45 }}>{i + 1}. {q ? q.text : quiz === null ? "불러오는 중…" : "(시험지에서 문항을 찾지 못함)"}{textQ && <span style={{ color: C.sub, fontWeight: 400 }}> · {QTYPE_KO[q.type]}</span>}</div>
                  </div>
                  {opts.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }} role="group" aria-label={`${i + 1}번 고른 보기`}>
                      {opts.map((o, oi) => {
                        const on = (d.m || []).includes(oi), isAns = answers.includes(oi);
                        return (
                          <button key={oi} className="em-btn" onClick={() => pick(oi)} aria-pressed={on} title={isAns ? "정답 보기" : ""}
                            style={{ fontFamily: FONT, fontSize: 13.5, padding: "6px 10px", borderRadius: 999, cursor: "pointer", border: `1.5px solid ${on ? C.accent : isAns ? C.good : C.line}`, background: on ? C.accentSoft : C.field, color: on ? C.accent : C.ink, maxWidth: "100%", textAlign: "left" }}>
                            <span style={{ fontWeight: 800, marginRight: 4 }}>{mark(oi)}</span>{o}{isAns ? <span style={{ color: C.good, fontSize: 11.5, marginLeft: 4 }}>정답</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {textQ && (
                    <Field value={d.t || ""} onChange={(v) => setRow({ t: v })} placeholder={q.type === "short" ? "학생이 적은 답" : "학생이 적은 서술"} multiline={q.type === "essay"} rows={q.type === "essay" ? 3 : 1} maxLength={500} style={{ marginTop: 8, fontSize: 14 }} ariaLabel={`${i + 1}번 학생 답`} />
                  )}
                  <div style={{ fontSize: 12.5, color: C.sub, marginTop: 6 }}>
                    {textQ ? (q.type === "short" ? `정답 ${String(q.answerText || "").split("|").join(" / ")}` : "서술형 · 정답/오답 배지를 눌러 채점") : `고른 답 ${d.m && d.m.length ? d.m.map((k) => mark(k)).join("") : "없음"}${answers.length ? ` · 정답 ${answers.map((k) => mark(k)).join("")}` : ""} · 배지를 누르면 정오를 직접 바꿉니다`}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 14, margin: "0 0 8px", color: C.inkMid }}>문항별 기록이 없는 결과라 점수만 고칠 수 있습니다. (0 ~ {item.total})</p>
          <input type="number" min="0" max={item.total} value={score} onChange={(e) => setScore(e.target.value)} className="em-in" aria-label="점수" style={{ width: "100%", boxSizing: "border-box", fontFamily: FONT, fontSize: 16, color: C.ink, background: C.field, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 13px" }} />
        </>
      )}
      <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
        <Btn onClick={save} disabled={busy}>저장</Btn>
        <Btn kind="ghost" onClick={onClose}>닫기</Btn>
      </div>
    </Modal>
  );
}

/* 관리자: 학교 교과서 목록 보기·붙여넣기 저장. 한 줄에 "과목[탭]출판사[탭]저자" (학년은 위에서 고름) */
function TextbookAdmin({ flash }) {
  const sc0 = schoolGet();
  const [school, setSchool] = useState(sc0.school);
  const [year, setYear] = useState(sc0.year);
  const [grade, setGrade] = useState(1);
  const [text, setText] = useState("");
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); const r = await remote().textbookGet(school.trim(), year); setBusy(false); if (!r.ok) return flash(errMsg(r)); setItems(r.items || []); };
  useEffect(() => { load(); }, []);
  const parseLines = () => text.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const c = l.split(/\t| {2,}|\|/).map((x) => x.trim()).filter(Boolean); return c.length >= 2 ? { subject: c[0], publisher: c[1], author: c[2] || "", grade } : null; }).filter(Boolean);
  const add = async () => {
    const add = parseLines(); if (!add.length) return flash("한 줄에 '과목 탭 출판사 탭 저자' 형식으로 붙여 넣어 주세요.");
    const merged = [...(items || []).filter((x) => !add.some((a) => a.subject === x.subject && a.grade === x.grade)), ...add];
    setBusy(true); const r = await remote().textbookSet({ school: school.trim(), year, items: merged }); setBusy(false);
    if (!r.ok) return flash(errMsg(r)); setText(""); flash(`${r.count}과목을 저장했습니다.`); load();
  };
  const removeOne = async (i) => { const next = (items || []).filter((_, k) => k !== i); setBusy(true); const r = await remote().textbookSet({ school: school.trim(), year, items: next }); setBusy(false); if (!r.ok) return flash(errMsg(r)); load(); };
  const inStyle = { fontFamily: FONT, fontSize: 14.5, color: C.ink, background: C.field, border: `1px solid ${C.line}`, borderRadius: 12, padding: "10px 10px", width: "100%", boxSizing: "border-box" };
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 90px auto", gap: 6, marginBottom: 10 }}>
        <Field value={school} onChange={setSchool} placeholder="학교" ariaLabel="학교" maxLength={40} onEnter={load} />
        <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} className="em-in" aria-label="학년도" style={inStyle} />
        <Btn kind="soft" onClick={load} disabled={busy} style={{ width: "auto", padding: "10px 14px", fontSize: 14 }}>불러오기</Btn>
      </div>
      {items === null ? <p style={{ color: C.sub }}>불러오는 중…</p> : items.length === 0 ? <p style={{ color: C.sub, fontSize: 14 }}>등록된 교과서가 없습니다. 아래에 붙여 넣어 저장하세요. 학생이 계정 창에서 학교를 저장하면 워커가 자동으로 찾아 채우기도 합니다.</p> : (
        <Card style={{ padding: 8, marginBottom: 12 }}>
          <div className="em-tbl-wrap"><table className="em-tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead><tr>{["학년", "과목", "출판사", "저자", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
            <tbody>{items.map((t, i) => <tr key={i}><td style={{ padding: "5px 8px" }}>{t.grade || "-"}</td><td style={{ padding: "5px 8px" }}>{t.subject}</td><td style={{ padding: "5px 8px" }}>{t.publisher}</td><td style={{ padding: "5px 8px" }}>{t.author}</td><td style={{ padding: "5px 8px" }}><TextBtn tone="sub" onClick={() => removeOne(i)} style={{ fontSize: 13 }}>삭제</TextBtn></td></tr>)}</tbody>
          </table></div>
        </Card>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontSize: 13.5, color: C.sub }}>추가 (학년 선택 후 붙여넣기)</span>
        <select value={grade} onChange={(e) => setGrade(Number(e.target.value))} className="em-in" aria-label="학년" style={{ ...inStyle, width: "auto", padding: "6px 8px" }}>{[1, 2, 3].map((g) => <option key={g} value={g}>{g}학년</option>)}</select>
      </div>
      <Field multiline rows={5} value={text} onChange={setText} placeholder={"과목\t출판사\t저자  (한 줄에 하나, 탭이나 | 로 구분)\n통합과학1\t㈜미래엔\t오현선"} maxLength={5000} style={{ fontSize: 13.5 }} />
      <div style={{ marginTop: 8 }}><Btn onClick={add} disabled={busy}>붙여 넣은 목록 저장</Btn></div>
    </div>
  );
}

/* 관리자: 계정 관리 + 전체 기록 */
function AdminScreen({ onBack, toast, flash, lite, user, onOpenExam, onCopyExam }) {
  const liteCan = (k) => isLiteCan(user, k);   // 관리자는 전부 true, 제한 관리자는 세부 권한이 켜진 것만
  const [users, setUsers] = useState(null);
  const [assign, setAssign] = useState(null);   // 시험지 탭의 배정 창
  const [tab, setTab] = useState("users");
  const [form, setForm] = useState({ id: "", pw: "", name: "", role: "student", teacherId: "", subjects: "", shOn: false, repOn: false, perms: { ...PERMS_ALL } });
  const [allExams, setAllExams] = useState(null);
  const [bc, setBc] = useState({ title: "", body: "" });   // 전체 알림
  const [newOpen, setNewOpen] = useState(false);   // 계정 만들기 폼 펼침
  const [tempPw, setTempPw] = useState(null);   // { id, pw } — 서버가 응답에 한 번만 주는 임시 비밀번호. 어디에도 저장하지 않는다
  const loadExams = async () => { const r = await remote().examListAll(); if (!r.ok) return flash(errMsg(r)); setAllExams(r.exams); };
  const delExam = async (e) => { if (!confirm(`"${e.title || "제목 없음"}" (${e.ownerName || e.ownerId}) 시험지를 지울까요? 공유 코드와 응시 기록도 지워집니다.`)) return; const r = await remote().examDelete(e.id); if (!r.ok) return flash(errMsg(r)); setAllExams(allExams.filter((x) => x.id !== e.id)); };
  const sendAll = async () => { if (!bc.title.trim() && !bc.body.trim()) return flash("제목이나 내용을 적어 주세요."); if (!confirm("모든 계정에 알림을 보낼까요?")) return; const r = await remote().adminNotify({ all: true, title: bc.title.trim(), body: bc.body.trim() }); if (!r.ok) return flash(errMsg(r)); setBc({ title: "", body: "" }); flash(`${r.sent}명에게 보냈습니다.`); };
  const [msg, setMsg] = useState({ title: "", body: "" });   // 계정 수정 창의 알림
  const sendOne = async () => { if (!msg.title.trim() && !msg.body.trim()) return flash("제목이나 내용을 적어 주세요."); const r = await remote().adminNotify({ userId: edit.id, title: msg.title.trim(), body: msg.body.trim() }); if (!r.ok) return flash(errMsg(r)); setMsg({ title: "", body: "" }); flash("알림을 보냈습니다."); };
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
  const [resView, setResView] = useState("results");   // results | activity
  const [acts, setActs] = useState(null);
  const [actType, setActType] = useState("");
  const [actUser, setActUser] = useState("");
  const [editRes, setEditRes] = useState(null);
  const [actShow, setActShow] = useState(10);   // 모든 활동: 10건씩 더 보기
  const loadActs = async (t, uid) => { setActs(null); setActShow(10); const r = await remote().activityList({ limit: 300, type: t || "", userId: (uid || "").trim() }); if (!r.ok) return flash(errMsg(r)); setActs(r.items); };

  const create = async () => {
    if (!form.id.trim() || form.pw.length < 4) return flash("아이디와 4자 이상 비밀번호를 넣어 주세요.");
    setBusy(true);
    const body = { ...form, id: form.id.trim(), name: form.name.trim() };
    if (lite) { delete body.perms; if (body.role === "admin") body.role = "student"; }   // 제한 관리자: 학생·선생님만, 기능 권한은 서버 기본값
    const r = await remote().userCreate(body);
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    setForm({ id: "", pw: "", name: "", role: form.role, teacherId: form.teacherId, subjects: "", shOn: form.shOn, repOn: form.repOn, perms: form.perms });
    flash(`${r.user.name} (${ROLE_KO[r.user.role]}) 계정을 만들었습니다.`);
    if (r.tempPw) setTempPw({ id: r.user.id, pw: String(r.tempPw) });
    load();
  };
  const save = async () => {
    setBusy(true);
    const subjects = Array.isArray(edit.subjects) ? edit.subjects : splitTags(edit.subjects).slice(0, 10);
    const body = lite
      ? { id: edit.id, name: edit.name, teacherId: edit.role === "student" ? edit.teacherId : "", active: edit.active, shOn: !!edit.shOn, repOn: !!edit.repOn, subjects }   // 제한 관리자: 역할·권한·아이디·범위·지시는 못 바꿈
      : { id: edit.id, name: edit.name, role: edit.role, teacherId: edit.role === "student" ? edit.teacherId : "", active: edit.active, shOn: !!edit.shOn, repOn: !!edit.repOn, perms: edit.perms || PERMS_ALL, scope: edit.scope || "", prompt: edit.prompt || "", ...(edit.newId && edit.newId.trim() !== edit.id ? { newId: edit.newId.trim() } : {}), subjects };
    if (edit.pw) body.pw = edit.pw;
    const r = await remote().userUpdate(body);
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    if (r.tempPw) setTempPw({ id: edit.id, pw: String(r.tempPw) });
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
    if (!r.ok) return flash(errMsg(r, { bad_key: "연결 코드가 올바르지 않습니다." }));
    setWorkerKey(""); flash("리포트 워커 연결 코드를 등록했습니다.");
  };
  const teacherName = (id) => (users || []).find((u) => u.id === id)?.name || id || "-";
  const sel = { fontFamily: FONT, fontSize: 15, padding: "10px 12px", border: `1px solid ${C.line}`, borderRadius: 10, background: C.field, color: C.ink };

  return (
    <Shell back="홈으로" backTo={onBack} toast={toast}>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 12px" }}>관리자</h2>
      <Seg value={tab} onChange={(v) => { setTab(v); if (v === "results" && results === null) loadResults(); if (v === "exams" && allExams === null) loadExams(); }} items={lite ? [["users", "계정"], ["results", "전체 기록"], ...(liteCan("liteCopy") || liteCan("liteAssign") ? [["exams", "시험지"]] : [])] : [["users", "계정"], ["results", "전체 기록"], ["exams", "시험지"], ["textbook", "교과서"], ["worker", "리포트 워커"], ["usage", "AI 사용량"]]} />
      {lite && <p style={{ fontSize: 13, color: C.sub, margin: "8px 0 0" }}>제한 관리자: 열람{LITE_KEYS.filter(liteCan).length ? " + " + LITE_KEYS.filter(liteCan).map((k) => PERM_KO[k].replace("제한: ", "")).join(" · ") : "만"} 할 수 있습니다.</p>}
      {tab === "exams" && (
        <div style={{ marginTop: 14 }}>
          {allExams === null ? <p style={{ color: C.sub }}>불러오는 중…</p> : allExams.length === 0 ? <p style={{ color: C.sub }}>시험지가 없습니다.</p> : (
            <Card style={{ padding: 8 }}>
              <div className="em-tbl-wrap"><table className="em-tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr>{["출제자", "제목", "문제", "코드", "수정", ""].map((h, i) => <th key={i} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
                <tbody>{allExams.map((e) => (
                  <tr key={e.id}>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{e.ownerName || e.ownerId}</td>
                    <td className="em-wrap" style={{ padding: "6px 8px" }}>{e.title || "제목 없음"}{e.subject ? <span style={{ color: C.sub, fontSize: 12.5 }}> · {e.subject}</span> : null}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{(e.questions || []).length}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{e.code || "-"}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap", color: C.sub }}>{fmtDate(e.updatedAt)}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{!lite && onOpenExam && <TextBtn onClick={() => onOpenExam(e)} style={{ fontSize: 13 }}>편집</TextBtn>}{liteCan("liteCopy") && onCopyExam && <TextBtn onClick={() => onCopyExam(e)} style={{ fontSize: 13 }}>복제</TextBtn>}{liteCan("liteAssign") && e.code && <TextBtn onClick={() => setAssign(e)} style={{ fontSize: 13 }}>배정</TextBtn>}{!lite && <TextBtn tone="sub" onClick={() => delExam(e)} style={{ fontSize: 13 }}>삭제</TextBtn>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              <p style={{ fontSize: 12.5, color: C.sub, margin: "8px 8px 2px" }}>모든 계정의 시험지 {allExams.length}개 · <TextBtn tone="sub" onClick={loadExams} style={{ fontSize: 12.5 }}>새로고침</TextBtn></p>
            </Card>
          )}
          {assign && <AssignModal exam={assign} onClose={() => setAssign(null)} flash={flash} />}
        </div>
      )}
      {tab === "textbook" && <TextbookAdmin flash={flash} />}

      {tab === "users" && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, margin: "18px 0 8px" }}>
            <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: C.inkMid }}>계정 목록 {users ? `(${users.length})` : ""}</h3>
            {liteCan("liteUsers") && <TextBtn onClick={() => setNewOpen((v) => !v)} style={{ fontSize: 14.5 }}>{newOpen ? "만들기 닫기" : "+ 새 계정 만들기"}</TextBtn>}
          </div>
          {liteCan("liteUsers") && newOpen && <Card style={{ margin: "0 0 14px" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>계정 만들기</div>
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field value={form.id} onChange={(v) => setForm({ ...form, id: v })} placeholder="아이디" ariaLabel="아이디" />
                <Field value={form.name} onChange={(v) => setForm({ ...form, name: v })} placeholder="이름" ariaLabel="이름" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field type="password" value={form.pw} onChange={(v) => setForm({ ...form, pw: v })} placeholder="비밀번호 (4자 이상)" ariaLabel="비밀번호" />
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={sel} aria-label="역할">
                  <option value="student">학생</option><option value="teacher">선생님</option>{!lite && <option value="admin">관리자</option>}
                </select>
              </div>
              {form.role === "student" && (
                <select value={form.teacherId} onChange={(e) => setForm({ ...form, teacherId: e.target.value })} style={sel} aria-label="담당 선생님">
                  <option value="">담당 선생님 없음</option>
                  {teachers.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
                </select>
              )}
              <Field value={form.subjects} onChange={(v) => setForm({ ...form, subjects: v })} placeholder="수강 과목 (선택, 쉼표로) 예: 통합과학, 수학" ariaLabel="수강 과목" maxLength={200} />
              {form.role !== "admin" && <CheckRow on={!!form.shOn} onToggle={() => setForm({ ...form, shOn: !form.shOn })}><Check on={!!form.shOn} size={20} /><span style={{ fontSize: 14.5 }}>오답노트 사용 허용</span></CheckRow>}
              {form.role !== "admin" && <CheckRow on={!!form.repOn} onToggle={() => setForm({ ...form, repOn: !form.repOn })}><Check on={!!form.repOn} size={20} /><span style={{ fontSize: 14.5 }}>분석 리포트 허용</span></CheckRow>}
              {form.role !== "admin" && !lite && <><div style={{ fontSize: 13, color: C.sub }}>기능 권한</div><PermPicker value={form.perms} onChange={(v) => setForm({ ...form, perms: v })} /></>}
              <Btn onClick={create} disabled={busy}>계정 만들기</Btn>
            </div>
          </Card>}
          {users === null && <p style={{ color: C.sub }}>불러오는 중…</p>}
          {(users || []).map((u) => (
            <button key={u.id} className="em-btn em-row" onClick={() => { if (lite && !liteCan("liteUsers") && !liteCan("liteNotify")) return flash("제한 관리자는 열람만 할 수 있습니다."); if (lite && u.role === "admin" && !liteCan("liteNotify")) return flash("관리자 계정은 수정할 수 없습니다."); setEdit({ ...u, pw: "", newId: u.id, perms: u.perms || { ...PERMS_ALL } }); setMsg({ title: "", body: "" }); }}
              style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, textAlign: "left", background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8, cursor: "pointer", fontFamily: FONT, opacity: u.active ? 1 : 0.55 }}>
              <span style={{ fontWeight: 700, color: C.ink }}>{u.name}</span>
              <Badge tone={u.role === "admin" ? "accent" : u.role === "teacher" ? "good" : "neutral"}>{ROLE_KO[u.role]}</Badge>
              <span style={{ color: C.sub, fontSize: 13.5, flex: 1, minWidth: 0 }}>{u.id}{u.role === "student" && u.teacherId ? ` · 담당 ${teacherName(u.teacherId)}` : ""}{u.shOn && u.role !== "admin" ? " · 오답노트" : ""}{u.repOn && u.role !== "admin" ? " · 리포트" : ""}{u.active ? "" : " · 정지"}{u.role !== "admin" && u.perms && BASE_KEYS.some((k) => k !== "adminLite" && k !== "genPlus" && !u.perms[k]) ? ` · 잠김 ${BASE_KEYS.filter((k) => k !== "adminLite" && k !== "genPlus" && !u.perms[k]).length}` : ""}{u.perms && u.perms.adminLite && u.role !== "admin" ? " · 제한 관리자" : ""}</span>
              <span aria-hidden="true" style={{ color: C.sub, fontSize: 20, lineHeight: 1 }}>›</span>
            </button>
          ))}
          {!lite && (
            <details style={{ marginTop: 22, background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 16px" }}>
              <summary style={{ fontSize: 15, fontWeight: 700, cursor: "pointer", color: C.inkMid }}>전체 알림 보내기 <span style={{ fontWeight: 400, fontSize: 13, color: C.sub }}>· 모든 계정에 한 번에</span></summary>
              <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
                <Field value={bc.title} onChange={(v) => setBc({ ...bc, title: v })} placeholder="제목" ariaLabel="알림 제목" maxLength={80} />
                <Field value={bc.body} onChange={(v) => setBc({ ...bc, body: v })} placeholder="내용" ariaLabel="알림 내용" multiline rows={2} maxLength={300} />
                <Btn kind="soft" onClick={sendAll}>모든 계정에 보내기</Btn>
              </div>
            </details>
          )}
        </>
      )}

      {tab === "results" && (
        <div style={{ marginTop: 14 }}>
          <Seg value={resView} onChange={(v) => { setResView(v); if (v === "activity" && acts === null) loadActs(actType, actUser); }} items={[["results", "응시 결과"], ["activity", "모든 활동"]]} />
          {resView === "activity" && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <select value={actType} onChange={(e) => { setActType(e.target.value); loadActs(e.target.value, actUser); }} style={sel} aria-label="활동 종류">
                  <option value="">모든 활동</option>
                  {Object.keys(ACT_KO).map((k) => <option key={k} value={k}>{ACT_KO[k]}</option>)}
                </select>
                <Field value={actUser} onChange={setActUser} placeholder="아이디로 거르기" ariaLabel="아이디" onEnter={() => loadActs(actType, actUser)} style={{ padding: "10px 12px", fontSize: 14.5 }} />
                <Btn kind="soft" onClick={() => loadActs(actType, actUser)} style={{ width: "auto", padding: "10px 14px", fontSize: 14 }}>새로고침</Btn>
              </div>
              {acts === null ? <p style={{ color: C.sub }}>불러오는 중…</p> : acts.length === 0 ? <p style={{ color: C.sub }}>기록이 없습니다.</p> : (
                <Card style={{ padding: 8 }}>
                  <div className="em-tbl-wrap"><table className="em-tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                    <thead><tr>{["때", "계정", "활동", "내용"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
                    <tbody>{acts.slice(0, actShow).map((a, i) => (
                      <tr key={i}>
                        <td style={{ padding: "5px 8px", whiteSpace: "nowrap", color: C.sub }}>{fmtDateTime(a.at)}</td>
                        <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{a.name}</td>
                        <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}><Badge tone={/error|delete|clear/.test(a.type) ? "bad" : /done|login|submit/.test(a.type) ? "good" : "neutral"}>{ACT_KO[a.type] || a.type}</Badge></td>
                        <td className="em-wrap" style={{ padding: "5px 8px", wordBreak: "break-all" }}>{a.detail}</td>
                      </tr>
                    ))}</tbody>
                  </table></div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 8px 2px", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, color: C.sub }}>{Math.min(actShow, acts.length)} / {acts.length}건 표시 · 6,000건이 넘으면 오래된 것부터 지워집니다.</span>
                    {acts.length > actShow && <TextBtn onClick={() => setActShow((n) => n + 10)} style={{ fontSize: 13 }}>10건 더 보기</TextBtn>}
                  </div>
                </Card>
              )}
            </div>
          )}
          {resView === "results" && (results === null ? <p style={{ color: C.sub, marginTop: 12 }}>불러오는 중…</p> : results.length === 0 ? <p style={{ color: C.sub, marginTop: 12 }}>아직 기록이 없습니다.</p> : (
            <Card style={{ padding: 8 }}>
              <div className="em-tbl-wrap"><table className="em-tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr>{["때", "이름", "시험지", "점수", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
                <tbody>{results.map((it) => (
                  <tr key={it.id}>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtDate(it.at)}</td>
                    <td style={{ padding: "6px 8px" }}>{it.name}{it.userId ? "" : <span style={{ color: C.sub }}> (비회원)</span>}</td>
                    <td className="em-wrap" style={{ padding: "6px 8px" }}>{it.title || it.code}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{it.score}/{it.total}</td>
                    <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{liteCan("liteResults") && <><TextBtn onClick={() => setEditRes(it)} style={{ fontSize: 13 }}>수정</TextBtn><TextBtn tone="sub" onClick={() => delResult(it)} style={{ fontSize: 13 }}>삭제</TextBtn></>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </Card>
          ))}
          {editRes && <ResultEditModal item={editRes} onClose={() => setEditRes(null)} flash={flash} onSaved={(it) => { setResults(results.map((x) => (x.id === it.id ? it : x))); setEditRes(null); }} />}
        </div>
      )}

      {tab === "usage" && (() => {
        const modelKo = (m) => (m.startsWith("claude:") ? `Claude · ${m.slice(7)}` : m.startsWith("gemini") ? `Gemini · ${m}` : m);
        const Tbl = ({ by }) => {
          const ents = Object.entries(by || {});
          if (!ents.length) return <p style={{ color: C.sub, fontSize: 14, margin: "4px 0 0" }}>기록 없음</p>;
          return (
            <div className="em-tbl-wrap"><table className="em-tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead><tr>{["모델", "호출", "성공", "입력 토큰", "출력 토큰"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
              <tbody>{ents.map(([m, v]) => <tr key={m}><td style={{ padding: "6px 8px" }}>{modelKo(m)}</td><td style={{ padding: "6px 8px" }}>{v.calls}</td><td style={{ padding: "6px 8px" }}>{v.ok}</td><td style={{ padding: "6px 8px" }}>{v.inputTokens.toLocaleString()}</td><td style={{ padding: "6px 8px" }}>{v.outputTokens.toLocaleString()}</td></tr>)}</tbody>
            </table></div>
          );
        };
        return (
          <Card style={{ marginTop: 14 }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>AI 문제 생성 사용량</div>
            <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>Gemini(기본 방식)는 무료 등급이라 요금 0원, Claude(고급 방식·오답노트·리포트)는 서버의 구독 예약 작업이라 요금 0원입니다. "오늘"은 매일 0시(한국 시간)에 새로 셉니다.</p>
            {usage === null ? <Btn kind="soft" onClick={loadUsage}>불러오기</Btn> : (
              <>
                <div style={{ fontSize: 14.5, fontWeight: 700, margin: "6px 0 4px" }}>오늘 <span style={{ color: C.sub, fontWeight: 400, fontSize: 13 }}>({usage.today}) · {usage.todayRows}건</span></div>
                <Tbl by={usage.todayByModel} />
                <div style={{ fontSize: 14.5, fontWeight: 700, margin: "16px 0 4px" }}>누적 <span style={{ color: C.sub, fontWeight: 400, fontSize: 13 }}>{usage.rows}건{usage.first ? ` · ${fmtDate(new Date(usage.first).getTime())}부터` : ""}</span></div>
                <Tbl by={usage.byModel} />
                {usage.quality && usage.quality.calls > 0 && (
                  <>
                    <div style={{ fontSize: 14.5, fontWeight: 700, margin: "16px 0 4px" }}>Gemini 생성 품질 <span style={{ color: C.sub, fontWeight: 400, fontSize: 13 }}>(최근 7일 · {usage.quality.calls}회)</span></div>
                    <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>
                      검증 통과 {usage.quality.passed}/{usage.quality.generated}문항({usage.quality.passRate}%) · 요청 {usage.quality.requested} → 전달 {usage.quality.delivered}
                      {usage.quality.unverifiedCalls > 0 && ` · 검증 실패 호출 ${usage.quality.unverifiedCalls}회`}
                    </p>
                    <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, margin: "2px 0 0" }}>
                      걸러낸 이유: {Object.entries(usage.quality.reasons || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${{ verify: "정답 불일치", self_mismatch: "정답 표시 불일치", calc: "계산 불일치", format: "형식", no_material: "자료 없음", hanja: "한자", artifact: "끼워 맞춤" }[k] || k} ${n}`).join(" · ") || "없음"}
                    </p>
                    <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.6, margin: "2px 0 0" }}>
                      과목별 통과율: {Object.entries(usage.quality.bySubject || {}).map(([k, v]) => `${k} ${v.generated ? Math.round(v.passed / v.generated * 100) : 0}%`).join(" · ")}
                    </p>
                  </>
                )}
                {Array.isArray(usage.recent) && usage.recent.length > 0 && (
                  <>
                    <div style={{ fontSize: 14.5, fontWeight: 700, margin: "16px 0 4px" }}>최근 호출 {usage.recent.length}건</div>
                    <div className="em-tbl-wrap"><table className="em-tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                      <thead><tr>{["때", "모델", "대상", "토큰", "상태"].map((h) => <th key={h} style={{ textAlign: "left", padding: "5px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
                      <tbody>{usage.recent.map((r, k) => <tr key={k}><td style={{ padding: "5px 8px", whiteSpace: "nowrap", color: C.sub }}>{fmtDateTime(r.at)}</td><td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{modelKo(r.model)}</td><td style={{ padding: "5px 8px", wordBreak: "break-all" }}>{r.scope}</td><td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{(r.inputTokens + r.outputTokens).toLocaleString()}</td><td style={{ padding: "5px 8px" }}><Badge tone={r.status === "ok" ? "good" : "bad"}>{r.status}</Badge></td></tr>)}</tbody>
                    </table></div>
                  </>
                )}
                <div style={{ fontSize: 13, color: C.sub, marginTop: 8 }}><TextBtn tone="sub" onClick={loadUsage} style={{ fontSize: 13 }}>새로고침</TextBtn></div>
              </>
            )}
          </Card>
        );
      })()}

      {tab === "worker" && (
        <Card style={{ marginTop: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>분석 리포트 워커 연결</div>
          <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.6, margin: "0 0 10px" }}>학생 분석 리포트는 서버의 Claude 예약 작업이 만듭니다. 서버의 study-helper\sync.json 에 있는 연결 코드를 등록하면 그 서버만 기록을 읽고 리포트를 올릴 수 있습니다.</p>
          <Field value={workerKey} onChange={setWorkerKey} placeholder="연결 코드" ariaLabel="연결 코드" onEnter={setWorker} />
          <div style={{ marginTop: 10 }}><Btn kind="soft" onClick={setWorker}>등록</Btn></div>
        </Card>
      )}

      {tempPw && (
        <Modal title="임시 비밀번호 (이번 한 번만 표시)" onClose={() => setTempPw(null)}>
          <p style={{ fontSize: 14, color: C.inkMid, lineHeight: 1.6, margin: "0 0 10px" }}><b>{tempPw.id}</b> 계정의 비밀번호입니다. 서버에도 이 화면 밖에도 남지 않으니 지금 복사해 전해 주세요. 창을 닫으면 다시 볼 수 없습니다.</p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px", background: C.field, border: `1px solid ${C.line}`, borderRadius: 12 }}>
            <code style={{ flex: 1, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 18, fontWeight: 700, letterSpacing: "0.04em", wordBreak: "break-all" }}>{tempPw.pw}</code>
            <Btn kind="soft" onClick={async () => flash((await copyText(tempPw.pw)) ? "복사했습니다." : "복사가 안 돼요. 직접 선택해서 복사해 주세요.")} style={{ width: "auto", padding: "9px 14px", fontSize: 14 }}>복사</Btn>
          </div>
          <div style={{ display: "grid", gap: 8, marginTop: 14 }}><Btn kind="ghost" onClick={() => setTempPw(null)}>닫기</Btn></div>
        </Modal>
      )}
      {edit && (() => {
        const canEdit = !lite || (liteCan("liteUsers") && edit.role !== "admin");   // 제한 관리자는 학생·선생님 계정만
        const canNotify = liteCan("liteNotify");
        return (
        <Modal title={`${canEdit ? "계정 수정" : "알림 보내기"} · ${edit.id}`} onClose={() => setEdit(null)}>
          <div style={{ display: "grid", gap: 8 }}>
            {canEdit && <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field value={edit.name} onChange={(v) => setEdit({ ...edit, name: v })} placeholder="이름" ariaLabel="이름" />
              {lite ? <div style={{ ...sel, color: C.sub }}>{edit.id} · {ROLE_KO[edit.role]}</div> : <Field value={edit.newId !== undefined ? edit.newId : edit.id} onChange={(v) => setEdit({ ...edit, newId: v })} placeholder="아이디" ariaLabel="아이디" maxLength={30} />}
            </div>
            <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>비밀번호는 암호화되어 저장되므로 볼 수 없습니다. 아래에서 새로 정하면 저장 직후 한 번만 표시됩니다.</div>
            {!lite && <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} style={sel} aria-label="역할">
              <option value="student">학생</option><option value="teacher">선생님</option><option value="admin">관리자</option>
            </select>}
            {edit.role === "student" && (
              <select value={edit.teacherId || ""} onChange={(e) => setEdit({ ...edit, teacherId: e.target.value })} style={sel} aria-label="담당 선생님">
                <option value="">담당 선생님 없음</option>
                {teachers.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.id})</option>)}
              </select>
            )}
            <Field value={Array.isArray(edit.subjects) ? edit.subjects.join(", ") : edit.subjects || ""} onChange={(v) => setEdit({ ...edit, subjects: v })} placeholder="수강 과목 (쉼표로)" ariaLabel="수강 과목" maxLength={200} />
            <Field type="password" value={edit.pw} onChange={(v) => setEdit({ ...edit, pw: v })} placeholder="새 비밀번호 (바꿀 때만)" ariaLabel="새 비밀번호" />
            {edit.role !== "admin" && <CheckRow on={!!edit.shOn} onToggle={() => setEdit({ ...edit, shOn: !edit.shOn })}><Check on={!!edit.shOn} size={20} /><span style={{ fontSize: 14.5 }}>오답노트 사용 허용</span></CheckRow>}
            {edit.role !== "admin" && <CheckRow on={!!edit.repOn} onToggle={() => setEdit({ ...edit, repOn: !edit.repOn })}><Check on={!!edit.repOn} size={20} /><span style={{ fontSize: 14.5 }}>분석 리포트 허용</span></CheckRow>}
            <CheckRow on={edit.active !== false} onToggle={() => setEdit({ ...edit, active: edit.active === false })}>로그인 허용</CheckRow>
            {edit.role !== "admin" && !lite && <><div style={{ fontSize: 13, color: C.sub }}>기능 권한</div><PermPicker value={edit.perms || PERMS_ALL} onChange={(v) => setEdit({ ...edit, perms: v })} /></>}
            {!lite && <>
            <div style={{ fontSize: 13, color: C.sub, marginTop: 4 }}>학습 범위 · 개인 맞춤 지시 (열람·수정)</div>
            <Field value={edit.scope || ""} onChange={(v) => setEdit({ ...edit, scope: v })} placeholder="학습 범위" ariaLabel="학습 범위" maxLength={200} />
            <Field value={edit.prompt || ""} onChange={(v) => setEdit({ ...edit, prompt: v })} placeholder="개인 맞춤 지시 (AI 문제 만들기에 반영)" ariaLabel="개인 맞춤 지시" multiline rows={2} maxLength={1000} />
            </>}
            <Btn onClick={save} disabled={busy}>저장</Btn>
            </>}
            {canNotify && <div style={{ borderTop: canEdit ? `1px solid ${C.line}` : "none", paddingTop: canEdit ? 10 : 0, marginTop: 4 }}>
              <div style={{ fontSize: 13, color: C.sub, marginBottom: 6 }}>이 계정에 알림 보내기</div>
              <div style={{ display: "grid", gap: 6 }}>
                <Field value={msg.title} onChange={(v) => setMsg({ ...msg, title: v })} placeholder="제목" ariaLabel="알림 제목" maxLength={80} />
                <Field value={msg.body} onChange={(v) => setMsg({ ...msg, body: v })} placeholder="내용" ariaLabel="알림 내용" multiline rows={2} maxLength={300} />
                <Btn kind="soft" onClick={sendOne}>알림 보내기</Btn>
              </div>
            </div>}
            {!lite && <Btn kind="danger" onClick={del}>계정 삭제</Btn>}
          </div>
        </Modal>
        );
      })()}
    </Shell>
  );
}

/* 결과 표 + 리포트 (선생·관리자가 학생을 볼 때, 학생이 자기 기록을 볼 때 공용) */
function ResultsTable({ items, onNote }) {
  if (!items.length) return <p style={{ color: C.sub, fontSize: 14.5 }}>아직 응시 기록이 없습니다.</p>;
  const avg = Math.round((items.reduce((s, r) => s + r.score / r.total, 0) / items.length) * 100);
  return (
    <>
      <p style={{ fontSize: 14.5, color: C.sub, margin: "0 0 8px" }}>{items.length}회 응시 · 평균 {avg}점</p>
      {/* 휴대폰: 한 줄 카드(점수가 잘리지 않게) */}
      <div className="em-rt-cards">
        {items.map((it) => {
          const wait = Array.isArray(it.detail) ? it.detail.filter((d) => d.p).length : 0;
          const canNote = onNote && Array.isArray(it.detail) && it.detail.some((d) => !d.ok && !d.p);
          return (
            <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "10px 14px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title || it.code}</div>
                <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2 }}>{fmtDate(it.at)} · {fmtSec(it.sec)}{wait ? ` · 채점 대기 ${wait}` : ""}{canNote && <> · <TextBtn onClick={() => onNote(it.id)} style={{ fontSize: 12.5, padding: 0, minHeight: 0 }}>오답노트</TextBtn></>}</div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 800, color: it.score === it.total ? C.good : C.ink, flex: "0 0 auto" }}>{it.score}<span style={{ fontSize: 13, color: C.sub, fontWeight: 600 }}>/{it.total}</span></div>
            </div>
          );
        })}
      </div>
      <Card style={{ padding: 8 }} className="em-rt-table">
        <div className="em-tbl-wrap"><table className="em-tbl" style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead><tr>{["때", "시험지", "점수", "시간"].concat(onNote ? [""] : []).map((h, i) => <th key={i} style={{ textAlign: "left", padding: "6px 8px", color: C.sub, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>)}</tr></thead>
          <tbody>{items.map((it) => (
            <tr key={it.id}><td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtDate(it.at)}</td><td className="em-wrap" style={{ padding: "6px 8px" }}>{it.title || it.code}</td><td style={{ padding: "6px 8px", whiteSpace: "nowrap", fontWeight: 700, color: it.score === it.total ? C.good : C.ink }}>{it.score}/{it.total}{Array.isArray(it.detail) && it.detail.some((d) => d.p) ? <span style={{ fontWeight: 500, color: C.warn, fontSize: 12.5 }}> · 대기 {it.detail.filter((d) => d.p).length}</span> : null}</td><td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtSec(it.sec)}</td>
              {onNote && <td style={{ padding: "4px 6px", whiteSpace: "nowrap" }}>{Array.isArray(it.detail) && it.detail.some((d) => !d.ok && !d.p) && <TextBtn onClick={() => onNote(it.id)} style={{ fontSize: 13 }}>오답노트</TextBtn>}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
    </>
  );
}

/* 제출 현황표: 학생 × 배정한 시험지. 공유 코드가 있는 최근 시험지 12개의 배정을 모아 한눈에 */
function SubmitGrid({ exams, students, flash }) {
  const [data, setData] = useState(null);   // { cols: [{code,title}], rows: {studentId: {code: cell}} }
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    const list = (exams || []).filter((e) => e.code).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 12);
    const many = await remote().assignListMany(list.map((e) => e.code));
    const got = many && many.ok && many.forCodes
      ? list.map((e) => ({ ok: true, forCode: many.forCodes[e.code] || [] }))
      : await Promise.all(list.map((e) => remote().assignList(e.code)));
    setBusy(false);
    const cols = [], rows = {};
    got.forEach((r, i) => {
      if (!r || !r.ok) return;
      const fc = r.forCode || [];
      if (!fc.length) return;
      cols.push({ code: list[i].code, title: list[i].title || list[i].code });
      fc.forEach((x) => { (rows[x.studentId] = rows[x.studentId] || { name: x.name })[list[i].code] = x; });
    });
    if (got.some((r) => r && !r.ok)) flash(errMsg(got.find((r) => r && !r.ok)));
    setData({ cols, rows });
  };
  if (!data)
    return <div style={{ marginBottom: 14 }}><Btn kind="soft" onClick={load} disabled={busy}>{busy ? "불러오는 중…" : "제출 현황표 보기 (학생 × 배정한 시험지)"}</Btn></div>;
  const now = Date.now();
  const ids = [...new Set([...(students || []).map((s) => s.id), ...Object.keys(data.rows)])].filter((id) => data.rows[id]);
  const nameOf = (id) => ((students || []).find((s) => s.id === id) || {}).name || data.rows[id].name || id;
  if (!data.cols.length) return <p style={{ fontSize: 14, color: C.sub, margin: "0 0 14px" }}>최근 시험지에 배정한 학생이 없습니다. 내 시험지에서 "배정"으로 학생에게 보내면 여기에 나타납니다.</p>;
  const th = { padding: "8px 10px", fontSize: 13, color: C.sub, fontWeight: 700, textAlign: "left", borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap" };
  const td = { padding: "8px 10px", fontSize: 14, borderBottom: `1px solid ${C.lineSoft}`, whiteSpace: "nowrap" };
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>제출 현황표</span>
        <TextBtn onClick={load} disabled={busy}>새로고침</TextBtn>
      </div>
      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 12, background: C.card }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><th style={th}>학생</th>{data.cols.map((c) => <th key={c.code} style={th} title={c.title}>{c.title.length > 10 ? c.title.slice(0, 10) + "…" : c.title}</th>)}<th style={th}>완료</th></tr></thead>
          <tbody>
            {ids.map((id) => {
              const row = data.rows[id];
              const asg = data.cols.filter((c) => row[c.code]);
              const done = asg.filter((c) => row[c.code].done).length;
              return (
                <tr key={id}>
                  <td style={{ ...td, fontWeight: 700 }}>{nameOf(id)}</td>
                  {data.cols.map((c) => {
                    const x = row[c.code];
                    if (!x) return <td key={c.code} style={{ ...td, color: C.sub }}>·</td>;
                    const late = !x.done && x.dueAt && now > x.dueAt;
                    return <td key={c.code} style={{ ...td, fontWeight: x.done ? 700 : 400, color: x.done ? C.ink : late ? C.bad : C.sub }}>{x.done ? `${x.score}/${x.total}` : late ? "기한 지남" : "아직"}</td>;
                  })}
                  <td style={{ ...td, color: done < asg.length ? C.warn : C.good, fontWeight: 700 }}>{done}/{asg.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── 오답 변형 문제: 시험지를 골라 틀린 문항(바꿀 수 있음)을 변형해 다시 낸다 ──
   기본은 AI 가 문제를 살짝 바꿔 답이 달라지게(객관식·참거짓·주관식·서술형 모두, 지문·그림은 그대로).
   AI 를 못 쓰면 보기 순서만 섞기(객관식만 의미 있음). 바로 풀기 또는 내 시험지에 저장 */
const isTF = (q) => Array.isArray(q.options) && q.options.length === 2 && q.options[0] === "참" && q.options[1] === "거짓";
const shuffleUseless = (q) => q.type === "short" || q.type === "essay" || isTF(q);   // 보기를 섞어도 같은 문제
/* 보기 순서를 섞되 정답 자리가 원래와 달라지게(가능하면) */
function remakeByShuffle(q) {
  const n = (q.options || []).length;
  if (shuffleUseless(q) || n < 2) return { ...q };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  let perm = range(n);
  for (let t = 0; t < 30; t++) {
    perm = shuffled(range(n));
    const ans = q.answers.map((a) => perm.indexOf(a)).sort((x, y) => x - y);
    if (!same(ans, [...q.answers].sort((x, y) => x - y))) break;
  }
  return { ...q, options: perm.map((i) => q.options[i]), answers: q.answers.map((a) => perm.indexOf(a)).sort((x, y) => x - y) };
}
function WrongRemakeModal({ items, studentId, user, onClose, onPractice, onSave, flash }) {
  /* 시험지마다 가장 최근 기록 하나 */
  const exams = useMemo(() => {
    const seen = {};
    (items || []).forEach((it) => { if (it.code && !(it.code in seen) && Array.isArray(it.detail)) seen[it.code] = it; });
    return Object.values(seen).map((it) => ({ ...it, wrong: it.detail.filter((d) => !d.ok && !d.p).length }));
  }, [items]);
  const [pick, setPick] = useState(null);       // 고른 기록
  const [src, setSrc] = useState(null);         // 그 시험지 원본(정규화)
  const [sel, setSel] = useState({});           // 문항 id → 포함 여부
  const aiOk = remote().kind === "server" && (can(user, "gen") || can(user, "solve"));   // 변형은 풀기 권한만 있어도(계정별 하루 한도)
  const [how, setHow] = useState(aiOk ? "ai" : "shuffle");
  const [busy, setBusy] = useState(false);
  const open = async (it) => {
    setBusy(true);
    const r = await remote().quizReview(it.code, studentId);
    setBusy(false);
    if (!r.ok) return flash(errMsg(r));
    const ex = parsePayload(JSON.stringify(r.quiz));
    if (!ex) return flash("시험지 데이터가 손상되어 열 수 없습니다.");
    const dm = detailMap(it);
    const s0 = {};
    ex.questions.forEach((q) => { const d = dm.get(String(q.id)); s0[q.id] = !!d && !d.ok && !d.p; });
    setPick(it); setSrc(ex); setSel(s0);
  };
  const chosen = src ? src.questions.filter((q) => sel[q.id]) : [];
  const build = async () => {
    /* 공용 보기를 쓰는 옛 시험지도 문항마다 보기를 갖게 한 뒤 바꾼다 */
    const base = chosen.map((q) => ({ ...q, options: Array.isArray(q.options) && q.options.length >= 2 ? q.options : src.options }));
    let out = base.map(remakeByShuffle);
    if (how === "ai") {
      const r = await remote().generate({ variant: base.map((q) => ({ type: q.type || "mc", text: q.text, options: shuffleUseless(q) && !isTF(q) ? [] : q.options, answers: q.answers || [], answerText: q.answerText || "", explain: q.explain || "", passage: q.passage || "", figure: !!q.svg })) });
      if (!r.ok) { flash(errMsg(r)); return null; }
      let got = 0;
      (r.variant || []).forEach((v) => {
        const q = base[v.i]; if (!q) return;
        const typed = v.type === "short" || v.type === "essay";
        out[v.i] = { ...q, text: v.text, options: typed ? [] : v.options, answers: typed ? [] : v.answers, answerText: typed ? v.answerText : q.answerText, explain: v.explain || q.explain };   // 지문·그림·태그는 원본 그대로
        got++;
      });
      const vfail = (r.dropped || []).filter((d) => d.why === "verify").length;
      if (r.verified === false) flash("AI 정답 검증을 하지 못했습니다. 저장·배정 전에 편집 화면에서 정답을 꼭 확인하세요.");
      else if (got < base.length) flash(`${base.length - got}문항은 원래 문항(객관식은 보기 섞기)으로 넣었습니다${vfail ? ` — 그중 ${vfail}문항은 AI 정답 검증에서 걸러짐` : ""}.`);
    }
    const title = `${src.title || pick.title || "시험지"} · 오답 변형`.slice(0, 80);
    return normalizeExam({ id: uid(), title, subject: src.subject || "", level: src.level, desc: `${pick.title || src.title || ""}에서 고른 ${out.length}문항${how === "ai" ? "을 살짝 바꾼 변형 문제" : ", 보기 순서만 섞음"}`, options: [], questions: out.map((q) => ({ ...q, id: uid(), src: q.src || String(src.questions.findIndex((x) => x.id === q.id) + 1) })) });
  };
  const go = async (then) => {
    if (!chosen.length) return flash("문항을 하나 이상 골라 주세요.");
    setBusy(true);
    try { const ex = await build(); if (ex) { then(ex); onClose(); } } finally { setBusy(false); }
  };
  return (
    <Modal title="오답 변형 문제 만들기" onClose={onClose} wide>
      {!src ? (
        <>
          <p style={{ fontSize: 14, color: C.sub, lineHeight: 1.55, margin: "0 0 12px" }}>시험지를 고르면 틀린 문항이 미리 체크됩니다. 같은 개념으로 문제를 살짝 바꿔 답이 달라진 변형 문제를 다시 풉니다.</p>
          {exams.length === 0 && <p style={{ color: C.sub, fontSize: 14.5 }}>아직 푼 시험지 기록이 없습니다.</p>}
          <div style={{ display: "grid", gap: 6, marginBottom: 14 }}>
            {exams.map((it) => (
              <button key={it.code} className="em-btn em-row" disabled={busy} onClick={() => open(it)}
                style={{ display: "flex", alignItems: "center", gap: 10, textAlign: "left", background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "11px 14px", cursor: "pointer", fontFamily: FONT, minHeight: 44 }}>
                <span style={{ flex: 1, minWidth: 0, fontWeight: 700, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title || it.code}</span>
                <span style={{ fontSize: 13, color: C.sub, whiteSpace: "nowrap" }}>{fmtDate(it.at)} · {it.score}/{it.total}</span>
                <Badge tone={it.wrong ? "bad" : "good"}>{it.wrong ? `틀림 ${it.wrong}` : "다 맞음"}</Badge>
              </button>
            ))}
          </div>
          <Btn kind="ghost" onClick={onClose}>닫기</Btn>
        </>
      ) : (
        <>
          <p style={{ fontSize: 14, color: C.sub, margin: "0 0 8px" }}><b style={{ color: C.ink }}>{src.title || pick.title}</b> · {chosen.length}문항 선택</p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <TextBtn onClick={() => { const d = detailMap(pick); const s0 = {}; src.questions.forEach((q) => { const x = d.get(String(q.id)); s0[q.id] = !!x && !x.ok && !x.p; }); setSel(s0); }}>틀린 것만</TextBtn>
            <TextBtn onClick={() => setSel(Object.fromEntries(src.questions.map((q) => [q.id, true])))}>모두</TextBtn>
            <TextBtn tone="sub" onClick={() => setSel({})}>모두 해제</TextBtn>
          </div>
          <div style={{ display: "grid", gap: 6, maxHeight: "42vh", overflowY: "auto", marginBottom: 12 }}>
            {src.questions.map((q, qi) => {
              const d = detailMap(pick).get(String(q.id));
              return (
                <CheckRow key={q.id} on={!!sel[q.id]} onToggle={() => setSel((m) => ({ ...m, [q.id]: !m[q.id] }))}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                    <b style={{ flex: "0 0 auto" }}>{qi + 1}번</b>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14 }}>{String(q.text || "").replace(/\s+/g, " ")}</span>
                    {d && <Badge tone={d.p ? "warn" : d.ok ? "good" : "bad"}>{d.p ? "채점 대기" : d.ok ? "맞음" : "틀림"}</Badge>}
                    {how === "shuffle" && shuffleUseless(q) && <Badge>그대로</Badge>}
                  </span>
                </CheckRow>
              );
            })}
          </div>
          <Seg value={how} onChange={(v) => (v === "ai" && !aiOk ? flash(ERR.perm_solve) : setHow(v))} items={[["ai", "문제 살짝 바꾸기 (AI)"], ["shuffle", "보기 순서만 섞기"]]} />
          <p style={{ fontSize: 13, color: C.sub, lineHeight: 1.55, margin: "8px 0 12px" }}>
            {how === "ai"
              ? "같은 개념·난이도로 숫자·조건·대상을 조금 바꿔 답이 달라지게 만듭니다. 참/거짓은 진술이 바뀌어 참·거짓이 뒤집히고, 주관식·서술형은 새 정답·모범 답안이 붙습니다. 지문·그림은 그대로입니다(AI 생성 1회, 몇 초 걸림)."
              : "문제는 그대로, 보기 순서만 바꿔 정답 번호가 달라집니다(무료·즉시). 참/거짓·주관식·서술형은 바뀌지 않습니다."}
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            <Btn onClick={() => go(onPractice)} disabled={busy || !chosen.length}>{busy ? "만드는 중…" : "바로 풀기 (기록 안 남음)"}</Btn>
            <Btn kind="soft" onClick={() => go(onSave)} disabled={busy || !chosen.length}>내 시험지에 저장 (편집 화면)</Btn>
            <Btn kind="ghost" onClick={() => { setSrc(null); setPick(null); }} disabled={busy}>다른 시험지 고르기</Btn>
          </div>
        </>
      )}
    </Modal>
  );
}

function StudentsScreen({ user, onBack, toast, flash, exams, onRemakePractice, onRemakeSave }) {
  const [remakeOpen, setRemakeOpen] = useState(false);
  const [students, setStudents] = useState(null);
  const [detail, setDetail] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tNames, setTNames] = useState({});   // 선생님 아이디 → 이름(관리자 화면의 담당 표시)
  useEffect(() => { (async () => { const r = await remote().userList(); if (!r.ok) return flash(errMsg(r)); setStudents(r.users.filter((u) => u.role === "student")); setTNames(Object.fromEntries(r.users.filter((u) => u.role !== "student").map((u) => [u.id, u.name]))); })(); }, []);
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
    if (!r.ok) return flash(r.error === "no_report" ? "아직 리포트가 만들어지지 않았습니다. 서버가 켜져 있으면 응시 후 10분 안에 만들어집니다." : errMsg(r));
    setReport(r.html);
  };
  if (detail && report !== null)
    return (
      <Shell back={detail.student.name} backTo={() => setReport(null)} toast={toast}>
        <div style={{ marginBottom: 10 }}><Btn kind="soft" onClick={() => openHtmlWindow(report, flash)}>새 창에서 열기(인쇄·PDF)</Btn></div>
        <iframe title="분석 리포트" srcDoc={report} sandbox="allow-popups" style={{ width: "100%", height: "78vh", border: `1px solid ${C.line}`, borderRadius: 12, background: "#fff" }} />
      </Shell>
    );
  if (detail)
    return (
      <Shell back="학생 목록" backTo={() => setDetail(null)} toast={toast}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, margin: "6px 0 4px" }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>{detail.student.name} <span style={{ color: C.sub, fontSize: 14, fontWeight: 500 }}>{detail.student.id}</span></h2>
          <TextBtn tone="sub" onClick={() => open(detail.student)} disabled={busy} style={{ fontSize: 14 }}>새로고침</TextBtn>
        </div>
        <div style={{ display: "grid", gap: 8, margin: "8px 0 14px" }}>
          {detail.student.repOn && <Btn onClick={openReport} disabled={busy}>리포트 열기</Btn>}
          <div className="em-btn-grid">
            {detail.student.repOn && <Btn kind="soft" onClick={async () => { const r = await remote().reportRequest(detail.student.id); flash(r.ok ? "요청했습니다. 서버가 켜져 있으면 10분 안에 새 리포트가 만들어집니다." : errMsg(r)); }} disabled={busy} style={{ fontSize: 14.5, padding: "11px 10px" }}>리포트 새로 만들기</Btn>}
            {onRemakeSave && detail.items.length > 0 && <Btn kind="soft" onClick={() => setRemakeOpen(true)} disabled={busy} style={{ fontSize: 14.5, padding: "11px 10px" }}>오답 변형 문제</Btn>}
          </div>
        </div>
        {!detail.student.repOn && <p style={{ fontSize: 14, color: C.sub, margin: "0 0 14px", lineHeight: 1.5 }}>이 계정은 분석 리포트 허용이 꺼져 있습니다. 관리자 화면의 계정 수정에서 켤 수 있습니다.</p>}
        {detail.report && (
          <Card style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13.5, color: C.sub }}>리포트 요약 · {fmtDate(detail.report.updatedAt)} 기준 {detail.report.basis}회</div>
            {detail.report.summary && detail.report.summary.headline && <div style={{ fontSize: 15, marginTop: 4 }}>{detail.report.summary.headline}</div>}
            {detail.report.summary && Array.isArray(detail.report.summary.weak) && detail.report.summary.weak.length > 0 && <div style={{ fontSize: 14, marginTop: 6 }}>취약: {detail.report.summary.weak.join(" · ")}</div>}
            {detail.report.summary && detail.report.summary.notes > 0 && <div style={{ fontSize: 13.5, color: C.sub, marginTop: 4 }}>오답노트 {detail.report.summary.notes}권 포함{detail.report.summary.noteWrong ? ` · 틀림 ${detail.report.summary.noteWrong}문항` : ""}</div>}
          </Card>
        )}
        <TrendChart items={detail.items} />
        <BreakdownChart items={detail.items} quizzes={detail.quizzes} />
        <ResultsTable items={detail.items} />
        {remakeOpen && <WrongRemakeModal items={detail.items} studentId={detail.student.id} user={user} flash={flash} onClose={() => setRemakeOpen(false)} onPractice={onRemakePractice} onSave={onRemakeSave} />}
      </Shell>
    );
  return (
    <Shell back="홈으로" backTo={onBack} toast={toast}>
      <h2 style={{ fontSize: 24, fontWeight: 800, margin: "6px 0 12px" }}>내 학생</h2>
      {students === null && <p style={{ color: C.sub }}>불러오는 중…</p>}
      {students && students.length > 0 && <SubmitGrid exams={exams} students={students} flash={flash} />}
      {students && students.length === 0 && <p style={{ color: C.sub, fontSize: 14.5 }}>{user.role === "admin" ? "등록된 학생이 없습니다. 관리자 화면에서 계정을 만드세요." : "담당 학생이 없습니다. 관리자에게 학생 등록을 요청하세요."}</p>}
      {(students || []).map((st) => (
        <button key={st.id} className="em-btn em-row" onClick={() => open(st)} disabled={busy}
          style={{ display: "flex", width: "100%", alignItems: "center", gap: 10, textAlign: "left", background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8, cursor: "pointer", fontFamily: FONT }}>
          <span style={{ fontWeight: 700, color: C.ink }}>{st.name}</span><span style={{ color: C.sub, fontSize: 13.5, flex: 1, minWidth: 0 }}>{st.id}{user.role === "admin" && st.teacherId ? ` · 담당 ${tNames[st.teacherId] || st.teacherId}` : ""}</span>
          <span aria-hidden="true" style={{ color: C.sub, fontSize: 20, lineHeight: 1 }}>›</span>
        </button>
      ))}
    </Shell>
  );
}

function MyResultsScreen({ user, onBack, toast, flash, onPractice, onMakeNote, onWrongBank, onRemakePractice, onRemakeSave }) {
  const [remakeOpen, setRemakeOpen] = useState(false);
  const repOn = user.role === "admin" || !!user.repOn;
  const [detail, setDetail] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { const r = await remote().studentResults(user.id); if (!r.ok) return flash(errMsg(r)); setDetail(r); };
  useEffect(() => { load(); }, []);
  const openReport = async () => {
    setBusy(true);
    const r = await remote().reportGet(user.id);
    setBusy(false);
    if (!r.ok) return flash(r.error === "no_report" ? "아직 리포트가 없습니다. '리포트 새로 만들기'를 누르면 서버가 켜져 있을 때 10분 안에 만들어집니다." : errMsg(r));
    setReport(r.html);
  };
  const request = async () => { const r = await remote().reportRequest(); flash(r.ok ? "요청했습니다. 서버가 켜져 있으면 10분 안에 만들어집니다." : errMsg(r)); };
  if (report !== null)
    return (
      <Shell back="분석 리포트" backTo={() => setReport(null)} toast={toast}>
        <div style={{ marginBottom: 10 }}><Btn kind="soft" onClick={() => openHtmlWindow(report, flash)}>새 창에서 열기(인쇄·PDF)</Btn></div>
        <iframe title="분석 리포트" srcDoc={report} sandbox="allow-popups" style={{ width: "100%", height: "78vh", border: `1px solid ${C.line}`, borderRadius: 12, background: "#fff" }} />
      </Shell>
    );
  return (
    <Shell back="홈으로" backTo={onBack} toast={toast}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, margin: "6px 0 12px" }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>분석 리포트</h2>
        <TextBtn tone="sub" onClick={load} disabled={busy} style={{ fontSize: 14 }}>새로고침</TextBtn>
      </div>
      {remakeOpen && detail && <WrongRemakeModal items={detail.items} user={user} flash={flash} onClose={() => setRemakeOpen(false)} onPractice={onRemakePractice} onSave={onRemakeSave} />}
      {/* 주 버튼 하나(리포트 열기) + 작은 2열 버튼 */}
      <div style={{ display: "grid", gap: 8, margin: "0 0 14px" }}>
        {repOn && <Btn onClick={openReport} disabled={busy}>리포트 열기</Btn>}
        <div className="em-btn-grid">
          {repOn && <Btn kind="soft" onClick={request} disabled={busy} style={{ fontSize: 14.5, padding: "11px 10px" }}>리포트 새로 만들기</Btn>}
          {onRemakePractice && detail && detail.items.length > 0 && <Btn kind="soft" onClick={() => setRemakeOpen(true)} disabled={busy} style={{ fontSize: 14.5, padding: "11px 10px" }}>오답 변형 문제</Btn>}
          {onWrongBank && detail && detail.items.length > 0 && <Btn kind="soft" onClick={async () => { setBusy(true); try { await onWrongBank(detail.items); } finally { setBusy(false); } }} disabled={busy} style={{ fontSize: 14.5, padding: "11px 10px" }}>틀린 문제 모아 풀기</Btn>}
        </div>
      </div>
      {!repOn && <p style={{ fontSize: 14, color: C.sub, margin: "0 0 14px", lineHeight: 1.5 }}>이 계정은 아직 분석 리포트를 받을 수 없습니다. 관리자에게 문의하세요.</p>}
      {detail && detail.report && (
        <Card style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13.5, color: C.sub }}>리포트 요약 · {fmtDate(detail.report.updatedAt)} 기준 {detail.report.basis}회</div>
          {detail.report.summary && detail.report.summary.headline && <div style={{ fontSize: 15, marginTop: 4 }}>{detail.report.summary.headline}</div>}
          {detail.report.summary && Array.isArray(detail.report.summary.weak) && detail.report.summary.weak.length > 0 && <div style={{ fontSize: 14, marginTop: 6 }}>취약: {detail.report.summary.weak.join(" · ")}</div>}
            {detail.report.summary && detail.report.summary.notes > 0 && <div style={{ fontSize: 13.5, color: C.sub, marginTop: 4 }}>오답노트 {detail.report.summary.notes}권 포함{detail.report.summary.noteWrong ? ` · 틀림 ${detail.report.summary.noteWrong}문항` : ""}</div>}
        </Card>
      )}
      {detail && detail.items.length > 0 && (() => {
        const agg = aggregateResults(detail.items, detail.quizzes);
        const repWeak = detail.report && detail.report.summary && Array.isArray(detail.report.summary.weak) ? detail.report.summary.weak : [];
        const weak = [...new Set([...repWeak, ...agg.tags.filter((t) => t.pct < 60).map((t) => t.k)])].slice(0, 6);
        const subj = agg.subs.length && agg.subs[0].k !== "(과목 없음)" ? agg.subs[0].k : "";
        return (
          <>
            {weak.length > 0 && (
              <Card style={{ marginBottom: 14, borderColor: C.accent }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}><SubjThumb kind="ai" size={38} /><div style={{ fontSize: 14.5, fontWeight: 700 }}>추천 학습</div></div>
                <div style={{ fontSize: 14, color: C.inkMid, lineHeight: 1.6, marginBottom: 10 }}>약한 부분: <b>{weak.join(" · ")}</b></div>
                <div style={{ display: "grid", gap: 8 }}>
                  {onPractice && <Btn kind="soft" onClick={() => onPractice(weak.join(", "), subj)} disabled={busy}>이 약점으로 연습 문제 만들기 (AI)</Btn>}
                  {repOn && detail.report && <TextBtn onClick={openReport} disabled={busy}>리포트의 맞춤 연습 문제 보기</TextBtn>}
                </div>
              </Card>
            )}
            <TrendChart items={detail.items} />
            <BreakdownChart items={detail.items} quizzes={detail.quizzes} />
          </>
        );
      })()}
      {detail === null ? <p style={{ color: C.sub }}>불러오는 중…</p> : <ResultsTable items={detail.items} onNote={onMakeNote} />}
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
  const [typed, setTyped] = useState({});   // 주관식·서술형 답
  const [name, setName] = useState("");
  const [result, setResult] = useState(null);
  const [resultId, setResultId] = useState(null);   // 방금 제출한 결과의 서버 행 id(오답노트 만들기용)
  const [saveState, setSaveState] = useState(null);   // null | "saving" | "ok" | { error, msg } — 결과의 서버 저장 상태
  const pendingRef = useRef(null);                     // 서버에 못 보낸 결과 { code, entry } (재로그인·다시 보내기용)
  const submittingRef = useRef(false);                 // 타이머 자동 제출과 버튼 제출이 겹쳐도 한 번만
  const canNote = () => remote().kind === "server" && !!user && (user.role === "admin" || !!user.shOn);
  const makeNote = async (rid) => {
    const r = await remote().jobCreate({ resultId: rid }, "note");
    flash(r.ok ? "오답노트를 요청했습니다. 서버가 켜져 있으면 10분 안에 만들어지고 알림이 뜹니다." : errMsg(r));
    return r.ok;
  };

  /* 계정 */
  const [user, setUser] = useState(null);
  const [needSetup, setNeedSetup] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const [genInit, setGenInit] = useState(null);   // 추천 학습 → 편집 화면을 열며 AI 생성 창에 넣을 범위
  const [printSrc, setPrintSrc] = useState(null); // 인쇄·PDF 모달에 넘길 시험지
  const [genAuto, setGenAuto] = useState(false);   // 새 시험지는 AI 생성 창을 먼저 연다(직접 만들기 버튼으로 닫음)
  const examsRef = useRef([]);
  useEffect(() => { examsRef.current = exams; }, [exams]);
  const migrateAsked = useRef(false);
  const loadServerExams = async (u) => {
    const r = await remote().examList();
    if (!r.ok) return false;
    const local = examsRef.current;
    const cur = u || user;
    if (r.exams.length === 0 && local.length > 0 && cur && cur.role !== "student" && !migrateAsked.current) {
      /* 계정 도입 전 이 브라우저에만 저장돼 있던 시험지를 서버로 한 번 옮긴다 — 학생 계정으로는 옮기지 않고, 반드시 물어본다(공용 PC) */
      migrateAsked.current = true;
      if (window.confirm(`이 브라우저에 저장된 시험지 ${local.length}개를 ${cur.name || cur.id} 계정으로 옮길까요?`)) {
        for (const e of local) await remote().examSave(e);
        setExams(local);
        await store.del("exams");   // 옮긴 뒤 브라우저 사본은 지운다(다른 계정에 섞이지 않게)
        return true;
      }
    }
    setExams(r.exams.map(normalizeExam));
    return true;
  };
  const afterLogin = async (u) => {
    setNeedSetup(false);
    setUser(u);
    if (u.name) setName(u.name);
    await loadServerExams(u);
    await flushQueue(u.id);   // 옛 항목을 먼저 보내고 나서 방금 결과를 보낸다(같은 결과 이중 전송 방지)
    /* 로그인이 풀려 못 보낸 결과가 있으면 결과 화면으로 돌아가 이어서 보낸다 */
    if (pendingRef.current && run && result) { setScreen("result"); sendResult(pendingRef.current); return; }
    setScreen("home");
  };
  const clearSession = () => { authSet(null); setUser(null); setExams([]); setAcctOpen(false); homeCache = null; };
  const logoutNow = async () => {
    await remote().logout();
    clearSession(); setScreen("home"); pendingRef.current = null;
    const pg = await remote().ping(); setNeedSetup(!!(pg && pg.setup));
  };
  /* apiPost 가 bad_token 을 받으면 em-logout 이벤트 → 로그인 화면으로(응시 중이던 결과는 pendingRef 에 남겨 재로그인 뒤 보냄) */
  useEffect(() => {
    const onOut = () => { if (!authGet()) { clearSession(); flash("로그인이 풀렸습니다. 다시 들어와 주세요."); } };
    window.addEventListener("em-logout", onOut);
    return () => window.removeEventListener("em-logout", onOut);
  }, []);

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
        if (meR.ok) {
          authSet({ token: a.token, user: meR.user }); setUser(meR.user); if (meR.user.name) setName(meR.user.name); await loadServerExams(); flushQueue(meR.user.id);
          const h = (INITIAL_HASH.match(/^#\/(\w+)/) || [])[1];
          if (RESTORE_SCREENS.includes(h)) setScreen(h);
        }
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
    toastTimer.current = setTimeout(() => setToast(""), Math.min(6000, 1500 + String(m).length * 60));   // 긴 안내는 더 오래
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
  const dirty = useMemo(() => (draft ? snapOf(draft) !== savedSnap : false), [draft, savedSnap]);

  /* 브라우저 뒤로가기·앞으로가기: 화면을 주소(#/화면)와 맞춘다. 되살릴 상태가 없는 화면(편집·풀이·결과)은 홈으로 */
  const stRef = useRef({});
  const flashRef = useRef(null);
  flashRef.current = (m) => flash(m);
  stRef.current = { screen, dirty, draft, run, result };
  const firstHash = useRef(true);
  const replaceNext = useRef(false);
  useEffect(() => {
    const want = "#/" + screen;
    if (location.hash !== want) {
      if (firstHash.current || replaceNext.current) history.replaceState(null, "", want); else history.pushState(null, "", want);
    }
    firstHash.current = false; replaceNext.current = false;
  }, [screen]);
  useEffect(() => {
    const can = { editor: (s) => !!s.draft, take: (s) => !!s.run && !s.result, result: (s) => !!s.run && !!s.result };
    const onPop = () => {
      const target = (location.hash.match(/^#\/(\w+)/) || [])[1] || "home";
      const cur = stRef.current;
      if (target === cur.screen) return;
      if (cur.screen === "editor" && cur.dirty && !window.confirm("저장하지 않은 변경이 있습니다. 나갈까요?")) { history.pushState(null, "", "#/editor"); return; }
      const blocked = !SCREENS.includes(target) || (can[target] && !can[target](cur));
      if (blocked) replaceNext.current = true;
      /* 15) 풀이 중 뒤로가기: 답은 기기에 저장돼 있으니 안내만 */
      if (cur.screen === "take" && cur.run && !cur.run.partial && !cur.run.preview) flashRef.current("푼 답은 이 기기에 저장돼 같은 코드로 다시 열면 이어서 풉니다.");
      setScreen(blocked ? "home" : target);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /* 편집 */
  const openEditor = (exam, isNew) => {
    exam = withOwnOptions(exam);
    setDraft(exam);
    setSavedSnap(isNew ? null : snapOf(exam));
    setScreen("editor");
  };
  const newExam = () => { setGenAuto(true); openEditor(normalizeExam({ id: uid(), options: DEFAULT_OPTS() }), true); };
  /* 추천 학습: 약점 태그를 범위로 AI 생성 창을 바로 연다 */
  /* 오답 은행: 최근 시험지(최대 10개)의 마지막 응시에서 틀린 문항만 모아 한 번에 다시 푼다(기록에는 안 남음) */
  const wrongBank = async (items) => {
    setBusy(true);
    try {
      const latest = {};
      (items || []).forEach((it) => { if (!(it.code in latest) && Array.isArray(it.detail)) latest[it.code] = it; });
      const wrongBy = Object.values(latest)
        .map((it) => ({ code: it.code, ids: new Set(it.detail.filter((d) => !d.ok && !d.p).map((d) => String(d.q))) }))
        .filter((x) => x.ids.size)
        .slice(0, 10);
      if (!wrongBy.length) return flash("최근 기록에 틀린 문제가 없습니다.");
      const got = await Promise.all(wrongBy.map((x) => remote().getQuiz(x.code)));
      const questions = [];
      got.forEach((g, i) => {
        const src = g && g.ok ? parsePayload(JSON.stringify(g.quiz)) : null;
        if (!src) return;   // 마감·삭제된 시험지는 건너뛴다
        src.questions.filter((q) => wrongBy[i].ids.has(String(q.id))).forEach((q) => {
          const own = Array.isArray(q.options) && q.options.length >= 2 ? q.options : src.options;
          questions.push({ ...q, id: `${wrongBy[i].code}:${q.id}`, src: q.src || `${(src.title || wrongBy[i].code).slice(0, 10)} ${src.questions.indexOf(q) + 1}번`, options: own, tags: [...(q.tags || []), src.title].filter(Boolean) });
        });
      });
      if (!questions.length) return flash("틀린 문제가 있던 시험지를 지금은 열 수 없습니다(마감·삭제).");
      const src = { title: "오답 모아 풀기", desc: `최근 시험지 ${wrongBy.length}개에서 틀린 ${questions.length}문항`, options: [], questions, shuffle: true, timeLimit: 0, subject: "" };
      const run0 = buildRun(src, "", new Set(questions.map((q) => q.id)));
      run0.owner = "";
      setRun(run0);
      setPicked({}); setTyped({});
      setResult(null);
      setScreen("take");
      window.scrollTo(0, 0);
    } finally { setBusy(false); }
  };
  /* 만든 시험지를 기록 없는 연습으로 바로 푼다(오답 모아 풀기와 같은 방식) */
  const practiceNow = (ex) => {
    const run0 = buildRun(ex, "", new Set(ex.questions.map((q) => q.id)));
    run0.owner = "";
    setRun(run0);
    setPicked({}); setTyped({});
    setResult(null);
    setScreen("take");
    window.scrollTo(0, 0);
  };
  const remakeSave = (ex) => { openEditor(ex, true); flash("편집 화면에서 저장하면 내 시험지에 들어갑니다. 공유·배정도 여기서 할 수 있습니다."); };
  const practiceExam = (scope, subject) => { setGenInit(scope); openEditor(normalizeExam({ id: uid(), subject: subject || "", title: `약점 보완 · ${scope}`.slice(0, 80) }), true); };
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

  /* 관리자 › 시험지 탭의 "복제": 다른 계정의 시험지를 내 시험지로(새 id, 공유 코드 없음) */
  const copyExamIn = async (e) => {
    if (!e) return;
    const copy = normalizeExam({ ...JSON.parse(JSON.stringify(e)), id: uid(), title: `${e.title || "제목 없음"} (복사본)`, code: null, ownerKey: null, ownerId: undefined, ownerName: undefined, sharedHash: null, sharedAt: null, createdAt: Date.now(), updatedAt: Date.now() });
    copy.questions = copy.questions.map((q) => ({ ...q, id: uid() }));
    await persist([copy, ...exams]);
    flash("내 시험지로 복제했습니다.");
  };

  const importExams = async (list) => {
    const dup = list.filter((e) => e.code && exams.some((x) => x.code === e.code)).length;   // 같은 공유 코드가 이미 있으면 어느 쪽을 다시 공유해도 같은 코드를 덮어쓴다
    await persist([...list, ...exams]);
    setImportOpen(false);
    flash(`시험지 ${list.length}개를 가져왔습니다.` + (dup ? ` 이미 있는 시험지와 공유 코드가 같은 것이 ${dup}개 있습니다(다시 공유하면 서로 덮어씁니다).` : ""));
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
      if (r.error === "not_open") setCodeErr(`아직 응시 시작 전입니다. ${fmtDateTime(r.openAt)}부터 풀 수 있습니다.`);
      else if (r.error === "closed") setCodeErr(`응시가 마감된 시험지입니다. (마감 ${fmtDateTime(r.closeAt)})`);
      else setCodeErr(errMsg(r));
      return;
    }
    const src = parsePayload(JSON.stringify(r.quiz));
    if (!src) {
      setCodeErr("시험지 데이터가 손상되어 열 수 없습니다. 출제자에게 다시 공유해 달라고 해 주세요.");
      return;
    }
    /* 새로고침·실수로 나갔다 들어오면 풀던 답과 시작 시각을 되살린다(제한 시간도 이어서 흐름) */
    let saved = null;
    if (!r.preview) { try { saved = JSON.parse((await store.get(takeKey(code))) || "null"); } catch (e) {} }
    if (saved && (!(saved.at > 0) || Date.now() - saved.at > TAKE_KEEP_MS || saved.sig !== takeSig(src))) { store.del(takeKey(code)); saved = null; }
    const run0 = buildRun(src, code, null, saved);
    run0.owner = asStr(r.owner);
    run0.preview = !!r.preview;
    setRun(run0);
    setPicked((saved && saved.picked) || {}); setTyped((saved && saved.typed) || {});
    if (saved && (Object.keys(saved.picked || {}).length || Object.keys(saved.typed || {}).length)) flash("풀던 답을 이어서 불러왔습니다.");
    setResult(null);
    setScreen("take");
    window.scrollTo(0, 0);
  };

  /* 풀이 중 답 임시 저장(기기 안). 제출하면 지운다 */
  const takeKey = (code) => `take:${(user && user.id) || ""}:${code}`;
  useEffect(() => {
    if (screen !== "take" || !run || run.partial || run.preview) return;
    const perm = {}; run.questions.forEach((q) => { if (q.perm) perm[q.id] = q.perm; });
    const t = setTimeout(() => { if (!submittingRef.current) store.set(takeKey(run.code), JSON.stringify({ at: run.startedAt, sig: takeSig(run.src), sp: run.sharedPerm, perm, order: run.questions.map((q) => q.id), picked, typed })); }, 300);
    return () => clearTimeout(t);
  }, [screen, run, picked, typed]);
  /* 답을 하나라도 고른 채 탭을 닫거나 새로고침하면 브라우저 경고(답은 저장돼 있지만 실수 방지) */
  useEffect(() => {
    if (screen !== "take") return;
    const h = (e) => { if (Object.keys(picked).length || Object.values(typed || {}).some(Boolean)) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [screen, picked, typed]);

  const togglePick = (qid, oi) =>
    setPicked((p) => {
      const cur = p[qid] || [];
      const next = cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi].sort((a, b) => a - b);
      return { ...p, [qid]: next };
    });

  /* 못 보낸 결과는 기기에도 남겨 두었다가(새로고침해도 유지) 다음 로그인·접속 때 자동으로 다시 보낸다 */
  const RETRY_ERRORS = ["network", "timeout", "server", "busy", "bad_token"];
  const qChain = useRef(Promise.resolve());
  const qOp = (f) => (qChain.current = qChain.current.then(f, f));   // 큐 읽고-쓰기를 차례로
  const queueGet = async () => { try { const v = JSON.parse((await store.get("pending-results")) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const queuePut = (list) => store.set("pending-results", JSON.stringify(list.slice(-20)));
  const queueDrop = (id) => qOp(async () => queuePut((await queueGet()).filter((x) => x.id !== id)));
  const queueAdd = (item) => qOp(async () => queuePut([...(await queueGet()).filter((x) => x.id !== item.id), item]));
  const flushQueue = async (uid) => {
    const list = await queueGet();
    let sent = 0;
    for (const x of list) {
      if (x.uid !== uid || (pendingRef.current && pendingRef.current.id === x.id)) continue;
      if (!(await queueGet()).some((y) => y.id === x.id)) continue;   // 그사이 다른 경로로 보냈으면 건너뜀
      const r = await remote().submit(x.code, x.entry);
      if (r && r.ok) { sent++; await queueDrop(x.id); }
      else if (!r || !RETRY_ERRORS.includes(r.error)) await queueDrop(x.id);   // 마감·삭제 등 다시 보내도 안 되는 것은 버린다
      else break;
    }
    if (sent) flash(`전에 보내지 못한 결과 ${sent}개를 저장했습니다.`);
  };
  /* 결과를 서버에 보낸다. 실패하면 pendingRef 에 남기고 결과 화면에 빨간 배너 + 다시 보내기 */
  const sendResult = async (p) => {
    if (!p) return;
    setSaveState("saving");
    const sr = await remote().submit(p.code, p.entry);
    if (sr && sr.ok) { pendingRef.current = null; setSaveState("ok"); if (sr.id) setResultId(String(sr.id)); if (p.id) queueDrop(p.id); return; }
    pendingRef.current = p;
    if (p.id && user && RETRY_ERRORS.includes((sr && sr.error) || "network")) await queueAdd({ ...p, uid: user.id });
    setSaveState({ error: (sr && sr.error) || "network", msg: errMsg(sr) });
    if (sr && sr.error === "bad_token") { authSet(null); clearSession(); flash("로그인이 풀렸습니다. 다시 로그인하면 결과를 이어서 보냅니다."); }   // 로그인 화면으로(결과는 보존)
  };
  const submit = async () => {
    if (submittingRef.current) return;   // 타이머 자동 제출 + 버튼 제출이 겹쳐도 한 번만
    submittingRef.current = true;
    try {
    const rows = run.questions.map((q) => {
      const mine = picked[q.id] || [];
      const t = String((typed || {})[q.id] || "").trim();
      if (q.type === "short") { const acc = String(q.answerText || "").split("|").map(normAns).filter(Boolean); return { q, mine: [], typed: t, ok: !!t && acc.includes(normAns(t)) }; }
      if (q.type === "essay") return { q, mine: [], typed: t, ok: false, pending: true };   // 서술형은 선생님이 채점(결과 수정)
      return { q, mine, ok: mine.length > 0 && sameSet(mine, q.answers) };
    });
    const pendingN = rows.filter((r) => r.pending).length;
    const score = rows.filter((r) => r.ok).length;
    const total = rows.length - pendingN;   // 채점 대기(서술형)는 분모에서 뺀다
    const sec = (Date.now() - run.startedAt) / 1000;
    if (!run.partial && !run.preview) store.del(takeKey(run.code));
    setResult({ rows, score, total, pending: pendingN, sec });
    setResultId(null);
    setSaveState(null);
    pendingRef.current = null;
    setScreen("result");
    window.scrollTo(0, 0);

    if (run.partial || run.preview) return;   // 틀린 문제 다시 풀기·출제자 미리 보기는 기록하지 않는다
    const trimmed = name.trim().slice(0, 20);
    /* 최근 목록 + 이름 기억 (내 저장소) */
    const nextRecent = [{ code: run.code, title: run.title, owner: run.owner || "", subject: run.subject || "", score, total, at: Date.now() }, ...recent.filter((r) => r.code !== run.code)].slice(0, 8);
    setRecent(nextRecent);
    store.set("recent", JSON.stringify(nextRecent));
    if (trimmed) store.set("name", trimmed);
    /* 출제자에게 결과 전달. 고른 보기(m)는 섞기 전 원본 번호로 되돌려 보내고 v:2 로 표시한다 */
    const toOrig = (q, arr) => arr.map((i) => (q.perm && q.perm[i] != null ? q.perm[i] : i)).sort((a, b) => a - b);
    const entry = { v: 2, name: trimmed, score, total, pending: pendingN, sec: Math.round(sec), detail: rows.map((r) => ({ q: r.q.id, m: toOrig(r.q, r.mine), ok: r.ok, ...(r.typed !== undefined ? { t: r.typed.slice(0, 500) } : {}), ...(r.pending ? { p: true } : {}) })) };
    const id = Date.now();
    entry.cid = String(id);
    await sendResult({ code: run.code, entry, id });
    store.del(takeKey(run.code));   // 제출 중 늦게 돈 임시 저장 타이머가 남긴 것까지 지운다
    } finally { submittingRef.current = false; }
  };

  const retryWrong = (ids) => {
    const r0 = buildRun(run.src, run.code, new Set(ids));
    r0.owner = run.owner; r0.preview = run.preview;
    setRun(r0);
    setPicked({}); setTyped({});
    setResult(null);
    setScreen("take");
    window.scrollTo(0, 0);
  };
  const retryAll = () => {
    const r0 = buildRun(run.src, run.code, run.code ? null : new Set(run.src.questions.map((q) => q.id)));   // 코드 없는 런(오답 모아 풀기)은 기록하지 않는 연습으로
    r0.owner = run.owner; r0.preview = run.preview;
    setRun(r0);
    setPicked({}); setTyped({});
    setResult(null);
    setScreen("take");
    window.scrollTo(0, 0);
  };

  const goHome = () => {
    setDraft(null);
    setSavedSnap(null);
    setScreen("home");
  };

  /* ── 알림: 워커(Claude)가 끝낸 일을 1분마다 확인해 토스트·배지·홈 패널로 보여 준다 */
  const [notes, setNotes] = useState([]);
  const toastedRef = useRef(new Set());
  const pollNotes = async () => {
    if (remote().kind !== "server" || !user) return;
    const r = await remote().noteList();
    if (!r.ok) return;
    setNotes(r.notes || []);
    const fresh = (r.notes || []).filter((n) => !n.seen && !toastedRef.current.has(n.id) && Date.now() - n.at < 3 * 86400000);
    if (fresh.length) {
      fresh.forEach((n) => toastedRef.current.add(n.id));
      flash(fresh.length === 1 ? `🔔 ${fresh[0].title}` : `🔔 새 알림 ${fresh.length}개 — 홈에서 확인하세요`);
      if (fresh.some((n) => n.kind === "gen")) loadServerExams();
    }
  };
  useEffect(() => {
    if (remote().kind !== "server" || !user) { setNotes([]); return; }
    pollNotes();
    const id = setInterval(() => { if (document.visibilityState === "visible") pollNotes(); }, 60000);
    const onVis = () => { if (document.visibilityState === "visible") pollNotes(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [user && user.id]);
  const unseen = notes.filter((n) => !n.seen).length;
  const markSeen = async (ids) => {
    setNotes((ns) => ns.map((n) => (ids === "all" || ids.includes(n.id) ? { ...n, seen: true } : n)));
    await remote().noteSeen(ids === "all" ? [] : ids);
  };
  const openNote = async (n) => {
    markSeen([n.id]);
    if (n.kind === "gen" && n.ref) {
      if (!examsRef.current.find((x) => x.id === n.ref)) await loadServerExams();
      if (examsRef.current.find((x) => x.id === n.ref)) return openExam(n.ref);
      return setScreen("list");
    }
    if (n.kind === "assign" && n.ref) { setCodeInput(n.ref); setCodeErr(""); setScreen("code"); return loadByCode(n.ref); }
    if (n.kind === "note") return setScreen("study");
    if (n.kind === "report") return setScreen("myresults");
    if (n.kind === "perm") return setScreen("admin");
  };

  /* ── 내비게이션(하단 탭/사이드바): 로그인 뒤, 응시·편집 중이 아닐 때만 */
  const navOn = ready && !!user && !["take", "result", "editor"].includes(screen);
  useEffect(() => { document.body.classList.toggle("em-has-nav", navOn); }, [navOn]);
  const navGo = (k) => {
    if (k === "home") return goHome();
    if (k === "code") { setCodeInput(""); setCodeErr(""); return setScreen("code"); }
    setScreen(k);
  };
  const chrome = (
    <>
      {printSrc && <PrintModal src={printSrc} onClose={() => setPrintSrc(null)} flash={flash} />}
      {acctOpen && user && <AccountModal user={user} onClose={() => setAcctOpen(false)} onLogout={logoutNow} flash={flash} onUser={(u) => { setUser(u); const a = authGet(); if (a) authSet({ token: a.token, user: u }); }} />}
      {navOn && <NavBar screen={screen} role={(user && user.role) || "admin"} go={navGo} onAccount={() => setAcctOpen(true)} user={user} badge={unseen} />}
    </>
  );

  /* ── 렌더 ──────────────────────────────────── */
  if (!ready)
    return (
      <div style={{ minHeight: "100vh", background: C.bg, fontFamily: FONT, color: C.sub, display: "flex", alignItems: "center", justifyContent: "center" }}>
        불러오는 중…
      </div>
    );

  if (remote().kind === "server" && !user)
    return <LoginScreen needSetup={needSetup} onDone={afterLogin} toast={toast} flash={flash} />;

  if (screen === "admin") return <>{<AdminScreen onBack={goHome} toast={toast} flash={flash} lite={!!user && user.role !== "admin"} user={user} onCopyExam={copyExamIn} onOpenExam={(e) => openEditor(JSON.parse(JSON.stringify(normalizeExam(e))), false)} />}{chrome}</>;
  if (screen === "students") return <>{<StudentsScreen user={user} onBack={goHome} toast={toast} flash={flash} exams={exams} onRemakePractice={practiceNow} onRemakeSave={remote().kind === "server" ? remakeSave : null} />}{chrome}</>;
  if (screen === "myresults") return <>{<MyResultsScreen user={user} onBack={goHome} toast={toast} flash={flash} onPractice={practiceExam} onMakeNote={canNote() ? makeNote : null} onWrongBank={remote().kind === "server" ? wrongBank : null} onRemakePractice={remote().kind === "server" ? practiceNow : null} onRemakeSave={remakeSave} />}{chrome}</>;

  const overlays = (
    <>
      {chrome}
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
        notes={notes}
        onOpenNote={openNote}
        onSeenAll={() => markSeen("all")}
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

  if (screen === "study") return <>{<StudyScreen onBack={() => setScreen("home")} flash={flash} toast={toast} user={user} />}{chrome}</>;

  if (screen === "list")
    return (
      <>
        <ListScreen
          exams={exams}
          toast={toast}
          user={user}
          flash={flash}
          onOpen={openExam}
          onNew={newExam}
          onDelete={removeExam}
          onDuplicate={duplicateExam}
          onImport={() => setImportOpen(true)}
          onExportAll={exportAll}
          onBack={goHome}
          onReload={() => loadServerExams(user)}
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
          onPrint={(d) => setPrintSrc(d)}
          flash={flash}
          toast={toast}
          genInit={genInit}
          genAuto={genAuto}
          onGenInitUsed={() => { setGenInit(null); setGenAuto(false); }}
        />
        {overlays}
      </>
    );

  if (screen === "code")
    return <>{<CodeScreen codeInput={codeInput} setCodeInput={setCodeInput} codeErr={codeErr} busy={busy} onLoad={() => loadByCode()} onBack={goHome} toast={toast} user={user} onOpenCode={(code) => { setCodeInput(code); setCodeErr(""); loadByCode(code); }} />}{chrome}</>;

  if (screen === "take" && run)
    return <>{<TakeScreen run={run} picked={picked} togglePick={togglePick} typed={typed} setTyped={setTyped} name={name} setName={setName} onSubmit={submit} onExit={() => { if (!run.partial && !run.preview && (Object.keys(picked).length || Object.values(typed || {}).some(Boolean))) flash("푼 답은 이 기기에 저장돼 같은 코드로 다시 열면 이어서 풉니다."); goHome(); }} toast={toast} onPrint={(d, noKey) => setPrintSrc({ ...d, noKey: !!noKey })} user={user} onManualDone={(r) => { flash(`결과를 기록했습니다. ${r.score}/${r.total}`); setScreen("myresults"); }} />}{chrome}</>;

  if (screen === "result" && result && run)
    return <>{<ResultScreen run={run} result={result} onRetryWrong={retryWrong} onRetryAll={retryAll} onHome={goHome} flash={flash} toast={toast} loggedIn={remote().kind === "server" && !!user} onMyResults={() => setScreen("myresults")} onStudy={() => setScreen("study")} resultId={resultId} canNote={canNote()} onMakeNote={makeNote} saveState={run.partial || run.preview ? null : saveState} onResend={() => sendResult(pendingRef.current)} />}{chrome}</>;

  return (
    <Shell back="홈으로" backTo={goHome} toast={toast}>
      <Card>화면을 불러오지 못했습니다. 홈으로 돌아가 주세요.</Card>
    </Shell>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<ExamMaker />);

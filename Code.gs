// 시험지 서버 (Google Apps Script + Google Sheets)
//
// 설치 순서
// 1) script.google.com 에서 새 프로젝트를 만들거나, Google Sheets 의 확장 프로그램 › Apps Script 를 엽니다.
// 2) 기본 Code.gs 내용을 이 파일 전체로 바꿉니다. (독립 프로젝트면 "시험지 데이터" 시트가 내 드라이브에 자동 생성됩니다)
// 3) 배포 › 새 배포 › 유형 선택(톱니) › 웹 앱
//    - 설명: 시험지 서버 / 실행 주체: 나 / 액세스 권한: 모든 사용자 → 배포 (권한 허용)
// 4) 나온 "웹 앱 URL" 을 사이트 index.html 의 SYNC_URL 에 넣습니다.
// 5) 서버 코드를 고친 뒤에는 배포 › 배포 관리 › 새 버전 으로 다시 배포해야 반영됩니다.
//
// 시트 두 개가 첫 요청 때 자동으로 만들어집니다.
//   quizzes : code | keyHash | title | json | createdAt | updatedAt | attempts
//   results : code | name | score | total | sec | at
// 출제자는 results 시트를 스프레드시트에서 직접 열어 볼 수도 있습니다.
//
// AI 문제 생성: 아래 'AI 문제 생성' 절의 스크립트 속성 설정 참고
//
// 보안 모델
//   - 공유 코드(5자)는 누구나 읽을 수 있습니다. (응시용)
//   - 시험지를 고치거나 지우거나 응시 기록을 보려면 출제자 키가 필요합니다.
//     키는 처음 공유할 때 서버가 만들어 출제자 기기에만 저장되고, 서버에는 해시만 남습니다.

const SHEET_QUIZ = 'quizzes';
const SHEET_RES = 'results';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I 처럼 헷갈리는 글자 제외
const RESULTS_MAX_PER_CODE = 500;   // 코드당 보관하는 응시 기록 수
const QUIZ_MAX_CHARS = 45000;       // 시트 셀 하나의 한도(50,000자) 안에서 여유를 둠
const NAME_MAX = 20;

/* ── 시트 접근 ─────────────────────────────── */
// 시트에 연결된 프로젝트면 그 시트를, 독립 프로젝트면 "시험지 데이터" 시트를 자동으로 만들어 씁니다.
function ss() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ssId');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  const created = SpreadsheetApp.create('시험지 데이터');
  props.setProperty('ssId', created.getId());
  return created;
}
function sheet(name, header) {
  let s = ss().getSheetByName(name);
  if (!s) {
    s = ss().insertSheet(name);
    s.appendRow(header);
    s.setFrozenRows(1);
  }
  return s;
}
function quizSheet() { return sheet(SHEET_QUIZ, ['code', 'keyHash', 'title', 'json', 'createdAt', 'updatedAt', 'attempts', 'ownerId']); }
function resSheet() { return sheet(SHEET_RES, ['code', 'name', 'score', 'total', 'sec', 'at', 'userId', 'detail']); }

function sha(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}
function randomKey(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function makeCode() {
  let out = '';
  for (let i = 0; i < 5; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}
function cleanCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); }
// 시트 수식으로 해석되지 않도록 앞 글자 정리
function safeText(v, max) { return String(v || '').replace(/^[=+\-@'\s]+/, '').slice(0, max); }

function findQuizRow(code) {
  const s = quizSheet();
  const last = s.getLastRow();
  if (last < 2) return null;
  const codes = s.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < codes.length; i++) if (String(codes[i][0]) === code) return i + 2;
  return null;
}
function newCode() {
  for (let i = 0; i < 30; i++) {
    const c = makeCode();
    if (!findQuizRow(c)) return c;
  }
  throw new Error('code_exhausted');
}
function resultsFor(code) {
  const s = resSheet();
  const last = s.getLastRow();
  if (last < 2) return [];
  const rows = s.getRange(2, 1, last - 1, 6).getValues();
  const items = [];
  for (let i = rows.length - 1; i >= 0; i--) { // 최신 순
    const r = rows[i];
    if (String(r[0]) !== code) continue;
    items.push({ id: String(i + 2), name: String(r[1] || ''), score: Number(r[2]) || 0, total: Number(r[3]) || 0, sec: Number(r[4]) || 0, at: Number(r[5]) || 0 });
    if (items.length >= RESULTS_MAX_PER_CODE) break;
  }
  return items;
}
function deleteResultsFor(code) {
  const s = resSheet();
  const last = s.getLastRow();
  if (last < 2) return 0;
  const codes = s.getRange(2, 1, last - 1, 1).getValues();
  let n = 0;
  for (let i = codes.length - 1; i >= 0; i--) {
    if (String(codes[i][0]) === code) { s.deleteRow(i + 2); n++; }
  }
  return n;
}
function validQuiz(q) {
  return q && typeof q === 'object' && Array.isArray(q.options) && q.options.length >= 2 &&
    Array.isArray(q.questions) && q.questions.length >= 1;
}


/* ── AI 문제 생성 (Claude API) ─────────────────
   프로젝트 설정(왼쪽 톱니) › 스크립트 속성에 아래를 추가한 뒤, 배포 › 배포 관리 › 새 버전으로 다시 배포합니다.
     GEN_ENABLED        'true' 일 때만 생성 기능이 켜짐 (없거나 다른 값이면 API 호출 자체를 하지 않음 = 비용 0)
     ANTHROPIC_API_KEY  Anthropic API 키 (console.anthropic.com 에서 발급)
     GEN_PW             생성 비밀번호 (출제자만 아는 값. 학생이 생성 기능을 쓰지 못하게 막음)
     GEN_DAILY_LIMIT    하루 생성 횟수 상한 (선택, 기본 50)
     GEN_MODEL          모델 ID (선택, 기본 claude-opus-5)
   사용 내역은 usage 시트에 쌓입니다. */
const SHEET_USAGE = 'usage';
const GEN_MAX_COUNT = 20;
const GEN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          answers: { type: 'array', items: { type: 'integer' } },
          explain: { type: 'string' },
        },
        required: ['text', 'options', 'answers', 'explain'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'questions'],
  additionalProperties: false,
};
function usageSheet() { return sheet(SHEET_USAGE, ['at', 'scope', 'count', 'model', 'inputTokens', 'outputTokens', 'ms', 'status']); }
function logUsage(scope, count, model, inTok, outTok, ms, status) {
  try { usageSheet().appendRow([new Date(), safeText(scope, 200), count, model, inTok, outTok, ms, status]); } catch (e) {}
}

/* 사용량 요약(GET action=usage&pw=생성비밀번호). 모델별 호출 수·토큰 합계와 추정 비용(USD).
   단가는 100만 토큰당 입력/출력 달러. 키·개인정보는 내보내지 않는다. */
const PRICE_PER_M = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5], 'claude-opus-4-8': [5, 25] };
function usageSummary(pw, token) {
  const props = PropertiesService.getScriptProperties();
  const want = props.getProperty('GEN_PW');
  const admin = auth(token);
  if (!isAdmin(admin) && !(want && String(pw || '') === want)) return { ok: false, error: 'forbidden' };
  const rows = usageSheet().getDataRange().getValues().slice(1);
  const byModel = {};
  let first = null, last = null;
  rows.forEach(function (r) {
    const at = r[0], model = String(r[3] || '?'), inTok = Number(r[4]) || 0, outTok = Number(r[5]) || 0, status = String(r[7] || '');
    if (at instanceof Date) { if (!first || at < first) first = at; if (!last || at > last) last = at; }
    const m = byModel[model] || (byModel[model] = { calls: 0, ok: 0, inputTokens: 0, outputTokens: 0, usd: 0 });
    m.calls++; if (status === 'ok') m.ok++;
    m.inputTokens += inTok; m.outputTokens += outTok;
    const price = PRICE_PER_M[model] || [5, 25];
    m.usd += inTok / 1e6 * price[0] + outTok / 1e6 * price[1];
  });
  let total = 0; Object.keys(byModel).forEach(function (k) { byModel[k].usd = Math.round(byModel[k].usd * 10000) / 10000; total += byModel[k].usd; });
  return { ok: true, rows: rows.length, first: first, last: last, byModel: byModel, totalUsd: Math.round(total * 10000) / 10000 };
}

/* 비용 차단 스위치: 스크립트 속성 GEN_ENABLED 가 정확히 'true' 일 때만 Claude API 를 호출한다.
   기본(속성 없음)은 꺼짐 → 키가 등록돼 있어도 요금이 발생하지 않는다. */
function genEnabled() { return PropertiesService.getScriptProperties().getProperty('GEN_ENABLED') === 'true'; }

function generate(body) {
  if (!genEnabled()) return { ok: false, error: 'gen_disabled' };
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('ANTHROPIC_API_KEY');
  const pw = props.getProperty('GEN_PW');
  if (!key || !pw) return { ok: false, error: 'gen_not_configured' };
  if (String(body.pw || '') !== pw) return { ok: false, error: 'bad_pw' };
  const limit = Number(props.getProperty('GEN_DAILY_LIMIT')) || 50;
  const dayKey = 'gen:' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  const used = Number(props.getProperty(dayKey)) || 0;
  if (used >= limit) return { ok: false, error: 'gen_limit' };

  const scope = String(body.scope || '').trim().slice(0, 500);
  if (!scope) return { ok: false, error: 'bad_scope' };
  const material = String(body.material || '').trim().slice(0, 20000);
  const count = Math.min(GEN_MAX_COUNT, Math.max(1, Math.floor(Number(body.count) || 10)));
  const difficulty = { '하': '쉬움 (기본 개념 확인)', '중': '보통 (개념 적용)', '상': '어려움 (추론·비교·응용)' }[body.difficulty] || '보통 (개념 적용)';
  const kindText = body.kind === 'tf'
    ? '참·거짓 문제. options 는 정확히 ["참", "거짓"] 두 개이고 정답은 하나.'
    : body.kind === 'multi'
    ? '객관식. 보기 4~5개. 문제의 절반 정도는 정답이 2개 이상이 되게 하고, 그런 문제는 본문에 "모두 고르시오"를 넣는다.'
    : '객관식. 보기 4개. 정답은 정확히 하나.';
  const model = props.getProperty('GEN_MODEL') || 'claude-opus-5';

  const system =
    '당신은 한국 학교 교사를 돕는 출제 도우미입니다. 요청한 범위에 맞는 평가 문제를 한국어로 만듭니다.\n' +
    '규칙:\n' +
    '- 문제는 서로 겹치지 않게, 범위 안의 핵심 개념을 고르게 다룹니다.\n' +
    '- 정답은 논쟁의 여지가 없게 명확히 하고, 오답 보기는 흔한 오개념을 반영해 그럴듯하게 만듭니다.\n' +
    '- answers 는 options 배열의 0부터 시작하는 인덱스입니다.\n' +
    '- 각 문제에 한두 문장의 해설(explain)을 씁니다.\n' +
    '- 자료가 주어지면 자료의 내용만 근거로 출제합니다.\n' +
    '- title 은 범위를 요약한 짧은 시험지 제목입니다.';
  const user = '범위: ' + scope + '\n문제 수: ' + count + '\n난이도: ' + difficulty + '\n유형: ' + kindText + (material ? '\n\n[자료]\n' + material : '');

  const req = {
    model: model,
    max_tokens: 8000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: GEN_SCHEMA } },
    fallbacks: 'default',
    system: system,
    messages: [{ role: 'user', content: user }],
  };
  const t0 = Date.now();
  let res, code;
  try {
    res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      payload: JSON.stringify(req),
      muteHttpExceptions: true,
    });
    code = res.getResponseCode();
  } catch (err) {
    logUsage(scope, count, model, 0, 0, Date.now() - t0, 'fetch_error');
    return { ok: false, error: 'api', message: String(err) };
  }
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  const usage = data.usage || {};
  const ms = Date.now() - t0;
  if (code !== 200) {
    logUsage(scope, count, model, 0, 0, ms, 'http_' + code);
    return { ok: false, error: 'api', message: (data.error && data.error.message) || ('HTTP ' + code) };
  }
  if (data.stop_reason === 'refusal') {
    logUsage(scope, count, model, usage.input_tokens || 0, usage.output_tokens || 0, ms, 'refusal');
    return { ok: false, error: 'refused' };
  }
  if (data.stop_reason === 'max_tokens') {
    logUsage(scope, count, model, usage.input_tokens || 0, usage.output_tokens || 0, ms, 'truncated');
    return { ok: false, error: 'truncated' };
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch (err) {
    logUsage(scope, count, model, usage.input_tokens || 0, usage.output_tokens || 0, ms, 'bad_json');
    return { ok: false, error: 'api', message: '응답을 해석하지 못했습니다.' };
  }
  const questions = (Array.isArray(out.questions) ? out.questions : [])
    .map(q => ({
      text: String(q.text || '').trim(),
      options: (Array.isArray(q.options) ? q.options : []).map(o => String(o || '').trim()),
      answers: Array.isArray(q.answers) ? q.answers.filter(a => Number.isInteger(a)) : [],
      explain: String(q.explain || '').trim(),
    }))
    .filter(q => q.text && q.options.length >= 2 && q.options.every(Boolean) && q.answers.length && q.answers.every(a => a >= 0 && a < q.options.length))
    .slice(0, count);
  props.setProperty(dayKey, String(used + 1));
  logUsage(scope, questions.length, model, usage.input_tokens || 0, usage.output_tokens || 0, ms, 'ok');
  return { ok: true, title: String(out.title || scope).slice(0, 80), questions: questions, remaining: limit - used - 1 };
}

/* ── 읽기 (GET) ────────────────────────────── */
const READ_ACTIONS = ['ping', 'quiz', 'results', 'usage', 'me', 'userList', 'examList', 'myResults', 'studentResults', 'allResults', 'reportGet', 'assignList', 'sh_list', 'sh_detail', 'sh_note'];
function doGet(e) { return readAction((e && e.parameter) || {}); }
// 조회 동작. 사이트는 토큰을 주소에 싣지 않도록 POST 로 보내고, 워커·구형 호출은 GET 그대로.
function readAction(p) {
  const a = p.action;
  try {
    if (a === 'ping') return out({ ok: true, v: 2, gen: !!geminiKey(), setup: usersCount() === 0 });

    if (a === 'quiz') {
      const code = cleanCode(p.code);
      const row = findQuizRow(code);
      if (!row) return out({ ok: false, error: 'not_found' });
      const json = quizSheet().getRange(row, 4).getValue();
      let quiz;
      try { quiz = JSON.parse(json); } catch (err) { return out({ ok: false, error: 'corrupt' }); }
      const ownerId = String(quizSheet().getRange(row, 8).getValue() || '');
      const viewer = auth(p.token);
      const isOwner = !!viewer && (viewer.role === 'admin' || (ownerId && ownerId === viewer.id));
      const now = Date.now();
      if (!isOwner && Number(quiz.openAt) && now < Number(quiz.openAt)) return out({ ok: false, error: 'not_open', openAt: Number(quiz.openAt) });
      if (!isOwner && Number(quiz.closeAt) && now > Number(quiz.closeAt)) return out({ ok: false, error: 'closed', closeAt: Number(quiz.closeAt) });
      const ow = ownerId ? findUser(ownerId) : null;
      return out({ ok: true, code: code, quiz: quiz, owner: ow ? ow.name : '', preview: isOwner && !!(Number(quiz.openAt) && now < Number(quiz.openAt) || Number(quiz.closeAt) && now > Number(quiz.closeAt)) });
    }

    if (a === 'results') {
      const code = cleanCode(p.code);
      const row = findQuizRow(code);
      if (!row) return out({ ok: false, error: 'not_found' });
      const viewer = auth(p.token);
      const owner = String(quizSheet().getRange(row, 8).getValue() || '');
      const okKey = p.key && sha(p.key) === String(quizSheet().getRange(row, 2).getValue());
      const okTeacher = viewer && viewer.role === 'teacher' && owner && (findUser(owner) || {}).teacherId === viewer.id;
      const okUser = viewer && (viewer.role === 'admin' || (owner && owner === viewer.id) || okTeacher);
      if (!okKey && !okUser) return out({ ok: false, error: 'bad_key' });
      return out({ ok: true, items: resultsWithDetail(r => String(r[0]) === code, RESULTS_MAX_PER_CODE) });
    }

    if (a === 'usage') return out(usageSummary(p.pw, p.token));

    if (a === 'me') return out(me(p));
    if (a === 'userList') return out(userList(p));
    if (a === 'examList') return out(examList(p));
    if (a === 'myResults') return out(myResults(p));
    if (a === 'studentResults') return out(studentResults(p));
    if (a === 'allResults') return out(allResults(p));
    if (a === 'reportGet') return out(reportGet(p));
    if (a === 'assignList') return out(assignList(p));
    if (a === 'reportPending') return out(reportPending(p));

    if (a === 'sh_list') return out(shList(p));
    if (a === 'sh_detail') return out(shDetail(p));
    if (a === 'sh_note') return out(shNote(p));
    if (a === 'sh_pending') return out(shPending(p));
    if (a === 'sh_file') return out(shFile(p));

    return out({ ok: false, error: 'bad_action' });
  } catch (err) {
    return out({ ok: false, error: 'server', message: String(err) });
  }
}

/* ── 쓰기 (POST, 본문은 JSON 문자열) ──────── */
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad_json' }); }
  const a = body.action;
  if (READ_ACTIONS.indexOf(a) >= 0) return readAction(body);
  // AI 생성은 오래 걸리므로 잠금 없이 처리 (시트에는 사용 기록만 추가)
  if (a === 'generate') {
    try { return out(generateGemini(body)); } catch (err) { return out({ ok: false, error: 'server', message: String(err) }); }
  }
  if (a === 'login' || a === 'logout' || a === 'setup' || a === 'changePw') {
    try {
      if (a === 'login') return out(login(body));
      if (a === 'logout') return out(logout(body));
      if (a === 'setup') return out(setup(body));
      return out(changePw(body));
    } catch (err) { return out({ ok: false, error: 'server', message: String(err) }); }
  }
  if (a === 'reportPut') { try { return out(reportPut(body)); } catch (err) { return out({ ok: false, error: 'server', message: String(err) }); } }
  if (a === 'reportRequest') { try { return out(reportRequest(body)); } catch (err) { return out({ ok: false, error: 'server', message: String(err) }); } }
  // 학습 도우미: 사진 업로드·결과 저장은 드라이브 쓰기라 오래 걸릴 수 있어 잠금 없이 처리
  if (a === 'sh_upload' || a === 'sh_result' || a === 'sh_fetched' || a === 'sh_confirm') {
    try {
      if (a === 'sh_upload') return out(shUpload(body));
      if (a === 'sh_result') return out(shResult(body));
      if (a === 'sh_fetched') return out(shFetched(body));
      return out(shConfirm(body));
    } catch (err) { return out({ ok: false, error: 'server', message: String(err) }); }
  }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return out({ ok: false, error: 'busy' });
  }
  try {
    if (a === 'share') return out(share(body));
    if (a === 'delete') return out(remove(body));
    if (a === 'submit') return out(submit(body));
    if (a === 'clearResults') return out(clearResults(body));
    if (a === 'userCreate') return out(userCreate(body));
    if (a === 'userUpdate') return out(userUpdate(body));
    if (a === 'userDelete') return out(userDelete(body));
    if (a === 'examSave') return out(examSave(body));
    if (a === 'examDelete') return out(examDelete(body));
    if (a === 'assignSet') return out(assignSet(body));
    if (a === 'assignRemove') return out(assignRemove(body));
    if (a === 'profileUpdate') return out(profileUpdate(body));
    if (a === 'resultDelete') return out(resultDelete(body));
    if (a === 'workerKeySet') return out(workerKeySet(body));
    if (a === 'resetTestUsers') return out(resetTestUsers(body));
    return out({ ok: false, error: 'bad_action' });
  } catch (err) {
    return out({ ok: false, error: 'server', message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// 새 시험지 공유(코드·키 발급) 또는 기존 코드 갱신(키 필요)
function share(body) {
  const quiz = body.quiz;
  if (!validQuiz(quiz)) return { ok: false, error: 'bad_quiz' };
  const json = JSON.stringify(quiz);
  if (json.length > QUIZ_MAX_CHARS) return { ok: false, error: 'too_big' };
  const title = safeText(quiz.title, 80);
  const now = Date.now();
  const s = quizSheet();

  const user = auth(body.token);
  const code = cleanCode(body.code);
  if (code) {
    const row = findQuizRow(code);
    if (row) {
      const owner = String(s.getRange(row, 8).getValue() || '');
      const okKey = body.key && sha(body.key) === String(s.getRange(row, 2).getValue());
      const okUser = user && (user.role === 'admin' || (owner && owner === user.id));
      if (!okKey && !okUser) return { ok: false, error: 'bad_key' };
      s.getRange(row, 3, 1, 4).setValues([[title, json, s.getRange(row, 5).getValue(), now]]);
      if (user && !owner) s.getRange(row, 8).setValue(user.id);
      return { ok: true, code: code, updated: true };
    }
    // 코드가 서버에 없으면(예: 지워짐) 새 코드로 발급
  }
  if (!user) return { ok: false, error: 'bad_token' };   // 새 코드 발급은 로그인 계정만
  const newC = newCode();
  const key = randomKey(24);
  s.appendRow([newC, sha(key), title, json, now, now, 0, user.id]);
  return { ok: true, code: newC, key: key, updated: false };
}

function remove(body) {
  const code = cleanCode(body.code);
  const s = quizSheet();
  const row = findQuizRow(code);
  if (!row) return { ok: true, gone: true };
  const user = auth(body.token);
  const owner = String(s.getRange(row, 8).getValue() || '');
  const okKey = body.key && sha(body.key) === String(s.getRange(row, 2).getValue());
  const okUser = user && (user.role === 'admin' || (owner && owner === user.id));
  if (!okKey && !okUser) return { ok: false, error: 'bad_key' };
  s.deleteRow(row);
  deleteResultsFor(code);
  deleteAssignFor(code);
  return { ok: true };
}

function submit(body) {
  const code = cleanCode(body.code);
  const s = quizSheet();
  const row = findQuizRow(code);
  if (!row) return { ok: false, error: 'not_found' };
  const en = body.entry && typeof body.entry === 'object' ? body.entry : {};
  const score = Math.max(0, Math.floor(Number(en.score) || 0));
  const total = Math.max(1, Math.floor(Number(en.total) || 0));
  if (score > total) return { ok: false, error: 'bad_entry' };
  const user = auth(body.token);
  if (!user) return { ok: false, error: 'bad_token' };   // 결과 제출은 로그인 계정만(이름 위조·익명 기록 방지)
  try {
    const qz = JSON.parse(s.getRange(row, 4).getValue());
    const owner = String(s.getRange(row, 8).getValue() || '');
    if (Number(qz.closeAt) && Date.now() > Number(qz.closeAt) + 120000 && user.role !== 'admin' && owner !== user.id) return { ok: false, error: 'closed' };
  } catch (err) {}
  let detail = '';
  if (Array.isArray(en.detail)) { detail = JSON.stringify(en.detail.slice(0, 200).map(d => ({ q: String(d.q || '').slice(0, 40), m: Array.isArray(d.m) ? d.m.slice(0, 12) : [], ok: !!d.ok }))); if (detail.length > SH_CELL_MAX) detail = ''; }
  resSheet().appendRow([code, safeText(user ? user.name : en.name, NAME_MAX), score, total, Math.max(0, Math.round(Number(en.sec) || 0)), Date.now(), user ? user.id : '', detail]);
  archiveOldResults();
  const cell = s.getRange(row, 7);
  cell.setValue((Number(cell.getValue()) || 0) + 1);
  return { ok: true };
}

// 보관 정책: results 가 3,000행을 넘으면 1년 지난 행을 results_archive 시트로 옮긴다(삭제하지 않음)
function archiveOldResults() {
  const s = resSheet(); const n = s.getLastRow();
  if (n < 3000) return;
  const cutoff = Date.now() - 365 * 86400000;
  const rows = s.getRange(2, 1, n - 1, 8).getValues();
  const arch = sheet('results_archive', ['code', 'name', 'score', 'total', 'sec', 'at', 'userId', 'detail']);
  const move = [];
  for (let i = rows.length - 1; i >= 0; i--) if ((Number(rows[i][5]) || 0) < cutoff) { move.push(rows[i]); s.deleteRow(i + 2); }
  if (move.length) arch.getRange(arch.getLastRow() + 1, 1, move.length, 8).setValues(move);
}
function clearResults(body) {
  const code = cleanCode(body.code);
  const s = quizSheet();
  const row = findQuizRow(code);
  if (!row) return { ok: false, error: 'not_found' };
  const user = auth(body.token);
  const owner = String(s.getRange(row, 8).getValue() || '');
  const okKey = body.key && sha(body.key) === String(s.getRange(row, 2).getValue());
  const okUser = user && (user.role === 'admin' || (owner && owner === user.id));
  if (!okKey && !okUser) return { ok: false, error: 'bad_key' };
  const n = deleteResultsFor(code);
  return { ok: true, removed: n };
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}


/* ── 학습 도우미 (오답노트) ─────────────────────
   사이트에서 올린 문제지 사진을 드라이브에 보관하고, PC 워커(Claude 예약 작업)가 가져가 처리한 뒤
   결과(오답노트 HTML·정답표·확인 질문)를 다시 올리면 사이트가 보여 준다.
   연결 코드(key): PC 의 study-helper\sync.json 이 만든 임의 문자열. 서버는 sha(key) 로 공간을 나눈다.
   시트  sh_files : id | kh | worksheet | filename | driveId | at | fetched
         sh_ws    : kh | worksheet | status | summary | noteDriveId | confirm | questions | createdAt | updatedAt
   드라이브 폴더 "학습도우미/<kh 앞 12자>" 에 사진과 note.html 저장 */
const SH_FOLDER = '학습도우미';
const SH_FILE_MAX = 12 * 1024 * 1024;   // 사진 1장 base64 상한(약 9MB 원본)
const SH_CELL_MAX = 45000;

// 최초 1회: Apps Script 편집기에서 이 함수를 실행해 드라이브 권한을 승인한다(웹 앱 배포 뒤에도 필요).
function shAuthorize() { shFolder('setup'); shFilesSheet(); shWsSheet(); return 'ok'; }

function shFilesSheet() { return sheet('sh_files', ['id', 'kh', 'worksheet', 'filename', 'driveId', 'at', 'fetched', 'ownerId']); }
function shWsSheet() { return sheet('sh_ws', ['kh', 'worksheet', 'status', 'summary', 'noteDriveId', 'confirm', 'questions', 'createdAt', 'updatedAt', 'ownerId']); }
// 오답노트 열람 권한: 본인, 관리자, 담당 선생(학생의 것). 소유자가 비어 있는 옛 문제지는 관리자만.
function shCanSee(u, owner) {
  if (!u) return false;
  if (u.role === 'admin') return true;
  if (!owner) return false;
  if (owner === u.id) return true;
  return u.role === 'teacher' && (findUser(owner) || {}).teacherId === u.id;
}
function shOwnerOf(row) { return String(shWsSheet().getRange(row, 10).getValue() || ''); }
function shKh(key) {
  const k = String(key || '').trim();
  if (k.length < 8 || k.length > 64) return null;
  return sha(k);
}
function shWsName(v) { return safeText(String(v || '').replace(/[\\/:*?"<>|]+/g, ''), 60).replace(/\s+/g, '_'); }
function shFolder(kh) {
  const root = DriveApp.getRootFolder();
  let top = root.getFoldersByName(SH_FOLDER);
  top = top.hasNext() ? top.next() : root.createFolder(SH_FOLDER);
  const name = kh.slice(0, 12);
  let sub = top.getFoldersByName(name);
  return sub.hasNext() ? sub.next() : top.createFolder(name);
}
function shFindWsRow(kh, ws) {
  const s = shWsSheet();
  const n = s.getLastRow();
  if (n < 2) return 0;
  const vals = s.getRange(2, 1, n - 1, 2).getValues();
  for (let i = 0; i < vals.length; i++) if (vals[i][0] === kh && vals[i][1] === ws) return i + 2;
  return 0;
}
function shEnsureWs(kh, ws, status, ownerId) {
  const s = shWsSheet();
  const row = shFindWsRow(kh, ws);
  const now = Date.now();
  if (row) { if (ownerId && !shOwnerOf(row)) s.getRange(row, 10).setValue(ownerId); return row; }
  s.appendRow([kh, ws, status || 'uploaded', '', '', '', '', now, now, ownerId || '']);
  return s.getLastRow();
}
function shParse(v, dflt) { try { return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }

// 사진 업로드: {key, worksheet, filename, data(base64), mime}
function shUpload(body) {
  const user = auth(body.token); if (!user) return { ok: false, error: 'bad_token' };
  const kh = shKh(body.key); if (!kh) return { ok: false, error: 'bad_key' };
  const ws = shWsName(body.worksheet); if (!ws) return { ok: false, error: 'bad_worksheet' };
  const data = String(body.data || '');
  if (!data || data.length > SH_FILE_MAX) return { ok: false, error: 'too_big' };
  const mime = /png/i.test(body.mime || '') ? 'image/png' : 'image/jpeg';
  const ext = mime === 'image/png' ? '.png' : '.jpg';
  const filename = safeText(String(body.filename || 'photo').replace(/[\\/:*?"<>|]+/g, ''), 60) || 'photo';
  const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd_HHmmss');
  const name = ws + '__' + stamp + '_' + filename.replace(/\.(jpe?g|png)$/i, '') + ext;
  const blob = Utilities.newBlob(Utilities.base64Decode(data), mime, name);
  const file = shFolder(kh).createFile(blob);
  const id = randomKey(10);
  const row0 = shFindWsRow(kh, ws);
  if (row0 && !shCanSee(user, shOwnerOf(row0))) return { ok: false, error: 'forbidden' };   // 남의 문제지 이름에 덧붙이기 방지
  shFilesSheet().appendRow([id, kh, ws, name, file.getId(), Date.now(), '', user.id]);
  shEnsureWs(kh, ws, 'uploaded', user.id);
  return { ok: true, id: id, worksheet: ws };
}

// 사이트 목록: {key}
function shList(p) {
  const user = auth(p.token); if (!user) return { ok: false, error: 'bad_token' };
  const kh = shKh(p.key); if (!kh) return { ok: false, error: 'bad_key' };
  const photos = {};
  const fs = shFilesSheet(); const fn = fs.getLastRow();
  if (fn >= 2) fs.getRange(2, 1, fn - 1, 7).getValues().forEach(r => { if (r[1] === kh) photos[r[2]] = (photos[r[2]] || 0) + 1; });
  const s = shWsSheet(); const n = s.getLastRow();
  const list = [];
  if (n >= 2) s.getRange(2, 1, n - 1, 10).getValues().forEach(r => {
    if (r[0] !== kh) return;
    if (!shCanSee(user, String(r[9] || ''))) return;
    const confirm = shParse(r[5], []);
    list.push({ name: r[1], status: r[2] || 'uploaded', summary: shParse(r[3], null), hasNote: !!r[4], owner: String(r[9] || ''),
      pending: confirm.filter(c => !c.answer).length, photos: photos[r[1]] || 0, updatedAt: r[8] || r[7] });
  });
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, worksheets: list };
}

// 사이트 상세: {key, ws}
function shDetail(p) {
  const user = auth(p.token); if (!user) return { ok: false, error: 'bad_token' };
  const kh = shKh(p.key); if (!kh) return { ok: false, error: 'bad_key' };
  const ws = shWsName(p.ws);
  const row = shFindWsRow(kh, ws); if (!row) return { ok: false, error: 'not_found' };
  if (!shCanSee(user, shOwnerOf(row))) return { ok: false, error: 'forbidden' };
  const r = shWsSheet().getRange(row, 1, 1, 9).getValues()[0];
  return { ok: true, name: ws, status: r[2], summary: shParse(r[3], null), hasNote: !!r[4], confirm: shParse(r[5], []), questions: shParse(r[6], []), updatedAt: r[8] };
}

// 오답노트 HTML: {key, ws}
function shNote(p) {
  const user = auth(p.token); if (!user) return { ok: false, error: 'bad_token' };
  const kh = shKh(p.key); if (!kh) return { ok: false, error: 'bad_key' };
  const row = shFindWsRow(kh, shWsName(p.ws)); if (!row) return { ok: false, error: 'not_found' };
  if (!shCanSee(user, shOwnerOf(row))) return { ok: false, error: 'forbidden' };
  const id = shWsSheet().getRange(row, 5).getValue();
  if (!id) return { ok: false, error: 'no_note' };
  return { ok: true, html: DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8') };
}

// 확인 질문 답 저장: {key, worksheet, answers:{id: text}}
function shConfirm(body) {
  const user = auth(body.token); if (!user) return { ok: false, error: 'bad_token' };
  const kh = shKh(body.key); if (!kh) return { ok: false, error: 'bad_key' };
  const ws = shWsName(body.worksheet);
  const row = shFindWsRow(kh, ws); if (!row) return { ok: false, error: 'not_found' };
  if (!shCanSee(user, shOwnerOf(row))) return { ok: false, error: 'forbidden' };
  const s = shWsSheet();
  const items = shParse(s.getRange(row, 6).getValue(), []);
  const answers = body.answers || {};
  let n = 0;
  items.forEach(c => { const v = safeText(answers[c.id], 300); if (v && !c.answer) { c.answer = v; c.answeredAt = Date.now(); n++; } });
  s.getRange(row, 6).setValue(JSON.stringify(items));
  s.getRange(row, 9).setValue(Date.now());
  return { ok: true, saved: n };
}

// 워커: 아직 안 가져간 사진 + 답이 채워진 확인 질문: {key}
function shPending(p) {
  const kh = shKh(p.key); if (!kh) return { ok: false, error: 'bad_key' };
  const files = [];
  const fs = shFilesSheet(); const fn = fs.getLastRow();
  if (fn >= 2) fs.getRange(2, 1, fn - 1, 7).getValues().forEach(r => { if (r[1] === kh && !r[6]) files.push({ id: r[0], worksheet: r[2], filename: r[3] }); });
  const confirms = [];
  const s = shWsSheet(); const n = s.getLastRow();
  if (n >= 2) s.getRange(2, 1, n - 1, 9).getValues().forEach(r => {
    if (r[0] !== kh) return;
    const items = shParse(r[5], []).filter(c => c.answer);
    if (items.length) confirms.push({ worksheet: r[1], items: items });
  });
  return { ok: true, files: files, confirms: confirms };
}

// 워커: 사진 내려받기: {key, id}
function shFile(p) {
  const kh = shKh(p.key); if (!kh) return { ok: false, error: 'bad_key' };
  const fs = shFilesSheet(); const fn = fs.getLastRow();
  if (fn < 2) return { ok: false, error: 'not_found' };
  const rows = fs.getRange(2, 1, fn - 1, 7).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === String(p.id) && rows[i][1] === kh) {
      const blob = DriveApp.getFileById(rows[i][4]).getBlob();
      return { ok: true, worksheet: rows[i][2], filename: rows[i][3], data: Utilities.base64Encode(blob.getBytes()) };
    }
  }
  return { ok: false, error: 'not_found' };
}

// 워커: 가져간 사진 표시: {key, ids:[...]}
function shFetched(body) {
  const kh = shKh(body.key); if (!kh) return { ok: false, error: 'bad_key' };
  const ids = (body.ids || []).map(String);
  const fs = shFilesSheet(); const fn = fs.getLastRow();
  let n = 0;
  if (fn >= 2) {
    const rows = fs.getRange(2, 1, fn - 1, 7).getValues();
    for (let i = 0; i < rows.length; i++) if (rows[i][1] === kh && ids.indexOf(String(rows[i][0])) >= 0) { fs.getRange(i + 2, 7).setValue(Date.now()); n++; }
  }
  return { ok: true, marked: n };
}

// 워커: 결과 올리기: {key, worksheet, status, summary, questions(간단 정답표), confirm(항목), note(html, 선택)}
function shResult(body) {
  const kh = shKh(body.key); if (!kh) return { ok: false, error: 'bad_key' };
  const ws = shWsName(body.worksheet); if (!ws) return { ok: false, error: 'bad_worksheet' };
  const s = shWsSheet();
  const row = shEnsureWs(kh, ws, body.status || 'in_progress');
  const summary = JSON.stringify(body.summary || {}).slice(0, SH_CELL_MAX);
  const questions = JSON.stringify(body.questions || []).slice(0, SH_CELL_MAX);
  // 확인 질문: 서버에 이미 답이 있으면 유지
  const prev = shParse(s.getRange(row, 6).getValue(), []);
  const merged = (body.confirm || []).map(c => { const o = prev.find(x => x.id === c.id); return (o && o.answer && !c.answer) ? Object.assign({}, c, { answer: o.answer, answeredAt: o.answeredAt }) : c; });
  let noteId = s.getRange(row, 5).getValue();
  if (body.note) {
    const blob = Utilities.newBlob(String(body.note), 'text/html', ws + '__note.html');
    if (noteId) { try { DriveApp.getFileById(noteId).setContent(String(body.note)); } catch (e) { noteId = shFolder(kh).createFile(blob).getId(); } }
    else noteId = shFolder(kh).createFile(blob).getId();
  }
  s.getRange(row, 3, 1, 7).setValues([[String(body.status || 'in_progress'), summary, noteId || '', JSON.stringify(merged).slice(0, SH_CELL_MAX), questions, s.getRange(row, 8).getValue() || Date.now(), Date.now()]]);
  return { ok: true, worksheet: ws };
}


/* ── 계정·권한 ─────────────────────────────────
   역할: admin(관리자) / teacher(선생) / student(학생). 사이트는 로그인 후에만 쓴다.
   시트 users    : id | role | name | pwHash | salt | teacherId | createdAt | active
        sessions : token | userId | createdAt | lastAt
        exams    : id | ownerId | title | json | code | updatedAt        (계정별 시험지 초안 저장)
        reports  : userId | driveId | summary | basis | updatedAt        (학생별 분석 리포트, HTML 은 드라이브)
   비밀번호는 salt+SHA-256 해시로만 저장. 토큰은 60일 유효. 첫 관리자는 users 가 비어 있을 때 setup 으로 만든다. */
const SESSION_DAYS = 60;
const EXAM_MAX_CHARS = 45000;
const ID_RE = /^[\p{L}\p{N}_.-]{2,30}$/u;   // 한글·영문·숫자·_ . - (2~30자)

function usersSheet() { return sheet('users', ['id', 'role', 'name', 'pwHash', 'salt', 'teacherId', 'createdAt', 'active', 'subjects']); }
function sessionsSheet() { return sheet('sessions', ['token', 'userId', 'createdAt', 'lastAt']); }
function examsSheet() { return sheet('exams', ['id', 'ownerId', 'title', 'json', 'code', 'updatedAt']); }
function reportsSheet() { return sheet('reports', ['userId', 'driveId', 'summary', 'basis', 'updatedAt']); }

const PW_ROUNDS = 3000;   // 해시 반복 횟수(역산 비용을 키움). 저장 형식 'v2:' + 해시
function hashPw(pw, salt) {
  let h = sha(salt + ':' + String(pw || ''));
  for (let i = 0; i < PW_ROUNDS; i++) h = sha(h + salt);
  return 'v2:' + h;
}
function hashPwLegacy(pw, salt) { return sha(salt + ':' + String(pw || '')); }
function pwMatches(pw, u) { return u.pwHash.indexOf('v2:') === 0 ? hashPw(pw, u.salt) === u.pwHash : hashPwLegacy(pw, u.salt) === u.pwHash; }
// 로그인 실패 잠금: 아이디당 10회 실패 → 15분
function lockKey(id) { return 'lock:' + id; }
function isLocked(id) { return Number(CacheService.getScriptCache().get(lockKey(id)) || 0) >= 10; }
function noteFail(id) { const c = CacheService.getScriptCache(); const n = Number(c.get(lockKey(id)) || 0) + 1; c.put(lockKey(id), String(n), 900); return n; }
function clearFail(id) { CacheService.getScriptCache().remove(lockKey(id)); }
function cleanId(v) { const s = String(v || '').trim().normalize('NFC').toLowerCase(); return ID_RE.test(s) ? s : ''; }
function usersCount() { return Math.max(0, usersSheet().getLastRow() - 1); }
function allUsers() {
  const s = usersSheet(); const n = s.getLastRow();
  if (n < 2) return [];
  return s.getRange(2, 1, n - 1, 9).getValues().map((r, i) => ({ row: i + 2, id: String(r[0]), role: String(r[1]), name: String(r[2]), pwHash: String(r[3]), salt: String(r[4]), teacherId: String(r[5] || ''), createdAt: Number(r[6]) || 0, active: r[7] !== false && r[7] !== 'FALSE' && r[7] !== 0, subjects: String(r[8] || '') }));
}
// 수강 과목: 배열 또는 쉼표 문자열 → 최대 10개, 각 20자
function cleanSubjects(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  const seen = {}; const out = [];
  arr.forEach(x => { const t = safeText(String(x || '').trim(), 20); if (t && !seen[t] && out.length < 10) { seen[t] = 1; out.push(t); } });
  return out.join(',');
}
function subjectsOf(u) { return u.subjects ? u.subjects.split(',').filter(Boolean) : []; }
function findUser(id) { id = cleanId(id); return id ? allUsers().find(u => u.id === id) || null : null; }
function pubUser(u) { return { id: u.id, role: u.role, name: u.name, teacherId: u.teacherId, active: u.active, createdAt: u.createdAt, subjects: subjectsOf(u) }; }

function auth(token) {
  token = String(token || '').trim();
  if (token.length < 20) return null;
  const s = sessionsSheet(); const n = s.getLastRow();
  if (n < 2) return null;
  const rows = s.getRange(2, 1, n - 1, 4).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) !== token) continue;
    if (Date.now() - (Number(rows[i][2]) || 0) > SESSION_DAYS * 86400000) { s.deleteRow(i + 2); return null; }
    const u = findUser(rows[i][1]);
    if (!u || !u.active) return null;
    if (Date.now() - (Number(rows[i][3]) || 0) > 3600000) s.getRange(i + 2, 4).setValue(Date.now());
    return u;
  }
  return null;
}
function isAdmin(u) { return !!u && u.role === 'admin'; }
function canSeeStudent(u, studentId) {
  if (!u) return false;
  if (u.role === 'admin' || u.id === studentId) return true;
  const st = findUser(studentId);
  return !!st && u.role === 'teacher' && st.teacherId === u.id;
}

// 첫 관리자 만들기 (users 가 비어 있을 때만)
function setup(body) {
  if (usersCount() > 0) return { ok: false, error: 'already_setup' };
  const id = cleanId(body.id); const pw = String(body.pw || '');
  if (!id) return { ok: false, error: 'bad_id' };
  if (pw.length < 4) return { ok: false, error: 'bad_pw' };
  const salt = randomKey(16);
  usersSheet().appendRow([id, 'admin', safeText(body.name || id, NAME_MAX), hashPw(pw, salt), salt, '', Date.now(), true]);
  return login({ id: id, pw: pw });
}

function login(body) {
  const id = cleanId(body.id);
  if (id && isLocked(id)) return { ok: false, error: 'locked' };
  const u = findUser(id);
  if (!u || !u.active || !pwMatches(body.pw, u)) { if (id) noteFail(id); return { ok: false, error: 'bad_login' }; }
  clearFail(id);
  if (u.pwHash.indexOf('v2:') !== 0) { // 예전 방식 해시는 로그인 성공 때 새 방식으로 바꿔 저장
    const salt = randomKey(16);
    usersSheet().getRange(u.row, 4, 1, 2).setValues([[hashPw(body.pw, salt), salt]]);
  }
  const token = randomKey(40);
  const ss2 = sessionsSheet();
  if (ss2.getLastRow() > 200) {   // 만료 세션 정리
    const rows = ss2.getRange(2, 1, ss2.getLastRow() - 1, 4).getValues();
    for (let i = rows.length - 1; i >= 0; i--) if (Date.now() - (Number(rows[i][2]) || 0) > SESSION_DAYS * 86400000) ss2.deleteRow(i + 2);
  }
  ss2.appendRow([token, u.id, Date.now(), Date.now()]);
  return { ok: true, token: token, user: pubUser(u) };
}
function logout(body) {
  const s = sessionsSheet(); const n = s.getLastRow();
  if (n >= 2) {
    const rows = s.getRange(2, 1, n - 1, 1).getValues();
    for (let i = rows.length - 1; i >= 0; i--) if (String(rows[i][0]) === String(body.token || '')) s.deleteRow(i + 2);
  }
  return { ok: true };
}
function me(p) {
  const u = auth(p.token);
  return u ? { ok: true, user: pubUser(u) } : { ok: false, error: 'bad_token' };
}

// 관리자: 계정 목록 / 선생: 내 학생 목록
function userList(p) {
  const u = auth(p.token); if (!u) return { ok: false, error: 'bad_token' };
  const all = allUsers().map(pubUser);
  if (u.role === 'admin') return { ok: true, users: all };
  if (u.role === 'teacher') return { ok: true, users: all.filter(x => x.role === 'student' && x.teacherId === u.id) };
  return { ok: false, error: 'forbidden' };
}
function userCreate(body) {
  const u = auth(body.token); if (!isAdmin(u)) return { ok: false, error: 'forbidden' };
  const id = cleanId(body.id); const pw = String(body.pw || '');
  const role = ['admin', 'teacher', 'student'].indexOf(body.role) >= 0 ? body.role : 'student';
  if (!id) return { ok: false, error: 'bad_id' };
  if (pw.length < 4) return { ok: false, error: 'bad_pw' };
  if (findUser(id)) return { ok: false, error: 'dup_id' };
  const teacherId = role === 'student' ? cleanId(body.teacherId) : '';
  if (teacherId && !(findUser(teacherId) || {}).role) return { ok: false, error: 'bad_teacher' };
  const salt = randomKey(16);
  usersSheet().appendRow([id, role, safeText(body.name || id, NAME_MAX), hashPw(pw, salt), salt, teacherId, Date.now(), true, cleanSubjects(body.subjects)]);
  return { ok: true, user: pubUser(findUser(id)) };
}
function userUpdate(body) {
  const u = auth(body.token); if (!isAdmin(u)) return { ok: false, error: 'forbidden' };
  const t = findUser(body.id); if (!t) return { ok: false, error: 'not_found' };
  const s = usersSheet();
  if (body.name !== undefined) s.getRange(t.row, 3).setValue(safeText(body.name, NAME_MAX));
  if (body.role && ['admin', 'teacher', 'student'].indexOf(body.role) >= 0) {
    if (t.id === u.id && body.role !== 'admin') return { ok: false, error: 'self_demote' };
    s.getRange(t.row, 2).setValue(body.role);
    if (body.role !== 'student') s.getRange(t.row, 6).setValue('');
  }
  if (body.teacherId !== undefined) {
    const tid = cleanId(body.teacherId);
    if (tid && !findUser(tid)) return { ok: false, error: 'bad_teacher' };
    s.getRange(t.row, 6).setValue(tid);
  }
  if (body.pw) {
    if (String(body.pw).length < 4) return { ok: false, error: 'bad_pw' };
    const salt = randomKey(16);
    s.getRange(t.row, 4, 1, 2).setValues([[hashPw(body.pw, salt), salt]]);
  }
  if (body.active !== undefined) {
    if (t.id === u.id && !body.active) return { ok: false, error: 'self_disable' };
    s.getRange(t.row, 8).setValue(!!body.active);
  }
  if (body.subjects !== undefined) s.getRange(t.row, 9).setValue(cleanSubjects(body.subjects));
  return { ok: true, user: pubUser(findUser(t.id)) };
}
// 본인 프로필(수강 과목)
function profileUpdate(body) {
  const u = auth(body.token); if (!u) return { ok: false, error: 'bad_token' };
  if (body.subjects !== undefined) usersSheet().getRange(u.row, 9).setValue(cleanSubjects(body.subjects));
  return { ok: true, user: pubUser(findUser(u.id)) };
}
function userDelete(body) {
  const u = auth(body.token); if (!isAdmin(u)) return { ok: false, error: 'forbidden' };
  const t = findUser(body.id); if (!t) return { ok: true, gone: true };
  // 관리자 본인 삭제는 계정이 자기 하나뿐일 때만 허용(초기화: setup 이 다시 열림)
  if (t.id === u.id && usersCount() > 1) return { ok: false, error: 'self_delete' };
  usersSheet().deleteRow(t.row);
  try { const rep = reportRow(t.id); if (rep) { if (rep.driveId) { try { DriveApp.getFileById(rep.driveId).setTrashed(true); } catch (e) {} } reportsSheet().deleteRow(rep.row); } } catch (e) {}
  try { const ss2 = sessionsSheet(); const n2 = ss2.getLastRow(); if (n2 >= 2) { const rows = ss2.getRange(2, 1, n2 - 1, 2).getValues(); for (let i = rows.length - 1; i >= 0; i--) if (String(rows[i][1]) === t.id) ss2.deleteRow(i + 2); } } catch (e) {}
  if (t.id === u.id) { logout(body); return { ok: true, reset: true }; }
  // 이 선생에게 속한 학생은 소속 해제
  allUsers().forEach(x => { if (x.teacherId === t.id) usersSheet().getRange(x.row, 6).setValue(''); });
  return { ok: true };
}
// 본인 비밀번호 변경
function changePw(body) {
  const u = auth(body.token); if (!u) return { ok: false, error: 'bad_token' };
  if (!pwMatches(body.oldPw, u)) return { ok: false, error: 'bad_login' };
  if (String(body.newPw || '').length < 4) return { ok: false, error: 'bad_pw' };
  const salt = randomKey(16);
  usersSheet().getRange(u.row, 4, 1, 2).setValues([[hashPw(body.newPw, salt), salt]]);
  return { ok: true };
}

/* ── 계정별 시험지 저장 ── */
function examRows() {
  const s = examsSheet(); const n = s.getLastRow();
  if (n < 2) return [];
  return s.getRange(2, 1, n - 1, 6).getValues().map((r, i) => ({ row: i + 2, id: String(r[0]), ownerId: String(r[1]), title: String(r[2]), json: String(r[3]), code: String(r[4] || ''), updatedAt: Number(r[5]) || 0 }));
}
function examList(p) {
  const u = auth(p.token); if (!u) return { ok: false, error: 'bad_token' };
  const mine = examRows().filter(e => u.role === 'admin' && (p.all === '1' || p.all === true) ? true : e.ownerId === u.id);
  const exams = [];
  mine.forEach(e => { try { const x = JSON.parse(e.json); x.ownerId = e.ownerId; exams.push(x); } catch (err) {} });
  exams.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, exams: exams };
}
function examSave(body) {
  const u = auth(body.token); if (!u) return { ok: false, error: 'bad_token' };
  const ex = body.exam; if (!ex || typeof ex !== 'object' || !ex.id) return { ok: false, error: 'bad_exam' };
  delete ex.ownerKey; delete ex.ownerId;
  const json = JSON.stringify(ex);
  if (json.length > EXAM_MAX_CHARS) return { ok: false, error: 'too_big' };
  const s = examsSheet();
  const cur = examRows().find(e => e.id === String(ex.id));
  if (cur && cur.ownerId !== u.id && u.role !== 'admin') return { ok: false, error: 'forbidden' };
  const vals = [String(ex.id), cur ? cur.ownerId : u.id, safeText(ex.title, 80), json, String(ex.code || ''), Date.now()];
  if (cur) s.getRange(cur.row, 1, 1, 6).setValues([vals]); else s.appendRow(vals);
  return { ok: true };
}
function examDelete(body) {
  const u = auth(body.token); if (!u) return { ok: false, error: 'bad_token' };
  const cur = examRows().find(e => e.id === String(body.id || ''));
  if (!cur) return { ok: true, gone: true };
  if (cur.ownerId !== u.id && u.role !== 'admin') return { ok: false, error: 'forbidden' };
  examsSheet().deleteRow(cur.row);
  if (cur.code) { const row = findQuizRow(cur.code); if (row) { quizSheet().deleteRow(row); deleteResultsFor(cur.code); deleteAssignFor(cur.code); } }
  return { ok: true };
}

/* ── 응시 기록(계정) ── */
function resultsWithDetail(filterFn, limit) {
  const s = resSheet(); const last = s.getLastRow();
  if (last < 2) return [];
  const rows = s.getRange(2, 1, last - 1, 8).getValues();
  const items = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!filterFn(r)) continue;
    let detail = null; try { detail = r[7] ? JSON.parse(r[7]) : null; } catch (e) {}
    items.push({ id: String(i + 2), code: String(r[0]), name: String(r[1] || ''), score: Number(r[2]) || 0, total: Number(r[3]) || 0, sec: Number(r[4]) || 0, at: Number(r[5]) || 0, userId: String(r[6] || ''), detail: detail });
    if (items.length >= (limit || 200)) break;
  }
  return items;
}
function quizTitle(code) {
  const row = findQuizRow(code); if (!row) return '';
  try { return JSON.parse(quizSheet().getRange(row, 4).getValue()).title || ''; } catch (e) { return ''; }
}
function myResults(p) {
  const u = auth(p.token); if (!u) return { ok: false, error: 'bad_token' };
  const items = resultsWithDetail(r => String(r[6] || '') === u.id, 100);
  const titles = {}; items.forEach(it => { if (!(it.code in titles)) titles[it.code] = quizTitle(it.code); it.title = titles[it.code]; });
  return { ok: true, items: items };
}
function studentResults(p) {
  const u = auth(p.token); if (!u) return { ok: false, error: 'bad_token' };
  const sid = cleanId(p.studentId);
  if (!canSeeStudent(u, sid)) return { ok: false, error: 'forbidden' };
  const st = findUser(sid); if (!st) return { ok: false, error: 'not_found' };
  const items = resultsWithDetail(r => String(r[6] || '') === sid, 200);
  const quizzes = {};   // code → { title, subject, tags: { 문항id: [태그] } }
  items.forEach(it => {
    if (!(it.code in quizzes)) {
      let info = { title: '', subject: '', tags: {} };
      const row = findQuizRow(it.code);
      if (row) { try { const q = JSON.parse(quizSheet().getRange(row, 4).getValue()); info.title = String(q.title || ''); info.subject = String(q.subject || ''); (q.questions || []).forEach(x => { if (Array.isArray(x.tags) && x.tags.length) info.tags[x.id] = x.tags.map(String).slice(0, 8); }); } catch (e) {} }
      quizzes[it.code] = info;
    }
    it.title = quizzes[it.code].title;
  });
  const rep = reportRow(sid);
  const doneCodes = {}; items.forEach(it => { doneCodes[it.code] = 1; });
  const mine = assignRows().filter(a => a.studentId === sid);
  return { ok: true, student: pubUser(st), items: items, quizzes: quizzes, assign: { total: mine.length, done: mine.filter(a => doneCodes[a.code]).length }, report: rep ? { summary: rep.summary, updatedAt: rep.updatedAt, basis: rep.basis } : null };
}
// 관리자: 전체 기록(최근 300)
function allResults(p) {
  const u = auth(p.token); if (!isAdmin(u)) return { ok: false, error: 'forbidden' };
  const items = resultsWithDetail(() => true, 300);
  const titles = {}; items.forEach(it => { if (!(it.code in titles)) titles[it.code] = quizTitle(it.code); it.title = titles[it.code]; });
  return { ok: true, items: items };
}
function resultDelete(body) {
  const u = auth(body.token); if (!isAdmin(u)) return { ok: false, error: 'forbidden' };
  const row = Number(body.id) || 0;
  const s = resSheet();
  if (row < 2 || row > s.getLastRow()) return { ok: false, error: 'not_found' };
  s.deleteRow(row);
  return { ok: true };
}

/* ── 배정: 출제자(또는 관리자)가 공유 코드를 학생에게 배정. 학생 홈 "풀어야 할 시험"·완료율의 근거 ── */
function assignSheet() { return sheet('assignments', ['id', 'code', 'studentId', 'byId', 'at']); }
function assignRows() {
  const s = assignSheet(); const n = s.getLastRow();
  if (n < 2) return [];
  return s.getRange(2, 1, n - 1, 5).getValues().map((r, i) => ({ row: i + 2, id: String(r[0]), code: String(r[1]), studentId: String(r[2]), byId: String(r[3] || ''), at: Number(r[4]) || 0 }));
}
function deleteAssignFor(code) {
  const s = assignSheet();
  assignRows().filter(a => a.code === code).reverse().forEach(a => s.deleteRow(a.row));
}
function quizInfo(code, cache) {
  if (cache && code in cache) return cache[code];
  let info = null;
  const row = findQuizRow(code);
  if (row) {
    try {
      const q = JSON.parse(quizSheet().getRange(row, 4).getValue());
      const ownerId = String(quizSheet().getRange(row, 8).getValue() || '');
      const ow = ownerId ? findUser(ownerId) : null;
      info = { title: String(q.title || ''), subject: String(q.subject || ''), openAt: Number(q.openAt) || 0, closeAt: Number(q.closeAt) || 0, timeLimit: Number(q.timeLimit) || 0, questions: (q.questions || []).length, owner: ow ? ow.name : '', ownerId: ownerId };
    } catch (e) {}
  }
  if (cache) cache[code] = info;
  return info;
}
function canAssign(u, code) {
  if (!u) return false;
  if (u.role === 'admin') return true;
  const row = findQuizRow(code); if (!row) return false;
  return String(quizSheet().getRange(row, 8).getValue() || '') === u.id;
}
// {code, studentIds:[...]} → 아직 없는 학생만 추가
function assignSet(body) {
  const u = auth(body.token); if (!u) return { ok: false, error: 'bad_token' };
  const code = cleanCode(body.code);
  if (!findQuizRow(code)) return { ok: false, error: 'not_found' };
  if (!canAssign(u, code)) return { ok: false, error: 'forbidden' };
  const ids = (Array.isArray(body.studentIds) ? body.studentIds : []).map(cleanId).filter(Boolean).slice(0, 200);
  const have = {}; assignRows().filter(a => a.code === code).forEach(a => { have[a.studentId] = 1; });
  const s = assignSheet(); let added = 0;
  ids.forEach(sid => {
    if (have[sid]) return;
    const st = findUser(sid); if (!st || !st.active) return;
    if (!canSeeStudent(u, sid) && u.role !== 'admin') return;
    s.appendRow([randomKey(10), code, sid, u.id, Date.now()]); have[sid] = 1; added++;
  });
  return { ok: true, added: added };
}
function assignRemove(body) {
  const u = auth(body.token); if (!u) return { ok: false, error: 'bad_token' };
  const code = cleanCode(body.code); const sid = cleanId(body.studentId);
  if (!canAssign(u, code)) return { ok: false, error: 'forbidden' };
  const s = assignSheet();
  assignRows().filter(a => a.code === code && a.studentId === sid).reverse().forEach(a => s.deleteRow(a.row));
  return { ok: true };
}
// 내게 배정된 시험(mine) + (code 를 주면) 그 코드의 배정 현황(forCode)
function assignList(p) {
  const u = auth(p.token); if (!u) return { ok: false, error: 'bad_token' };
  const rows = assignRows();
  const cache = {};
  const myRes = {};   // code → 최근 기록
  resultsWithDetail(r => String(r[6] || '') === u.id, 300).forEach(it => { if (!(it.code in myRes)) myRes[it.code] = it; });
  const mine = [];
  rows.filter(a => a.studentId === u.id).forEach(a => {
    const q = quizInfo(a.code, cache); if (!q) return;
    const r = myRes[a.code] || null;
    mine.push({ id: a.id, code: a.code, title: q.title, subject: q.subject, owner: q.owner, openAt: q.openAt, closeAt: q.closeAt, timeLimit: q.timeLimit, questions: q.questions, at: a.at, done: !!r, score: r ? r.score : null, total: r ? r.total : null, doneAt: r ? r.at : null });
  });
  mine.sort((a, b) => (a.done - b.done) || ((a.closeAt || 9e15) - (b.closeAt || 9e15)) || (b.at - a.at));
  const out = { ok: true, mine: mine };
  const code = cleanCode(p.code);
  if (code && canAssign(u, code)) {
    const done = {};
    resultsWithDetail(r => String(r[0]) === code, RESULTS_MAX_PER_CODE).forEach(it => { if (it.userId && !(it.userId in done)) done[it.userId] = it; });
    out.forCode = rows.filter(a => a.code === code).map(a => { const st = findUser(a.studentId); const r = done[a.studentId]; return { studentId: a.studentId, name: st ? st.name : a.studentId, at: a.at, done: !!r, score: r ? r.score : null, total: r ? r.total : null }; });
  }
  return out;
}

/* ── 분석 리포트 (워커가 생성, 사이트가 보여 줌) ── */
function reportRow(userId) {
  const s = reportsSheet(); const n = s.getLastRow();
  if (n < 2) return null;
  const rows = s.getRange(2, 1, n - 1, 5).getValues();
  for (let i = 0; i < rows.length; i++) if (String(rows[i][0]) === userId) return { row: i + 2, driveId: String(rows[i][1] || ''), summary: shParse(rows[i][2], null), basis: Number(rows[i][3]) || 0, updatedAt: Number(rows[i][4]) || 0 };
  return null;
}
function reportGet(p) {
  const u = auth(p.token); if (!u) return { ok: false, error: 'bad_token' };
  const sid = cleanId(p.studentId);
  if (!canSeeStudent(u, sid)) return { ok: false, error: 'forbidden' };
  const rep = reportRow(sid);
  if (!rep || !rep.driveId) return { ok: false, error: 'no_report' };
  return { ok: true, html: DriveApp.getFileById(rep.driveId).getBlob().getDataAsString('UTF-8'), summary: rep.summary, updatedAt: rep.updatedAt };
}
// 워커(연결 코드 인증): 새 기록이 생긴 학생 목록 + 기록·문제지 내용
function reportPending(p) {
  const kh = shKh(p.key); if (!kh) return { ok: false, error: 'bad_key' };
  if (!workerKeyOk(kh)) return { ok: false, error: 'bad_key' };
  const students = allUsers().filter(u => u.active);   // 학생·선생·관리자 모두 자기 응시 기록으로 리포트를 받는다
  const out = [];
  const all = resultsWithDetail(r => !!r[6], 5000);        // 시트를 한 번만 읽고 계정별로 나눈다
  const byUser = {};
  all.forEach(it => { (byUser[it.userId] = byUser[it.userId] || []).push(it); });
  const quizCache = {};
  students.forEach(st => {
    const items = (byUser[st.id] || []).slice(0, 60);
    if (!items.length) return;
    const rep = reportRow(st.id);
    const latest = Math.max.apply(null, items.map(i => i.at));
    if (rep && rep.updatedAt >= latest && rep.basis === items.length) return;
    const quizzes = {};
    items.forEach(it => { if (!(it.code in quizzes)) { if (!(it.code in quizCache)) { const row = findQuizRow(it.code); quizCache[it.code] = row ? shParse(quizSheet().getRange(row, 4).getValue(), null) : null; } quizzes[it.code] = quizCache[it.code]; } });
    const teacher = st.teacherId ? findUser(st.teacherId) : null;
    out.push({ studentId: st.id, name: st.name, role: st.role, teacher: teacher ? teacher.name : '', results: items, quizzes: quizzes });
  });
  return { ok: true, students: out };
}
// 리포트 새로 만들기 요청: 본인, 또는 볼 수 있는 학생(선생·관리자). 다음 워커 실행 때 다시 만든다.
function reportRequest(body) {
  const u = auth(body.token); if (!u) return { ok: false, error: 'bad_token' };
  const sid = body.studentId ? cleanId(body.studentId) : u.id;
  if (!canSeeStudent(u, sid)) return { ok: false, error: 'forbidden' };
  if (!findUser(sid)) return { ok: false, error: 'not_found' };
  if (!resultsWithDetail(r => String(r[6] || '') === sid, 1).length) return { ok: false, error: 'no_results' };
  const s = reportsSheet();
  const rep = reportRow(sid);
  if (rep) s.getRange(rep.row, 4, 1, 2).setValues([[0, 0]]); else s.appendRow([sid, '', '', 0, 0]);
  return { ok: true };
}
function reportPut(body) {
  const kh = shKh(body.key); if (!kh || !workerKeyOk(kh)) return { ok: false, error: 'bad_key' };
  const sid = cleanId(body.studentId); if (!findUser(sid)) return { ok: false, error: 'not_found' };
  const s = reportsSheet();
  const rep = reportRow(sid);
  let driveId = rep ? rep.driveId : '';
  const html = String(body.html || '');
  if (html) {
    if (driveId) { try { DriveApp.getFileById(driveId).setContent(html); } catch (e) { driveId = ''; } }
    if (!driveId) driveId = shFolder(kh).createFile(Utilities.newBlob(html, 'text/html', 'report__' + sid + '.html')).getId();
  }
  const vals = [sid, driveId, JSON.stringify(body.summary || {}).slice(0, SH_CELL_MAX), Number(body.basis) || 0, Date.now()];
  if (rep) s.getRange(rep.row, 1, 1, 5).setValues([vals]); else s.appendRow(vals);
  return { ok: true };
}
// 워커 연결 코드: 관리자가 사이트에서 등록한 값(스크립트 속성 WORKER_KH = sha(key))만 허용
function workerKeyOk(kh) { const want = PropertiesService.getScriptProperties().getProperty('WORKER_KH'); return !!want && want === kh; }
// 워커 키로 초기화: 계정이 전부 tmp_ 로 시작하는 테스트 계정일 때만 users·sessions 를 비운다(setup 재개방)
function resetTestUsers(body) {
  const kh = shKh(body.key); if (!kh || !workerKeyOk(kh)) return { ok: false, error: 'bad_key' };
  const users = allUsers();
  if (users.some(u => u.id.indexOf('tmp_') !== 0)) return { ok: false, error: 'has_real_users' };
  for (let i = users.length - 1; i >= 0; i--) usersSheet().deleteRow(users[i].row);
  const ss2 = sessionsSheet(); const n = ss2.getLastRow(); if (n >= 2) ss2.deleteRows(2, n - 1);
  return { ok: true, removed: users.length };
}
function workerKeySet(body) {
  const u = auth(body.token); if (!isAdmin(u)) return { ok: false, error: 'forbidden' };
  const kh = shKh(body.key); if (!kh) return { ok: false, error: 'bad_key' };
  PropertiesService.getScriptProperties().setProperty('WORKER_KH', kh);
  return { ok: true };
}

/* ── AI 문제 생성 (Gemini API, 무료 등급) ──
   스크립트 속성 GEMINI_API_KEY (aistudio.google.com 에서 발급), GEMINI_MODEL(선택, 기본 gemini-3.5-flash-lite),
   GEN_DAILY_LIMIT(선택, 기본 100). 선생·관리자 계정만 호출 가능. */
function geminiKey() { return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || ''; }
function generateGemini(body) {
  const u = auth(body.token);
  const worker = !u && body.key && workerKeyOk(shKh(body.key));   // 워커 키로도 시험 호출 가능(진단용)
  if (!u && !worker) return { ok: false, error: 'bad_token' };
  const props = PropertiesService.getScriptProperties();
  const key = geminiKey(); if (!key) return { ok: false, error: 'gen_not_configured' };
  const model = props.getProperty('GEMINI_MODEL') || 'gemini-3.5-flash-lite';
  const limit = Number(props.getProperty('GEN_DAILY_LIMIT')) || 0;   // 0 = 자체 제한 없음(구글 무료 한도까지)
  const dayKey = 'gen:' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  const used = Number(props.getProperty(dayKey)) || 0;
  if (limit && used >= limit) return { ok: false, error: 'gen_limit' };
  const scope = String(body.scope || '').trim().slice(0, 500);
  if (!scope) return { ok: false, error: 'bad_scope' };
  const material = String(body.material || '').trim().slice(0, 20000);
  const count = Math.min(GEN_MAX_COUNT, Math.max(1, Math.floor(Number(body.count) || 10)));
  const difficulty = { '하': '쉬움 (기본 개념 확인)', '중': '보통 (개념 적용)', '상': '어려움 (추론·비교·응용)' }[body.difficulty] || '보통 (개념 적용)';
  const kind = body.kind === 'tf' ? '참/거짓 2지선다 (options 는 ["참","거짓"])' : '4지선다 객관식 (options 4개)';
  const prompt = [
    '당신은 한국 고등학교 교사다. 아래 조건으로 시험 문제를 JSON 으로만 만든다.',
    '범위/주제: ' + scope, '난이도: ' + difficulty, '형식: ' + kind, '문항 수: ' + count,
    material ? '참고 자료(이 내용에서만 출제):\n' + material : '',
    '규칙: 각 문항은 text(문제), options(보기 문자열 배열), answers(정답 보기의 0부터 시작하는 인덱스 배열, 보통 1개), explain(해설 2~3문장). 보기끼리 길이·형식을 비슷하게. 정답 위치를 골고루. 한국어.',
    '출력 JSON: {"title": "시험지 제목", "questions": [{"text": "...", "options": ["..."], "answers": [0], "explain": "..."}]}',
  ].filter(Boolean).join('\n');
  const schema = {
    type: 'object',
    properties: { title: { type: 'string' }, questions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, answers: { type: 'array', items: { type: 'integer' } }, explain: { type: 'string' } }, required: ['text', 'options', 'answers', 'explain'] } } },
    required: ['title', 'questions'],
  };
  const t0 = Date.now();
  let res, code;
  try {
    res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.8 } }),
      muteHttpExceptions: true,
    });
    code = res.getResponseCode();
  } catch (err) { logUsage(scope, count, model, 0, 0, Date.now() - t0, 'fetch_error'); return { ok: false, error: 'api', message: String(err) }; }
  let data = {}; try { data = JSON.parse(res.getContentText()); } catch (err) {}
  const um = data.usageMetadata || {};
  const ms = Date.now() - t0;
  if (code === 429) { logUsage(scope, count, model, 0, 0, ms, 'http_429'); return { ok: false, error: 'gen_quota' }; }
  if (code !== 200) { logUsage(scope, count, model, 0, 0, ms, 'http_' + code); return { ok: false, error: 'api', message: (data.error && data.error.message) || ('HTTP ' + code) }; }
  let text = '';
  try { text = data.candidates[0].content.parts.map(p => p.text || '').join(''); } catch (err) {}
  text = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed; try { parsed = JSON.parse(text); } catch (err) { logUsage(scope, count, model, um.promptTokenCount || 0, um.candidatesTokenCount || 0, ms, 'bad_json'); return { ok: false, error: 'api', message: '응답을 해석하지 못했습니다.' }; }
  const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .map(q => ({ text: String(q.text || '').trim(), options: (Array.isArray(q.options) ? q.options : []).map(o => String(o || '').trim()), answers: Array.isArray(q.answers) ? q.answers.filter(a => Number.isInteger(a)) : [], explain: String(q.explain || '').trim() }))
    .filter(q => q.text && q.options.length >= 2 && q.options.every(Boolean) && q.answers.length && q.answers.every(a => a >= 0 && a < q.options.length))
    .slice(0, count);
  props.setProperty(dayKey, String(used + 1));
  logUsage(scope, questions.length, model, um.promptTokenCount || 0, um.candidatesTokenCount || 0, ms, 'ok');
  return { ok: true, title: String(parsed.title || scope).slice(0, 80), questions: questions, remaining: limit ? limit - used - 1 : null, model: model };
}

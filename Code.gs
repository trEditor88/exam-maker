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
function quizSheet() { return sheet(SHEET_QUIZ, ['code', 'keyHash', 'title', 'json', 'createdAt', 'updatedAt', 'attempts']); }
function resSheet() { return sheet(SHEET_RES, ['code', 'name', 'score', 'total', 'sec', 'at']); }

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
function usageSummary(pw) {
  const props = PropertiesService.getScriptProperties();
  const want = props.getProperty('GEN_PW');
  if (!want) return { ok: false, error: 'gen_not_configured' };
  if (String(pw || '') !== want) return { ok: false, error: 'bad_pw' };
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
function doGet(e) {
  const p = (e && e.parameter) || {};
  const a = p.action;
  try {
    if (a === 'ping') return out({ ok: true, v: 1, gen: genEnabled() });

    if (a === 'quiz') {
      const code = cleanCode(p.code);
      const row = findQuizRow(code);
      if (!row) return out({ ok: false, error: 'not_found' });
      const json = quizSheet().getRange(row, 4).getValue();
      let quiz;
      try { quiz = JSON.parse(json); } catch (err) { return out({ ok: false, error: 'corrupt' }); }
      return out({ ok: true, code: code, quiz: quiz });
    }

    if (a === 'results') {
      const code = cleanCode(p.code);
      const row = findQuizRow(code);
      if (!row) return out({ ok: false, error: 'not_found' });
      if (sha(p.key || '') !== String(quizSheet().getRange(row, 2).getValue())) return out({ ok: false, error: 'bad_key' });
      return out({ ok: true, items: resultsFor(code) });
    }

    if (a === 'usage') return out(usageSummary(p.pw));

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
  // AI 생성은 오래 걸리므로 잠금 없이 처리 (시트에는 사용 기록만 추가)
  if (a === 'generate') {
    try { return out(generate(body)); } catch (err) { return out({ ok: false, error: 'server', message: String(err) }); }
  }
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

  const code = cleanCode(body.code);
  if (code) {
    const row = findQuizRow(code);
    if (row) {
      if (sha(body.key || '') !== String(s.getRange(row, 2).getValue())) return { ok: false, error: 'bad_key' };
      s.getRange(row, 3, 1, 4).setValues([[title, json, s.getRange(row, 5).getValue(), now]]);
      return { ok: true, code: code, updated: true };
    }
    // 코드가 서버에 없으면(예: 지워짐) 새 코드로 발급
  }
  const newC = newCode();
  const key = randomKey(24);
  s.appendRow([newC, sha(key), title, json, now, now, 0]);
  return { ok: true, code: newC, key: key, updated: false };
}

function remove(body) {
  const code = cleanCode(body.code);
  const s = quizSheet();
  const row = findQuizRow(code);
  if (!row) return { ok: true, gone: true };
  if (sha(body.key || '') !== String(s.getRange(row, 2).getValue())) return { ok: false, error: 'bad_key' };
  s.deleteRow(row);
  deleteResultsFor(code);
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
  resSheet().appendRow([code, safeText(en.name, NAME_MAX), score, total, Math.max(0, Math.round(Number(en.sec) || 0)), Date.now()]);
  const cell = s.getRange(row, 7);
  cell.setValue((Number(cell.getValue()) || 0) + 1);
  return { ok: true };
}

function clearResults(body) {
  const code = cleanCode(body.code);
  const s = quizSheet();
  const row = findQuizRow(code);
  if (!row) return { ok: false, error: 'not_found' };
  if (sha(body.key || '') !== String(s.getRange(row, 2).getValue())) return { ok: false, error: 'bad_key' };
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

function shFilesSheet() { return sheet('sh_files', ['id', 'kh', 'worksheet', 'filename', 'driveId', 'at', 'fetched']); }
function shWsSheet() { return sheet('sh_ws', ['kh', 'worksheet', 'status', 'summary', 'noteDriveId', 'confirm', 'questions', 'createdAt', 'updatedAt']); }
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
function shEnsureWs(kh, ws, status) {
  const s = shWsSheet();
  const row = shFindWsRow(kh, ws);
  const now = Date.now();
  if (row) return row;
  s.appendRow([kh, ws, status || 'uploaded', '', '', '', '', now, now]);
  return s.getLastRow();
}
function shParse(v, dflt) { try { return v ? JSON.parse(v) : dflt; } catch (e) { return dflt; } }

// 사진 업로드: {key, worksheet, filename, data(base64), mime}
function shUpload(body) {
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
  shFilesSheet().appendRow([id, kh, ws, name, file.getId(), Date.now(), '']);
  shEnsureWs(kh, ws, 'uploaded');
  return { ok: true, id: id, worksheet: ws };
}

// 사이트 목록: {key}
function shList(p) {
  const kh = shKh(p.key); if (!kh) return { ok: false, error: 'bad_key' };
  const photos = {};
  const fs = shFilesSheet(); const fn = fs.getLastRow();
  if (fn >= 2) fs.getRange(2, 1, fn - 1, 7).getValues().forEach(r => { if (r[1] === kh) photos[r[2]] = (photos[r[2]] || 0) + 1; });
  const s = shWsSheet(); const n = s.getLastRow();
  const list = [];
  if (n >= 2) s.getRange(2, 1, n - 1, 9).getValues().forEach(r => {
    if (r[0] !== kh) return;
    const confirm = shParse(r[5], []);
    list.push({ name: r[1], status: r[2] || 'uploaded', summary: shParse(r[3], null), hasNote: !!r[4],
      pending: confirm.filter(c => !c.answer).length, photos: photos[r[1]] || 0, updatedAt: r[8] || r[7] });
  });
  list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { ok: true, worksheets: list };
}

// 사이트 상세: {key, ws}
function shDetail(p) {
  const kh = shKh(p.key); if (!kh) return { ok: false, error: 'bad_key' };
  const ws = shWsName(p.ws);
  const row = shFindWsRow(kh, ws); if (!row) return { ok: false, error: 'not_found' };
  const r = shWsSheet().getRange(row, 1, 1, 9).getValues()[0];
  return { ok: true, name: ws, status: r[2], summary: shParse(r[3], null), hasNote: !!r[4], confirm: shParse(r[5], []), questions: shParse(r[6], []), updatedAt: r[8] };
}

// 오답노트 HTML: {key, ws}
function shNote(p) {
  const kh = shKh(p.key); if (!kh) return { ok: false, error: 'bad_key' };
  const row = shFindWsRow(kh, shWsName(p.ws)); if (!row) return { ok: false, error: 'not_found' };
  const id = shWsSheet().getRange(row, 5).getValue();
  if (!id) return { ok: false, error: 'no_note' };
  return { ok: true, html: DriveApp.getFileById(id).getBlob().getDataAsString('UTF-8') };
}

// 확인 질문 답 저장: {key, worksheet, answers:{id: text}}
function shConfirm(body) {
  const kh = shKh(body.key); if (!kh) return { ok: false, error: 'bad_key' };
  const ws = shWsName(body.worksheet);
  const row = shFindWsRow(kh, ws); if (!row) return { ok: false, error: 'not_found' };
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

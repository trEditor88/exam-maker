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

function generate(body) {
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
    if (a === 'ping') return out({ ok: true, v: 1 });

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

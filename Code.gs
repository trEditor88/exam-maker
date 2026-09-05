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

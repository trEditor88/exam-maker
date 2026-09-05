# 시험지

문제를 만들어 5자리 코드로 나누고, 푼 사람은 바로 채점 결과를 봅니다. 출제자는 응시 기록을 볼 수 있습니다.

- 사이트: GitHub Pages (`index.html` + `app.jsx`, React 를 브라우저에서 바로 컴파일)
- 서버: Google Apps Script + Google Sheets (`Code.gs`). 설치 방법은 파일 머리의 주석 참고
- 서버 URL 은 `index.html` 의 `window.EXAM_SYNC_URL` 에 넣습니다. 비어 있으면 한 기기 안에서만 동작합니다.

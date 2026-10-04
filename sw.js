/* 시험지 서비스 워커 — 푸시 알림 전용(오프라인 캐시는 하지 않는다: 항상 최신 app.js 를 받게).
   서버(Worker)는 내용 없는 푸시만 보낸다. 받으면 IndexedDB 에 저장된 로그인 토큰으로 알림 목록을 불러와
   가장 최근 안 읽은 알림의 제목·내용을 보여 준다(토큰이 없거나 실패하면 "새 알림이 있습니다"). */
const DB_NAME = "exam-maker", STORE = "kv";
function idbGet(key) {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction(STORE, "readonly");
        const g = tx.objectStore(STORE).get(key);
        g.onsuccess = () => resolve(g.result || null);
        g.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    };
  });
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let title = "시험지", body = "새 알림이 있습니다.", tag = "exam-note";
    try {
      const auth = await idbGet("auth");   // { api, token }
      if (auth && auth.api && auth.token) {
        const r = await fetch(auth.api, { method: "POST", body: JSON.stringify({ action: "noteList", token: auth.token }) });
        const j = await r.json();
        const items = (j && (j.notes || j.items)) || [];
        const n = items.find((x) => !x.seen) || items[0];
        if (n) { title = n.title || title; body = n.body || body; tag = "note-" + (n.id || ""); }
      }
    } catch (err) {}
    await self.registration.showNotification(title, { body, tag, icon: "icon-192.png", badge: "icon-192.png", data: { url: "./#/home" } });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if ("focus" in c) { c.focus(); return; } }
    await self.clients.openWindow((e.notification.data && e.notification.data.url) || "./");
  })());
});

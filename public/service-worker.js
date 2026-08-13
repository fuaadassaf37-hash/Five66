// ===================== Service Worker — الديوان العسكري =====================
// الهدف: تخزين "هيكل" التطبيق (الصفحة الرئيسية بكل أصولها المضمّنة)
// محلياً عبر Cache Storage API (لا حدود حجم منخفضة كـ localStorage)
// بحيث يفتح التطبيق فوراً حتى بدون إنترنت.
// بيانات API ومزامنة Socket.io تبقى دائماً Network-only لأن منطق
// المزامنة (pending state) موجود بالفعل داخل index.html.

const CACHE_NAME = 'diwan-shell-v5';
const SHELL_URLS = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .catch((err) => console.warn('SW install cache error:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }

  // فقط نفس الأصل (origin) نتعامل معه
  if (url.origin !== self.location.origin) {
    return;
  }

  // طلبات API والمزامنة اللحظية (Socket.io): تذهب دائماً للشبكة مباشرة
  // ولا تُخزَّن أبداً، حتى لا تتعارض مع منطق المزامنة الموجود في الصفحة.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    event.respondWith(
      fetch(req).catch(() =>
        new Response(
          JSON.stringify({ offline: true, message: 'لا يوجد اتصال بالإنترنت حالياً' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // لا نتدخل في أي طلب غير GET (مثل POST لحفظ البيانات)
  if (req.method !== 'GET') {
    return;
  }

  // باقي الطلبات (الصفحة الرئيسية والأصول الثابتة):
  // Stale-While-Revalidate: نُرجع النسخة المخزّنة فوراً (سريع وعمل بدون نت)
  // وفي نفس الوقت نحاول التحديث من الشبكة في الخلفية للمرة القادمة.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});

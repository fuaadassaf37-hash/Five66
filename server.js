socket.io
// ----- حماية Basic Auth على كل شيء (الواجهة + كل الـ API) -----
// هذا هو الإصلاح الأهم: قبله لم يكن هناك أي حماية فعلية رغم أن .env والـ package.json يوحيان بوجودها
app.use(basicAuth({
  users: { [APP_USER]: APP_PASS },
  challenge: true,
  realm: 'Diwan-Askari' // ملاحظة: رؤوس HTTP (WWW-Authenticate) لا تقبل حروف عربية، استخدام نص عربي هنا يسبب عطل (500) بدل رسالة تسجيل دخول (401)
}));

// حد إضافي وأصرم لمحاولات كتابة/قراءة الـ API لمنع إغراق السيرفر بطلبات متكررة بعد اجتياز تسجيل الدخول
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '50mb' }));

// تقديم الواجهة (index.html وملفات ثابتة)
app.use(express.static(path.join(__dirname, 'public')));

// ----- واجهة برمجية: قراءة الحالة الكاملة -----
app.get('/api/state', async (req, res) => {
  const state = await db.readAll();
  res.json(state);
});

// ----- واجهة برمجية: حفظ/تحديث الحالة -----
app.post('/api/state', async (req, res) => {
  try {
    const { state: incoming, clientId } = req.body || {};
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ ok: false, error: 'بيانات غير صالحة' });
    }
    const MAX_VALUE_LENGTH = 15 * 1024 * 1024; // 15MB كحد أقصى لكل مفتاح (نص JSON)
    const entries = {};
    for (const key of STATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) {
        const value = incoming[key];
        // القيم يجب أن تكون نصوصاً (JSON.stringify من جهة الواجهة) أو أرقام/فارغة، وليست كائنات معقدة غير متوقعة
        if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
          return res.status(400).json({ ok: false, error: `قيمة غير صالحة للمفتاح ${key}` });
        }
        if (typeof value === 'string' && value.length > MAX_VALUE_LENGTH) {
          return res.status(413).json({ ok: false, error: `حجم البيانات كبير جداً للمفتاح ${key}` });
        }
        entries[key] = value;
      }
    }
    const saved = await db.writeMany(entries);

    // إشعار جميع المستخدمين المتصلين بوجود تحديث
    io.emit('state-changed', { clientId, updatedAt: saved._updatedAt });

    res.json({ ok: true, updatedAt: saved._updatedAt });
  } catch (e) {
    console.error('POST /api/state error:', e);
    res.status(500).json({ ok: false, error: 'خطأ في السيرفر' });
  }
});

// نسخة احتياطية يدوية: تنزيل الحالة كاملة
app.get('/api/backup', async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="diwan-backup.json"');
  res.json(await db.readAll());
});

// ===================== تحميل الملفات (حل مشكلة Android WebView) =====================
const _tempFiles = new Map();
const MAX_TEMP_FILES = 200; // حد أقصى لعدد الملفات المؤقتة المخزّنة في الذاكرة بنفس اللحظة

app.post('/api/download/upload', (req, res) => {
  try {
    const { data, mime, filename } = req.body || {};
    if (!data || !mime || !filename) {
      return res.status(400).json({ ok: false, error: 'بيانات ناقصة' });
    }
    // تنظيف الملفات المنتهية أولاً
    for (const [k, v] of _tempFiles.entries()) {
      if (v.expiresAt < Date.now()) _tempFiles.delete(k);
    }
    // منع إغراق الذاكرة: إذا امتلأت السعة، احذف الأقدم
    if (_tempFiles.size >= MAX_TEMP_FILES) {
      const oldestKey = _tempFiles.keys().next().value;
      _tempFiles.delete(oldestKey);
    }
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const expiresAt = Date.now() + 5 * 60 * 1000;
    _tempFiles.set(token, { data, mime, filename, expiresAt });
    res.json({ ok: true, url: '/api/download/' + token });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/download/:token', (req, res) => {
  const entry = _tempFiles.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    _tempFiles.delete(req.params.token);
    return res.status(404).send('انتهت صلاحية الرابط');
  }
  const buf = Buffer.from(entry.data, 'base64');
  res.setHeader('Content-Type', entry.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename)}`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
  _tempFiles.delete(req.params.token);
});

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

server.listen(PORT, () => {
  console.log(`✅ سيرفر الديوان العسكري يعمل على المنفذ ${PORT}`);
  console.log(`   افتح: http://<server-ip>:${PORT}`);
});

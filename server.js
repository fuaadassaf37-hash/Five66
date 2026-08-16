// ===================== سيرفر الديوان العسكري =====================
// يوفر: تقديم الواجهة، تخزين دائم لبيانات النظام، ومزامنة لحظية بين المستخدمين

require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;

// ----- تحقق إلزامي من وجود بيانات الدخول -----
// لا يُسمح بتشغيل السيرفر بدون حساب مشرف (ADMIN) محدَّد صراحة في .env.
// حساب المشاهدة (VIEWER) اختياري: إن لم يُحدَّد، فكل من يملك رابط السيرفر
// ولا يملك بيانات المشرف لن يستطيع الدخول إطلاقاً.
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const VIEWER_USER = process.env.VIEWER_USER;
const VIEWER_PASS = process.env.VIEWER_PASS;

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('❌ يجب ضبط ADMIN_USER و ADMIN_PASS في ملف .env قبل تشغيل السيرفر (حماية إلزامية).');
  process.exit(1);
}

const basicAuthUsers = { [ADMIN_USER]: ADMIN_PASS };
if (VIEWER_USER && VIEWER_PASS) {
  basicAuthUsers[VIEWER_USER] = VIEWER_PASS;
} else {
  console.log('⚠ لم يتم ضبط VIEWER_USER / VIEWER_PASS — لا يوجد حساب مشاهدة منفصل، فقط حساب المشرف.');
}

// المفاتيح التي يخزّنها التطبيق (نفس مفاتيح localStorage السابقة)
const STATE_KEYS = [
  'mil_khasm',
  'mil_injured',
  'mil_martyrs',
  'mil_hararin',
  'mil_nextId',
  'mil_persons_added',
  'mil_persons_edited',
  'mil_persons_deleted',
  'mil_tafaqud_archive',
  'mil_ghiyab_archive',
  'mil_person_events',
  'mil_payroll',
  'mil_payroll_headers',
  'mil_payroll_nextId'
];

// ----- إعداد السيرفر -----
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Railway (وأي منصة استضافة تعمل خلف Reverse Proxy) تضيف ترويسة X-Forwarded-For
// لطلبات المستخدمين. express-rate-limit يرفض العمل بدون هذا الإعداد ويرمي خطأ
// "ValidationError" على كل طلب — وهذا كان يمنع تحميل الصفحة والـ API بالكامل.
app.set('trust proxy', 1);

// رؤوس أمان أساسية (helmet) — نعطّل CSP الافتراضي لأن الواجهة تحمّل سكربتات من عدة CDNs مضمّنة داخل index.html
app.use(helmet({ contentSecurityPolicy: false }));

// حماية شاملة من محاولات كسر كلمة المرور (Brute-force): حد أقصى للمحاولات على مستوى IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 50, // 50 محاولة كحد أقصى لكل IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'محاولات كثيرة جداً، حاول لاحقاً' }
});
app.use(authLimiter);

// ----- حماية Basic Auth على كل شيء (الواجهة + كل الـ API) -----
// كلا الحسابين (admin و viewer) يمكنهما الدخول ومشاهدة الموقع، لكن الكتابة
// عبر /api/state و /api/download/upload تقتصر على حساب المشرف فقط (انظر
// requireAdmin أدناه) — هذا يمنع حساب "العرض فقط" من أن يكون قادراً فعلياً
// على تعديل البيانات، وهي ثغرة كانت موجودة في النسخة السابقة.
app.use(basicAuth({
  users: basicAuthUsers,
  challenge: true,
  realm: 'Diwan-Askari' // ملاحظة: رؤوس HTTP (WWW-Authenticate) لا تقبل حروف عربية، استخدام نص عربي هنا يسبب عطل (500) بدل رسالة تسجيل دخول (401)
}));

// وسيط: يسمح فقط لحساب المشرف بتنفيذ عمليات الكتابة (POST/DELETE)
function requireAdmin(req, res, next) {
  if (req.auth && req.auth.user === ADMIN_USER) return next();
  return res.status(403).json({ ok: false, error: 'هذا الحساب للعرض فقط، لا يملك صلاحية التعديل' });
}

// حد إضافي وأصرم لمحاولات كتابة/قراءة الـ API لمنع إغراق السيرفر بطلبات متكررة بعد اجتياز تسجيل الدخول
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

app.use(express.json({ limit: '50mb' }));

// تقديم الواجهة (index.html وملفات ثابتة، منها shamcash-photos.json و persons-photos.json إن وُجد)
app.use(express.static(path.join(__dirname, 'public')));

// ----- واجهة برمجية: قراءة الحالة الكاملة (متاحة لكل من admin و viewer) -----
app.get('/api/state', async (req, res) => {
  const state = await db.readAll();
  res.json(state);
});

// ----- واجهة برمجية: حفظ/تحديث الحالة (للمشرف فقط) -----
app.post('/api/state', requireAdmin, async (req, res) => {
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

// حالة الاتصال بـ Supabase (متاحة لكل من admin و viewer) — للتأكد قبل إعادة
// نشر/تشغيل السيرفر أن الاتصال سليم وأنه لا توجد بيانات محفوظة محلياً فقط
app.get('/api/sync-status', async (req, res) => {
  res.json(db.getSyncStatus());
});

// نسخة احتياطية يدوية: تنزيل الحالة كاملة (للمشرف فقط، تحتوي كل البيانات)
app.get('/api/backup', requireAdmin, async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="diwan-backup.json"');
  res.json(await db.readAll());
});

// ===================== تحميل الملفات (حل مشكلة Android WebView) =====================
const _tempFiles = new Map();
const MAX_TEMP_FILES = 200; // حد أقصى لعدد الملفات المؤقتة المخزّنة في الذاكرة بنفس اللحظة

app.post('/api/download/upload', requireAdmin, (req, res) => {
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
  const buf = Buffer.from(String(entry.data).replace(/^data:[^,]*,/, ''), 'base64');
  res.setHeader('Content-Type', entry.mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(entry.filename)}`);
  res.setHeader('Content-Length', buf.length);
  res.send(buf);
  _tempFiles.delete(req.params.token);
});

io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

// ----- ترحيل بيانات لمرة واحدة (اختياري) — راجع migrate-persons-fix.js -----
async function startServer() {
  if (process.env.RUN_PERSON_FIX_2026_08 === 'true') {
    await require('./migrate-persons-fix').run(db);
  }
  // فحص صحة Supabase فور الإقلاع — بدونه قد يظهر /api/sync-status بصحة جيدة
  // خطأً لأن حالة الاتصال لا تتحدّث إلا عند أول عملية قراءة/كتابة فعلية.
  try {
    await db.readAll();
  } catch (e) {
    console.error('فحص Supabase الأولي فشل:', e.message);
  }
  server.listen(PORT, () => {
    console.log(`✅ سيرفر الديوان العسكري يعمل على المنفذ ${PORT}`);
    console.log(`   افتح: http://<server-ip>:${PORT}`);
  });
}
startServer();

// ===================== طبقة التخزين (Supabase) =====================
// يستخدم جدول kv_store(key text primary key, value text)
// مع تخزين احتياطي محلي (data/state.json) في حال عدم توفر اتصال
//
// ⚠️ ملف data/state.json مؤقت فقط: نظام ملفات Railway (وأي منصة PaaS مشابهة)
// يُمحى عند كل إعادة نشر (redeploy) أو إعادة تشغيل الخدمة. لذلك أي بيانات
// تُحفظ محلياً فقط (لأن Supabase كان معطلاً وقتها) قد تضيع نهائياً إن أُعيد
// نشر السيرفر قبل أن يعود الاتصال. للتعويض عن هذا: نتتبّع حالة الاتصال
// ونُرسل تنبيهاً فورياً (تيليجرام) عند أي فشل كتابة/قراءة، وعند التعافي.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { notifyAdmin } = require('./notify');

const DATA_DIR = path.join(__dirname, 'data');
const LOCAL_FILE = path.join(DATA_DIR, 'state.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOCAL_FILE)) fs.writeFileSync(LOCAL_FILE, '{}', 'utf8');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('✅ متصل بـ Supabase');
} else {
  console.log('⚠ لم يتم ضبط SUPABASE_URL / SUPABASE_KEY — سيتم استخدام ملف محلي (data/state.json) فقط');
}

function readLocal() {
  try { return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8') || '{}'); }
  catch (e) { return {}; }
}
function writeLocal(obj) {
  const tmp = LOCAL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, LOCAL_FILE);
}

// ----- تتبّع حالة الاتصال بـ Supabase وإرسال تنبيهات عند التغيّر -----
let _supabaseHealthy = true;   // تفاؤلي حتى أول عملية فعلية
let _lastFailureAt = null;
let _lastSuccessAt = null;
let _lastDownNotifyAt = 0;
let _localOnlyWritesSinceFailure = 0;
const DOWN_RENOTIFY_MS = 15 * 60 * 1000; // إعادة تذكير كل 15 دقيقة أثناء الانقطاع المستمر

function _onSupabaseFailure(context, errMsg) {
  const now = Date.now();
  const wasHealthy = _supabaseHealthy;
  _supabaseHealthy = false;
  _lastFailureAt = now;
  if (context === 'writeMany') _localOnlyWritesSinceFailure++;

  if (wasHealthy || (now - _lastDownNotifyAt > DOWN_RENOTIFY_MS)) {
    _lastDownNotifyAt = now;
    notifyAdmin(
      `🔴 تنبيه: فشل الاتصال بـ Supabase (${context}).\n` +
      `السبب: ${errMsg}\n` +
      `يتم الحفظ الآن على ملف محلي مؤقت فقط (data/state.json) — هذا الملف يُمحى عند أي إعادة نشر أو إعادة تشغيل للسيرفر على Railway.\n` +
      `⚠️ لا تُعِد نشر السيرفر أو تعيد تشغيله حتى تتأكد من عودة الاتصال، وإلا قد تضيع آخر التعديلات نهائياً.\n` +
      (_localOnlyWritesSinceFailure > 0 ? `عدد عمليات الحفظ المحلية فقط منذ بدء الانقطاع: ${_localOnlyWritesSinceFailure}` : '')
    );
  }
}

function _onSupabaseSuccess(context) {
  const now = Date.now();
  if (!_supabaseHealthy) {
    notifyAdmin(`🟢 تم استعادة الاتصال بـ Supabase (${context}) — البيانات تُحفظ وتُزامن بشكل طبيعي الآن. يمكن إعادة نشر/تشغيل السيرفر بأمان.`);
    _localOnlyWritesSinceFailure = 0;
  }
  _supabaseHealthy = true;
  _lastSuccessAt = now;
}

// حالة المزامنة — تُستخدم في endpoint /api/sync-status
function getSyncStatus() {
  return {
    supabaseConfigured: !!supabase,
    supabaseHealthy: !supabase ? null : _supabaseHealthy,
    lastFailureAt: _lastFailureAt ? new Date(_lastFailureAt).toISOString() : null,
    lastSuccessAt: _lastSuccessAt ? new Date(_lastSuccessAt).toISOString() : null,
    localOnlyWritesSinceFailure: _localOnlyWritesSinceFailure,
    telegramAlertsConfigured: require('./notify').configured
  };
}

// قراءة كل المفاتيح كـ object {key: value}
async function readAll() {
  if (!supabase) return readLocal();
  try {
    const { data, error } = await supabase.from('kv_store').select('key,value');
    if (error) throw error;
    _onSupabaseSuccess('readAll');
    const obj = {};
    (data || []).forEach(row => { obj[row.key] = row.value; });
    return obj;
  } catch (e) {
    console.error('Supabase readAll error, fallback to local:', e.message);
    _onSupabaseFailure('readAll', e.message);
    return readLocal();
  }
}

// كتابة مجموعة مفاتيح (upsert)
async function writeMany(entries) {
  // entries: {key1: value1, key2: value2, ...}
  // نحفظ نسخة محلية احتياطية دوماً
  const local = readLocal();
  Object.assign(local, entries);
  local._updatedAt = new Date().toISOString();
  writeLocal(local);

  if (!supabase) return local;

  try {
    const rows = Object.keys(entries).map(key => ({ key, value: entries[key] }));
    rows.push({ key: '_updatedAt', value: local._updatedAt });
    const { error } = await supabase.from('kv_store').upsert(rows, { onConflict: 'key' });
    if (error) throw error;
    _onSupabaseSuccess('writeMany');
  } catch (e) {
    console.error('Supabase writeMany error (تم الحفظ محلياً فقط):', e.message);
    _onSupabaseFailure('writeMany', e.message);
  }
  return local;
}

module.exports = { readAll, writeMany, getSyncStatus };

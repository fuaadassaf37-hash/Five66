// ===================== طبقة التخزين (Supabase) =====================
// يستخدم جدول kv_store(key text primary key, value text)
// مع تخزين احتياطي محلي (data/state.json) في حال عدم توفر اتصال

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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

// قراءة كل المفاتيح كـ object {key: value}
async function readAll() {
  if (!supabase) return readLocal();
  try {
    const { data, error } = await supabase.from('kv_store').select('key,value');
    if (error) throw error;
    const obj = {};
    (data || []).forEach(row => { obj[row.key] = row.value; });
    return obj;
  } catch (e) {
    console.error('Supabase readAll error, fallback to local:', e.message);
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
  } catch (e) {
    console.error('Supabase writeMany error (تم الحفظ محلياً فقط):', e.message);
  }
  return local;
}

module.exports = { readAll, writeMany };

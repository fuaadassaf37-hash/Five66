// ===================== تنبيهات المشرف (تيليجرام) =====================
// إرسال رسالة فورية للمشرف عند فشل الاتصال بـ Supabase أو عودته.
// الهدف: تجنّب ضياع بيانات صامت — ملف data/state.json المحلي مؤقت على
// Railway (يُمحى عند إعادة النشر/التشغيل)، فلا يجب أن يمر انقطاع Supabase
// بدون أن يلاحظه أحد.

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const configured = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

if (!configured) {
  console.log('⚠ لم يتم ضبط TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — تنبيهات فشل Supabase ستُطبع في السجل (logs) فقط، دون إرسال فعلي.');
}

async function notifyAdmin(message) {
  console.log('[تنبيه]', message.replace(/\n/g, ' | '));
  if (!configured) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('فشل إرسال تنبيه تيليجرام:', res.status, t);
    }
  } catch (e) {
    console.error('خطأ في إرسال تنبيه تيليجرام:', e.message);
  }
}

// إرسال ملف كمستند عبر تيليجرام — يُستخدم للنسخ الاحتياطية الدورية.
// الهدف من إرسالها عبر تيليجرام تحديداً (وليس فقط حفظها محلياً على Railway):
// نظام ملفات Railway مؤقت ويُمحى عند كل إعادة نشر، بينما تيليجرام يحفظ
// الملف بشكل دائم خارج السيرفر تماماً — نسخة احتياطية مستقلة عن كل من
// Railway و Supabase في آن واحد.
async function notifyAdminFile(filename, content, caption) {
  console.log('[نسخة احتياطية]', filename, `(${content.length} حرف)`, configured ? '— جارٍ الإرسال عبر تيليجرام' : '— تيليجرام غير مُعدّ، تخطّي الإرسال');
  if (!configured) return false;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    if (caption) form.append('caption', caption);
    form.append('document', new Blob([content], { type: 'application/json' }), filename);
    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('فشل إرسال ملف النسخة الاحتياطية عبر تيليجرام:', res.status, t);
      return false;
    }
    return true;
  } catch (e) {
    console.error('خطأ في إرسال ملف النسخة الاحتياطية:', e.message);
    return false;
  }
}

module.exports = { notifyAdmin, notifyAdminFile, configured };

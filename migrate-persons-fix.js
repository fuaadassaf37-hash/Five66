// ===================== ترحيل بيانات: تعديل الحالة الاجتماعية وأرقام التواصل =====================
// يُنفَّذ تلقائياً عند بدء تشغيل السيرفر فقط إذا كان المتغيّر البيئي
// RUN_PERSON_FIX_2026_08 = true (اضبطه في .env أو في متغيرات Railway).
// آمن للتكرار (idempotent): تشغيله أكثر من مرة ينتج نفس النتيجة بالضبط ولا
// يضر. بعد التأكد أن التعديل طُبِّق بنجاح (راجع سجل الطباعة عند التشغيل)،
// يمكنك حذف هذا المتغيّر من Railway أو تركه — لا فرق.

function norm(x) { return String(x || '').trim().toLowerCase(); }

// الأشخاص الذين حالتهم "أعزب" — كل من عداهم في السجلات الحالية يصبح "متزوج"
const SINGLE_MIL_IDS = [
  "3353210","9294968","N704859","7418225","N301996","c163857","c180780",
  "N403906","N320865","7388503","2389481","8323975","N771151","c180881",
  "2479503","6143842","9908786","c163579","N192147","9181384","N312025",
  "N398967","c173787","N151741","5494602","c180736","N251611","c180869",
  "N550098","6800525"
].map(norm);
const SINGLE_SET = new Set(SINGLE_MIL_IDS);

// تحديثات أرقام التواصل (مع اسم للتحقق فقط، لا يُستخدم للمطابقة)
const PHONE_UPDATES = [
  { name: "عزالدين حجي الخاير",     milId: "6268420",  phone: "+963936839049" },
  { name: "عبد الله حمود الفاضل",   milId: "3789688",  phone: "+963960037623" },
  { name: "عبد الرحمن رمضان الحمد", milId: "3353210",  phone: "+84795665370" },
  { name: "خليل حميد الحمدان",      milId: "5389957",  phone: "+201226619455" },
  { name: "سعيد علي المصطفى",       milId: "c163467",  phone: "+963949364817" },
  { name: "صالح مصطفى العامر",      milId: "N101268",  phone: null }, // غير متوفر -> حذف الحقل
];

async function run(db) {
  console.log('🔧 [ترحيل بيانات] فحص حالة الاجتماعية/أرقام التواصل...');
  try {
    const state = await db.readAll();
    const editedRaw = state.mil_persons_edited;
    if (!editedRaw) {
      console.warn('⚠️ [ترحيل بيانات] لا يوجد mil_persons_edited على السيرفر بعد — لا يوجد شيء لتعديله حالياً (ربما لم يُستخدم التطبيق مرة بعد). تم تخطي الترحيل.');
      return;
    }
    const persons = JSON.parse(editedRaw);

    const byId = new Map();
    persons.forEach(p => byId.set(norm(p.milId), p));

    let singleCount = 0, marriedCount = 0;
    const singleNotFound = SINGLE_MIL_IDS.filter(mid => !byId.has(mid));
    persons.forEach(p => {
      const mid = norm(p.milId);
      if (SINGLE_SET.has(mid)) { p.marital = 'أعزب'; singleCount++; }
      else { p.marital = 'متزوج'; marriedCount++; }
    });

    const phoneNotFound = [];
    PHONE_UPDATES.forEach(u => {
      const p = byId.get(norm(u.milId));
      if (!p) { phoneNotFound.push(u.milId); return; }
      if (p.name && p.name.trim() !== u.name.trim()) {
        console.warn(`⚠️ [ترحيل بيانات] تعارض اسم عند ${u.milId}: السيرفر لديه "${p.name}" بينما المتوقَّع "${u.name}" — تم تحديث الرقم رغم ذلك.`);
      }
      if (u.phone) p.phone = u.phone;
      else delete p.phone;
    });

    await db.writeMany({ mil_persons_edited: JSON.stringify(persons) });

    console.log(`✅ [ترحيل بيانات] تم بنجاح — أعزب: ${singleCount} | متزوج: ${marriedCount} | تحديثات هاتف مطبَّقة: ${PHONE_UPDATES.length - phoneNotFound.length}/${PHONE_UPDATES.length}`);
    if (singleNotFound.length) console.warn('⚠️ [ترحيل بيانات] أرقام عزّاب لم تُوجد في السجلات الحية:', singleNotFound);
    if (phoneNotFound.length) console.warn('⚠️ [ترحيل بيانات] أرقام تحديث هاتف لم تُوجد في السجلات الحية:', phoneNotFound);
  } catch (e) {
    console.error('❌ [ترحيل بيانات] فشل الترحيل:', e.message);
  }
}

module.exports = { run };

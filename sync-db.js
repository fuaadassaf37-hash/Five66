const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FALLBACK_FILE = path.join(DATA_DIR, 'sync-v2.json');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// التخزين المحلي في Railway مؤقت؛ لذلك نرفض اعتباره حفظاً ناجحاً افتراضياً.
// يُسمح به فقط عند ضبط REQUIRE_DURABLE_SYNC=false صراحةً في بيئة تطوير أو طوارئ.
const REQUIRE_DURABLE_SYNC = process.env.REQUIRE_DURABLE_SYNC !== 'false';
const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FALLBACK_FILE)) fs.writeFileSync(FALLBACK_FILE, JSON.stringify({ sequence: 0, records: {}, operations: [], results: {} }), 'utf8');

let _healthy = Boolean(supabase);
let _lastError = null;

function durableSyncUnavailable(error) {
  const failure = new Error(error?.message || 'التخزين الدائم غير متاح حالياً؛ لم تُقبل التعديلات على تخزين مؤقت.');
  failure.code = 'DURABLE_SYNC_UNAVAILABLE';
  failure.statusCode = 503;
  return failure;
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function readFallback() {
  try { return JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8')); }
  catch (_) { return { sequence: 0, records: {}, operations: [], results: {} }; }
}

function writeFallback(value) {
  const temporary = `${FALLBACK_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
  fs.renameSync(temporary, FALLBACK_FILE);
}

function normalizeOperation(input) {
  const operation = input && typeof input === 'object' ? input : {};
  if (!operation.opId || !operation.collection || !operation.recordId || !['upsert', 'delete'].includes(operation.type) || !Number.isInteger(operation.baseRevision) || operation.baseRevision < 0) {
    return { error: 'بيانات عملية المزامنة غير صالحة' };
  }
  if (operation.type === 'upsert' && (!operation.payload || typeof operation.payload !== 'object' || Array.isArray(operation.payload))) {
    return { error: 'بيانات السجل غير صالحة' };
  }
  if (operation.type === 'upsert' && Buffer.byteLength(JSON.stringify(operation.payload), 'utf8') > 512000) {
    return { error: 'حجم السجل أكبر من الحد المسموح' };
  }
  return {
    opId: String(operation.opId).slice(0, 128),
    collection: String(operation.collection).slice(0, 80),
    recordId: String(operation.recordId).slice(0, 160),
    type: operation.type,
    baseRevision: operation.baseRevision,
    payload: operation.type === 'delete' ? null : copy(operation.payload),
  };
}

function applyFallbackOperation(store, input, actor) {
  const operation = normalizeOperation(input);
  if (operation.error) return { opId: input?.opId ?? null, status: 'invalid', message: operation.error };
  if (store.results[operation.opId]) return copy(store.results[operation.opId]);
  const key = `${operation.collection}:${operation.recordId}`;
  const current = store.records[key] || null;
  const revision = current?.revision || 0;
  if (revision !== operation.baseRevision) {
    const conflict = { opId: operation.opId, status: 'conflict', record: copy(current), message: 'تم تعديل هذا السجل من جهاز آخر قبل حفظ تعديلاتك.' };
    store.results[operation.opId] = conflict;
    return copy(conflict);
  }
  const now = new Date().toISOString();
  const record = {
    id: operation.recordId,
    collection: operation.collection,
    revision: revision + 1,
    updatedAt: now,
    updatedBy: actor,
    deletedAt: operation.type === 'delete' ? now : null,
    payload: operation.payload,
  };
  store.records[key] = record;
  store.sequence += 1;
  const result = { opId: operation.opId, status: 'accepted', record: copy(record), sequence: store.sequence };
  store.results[operation.opId] = result;
  store.operations.push({ sequence: store.sequence, opId: operation.opId, type: operation.type, record: copy(record), actor, acceptedAt: now });
  if (store.operations.length > 5000) store.operations.splice(0, store.operations.length - 5000);
  return copy(result);
}

function mapSupabaseRecord(record) {
  if (!record) return null;
  return {
    id: record.record_id,
    collection: record.collection,
    revision: record.revision,
    updatedAt: record.updated_at,
    updatedBy: record.updated_by,
    deletedAt: record.deleted_at,
    payload: record.payload,
  };
}

async function applyWithSupabase(input, actor) {
  const operation = normalizeOperation(input);
  if (operation.error) return { opId: input?.opId ?? null, status: 'invalid', message: operation.error };
  const { data, error } = await supabase.rpc('apply_sync_operation', {
    p_op_id: operation.opId,
    p_collection: operation.collection,
    p_record_id: operation.recordId,
    p_type: operation.type,
    p_base_revision: operation.baseRevision,
    p_payload: operation.payload,
    p_actor: actor,
  });
  if (error) throw error;
  const result = data || {};
  return {
    opId: operation.opId,
    status: result.status,
    message: result.message || null,
    sequence: result.sequence || null,
    record: result.record ? mapSupabaseRecord(result.record) : null,
  };
}

async function applyOperations(inputs, actor) {
  const operations = Array.isArray(inputs) ? inputs.slice(0, 100) : [];
  const accepted = [];
  const results = [];
  if (supabase) {
    try {
      for (const input of operations) {
        const result = await applyWithSupabase(input, actor);
        results.push(result);
        if (result.status === 'accepted') accepted.push({ sequence: result.sequence, opId: result.opId, record: result.record, actor });
      }
      _healthy = true;
      _lastError = null;
      return { results, accepted, serverSequence: accepted.at(-1)?.sequence || null, backend: 'supabase' };
    } catch (error) {
      _healthy = false;
      _lastError = error.message;
      if (REQUIRE_DURABLE_SYNC) throw durableSyncUnavailable(error);
    }
  }
  if (REQUIRE_DURABLE_SYNC) {
    _healthy = false;
    _lastError = 'لم يتم ضبط اتصال Supabase للتخزين الدائم.';
    throw durableSyncUnavailable();
  }
  const fallback = readFallback();
  for (const input of operations) {
    const result = applyFallbackOperation(fallback, input, actor);
    results.push(result);
    if (result.status === 'accepted') accepted.push({ sequence: result.sequence, opId: result.opId, record: result.record, actor });
  }
  writeFallback(fallback);
  return { results, accepted, serverSequence: fallback.sequence, backend: 'fallback' };
}

async function bootstrap(since) {
  const cursor = Number.isInteger(since) && since >= 0 ? since : 0;
  if (supabase) {
    try {
      const { data, error } = await supabase.from('sync_operation_log').select('sequence, op_id, type, record, actor, created_at').gt('sequence', cursor).order('sequence', { ascending: true }).limit(501);
      if (error) throw error;
      const rows = data || [];
      const operations = rows.slice(0, 500).map((row) => ({ sequence: row.sequence, opId: row.op_id, type: row.type, record: mapSupabaseRecord(row.record), actor: row.actor, acceptedAt: row.created_at }));
      const serverSequence = rows.length ? rows[rows.length - 1].sequence : cursor;
      _healthy = true;
      _lastError = null;
      return { operations, serverSequence, hasMore: rows.length > 500, backend: 'supabase' };
    } catch (error) {
      _healthy = false;
      _lastError = error.message;
      if (REQUIRE_DURABLE_SYNC) throw durableSyncUnavailable(error);
    }
  }
  if (REQUIRE_DURABLE_SYNC) {
    _healthy = false;
    _lastError = 'لم يتم ضبط اتصال Supabase للتخزين الدائم.';
    throw durableSyncUnavailable();
  }
  const fallback = readFallback();
  const operations = fallback.operations.filter((operation) => operation.sequence > cursor).slice(0, 500);
  return { operations: copy(operations), serverSequence: fallback.sequence, hasMore: fallback.operations.some((operation) => operation.sequence > (operations.at(-1)?.sequence || cursor)), backend: 'fallback' };
}

function status() {
  const durableReady = Boolean(supabase && _healthy);
  return {
    backend: durableReady ? 'supabase' : 'fallback',
    supabaseConfigured: Boolean(supabase),
    supabaseHealthy: supabase ? _healthy : null,
    durableSyncRequired: REQUIRE_DURABLE_SYNC,
    durableSyncReady: durableReady,
    lastError: _lastError,
  };
}

module.exports = { applyOperations, bootstrap, status };

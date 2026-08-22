-- نفّذ هذا الكود في Supabase: لوحة التحكم > SQL Editor > New query > Run

create table if not exists kv_store (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

-- تحديث updated_at تلقائياً عند أي تعديل
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_kv_store_updated on kv_store;
create trigger trg_kv_store_updated
before update on kv_store
for each row execute function set_updated_at();

-- ===================== المزامنة الدقيقة لكل سجل =====================
-- لا تعدّل هذه الجداول kv_store الموجودة؛ تبقى البيانات القديمة قابلة للقراءة
-- أثناء انتقال الواجهة إلى sync-v2.js.
create table if not exists sync_records (
  collection text not null,
  record_id text not null,
  revision integer not null default 1,
  payload jsonb,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  primary key (collection, record_id)
);

create table if not exists sync_operation_log (
  sequence bigint generated always as identity primary key,
  op_id text not null unique,
  collection text not null,
  record_id text not null,
  operation_type text not null check (operation_type in ('upsert', 'delete')),
  record jsonb not null,
  actor text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sync_operation_log_sequence on sync_operation_log(sequence);
create index if not exists idx_sync_records_updated_at on sync_records(updated_at desc);

-- تقبل الدالة العملية مرة واحدة فقط عبر op_id؛ وعند اختلاف base_revision
-- تعيد النسخة الحالية كتعارض ولا تكتب فوق بيانات المستخدم الآخر.
create or replace function apply_sync_operation(
  p_op_id text,
  p_collection text,
  p_record_id text,
  p_type text,
  p_base_revision integer,
  p_payload jsonb,
  p_actor text
)
returns jsonb
language plpgsql
as $$
declare
  current_row sync_records%rowtype;
  logged_row sync_operation_log%rowtype;
  record_json jsonb;
  next_sequence bigint;
  current_exists boolean;
begin
  select * into logged_row from sync_operation_log where op_id = p_op_id;
  if found then
    return jsonb_build_object('status', 'accepted', 'sequence', logged_row.sequence, 'record', logged_row.record);
  end if;

  select * into current_row
  from sync_records
  where collection = p_collection and record_id = p_record_id
  for update;
  current_exists := found;

  if current_exists and current_row.revision <> p_base_revision then
    return jsonb_build_object(
      'status', 'conflict',
      'message', 'تم تعديل هذا السجل من جهاز آخر قبل حفظ تعديلاتك.',
      'record', jsonb_build_object(
        'record_id', current_row.record_id,
        'collection', current_row.collection,
        'revision', current_row.revision,
        'payload', current_row.payload,
        'deleted_at', current_row.deleted_at,
        'updated_at', current_row.updated_at,
        'updated_by', current_row.updated_by
      )
    );
  end if;

  if not current_exists and p_base_revision <> 0 then
    return jsonb_build_object('status', 'conflict', 'message', 'السجل لم يعد موجوداً أو تغير قبل مزامنته.', 'record', null);
  end if;

  if p_type not in ('upsert', 'delete') then
    return jsonb_build_object('status', 'invalid', 'message', 'نوع عملية المزامنة غير صالح.');
  end if;

  if current_exists then
    update sync_records
    set revision = current_row.revision + 1,
        payload = case when p_type = 'delete' then null else p_payload end,
        deleted_at = case when p_type = 'delete' then now() else null end,
        updated_at = now(),
        updated_by = p_actor
    where collection = p_collection and record_id = p_record_id;
  else
    insert into sync_records (collection, record_id, revision, payload, deleted_at, updated_at, updated_by)
    values (p_collection, p_record_id, 1, case when p_type = 'delete' then null else p_payload end, case when p_type = 'delete' then now() else null end, now(), p_actor);
  end if;

  select jsonb_build_object(
    'record_id', record_id,
    'collection', collection,
    'revision', revision,
    'payload', payload,
    'deleted_at', deleted_at,
    'updated_at', updated_at,
    'updated_by', updated_by
  ) into record_json
  from sync_records
  where collection = p_collection and record_id = p_record_id;

  insert into sync_operation_log (op_id, collection, record_id, operation_type, record, actor)
  values (p_op_id, p_collection, p_record_id, p_type, record_json, p_actor)
  returning sequence into next_sequence;

  return jsonb_build_object('status', 'accepted', 'sequence', next_sequence, 'record', record_json);
end;
$$;

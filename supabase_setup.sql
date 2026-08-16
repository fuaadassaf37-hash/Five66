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

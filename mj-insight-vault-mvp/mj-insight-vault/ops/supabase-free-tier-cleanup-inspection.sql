-- MJ Insight Vault Supabase free-tier cleanup inspection.
-- READ ONLY. Run only after PostgreSQL becomes reachable.
-- Purpose: identify what consumes DB space before any deletion decision.

select
  n.nspname as schema_name,
  c.relname as relation_name,
  c.relkind,
  pg_total_relation_size(c.oid) as total_bytes,
  pg_relation_size(c.oid) as table_bytes,
  pg_indexes_size(c.oid) as index_bytes,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total_pretty
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','m','i','t')
  and n.nspname in ('public','storage')
order by pg_total_relation_size(c.oid) desc
limit 100;

select
  pg_database_size(current_database()) as database_bytes,
  pg_size_pretty(pg_database_size(current_database())) as database_pretty;

-- Candidate classification only; this statement does not delete anything.
select table_schema, table_name
from information_schema.tables
where table_schema = 'public'
  and (
    table_name ilike '%job%'
    or table_name ilike '%lease%'
    or table_name ilike '%receipt%'
    or table_name ilike '%ocr%'
    or table_name ilike '%canary%'
    or table_name ilike '%embedding%'
    or table_name ilike '%report%'
  )
order by table_name;

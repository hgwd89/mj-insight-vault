begin;
do $do$
declare c record;v_expr text;
begin
  for c in select conname,pg_get_expr(conbin,conrelid) expr from pg_constraint where conrelid='public.articles'::regclass and contype='c' and pg_get_expr(conbin,conrelid) ilike '%analysis_text_origin%' loop
    v_expr:=c.expr;
    execute format('alter table public.articles drop constraint %I',c.conname);
    execute format('alter table public.articles add constraint %I check ((%s) or analysis_text_origin = %L)',c.conname,v_expr,'inventory_recovered_source_region_v18');
  end loop;
end
$do$;
commit;
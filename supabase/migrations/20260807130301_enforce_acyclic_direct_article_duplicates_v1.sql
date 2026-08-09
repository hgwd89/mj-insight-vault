update public.articles
set status='excluded',
    exclusion_reason=coalesce(exclusion_reason,'duplicate_reference_normalized_v1'),
    updated_at=now()
where duplicate_of_article_id is not null and status is distinct from 'excluded';

alter table public.articles drop constraint if exists articles_duplicate_not_self_chk;
alter table public.articles add constraint articles_duplicate_not_self_chk check(duplicate_of_article_id is null or duplicate_of_article_id<>id);

create or replace function public.enforce_direct_article_duplicate_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog','public'
as $$
declare t_dup uuid; t_status text; dependent_count integer;begin
  if new.duplicate_of_article_id is not null then
    if new.status is distinct from 'excluded' then
      raise exception using errcode='23514',message='duplicate_article_must_be_excluded';
    end if;
    select duplicate_of_article_id,status into t_dup,t_status from public.articles where id=new.duplicate_of_article_id;
    if not found then raise exception using errcode='23503',message='duplicate_target_missing'; end if;
    if t_dup is not null then raise exception using errcode='23514',message='duplicate_target_must_be_direct_canonical'; end if;
    if t_status in ('deleted','excluded','rejected') then raise exception using errcode='23514',message='duplicate_target_must_be_active'; end if;
  end if;

  if tg_op='UPDATE' and old.duplicate_of_article_id is null
     and ((new.duplicate_of_article_id is not null) or new.status in ('deleted','excluded','rejected')) then
    select count(*)::integer into dependent_count from public.articles d where d.duplicate_of_article_id=old.id and d.id<>old.id;
    if dependent_count>0 then
      raise exception using errcode='23514',message='canonical_article_has_duplicate_dependents',detail=format('article_id=%s dependent_count=%s; repoint dependents before hiding canonical',old.id,dependent_count);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_01_enforce_direct_article_duplicate_v1 on public.articles;
create trigger trg_01_enforce_direct_article_duplicate_v1
before insert or update of duplicate_of_article_id,status on public.articles
for each row execute function public.enforce_direct_article_duplicate_v1();
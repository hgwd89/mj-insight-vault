alter table public.theme_census_relations_v4 drop constraint if exists theme_census_relations_v4_check;

alter table public.theme_census_relations_v4
add constraint theme_census_relations_v4_source_grounded_check
check (
  (
    relation='none'
    and coalesce(btrim(clean_body_anchor),'')=''
    and coalesce(btrim(source_region_anchor),'')=''
    and source_block_index is null
    and source_block_sha256 is null
    and subject is null
    and measurement is null
  )
  or
  (
    relation<>'none'
    and coalesce(btrim(clean_body_anchor),'')=''
    and length(btrim(coalesce(source_region_anchor,'')))>=6
    and source_block_index is not null
    and source_block_sha256 ~ '^[0-9a-f]{64}$'
    and subject is not null
    and measurement is not null
  )
);
create or replace function public.is_hard_advertisement_v1(
  p_headline text,
  p_clean_body text
)
returns boolean
language sql
immutable
set search_path to 'pg_catalog', 'public'
as $function$
select
  coalesce(p_clean_body,'') ~ '本紙面.{0,40}(全面|特集)?広告'
  or coalesce(p_headline,'') ~ '(出展者募集中|出展者募集)'
  or coalesce(p_headline,'') ~ '日経の記事.{0,30}額装サービス'
  or coalesce(p_headline,'') ~ '(日経DVD|研修DVD|DVD広告|取適法)'
  or (
    coalesce(p_headline,'') ~ '(研修動画|研修教材|情報セキュリティ対策)'
    and coalesce(p_clean_body,'') ~ '(オンライン研修|eラーニング|DVD|日経BP|受講履歴|研修サービス)'
  )
  or (
    coalesce(p_clean_body,'') ~ '(出展申込締切|早期申込割引)'
    and coalesce(p_clean_body,'') ~ '(出展料|出展小間料|出展対象|来場対象)'
  )
$function$;

update public.articles
   set headline = headline,
       status = 'excluded',
       exclusion_reason = coalesce(exclusion_reason, 'advertisement_or_training_media_promotion_not_news_v1')
 where coalesce(hard_advertisement_flag, false) = false
   and (
     coalesce(headline,'') ~ '(日経DVD|研修DVD|DVD広告|取適法)'
     or (
       coalesce(headline,'') ~ '(研修動画|研修教材|情報セキュリティ対策)'
       and coalesce(analysis_body_clean,'') ~ '(オンライン研修|eラーニング|DVD|日経BP|受講履歴|研修サービス)'
     )
   );

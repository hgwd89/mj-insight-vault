revoke execute on function public.enforce_only_v6_formal_report_row() from public, anon, authenticated;
revoke execute on function public.theme_census_batch_input_fingerprint_v5(uuid) from public, anon, authenticated;
revoke execute on function public.theme_census_integrity_v5(uuid) from public, anon, authenticated;
revoke execute on function public.validate_formal_report_claim_v6() from public, anon, authenticated;
revoke execute on function public.validate_theme_census_stage_v5() from public, anon, authenticated;

grant execute on function public.theme_census_batch_input_fingerprint_v5(uuid) to service_role;
grant execute on function public.theme_census_integrity_v5(uuid) to service_role;
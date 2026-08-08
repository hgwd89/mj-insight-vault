alter table public.source_image_near_duplicate_audit_v1 enable row level security;
revoke all on public.source_image_near_duplicate_audit_v1 from public,anon,authenticated;
grant select on public.source_image_near_duplicate_audit_v1 to service_role;
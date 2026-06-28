-- The app reads/writes concept_clusters through the server-side Supabase service role.
-- Do not expose unrestricted anon/authenticated access through a permissive RLS policy.
DROP POLICY IF EXISTS "app_rw" ON concept_clusters;
ALTER TABLE concept_clusters ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS concept_clusters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_index      integer NOT NULL,
  cluster_label      text NOT NULL DEFAULT '',
  cluster_description text NOT NULL DEFAULT '',
  member_article_ids uuid[] NOT NULL DEFAULT '{}',
  member_summaries   jsonb NOT NULL DEFAULT '[]',
  source_rollup_months text[] NOT NULL DEFAULT '{}',
  centroid           vector(1536),
  total_articles     integer NOT NULL DEFAULT 0,
  generated_at       timestamptz DEFAULT now(),
  generation_params  jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS concept_clusters_cluster_index_idx ON concept_clusters(cluster_index);
CREATE INDEX IF NOT EXISTS concept_clusters_generated_at_idx  ON concept_clusters(generated_at DESC);
ALTER TABLE concept_clusters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "app_rw" ON concept_clusters FOR ALL USING (true) WITH CHECK (true);

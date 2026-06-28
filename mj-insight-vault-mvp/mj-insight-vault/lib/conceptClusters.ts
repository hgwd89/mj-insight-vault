import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getOpenAI } from '@/lib/openai';

export const CONCEPT_CLUSTERS_K_DEFAULT = 15;
const KMEANS_MAX_ITER = 50;
const TOP_MEMBERS_FOR_LABEL = 5;
const LABEL_MODEL = 'gpt-4o-mini';
const LABEL_MAX_TOKENS = 200;

// Regex to extract /articles/{UUID} from evidence_matrix item strings
const ARTICLE_UUID_RE = /\/articles\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const HEADLINE_RE = /^\d+\.\s*\[([^\]|]+?)(?:\s*\/[^\]|]+?)?\s*\|/;
const SUMMARY_RE = /\):\s*([\s\S]+)$/;

export interface ConceptElement {
  articleId: string;
  headline: string;
  summaryText: string;
  monthKey: string;
  sourceRollupId: string;
}

export interface MemberSummary {
  article_id: string;
  headline: string;
  summary_text: string;
  month_key: string;
  source_rollup_id: string;
}

export interface ConceptCluster {
  id: string;
  cluster_index: number;
  cluster_label: string;
  cluster_description: string;
  member_article_ids: string[];
  member_summaries: MemberSummary[];
  source_rollup_months: string[];
  total_articles: number;
  generated_at: string;
  generation_params: Record<string, unknown>;
}

// --- Vector utilities ---

function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === 'string') {
    try { return JSON.parse(v) as number[]; } catch { return null; }
  }
  return null;
}

function l2sq(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

// --- k-means ---

function kMeans(vectors: number[][], k: number): { assignments: number[]; centroids: number[][] } {
  const n = vectors.length;
  const dim = vectors[0].length;

  // Initialize: pick k distinct random indices
  const seen = new Set<number>();
  const initIdx: number[] = [];
  while (initIdx.length < k) {
    const i = Math.floor(Math.random() * n);
    if (!seen.has(i)) { seen.add(i); initIdx.push(i); }
  }
  const centroids = initIdx.map((i) => vectors[i].slice());
  let assignments = new Array<number>(n).fill(0);

  for (let iter = 0; iter < KMEANS_MAX_ITER; iter++) {
    // Assignment step
    const next = vectors.map((v) => {
      let best = 0;
      let bestD = l2sq(v, centroids[0]);
      for (let c = 1; c < k; c++) {
        const d = l2sq(v, centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    });

    const converged = iter > 0 && next.every((a, i) => a === assignments[i]);
    assignments = next;
    if (converged) break;

    // Update step
    const sums = Array.from({ length: k }, () => new Array<number>(dim).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) sums[c][d] += vectors[i][d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centroids[c] = sums[c].map((s) => s / counts[c]);
      } else {
        centroids[c] = vectors[Math.floor(Math.random() * n)].slice();
      }
    }
  }

  return { assignments, centroids };
}

// --- Element extraction ---

function parseElement(item: unknown, rollupId: string, monthKey: string): ConceptElement | null {
  if (typeof item !== 'string') return null;
  const uuidMatch = ARTICLE_UUID_RE.exec(item);
  if (!uuidMatch) return null;
  const articleId = uuidMatch[1];
  const headlineMatch = HEADLINE_RE.exec(item);
  const headline = headlineMatch ? headlineMatch[1].trim() : '';
  const summaryMatch = SUMMARY_RE.exec(item);
  const summaryText = summaryMatch ? summaryMatch[1].replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { articleId, headline, summaryText, monthKey, sourceRollupId: rollupId };
}

async function extractElementsFromRollups(): Promise<ConceptElement[]> {
  const { data, error } = await supabaseAdmin
    .from('monthly_rollups')
    .select('id, month_key, summary_json')
    .eq('status', 'ready');
  if (error) throw error;

  const elements: ConceptElement[] = [];
  const seen = new Set<string>();

  for (const row of data || []) {
    const matrix = (row.summary_json as Record<string, unknown>)?.evidence_matrix;
    if (!Array.isArray(matrix)) continue;
    for (const item of matrix) {
      const el = parseElement(item, row.id as string, row.month_key as string);
      if (!el || seen.has(el.articleId)) continue;
      seen.add(el.articleId);
      elements.push(el);
    }
  }

  return elements;
}

// --- Embedding loading ---

async function loadEmbeddings(articleIds: string[]): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  // Batch in groups of 200 to avoid query size limits
  for (let i = 0; i < articleIds.length; i += 200) {
    const batch = articleIds.slice(i, i + 200);
    const { data, error } = await supabaseAdmin
      .from('article_embeddings')
      .select('article_id, embedding_vector')
      .in('article_id', batch);
    if (error) throw error;
    for (const row of data || []) {
      const vec = parseVector((row as Record<string, unknown>).embedding_vector);
      if (vec && vec.length > 0) result.set(row.article_id as string, vec);
    }
  }
  return result;
}

// --- LLM labeling ---

async function labelCluster(members: ConceptElement[], clusterIndex: number, totalK: number): Promise<{ label: string; description: string }> {
  const openai = getOpenAI();
  if (!openai) return { label: `クラスタ${clusterIndex + 1}`, description: '' };

  const top = members.slice(0, TOP_MEMBERS_FOR_LABEL);
  const examples = top.map((m, i) => `${i + 1}. 【${m.headline}】${m.summaryText}`).join('\n');

  const prompt = `以下は消費者・マーケティングインサイトデータの中から、意味的に近い記事${members.length}件をクラスタリングした結果の代表例です（${clusterIndex + 1}/${totalK}番目のクラスタ）。

代表記事:
${examples}

このクラスタを表す「簡潔な日本語ラベル（15字以内）」と「このクラスタが何を表すかの説明（2〜3文）」を生成してください。
必ず下記のJSONのみを返してください:
{"label":"...", "description":"..."}`;

  try {
    const completion = await openai.chat.completions.create({
      model: LABEL_MODEL,
      max_completion_tokens: LABEL_MAX_TOKENS,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    });
    const parsed = JSON.parse(completion.choices[0]?.message.content || '{}') as Record<string, unknown>;
    return {
      label: typeof parsed.label === 'string' ? parsed.label : `クラスタ${clusterIndex + 1}`,
      description: typeof parsed.description === 'string' ? parsed.description : ''
    };
  } catch {
    return { label: `クラスタ${clusterIndex + 1}`, description: '' };
  }
}

// --- Main rebuild ---

export async function rebuildConceptClusters(k: number = CONCEPT_CLUSTERS_K_DEFAULT): Promise<{
  element_count: number;
  skipped_no_embedding: number;
  clusters_created: number;
  k: number;
  clusters: { index: number; label: string; description: string; member_count: number }[];
}> {
  // 1. Extract elements from rollups
  const elements = await extractElementsFromRollups();
  const articleIds = elements.map((e) => e.articleId);

  // 2. Load embeddings
  const embMap = await loadEmbeddings(articleIds);

  // 3. Filter to elements with embeddings
  const validElements: ConceptElement[] = [];
  const validVectors: number[][] = [];
  let skippedNoEmbedding = 0;
  for (const el of elements) {
    const vec = embMap.get(el.articleId);
    if (!vec) { skippedNoEmbedding++; console.warn(`[conceptClusters] no embedding for ${el.articleId} (${el.headline})`); continue; }
    validElements.push(el);
    validVectors.push(vec);
  }

  const effectiveK = Math.min(k, validElements.length);
  if (effectiveK < 2) throw new Error(`Not enough elements with embeddings (${validElements.length})`);

  // 4. k-means
  const { assignments, centroids } = kMeans(validVectors, effectiveK);

  // 5. Group elements by cluster
  const groups: ConceptElement[][] = Array.from({ length: effectiveK }, () => []);
  for (let i = 0; i < validElements.length; i++) groups[assignments[i]].push(validElements[i]);

  // 6. Label clusters in parallel batches of 5
  const labels: { label: string; description: string }[] = new Array(effectiveK);
  for (let start = 0; start < effectiveK; start += 5) {
    const batch = Array.from({ length: Math.min(5, effectiveK - start) }, (_, j) => start + j);
    const results = await Promise.all(batch.map((c) => labelCluster(groups[c], c, effectiveK)));
    for (let j = 0; j < batch.length; j++) labels[batch[j]] = results[j];
  }

  // 7. Build DB rows
  const rollupMonthsSet = (rollupId: string, elements: ConceptElement[]) => {
    void rollupId;
    return [...new Set(elements.map((e) => e.monthKey))];
  };

  const rows = groups.map((members, c) => ({
    cluster_index: c,
    cluster_label: labels[c].label,
    cluster_description: labels[c].description,
    member_article_ids: members.map((m) => m.articleId),
    member_summaries: members.map((m) => ({
      article_id: m.articleId,
      headline: m.headline,
      summary_text: m.summaryText,
      month_key: m.monthKey,
      source_rollup_id: m.sourceRollupId
    })) satisfies MemberSummary[],
    source_rollup_months: rollupMonthsSet('', members),
    centroid: JSON.stringify(centroids[c]),
    total_articles: members.length,
    generated_at: new Date().toISOString(),
    generation_params: { k: effectiveK, element_count: validElements.length, skipped_no_embedding: skippedNoEmbedding, kmeans_max_iter: KMEANS_MAX_ITER }
  }));

  // 8. Replace all rows atomically
  const { error: delError } = await supabaseAdmin.from('concept_clusters').delete().gte('cluster_index', 0);
  if (delError) throw delError;
  const { error: insError } = await supabaseAdmin.from('concept_clusters').insert(rows);
  if (insError) throw insError;

  return {
    element_count: validElements.length,
    skipped_no_embedding: skippedNoEmbedding,
    clusters_created: effectiveK,
    k: effectiveK,
    clusters: rows.map((r) => ({ index: r.cluster_index, label: r.cluster_label, description: r.cluster_description, member_count: r.total_articles }))
  };
}

// --- Read functions ---

export async function getConceptClusters(): Promise<ConceptCluster[]> {
  const { data, error } = await supabaseAdmin
    .from('concept_clusters')
    .select('id, cluster_index, cluster_label, cluster_description, member_article_ids, member_summaries, source_rollup_months, total_articles, generated_at, generation_params')
    .order('cluster_index', { ascending: true });
  if (error) throw error;
  return (data || []) as unknown as ConceptCluster[];
}

export async function getClusterById(id: string): Promise<ConceptCluster | null> {
  const { data, error } = await supabaseAdmin
    .from('concept_clusters')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return null;
  return data as unknown as ConceptCluster;
}

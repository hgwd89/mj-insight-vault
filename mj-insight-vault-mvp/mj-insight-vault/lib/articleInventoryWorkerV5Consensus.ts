import { createHash } from 'node:crypto';
import { supabaseAdmin, STORAGE_BUCKET } from './supabaseAdmin';
import { getOpenAIKey } from './openai';
import { runArticleInventoryWorkerV4VisionStep } from './articleInventoryWorkerV4Vision';
import { runArticleInventoryWorkerV3Step } from './articleInventoryWorkerV3';

type JsonRecord = Record<string, unknown>;
type PassKind = 'mapper' | 'critic' | 'adjudicator';
type ClaimedJob = {
  id: string;
  inventory_source_image_id: string;
  source_ocr_json_sha256: string;
  block_count: number;
  requires_third_pass: boolean;
  lease_token: string;
};
type Block = {
  block_index: number;
  block_text: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  source_ocr_json_sha256: string;
};
type Rect = { x_min: number; y_min: number; x_max: number; y_max: number };
type VisualArticle = { headline_hint: string; confidence: number; regions: Rect[]; reason: string };
type RawGroup = {
  pass_kind: PassKind;
  group_kind: 'article' | 'non_article';
  group_fingerprint: string;
  block_indices: number[];
  headline_anchor: string | null;
  non_article_role: string | null;
  confidence: number;
  reason: string | null;
};
type FinalGroup = {
  seq: number;
  group_kind: 'article' | 'non_article';
  block_indices: number[];
  headline_anchor: string;
  non_article_role: string;
  confidence: number;
  reason: string;
};

class ReviewRequiredError extends Error {}
const PASS_KINDS: PassKind[] = ['mapper', 'critic', 'adjudicator'];
const COORD_MAX = 1000;
const CENTER_MARGIN = 6;

const visualSchema = {
  type: 'json_schema',
  name: 'mj_visual_article_regions_v5_adjudicator',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false, required: ['articles'],
    properties: {
      articles: {
        type: 'array', minItems: 1, maxItems: 12,
        items: {
          type: 'object', additionalProperties: false,
          required: ['headline_hint', 'confidence', 'regions', 'reason'],
          properties: {
            headline_hint: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reason: { type: 'string' },
            regions: {
              type: 'array', minItems: 1, maxItems: 8,
              items: {
                type: 'object', additionalProperties: false,
                required: ['x_min', 'y_min', 'x_max', 'y_max'],
                properties: {
                  x_min: { type: 'integer', minimum: 0, maximum: 1000 },
                  y_min: { type: 'integer', minimum: 0, maximum: 1000 },
                  x_max: { type: 'integer', minimum: 0, maximum: 1000 },
                  y_max: { type: 'integer', minimum: 0, maximum: 1000 }
                }
              }
            }
          }
        }
      }
    }
  }
} as const;

function text(value: unknown) { return value == null ? '' : String(value).trim(); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewRequiredError('Expected object response.');
  return value as JsonRecord;
}
function outputText(payload: JsonRecord) {
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  for (const rawItem of Array.isArray(payload.output) ? payload.output : []) {
    const item = rawItem && typeof rawItem === 'object' ? rawItem as JsonRecord : {};
    for (const rawPart of Array.isArray(item.content) ? item.content : []) {
      const part = rawPart && typeof rawPart === 'object' ? rawPart as JsonRecord : {};
      if (typeof part.text === 'string' && part.text.trim()) return part.text.trim();
    }
  }
  throw new ReviewRequiredError('OpenAI response missing output text.');
}
function normalizeText(value: string) { return value.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
function bigrams(value: string) {
  const n = normalizeText(value); const out = new Set<string>();
  if (n.length === 1) out.add(n);
  for (let i = 0; i < n.length - 1; i += 1) out.add(n.slice(i, i + 2));
  return out;
}
function textSimilarity(a: string, b: string) {
  const aa = bigrams(a), bb = bigrams(b); if (!aa.size || !bb.size) return 0;
  let hit = 0; for (const x of aa) if (bb.has(x)) hit += 1;
  return 2 * hit / (aa.size + bb.size);
}
function jaccard(a: number[], b: number[]) {
  const aa = new Set(a), bb = new Set(b); let hit = 0;
  for (const x of aa) if (bb.has(x)) hit += 1;
  return hit / Math.max(1, aa.size + bb.size - hit);
}
function parseHint(reason: string | null) {
  const m = String(reason || '').match(/(?:^|;\s*)hint=(.*?);\s*regions=/);
  return m?.[1]?.trim() || '';
}
function median(values: number[]) {
  const x = [...values].sort((a, b) => a - b);
  if (!x.length) return 0;
  return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2;
}

async function claim(jobId?: string) {
  const { data, error } = await supabaseAdmin.rpc('claim_source_page_article_inventory_job_v3', {
    p_job_id: jobId || null, p_lease_seconds: 300
  });
  if (error) throw new Error(error.message);
  return ((Array.isArray(data) ? data[0] : data) || null) as ClaimedJob | null;
}
async function yieldJob(job: ClaimedJob, stage: string) {
  const { data, error } = await supabaseAdmin.rpc('yield_source_page_article_inventory_job_v2', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_stage: stage
  });
  if (error) throw new Error(error.message); return data;
}
async function reviewJob(job: ClaimedJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('review_source_page_article_inventory_job_v1', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_reason: reason.slice(0, 3000)
  });
  if (error) throw new Error(`${reason}; review rpc: ${error.message}`); return data;
}
async function failJob(job: ClaimedJob, reason: string) {
  const { data, error } = await supabaseAdmin.rpc('fail_source_page_article_inventory_job_v2', {
    p_job_id: job.id, p_lease_token: job.lease_token, p_error_message: reason.slice(0, 3000), p_retryable: true
  });
  if (error) throw new Error(`${reason}; fail rpc: ${error.message}`); return data;
}
async function passKinds(jobId: string) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_pass_runs_v1').select('pass_kind,model').eq('job_id', jobId);
  if (error) throw new Error(error.message);
  return { kinds: new Set((data || []).map((r) => String(r.pass_kind))), rows: data || [] };
}
async function loadBlocks(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_blocks_v1')
    .select('block_index,block_text,x_min,y_min,x_max,y_max,source_ocr_json_sha256').eq('job_id', job.id).order('block_index');
  if (error) throw new Error(error.message);
  const blocks = (data || []) as Block[];
  if (blocks.length !== job.block_count || blocks.some((b) => b.source_ocr_json_sha256 !== job.source_ocr_json_sha256)) {
    throw new ReviewRequiredError('Fresh OCR block provenance drift.');
  }
  return blocks;
}
async function loadSource(job: ClaimedJob) {
  const { data, error } = await supabaseAdmin.from('source_images')
    .select('storage_path,mime_type,width,height,storage_size_bytes').eq('id', job.inventory_source_image_id).single();
  if (error) throw new Error(error.message);
  const width = Number(data.width || 0), height = Number(data.height || 0), expected = Number(data.storage_size_bytes || 0);
  if (!data.storage_path || width < 1 || height < 1) throw new ReviewRequiredError('Source image metadata incomplete.');
  const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(String(data.storage_path));
  if (downloaded.error || !downloaded.data) throw new Error(downloaded.error?.message || 'Image download failed.');
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (expected > 0 && buffer.length !== expected) throw new ReviewRequiredError('Source image size drift.');
  return { buffer, width, height, mimeType: String(data.mime_type || downloaded.data.type || 'image/jpeg') };
}

function parseArticles(parsed: JsonRecord, minConfidence: number) {
  if (!Array.isArray(parsed.articles) || parsed.articles.length < 1 || parsed.articles.length > 12) throw new ReviewRequiredError('Adjudicator article count invalid.');
  return parsed.articles.map((raw, i) => {
    const item = asRecord(raw); const hint = text(item.headline_hint); const confidence = Number(item.confidence); const reason = text(item.reason);
    if (hint.length < 2 || !Number.isFinite(confidence) || confidence < minConfidence || confidence > 1 || reason.length < 2) {
      throw new ReviewRequiredError(`Adjudicator article ${i} invalid hint/confidence/reason.`);
    }
    if (!Array.isArray(item.regions) || item.regions.length < 1 || item.regions.length > 8) throw new ReviewRequiredError(`Adjudicator article ${i} regions invalid.`);
    const regions = item.regions.map((rr, j) => {
      const r = asRecord(rr); const v = { x_min: Number(r.x_min), y_min: Number(r.y_min), x_max: Number(r.x_max), y_max: Number(r.y_max) };
      if (!Object.values(v).every(Number.isInteger) || v.x_min < 0 || v.y_min < 0 || v.x_max > 1000 || v.y_max > 1000 || v.x_max <= v.x_min || v.y_max <= v.y_min) {
        throw new ReviewRequiredError(`Adjudicator article ${i} region ${j} invalid.`);
      }
      return v;
    });
    return { headline_hint: hint, confidence, reason, regions } as VisualArticle;
  });
}
function blockRect(block: Block, width: number, height: number): Rect {
  return { x_min: block.x_min / width * COORD_MAX, y_min: block.y_min / height * COORD_MAX, x_max: block.x_max / width * COORD_MAX, y_max: block.y_max / height * COORD_MAX };
}
function area(r: Rect) { return Math.max(1e-6, (r.x_max - r.x_min) * (r.y_max - r.y_min)); }
function intersect(a: Rect, b: Rect) { return Math.max(0, Math.min(a.x_max, b.x_max) - Math.max(a.x_min, b.x_min)) * Math.max(0, Math.min(a.y_max, b.y_max) - Math.max(a.y_min, b.y_min)); }
function articleScore(block: Rect, article: VisualArticle) {
  const cx = (block.x_min + block.x_max) / 2, cy = (block.y_min + block.y_max) / 2; let best = 0;
  for (const r of article.regions) {
    const coverage = intersect(block, r) / area(block);
    const inside = cx >= Math.max(0, r.x_min - CENTER_MARGIN) && cx <= Math.min(1000, r.x_max + CENTER_MARGIN) && cy >= Math.max(0, r.y_min - CENTER_MARGIN) && cy <= Math.min(1000, r.y_max + CENTER_MARGIN);
    best = Math.max(best, inside ? 1 + coverage : coverage >= 0.35 ? coverage : 0);
  }
  return best;
}
function chooseAnchor(hints: string[], blocks: Block[]) {
  const maxHeight = Math.max(...blocks.map((b) => Math.max(1, b.y_max - b.y_min))); let best: Block | null = null; let bestScore = -1;
  for (const b of blocks) {
    if (b.block_text.trim().length < 2) continue;
    const hintScore = hints.length ? Math.max(...hints.map((h) => textSimilarity(h, b.block_text))) : 0;
    const height = Math.min(1, Math.max(1, b.y_max - b.y_min) / maxHeight);
    const score = 0.84 * hintScore + 0.16 * height;
    if (score > bestScore) { bestScore = score; best = b; }
  }
  if (!best) throw new ReviewRequiredError('Consensus article has no grounded anchor block.');
  const raw = best.block_text.trim(); return raw.length <= 100 ? raw : raw.slice(0, 100).trim();
}
function deriveAdjudicatorGroups(articles: VisualArticle[], blocks: Block[], width: number, height: number) {
  const assigned = new Map<number, number[]>(), leftovers: number[] = []; let ambiguous = 0;
  for (const b of blocks) {
    const scores = articles.map((a, i) => ({ i, score: articleScore(blockRect(b, width, height), a) })).filter((x) => x.score > 0).sort((a, b2) => b2.score - a.score || a.i - b2.i);
    if (!scores.length) { leftovers.push(b.block_index); continue; }
    if (scores.length > 1 && scores[0].score - scores[1].score < 0.08) ambiguous += 1;
    const list = assigned.get(scores[0].i) || []; list.push(b.block_index); assigned.set(scores[0].i, list);
  }
  if (ambiguous > Math.max(2, Math.floor(blocks.length * 0.01))) throw new ReviewRequiredError(`Adjudicator regions ambiguously overlap ${ambiguous} blocks.`);
  const byIndex = new Map(blocks.map((b) => [b.block_index, b])); const groups: JsonRecord[] = [];
  articles.forEach((a, i) => {
    const ids = (assigned.get(i) || []).sort((x, y) => x - y); if (!ids.length) throw new ReviewRequiredError(`Adjudicator article ${i} has no OCR blocks.`);
    const articleBlocks = ids.map((id) => byIndex.get(id)).filter(Boolean) as Block[];
    groups.push({ group_kind: 'article', block_indices: ids, headline_anchor: chooseAnchor([a.headline_hint], articleBlocks), non_article_role: '', confidence: a.confidence, reason: `visual_regions_v5 pass=adjudicator; hint=${a.headline_hint}; regions=${JSON.stringify(a.regions)}; ${a.reason}` });
  });
  if (leftovers.length) groups.push({ group_kind: 'non_article', block_indices: leftovers.sort((a, b) => a - b), headline_anchor: '', non_article_role: 'outside_all_independently_detected_editorial_regions', confidence: 0.99, reason: 'deterministic complement of adjudicator visual article regions' });
  return groups;
}
async function runAdjudicator(job: ClaimedJob, blocks: Block[]) {
  const source = await loadSource(job); const apiKey = getOpenAIKey(); if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const model = process.env.OPENAI_INVENTORY_ADJUDICATOR_MODEL || 'gpt-4o-mini';
  const instructions = [
    'You are the third independent blind newspaper page-layout adjudicator.',
    'Use only the supplied page image. Do not use prior pass outputs, database article counts, filenames, or OCR grouping.',
    'Identify every distinct standalone editorial article. Exclude advertisements, mastheads, navigation, isolated captions, and decorative text.',
    'Return tight article rectangles in normalized 0-1000 coordinates. One article may use multiple rectangles.',
    'Do not merge neighboring articles. Do not split subsections into separate articles.',
    'headline_hint is a short visual transcription of the article headline.',
    'Use confidence 0.60-0.79 when an article boundary is uncertain instead of omitting the article. The final majority consensus decides acceptance.',
    'Return only JSON.'
  ].join(' ');
  const body = { model, store: false, max_output_tokens: 6000, instructions, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Blindly audit this newspaper page and return all standalone editorial article regions.' }, { type: 'input_image', image_url: `data:${source.mimeType};base64,${source.buffer.toString('base64')}`, detail: 'high' }] }], text: { format: visualSchema } };
  const promptSha256 = sha256(JSON.stringify(body));
  const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
  const raw = await response.text(); if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${raw.slice(0, 500)}`);
  const payload = JSON.parse(raw) as JsonRecord; const providerResponseId = text(payload.id); if (!providerResponseId.startsWith('resp_')) throw new Error('Adjudicator provider receipt missing.');
  const parsed = JSON.parse(outputText(payload)) as JsonRecord; const articles = parseArticles(parsed, 0.60); const groups = deriveAdjudicatorGroups(articles, blocks, source.width, source.height);
  const { data, error } = await supabaseAdmin.rpc('record_source_page_article_inventory_pass_v3', { p_job_id: job.id, p_lease_token: job.lease_token, p_pass_kind: 'adjudicator', p_model: model, p_provider_response_id: providerResponseId, p_prompt_sha256: promptSha256, p_response_sha256: sha256(raw), p_groups: groups });
  if (error) throw new Error(error.message); return { articles: articles.length, groups: groups.length, stored: data };
}

async function loadRawGroups(jobId: string) {
  const { data, error } = await supabaseAdmin.from('source_page_article_inventory_groups_v1').select('pass_kind,group_kind,group_fingerprint,block_indices,headline_anchor,non_article_role,confidence,reason').eq('job_id', jobId);
  if (error) throw new Error(error.message); return (data || []) as RawGroup[];
}
function matchScore(a: RawGroup, b: RawGroup) {
  const jac = jaccard(a.block_indices, b.block_indices), hint = textSimilarity(parseHint(a.reason), parseHint(b.reason)), anchor = textSimilarity(a.headline_anchor || '', b.headline_anchor || '');
  const compatible = jac >= 0.25 || hint >= 0.55 || anchor >= 0.75;
  return { compatible, jac, hint, anchor, score: jac + 0.65 * hint + 0.25 * anchor };
}
function buildConsensus(raw: RawGroup[], blocks: Block[]): FinalGroup[] {
  const articles = raw.filter((g) => g.group_kind === 'article');
  for (const pass of PASS_KINDS) if (!raw.some((g) => g.pass_kind === pass)) throw new ReviewRequiredError(`Raw ${pass} partition missing.`);
  const parent = articles.map((_, i) => i); const passes = articles.map((g) => new Set<PassKind>([g.pass_kind]));
  const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]));
  const candidates: Array<{ a: number; b: number; score: number }> = [];
  for (let i = 0; i < articles.length; i += 1) for (let j = i + 1; j < articles.length; j += 1) {
    if (articles[i].pass_kind === articles[j].pass_kind) continue;
    const m = matchScore(articles[i], articles[j]); if (m.compatible) candidates.push({ a: i, b: j, score: m.score });
  }
  for (let i = 0; i < articles.length; i += 1) for (const pass of PASS_KINDS) {
    if (pass === articles[i].pass_kind) continue;
    const options = candidates.filter((e) => (e.a === i && articles[e.b].pass_kind === pass) || (e.b === i && articles[e.a].pass_kind === pass)).map((e) => e.score).sort((a, b) => b - a);
    if (options.length > 1 && options[0] - options[1] < 0.08) throw new ReviewRequiredError(`Ambiguous article correspondence for ${articles[i].headline_anchor || articles[i].group_fingerprint}.`);
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const edge of candidates) {
    const ra = find(edge.a), rb = find(edge.b); if (ra === rb) continue;
    const merged = new Set([...passes[ra], ...passes[rb]]); if (merged.size !== passes[ra].size + passes[rb].size) continue;
    parent[rb] = ra; passes[ra] = merged;
  }
  const components = new Map<number, number[]>();
  articles.forEach((_, i) => { const r = find(i); const x = components.get(r) || []; x.push(i); components.set(r, x); });
  for (const ids of components.values()) if (new Set(ids.map((i) => articles[i].pass_kind)).size < 2) throw new ReviewRequiredError('One-model-only visual article has no independent support.');
  const roots = [...components.keys()].sort((a, b) => Math.min(...components.get(a)!.flatMap((i) => articles[i].block_indices)) - Math.min(...components.get(b)!.flatMap((i) => articles[i].block_indices)));
  const componentId = new Map<number, string>(); roots.forEach((r, i) => componentId.set(r, `A${i + 1}`));
  const nodeLabel = new Map<number, string>(); articles.forEach((_, i) => nodeLabel.set(i, componentId.get(find(i))!));
  const passLabels = new Map<PassKind, Map<number, string>>();
  for (const pass of PASS_KINDS) {
    const labels = new Map<number, string>();
    raw.filter((g) => g.pass_kind === pass).forEach((g) => {
      let label = 'N';
      if (g.group_kind === 'article') { const idx = articles.indexOf(g); if (idx < 0) throw new ReviewRequiredError('Internal visual node mismatch.'); label = nodeLabel.get(idx)!; }
      for (const bi of g.block_indices) { if (labels.has(bi)) throw new ReviewRequiredError(`${pass} raw partition duplicates block ${bi}.`); labels.set(bi, label); }
    });
    if (labels.size !== blocks.length) throw new ReviewRequiredError(`${pass} raw partition incomplete ${labels.size}/${blocks.length}.`);
    passLabels.set(pass, labels);
  }
  const winners = new Map<string, number[]>();
  for (const b of blocks) {
    const vote = new Map<string, number>();
    for (const pass of PASS_KINDS) { const label = passLabels.get(pass)!.get(b.block_index); if (!label) throw new ReviewRequiredError(`Missing ${pass} vote for block ${b.block_index}.`); vote.set(label, (vote.get(label) || 0) + 1); }
    const ranked = [...vote.entries()].sort((a, b2) => b2[1] - a[1] || a[0].localeCompare(b2[0]));
    if (ranked[0][1] < 2) throw new ReviewRequiredError(`Three-way visual tie at block ${b.block_index}.`);
    const list = winners.get(ranked[0][0]) || []; list.push(b.block_index); winners.set(ranked[0][0], list);
  }
  const byIndex = new Map(blocks.map((b) => [b.block_index, b])); const out: FinalGroup[] = [];
  roots.forEach((root, idx) => {
    const label = componentId.get(root)!; const blockIds = (winners.get(label) || []).sort((a, b) => a - b); if (!blockIds.length) throw new ReviewRequiredError(`Supported article ${label} receives no majority blocks.`);
    const members = components.get(root)!.map((i) => articles[i]); const support = new Set(members.map((g) => g.pass_kind)).size; const confidence = support === 2 ? Math.min(...members.map((g) => Number(g.confidence))) : median(members.map((g) => Number(g.confidence)));
    if (confidence < 0.80) throw new ReviewRequiredError(`Final visual article ${label} confidence ${confidence.toFixed(3)} < 0.80.`);
    const hints = members.map((g) => parseHint(g.reason)).filter(Boolean); const articleBlocks = blockIds.map((id) => byIndex.get(id)).filter(Boolean) as Block[];
    out.push({ seq: idx + 1, group_kind: 'article', block_indices: blockIds, headline_anchor: chooseAnchor(hints, articleBlocks), non_article_role: '', confidence, reason: `three-pass block-majority visual consensus; support=${support}/3; hints=${hints.join(' | ')}` });
  });
  const non = (winners.get('N') || []).sort((a, b) => a - b); if (non.length) out.push({ seq: out.length + 1, group_kind: 'non_article', block_indices: non, headline_anchor: '', non_article_role: 'three_pass_visual_majority_non_article', confidence: 0.99, reason: 'three-pass block-majority non-article complement' });
  return out.sort((a, b) => Math.min(...a.block_indices) - Math.min(...b.block_indices)).map((g, i) => ({ ...g, seq: i + 1 }));
}
async function normalizeConsensus(job: ClaimedJob, blocks: Block[]) {
  const raw = await loadRawGroups(job.id); const groups = buildConsensus(raw, blocks);
  const { data, error } = await supabaseAdmin.rpc('store_visual_inventory_consensus_v4', { p_job_id: job.id, p_lease_token: job.lease_token, p_groups: groups });
  if (error) throw new ReviewRequiredError(error.message); return data;
}

export async function runArticleInventoryWorkerV5ConsensusStep(jobId?: string) {
  const job = await claim(jobId); if (!job) return { claimed: 0, job_id: jobId || null, worker_version: 'article_inventory_v5_visual_consensus' };
  try {
    const passes = await passKinds(job.id);
    if (!passes.kinds.has('mapper') || !passes.kinds.has('critic')) {
      const released = await yieldJob(job, 'delegate_visual_v4_raw_pass');
      return { claimed: 1, job_id: job.id, stage: 'delegate_visual_v4_raw_pass', released, delegated: await runArticleInventoryWorkerV4VisionStep(job.id) };
    }
    if (job.requires_third_pass && !passes.kinds.has('adjudicator')) {
      const blocks = await loadBlocks(job); const result = await runAdjudicator(job, blocks);
      return { claimed: 1, job_id: job.id, stage: 'visual_adjudicator_v5', result, yield: await yieldJob(job, 'visual_adjudicator_v5') };
    }
    if (job.requires_third_pass) {
      const blocks = await loadBlocks(job); const consensus = await normalizeConsensus(job, blocks); const released = await yieldJob(job, 'visual_consensus_v5_ready');
      return { claimed: 1, job_id: job.id, stage: 'visual_consensus_v5', consensus, released, delegated: await runArticleInventoryWorkerV3Step(job.id) };
    }
    const released = await yieldJob(job, 'visual_two_pass_exact_ready');
    return { claimed: 1, job_id: job.id, stage: 'visual_two_pass_exact', released, delegated: await runArticleInventoryWorkerV3Step(job.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'visual consensus v5 error';
    if (error instanceof ReviewRequiredError) return { claimed: 1, job_id: job.id, stage: 'visual_consensus_review_v5', error: message, result: await reviewJob(job, message) };
    return { claimed: 1, job_id: job.id, stage: 'visual_consensus_failed_v5', error: message, result: await failJob(job, message) };
  }
}

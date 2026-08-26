import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { requireAppPassword, jsonError } from '@/lib/auth';
import { supabaseAdmin, STORAGE_BUCKET } from '@/lib/supabaseAdmin';
import { getOpenAIKey } from '@/lib/openai';
import { buildArticleBlockComposite, type ArticleBlockRect } from '@/lib/articleCrop';
import { buildArticleReadingSegmentsV15 } from '@/lib/articleReadingSegmentsV15';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

type JsonRecord = Record<string, unknown>;
type ArticleInput = {
  article_id: string;
  crop_spec_sha256: string;
  crop_image_sha256: string;
  source_image_sha256: string;
  block_rects: ArticleBlockRect[];
};

function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown) { return value === null || value === undefined ? '' : String(value).trim(); }
function sha256(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
function extractResponseText(responseJson: unknown) {
  const json = responseJson as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text.trim();
  return (json.output || []).flatMap((item) => item.content || []).map((item) => text(item.text)).filter(Boolean).join('\n').trim();
}

function responseFormat(articleId: string) {
  return {
    type: 'json_schema',
    name: 'mj_segment_candidate_audit_v15',
    strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['article_id','candidate_supported','confidence','numeric_status','proper_noun_status','reason'],
      properties: {
        article_id: { type: 'string', enum: [articleId] },
        candidate_supported: { type: 'boolean' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        numeric_status: { type: 'string', enum: ['passed','not_applicable','failed'] },
        proper_noun_status: { type: 'string', enum: ['passed','not_applicable','failed'] },
        reason: { type: 'string' }
      }
    }
  } as const;
}

async function auditOne(input: {
  model: string;
  passKind: 'sol' | 'terra';
  articleId: string;
  candidate: string;
  cropImageSha256: string;
  segmentationSpecSha256: string;
  segments: Awaited<ReturnType<typeof buildArticleReadingSegmentsV15>>['segments'];
}) {
  const apiKey = getOpenAIKey();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  const instructions = [
    input.passKind === 'sol' ? 'You are a strict visual OCR candidate auditor.' : 'You are a second strict visual OCR candidate auditor using a different model.',
    'You are given ONE Japanese newspaper article candidate OCR and narrow image strips cut from the exact article mask.',
    'The strips are supplied in explicit Japanese vertical reading order: rightmost to leftmost; within each strip read top-to-bottom.',
    'This is VALIDATION ONLY. Do not rewrite, repair, normalize, summarize, or infer missing text.',
    'Set candidate_supported=true only when the candidate is materially faithful to the visible pixels and its reading order. Set confidence below 0.85 if there are material omissions, insertions, column-order errors, or unsupported text.',
    'Numbers, dates, percentages, prices, quantities, company names, product names, and personal names are high-risk. numeric_status must be failed if any material visible numeric token disagrees or cannot be supported. proper_noun_status must be failed if any material proper noun disagrees or cannot be supported.',
    'Do not reward fluency. A coherent candidate that is not visibly supported must fail.'
  ].join('\n');
  const content: Array<Record<string, unknown>> = [{
    type: 'input_text',
    text: `ARTICLE_ID=${input.articleId}\nCANDIDATE_OCR_START\n${input.candidate}\nCANDIDATE_OCR_END`
  }];
  for (const segment of input.segments) {
    content.push({ type: 'input_text', text: `READING_SEGMENT=${segment.sequence}/${input.segments.length} BOUNDS=${segment.left},${segment.top},${segment.right},${segment.bottom}` });
    content.push({ type: 'input_image', image_url: `data:${segment.mimeType};base64,${segment.buffer.toString('base64')}`, detail: 'high' });
  }
  const binding = sha256([
    input.articleId,
    input.candidate,
    input.cropImageSha256,
    input.segmentationSpecSha256,
    ...input.segments.map((segment) => `${segment.sequence}:${segment.imageSha256}`)
  ].join('\n---\n'));
  const promptSha256 = sha256([input.model,input.passKind,instructions,binding].join('\n---\n'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        store: false,
        max_output_tokens: 2500,
        instructions,
        input: [{ role: 'user', content }],
        text: { format: responseFormat(input.articleId) }
      })
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`segment candidate audit failed: ${response.status} ${response.statusText} ${raw.slice(0,1200)}`);
    const json = JSON.parse(raw) as JsonRecord;
    const output = extractResponseText(json);
    if (!output) throw new Error('segment candidate audit output missing');
    const parsed = JSON.parse(output) as JsonRecord;
    if (text(parsed.article_id) !== input.articleId) throw new Error('segment candidate audit article mismatch');
    return {
      pass_kind: input.passKind,
      model: input.model,
      provider_response_id: text(json.id),
      prompt_sha256: promptSha256,
      response_sha256: sha256(raw),
      input_binding_sha256: binding,
      candidate_supported: parsed.candidate_supported === true,
      confidence: Number(parsed.confidence),
      numeric_status: text(parsed.numeric_status),
      proper_noun_status: text(parsed.proper_noun_status),
      reason: text(parsed.reason).slice(0,1400)
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(req: NextRequest) {
  try {
    requireAppPassword(req);
    const body = await req.json().catch(() => ({}));
    const requestedArticleId = isRecord(body) ? text(body.article_id) : '';
    let query = supabaseAdmin
      .from('ocr_segment_google_probes_v14')
      .select('job_id,article_id,google_segment_text,crop_image_sha256,segmentation_spec_sha256,segmentation_version,created_at')
      .order('created_at', { ascending: true })
      .limit(1);
    if (requestedArticleId) query = query.eq('article_id', requestedArticleId);
    const { data: probeRows, error: probeError } = await query;
    if (probeError) throw probeError;
    const probe = probeRows?.[0];
    if (!probe) throw new Error('No segmented Google canary probe is available.');

    const jobId = text(probe.job_id);
    const articleId = text(probe.article_id);
    const { data: job, error: jobError } = await supabaseAdmin.from('ocr_consensus_jobs_v11').select('id,is_canary,status').eq('id',jobId).single();
    if (jobError) throw jobError;
    if (job.is_canary !== true) throw new Error('OCR segment audit v15 is canary-only.');

    const { data: payload, error: inputError } = await supabaseAdmin.rpc('get_ocr_segment_google_canary_input_v14', { p_job_id: jobId });
    if (inputError) throw inputError;
    if (!isRecord(payload) || !isRecord(payload.source) || !Array.isArray(payload.articles)) throw new Error('OCR segment audit v15 input payload invalid.');
    const rawArticle = payload.articles.find((item) => isRecord(item) && text(item.article_id) === articleId);
    if (!isRecord(rawArticle) || !Array.isArray(rawArticle.block_rects)) throw new Error('OCR segment audit v15 article input missing.');
    const article: ArticleInput = {
      article_id: articleId,
      crop_spec_sha256: text(rawArticle.crop_spec_sha256),
      crop_image_sha256: text(rawArticle.crop_image_sha256),
      source_image_sha256: text(rawArticle.source_image_sha256),
      block_rects: rawArticle.block_rects.map((rect) => {
        if (!isRecord(rect)) throw new Error('OCR segment audit v15 block rectangle invalid.');
        return { block_index:Number(rect.block_index),x_min:Number(rect.x_min),y_min:Number(rect.y_min),x_max:Number(rect.x_max),y_max:Number(rect.y_max) };
      })
    };
    const source = payload.source;
    const storagePath = text(source.storage_path);
    const width = Number(source.width || 0), height = Number(source.height || 0);
    const downloaded = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(storagePath);
    if (downloaded.error || !downloaded.data) throw downloaded.error || new Error('OCR segment audit v15 source download failed.');
    const image = Buffer.from(await downloaded.data.arrayBuffer());
    if (sha256(image) !== article.source_image_sha256) throw new Error('OCR segment audit v15 source binding changed.');
    const composite = await buildArticleBlockComposite({ imageBuffer:image,expectedWidth:width,expectedHeight:height,articleId,rects:article.block_rects });
    if (composite.cropSpecSha256 !== article.crop_spec_sha256 || composite.cropImageSha256 !== article.crop_image_sha256 || composite.cropImageSha256 !== text(probe.crop_image_sha256)) throw new Error('OCR segment audit v15 crop binding changed.');
    const reading = await buildArticleReadingSegmentsV15({ articleId,compositeBuffer:composite.buffer,compositeWidth:composite.width,compositeHeight:composite.height,compositeImageSha256:composite.cropImageSha256 });
    if (reading.segmentationSpecSha256 !== text(probe.segmentation_spec_sha256) || reading.version !== text(probe.segmentation_version)) throw new Error('OCR segment audit v15 segmentation binding changed.');

    const sol = process.env.OPENAI_OCR_VERIFY_MODEL_V2?.trim() || 'gpt-5.6-sol';
    const terra = process.env.OPENAI_OCR_VERIFY_CRITIC_MODEL_V2?.trim() || 'gpt-5.6-terra';
    if (sol === terra) throw new Error('OCR segment audit v15 requires distinct models.');
    const candidate = text(probe.google_segment_text);
    const [solAudit, terraAudit] = await Promise.all([
      auditOne({ model:sol,passKind:'sol',articleId,candidate,cropImageSha256:composite.cropImageSha256,segmentationSpecSha256:reading.segmentationSpecSha256,segments:reading.segments }),
      auditOne({ model:terra,passKind:'terra',articleId,candidate,cropImageSha256:composite.cropImageSha256,segmentationSpecSha256:reading.segmentationSpecSha256,segments:reading.segments })
    ]);
    return Response.json({ ok:true,job_id:jobId,article_id:articleId,candidate_sha256:sha256(candidate),segment_count:reading.segments.length,audits:[solAudit,terraAudit] });
  } catch (error) {
    return jsonError(error);
  }
}

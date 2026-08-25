import { createHash } from 'node:crypto';
import sharp from 'sharp';

export type ArticleBlockRect = {
  block_index: number;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
};

export const ARTICLE_CROP_VERSION = 'article_geometry_mask_composite_v3';
const PADDING_PX = 2;
const MARGIN_PX = 12;

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function finiteInt(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`article crop ${label} is not finite`);
  return Math.round(value);
}

function normalizeRects(rects: ArticleBlockRect[], expectedWidth: number, expectedHeight: number) {
  const ordered = [...rects].sort((a, b) => a.block_index - b.block_index);
  if (new Set(ordered.map((r) => r.block_index)).size !== ordered.length) {
    throw new Error('article crop block indices are duplicated');
  }
  return ordered.map((rect) => {
    const xMin = finiteInt(rect.x_min, 'x_min');
    const yMin = finiteInt(rect.y_min, 'y_min');
    const xMax = finiteInt(rect.x_max, 'x_max');
    const yMax = finiteInt(rect.y_max, 'y_max');
    if (xMax <= xMin || yMax <= yMin) throw new Error(`article crop rectangle is invalid: block=${rect.block_index}`);
    const left = Math.max(0, xMin - PADDING_PX);
    const top = Math.max(0, yMin - PADDING_PX);
    const right = Math.min(expectedWidth, xMax + PADDING_PX);
    const bottom = Math.min(expectedHeight, yMax + PADDING_PX);
    if (right <= left || bottom <= top) throw new Error(`article crop rectangle is outside image: block=${rect.block_index}`);
    return { block_index: rect.block_index, left, top, right, bottom, width: right - left, height: bottom - top };
  });
}

async function validateSourceImage(imageBuffer: Buffer, expectedWidthValue: number, expectedHeightValue: number) {
  const expectedWidth = finiteInt(expectedWidthValue, 'expected width');
  const expectedHeight = finiteInt(expectedHeightValue, 'expected height');
  if (expectedWidth < 1 || expectedHeight < 1) throw new Error('article crop expected dimensions are invalid');
  const metadata = await sharp(imageBuffer, { failOn: 'error' }).metadata();
  const actualWidth = Number(metadata.width || 0);
  const actualHeight = Number(metadata.height || 0);
  if (actualWidth !== expectedWidth || actualHeight !== expectedHeight) {
    throw new Error(`image dimension mismatch: expected=${expectedWidth}x${expectedHeight} actual=${actualWidth}x${actualHeight}`);
  }
  return { expectedWidth, expectedHeight };
}

export async function buildArticleBlockFragments(input: {
  imageBuffer: Buffer;
  expectedWidth: number;
  expectedHeight: number;
  articleId: string;
  rects: ArticleBlockRect[];
}) {
  if (!input.articleId || !Array.isArray(input.rects) || !input.rects.length) throw new Error('article crop input is incomplete');
  const { expectedWidth, expectedHeight } = await validateSourceImage(input.imageBuffer, input.expectedWidth, input.expectedHeight);
  const normalized = normalizeRects(input.rects, expectedWidth, expectedHeight);
  const fragments = [] as Array<{ block_index: number; buffer: Buffer; mimeType: 'image/png'; imageSha256: string }>;
  for (const rect of normalized) {
    const buffer = await sharp(input.imageBuffer, { failOn: 'error' })
      .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      .png()
      .toBuffer();
    fragments.push({ block_index: rect.block_index, buffer, mimeType: 'image/png', imageSha256: sha256(buffer) });
  }
  return fragments;
}

export async function buildArticleBlockComposite(input: {
  imageBuffer: Buffer;
  expectedWidth: number;
  expectedHeight: number;
  articleId: string;
  rects: ArticleBlockRect[];
}) {
  if (!input.articleId || !Array.isArray(input.rects) || !input.rects.length) throw new Error('article crop input is incomplete');
  const { expectedWidth, expectedHeight } = await validateSourceImage(input.imageBuffer, input.expectedWidth, input.expectedHeight);
  const normalized = normalizeRects(input.rects, expectedWidth, expectedHeight);

  const minLeft = Math.min(...normalized.map((r) => r.left));
  const minTop = Math.min(...normalized.map((r) => r.top));
  const maxRight = Math.max(...normalized.map((r) => r.right));
  const maxBottom = Math.max(...normalized.map((r) => r.bottom));
  const canvasWidth = maxRight - minLeft + MARGIN_PX * 2;
  const canvasHeight = maxBottom - minTop + MARGIN_PX * 2;
  if (canvasWidth < 1 || canvasHeight < 1 || canvasWidth * canvasHeight > 120_000_000) {
    throw new Error(`article crop composite dimensions are unsafe: ${canvasWidth}x${canvasHeight}`);
  }

  const fragments: Array<{ input: Buffer; left: number; top: number }> = [];
  for (const rect of normalized) {
    const buffer = await sharp(input.imageBuffer, { failOn: 'error' })
      .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
      .png()
      .toBuffer();
    fragments.push({
      input: buffer,
      left: rect.left - minLeft + MARGIN_PX,
      top: rect.top - minTop + MARGIN_PX
    });
  }

  const buffer = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).composite(fragments).png().toBuffer();

  const cropSpecSha256 = sha256(JSON.stringify({
    version: ARTICLE_CROP_VERSION,
    article_id: input.articleId,
    source_width: expectedWidth,
    source_height: expectedHeight,
    padding_px: PADDING_PX,
    margin_px: MARGIN_PX,
    geometry_origin: { x: minLeft, y: minTop },
    geometry_bounds: { left: minLeft, top: minTop, right: maxRight, bottom: maxBottom },
    blocks: normalized
  }));

  return {
    buffer,
    mimeType: 'image/png',
    width: canvasWidth,
    height: canvasHeight,
    cropSpecSha256,
    cropImageSha256: sha256(buffer)
  };
}

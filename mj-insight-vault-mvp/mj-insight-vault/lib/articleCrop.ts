import { createHash } from 'node:crypto';
import sharp from 'sharp';

export type ArticleBlockRect = {
  block_index: number;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
};

export type ArticleReadingSegment = {
  sequence: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  buffer: Buffer;
  mimeType: 'image/png';
  imageSha256: string;
};

export const ARTICLE_CROP_VERSION = 'article_geometry_mask_composite_v3';
export const ARTICLE_READING_SEGMENT_VERSION = 'article_vertical_whitespace_segments_v1';
const PADDING_PX = 2;
const MARGIN_PX = 12;
const DARK_THRESHOLD = 220;
const MIN_GUTTER_PX = 5;
const MIN_SEGMENT_WIDTH_PX = 24;
const TARGET_SEGMENT_WIDTH_PX = 96;
const MAX_READING_SEGMENTS = 10;
const SEGMENT_PADDING_PX = 5;
const MAX_SEGMENT_SCALE = 3;

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function finiteInt(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`article crop ${label} is not finite`);
  return Math.round(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
    mimeType: 'image/png' as const,
    width: canvasWidth,
    height: canvasHeight,
    cropSpecSha256,
    cropImageSha256: sha256(buffer)
  };
}

function findInkBounds(raw: Buffer, width: number, height: number) {
  const columnInk = new Array<number>(width).fill(0);
  const rowInk = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (raw[row + x] < DARK_THRESHOLD) {
        columnInk[x] += 1;
        rowInk[y] += 1;
      }
    }
  }
  const activeColumnThreshold = Math.max(2, Math.floor(height * 0.002));
  const activeRowThreshold = Math.max(2, Math.floor(width * 0.002));
  let left = columnInk.findIndex((value) => value >= activeColumnThreshold);
  let right = -1;
  for (let x = width - 1; x >= 0; x -= 1) {
    if (columnInk[x] >= activeColumnThreshold) { right = x; break; }
  }
  let top = rowInk.findIndex((value) => value >= activeRowThreshold);
  let bottom = -1;
  for (let y = height - 1; y >= 0; y -= 1) {
    if (rowInk[y] >= activeRowThreshold) { bottom = y; break; }
  }
  if (left < 0 || right < left || top < 0 || bottom < top) {
    left = 0; right = width - 1; top = 0; bottom = height - 1;
  }
  return { columnInk, left, right, top, bottom };
}

function whitespaceBoundaries(columnInk: number[], left: number, right: number, height: number) {
  const blankThreshold = Math.max(1, Math.floor(height * 0.0015));
  const gutters: Array<{ start: number; end: number }> = [];
  let start: number | null = null;
  for (let x = left; x <= right; x += 1) {
    if (columnInk[x] <= blankThreshold) {
      if (start === null) start = x;
    } else if (start !== null) {
      if (x - start >= MIN_GUTTER_PX) gutters.push({ start, end: x - 1 });
      start = null;
    }
  }
  if (start !== null && right - start + 1 >= MIN_GUTTER_PX) gutters.push({ start, end: right });
  return gutters
    .filter((gutter) => gutter.start > left + MIN_SEGMENT_WIDTH_PX && gutter.end < right - MIN_SEGMENT_WIDTH_PX)
    .map((gutter) => Math.round((gutter.start + gutter.end) / 2));
}

function fallbackBoundaries(columnInk: number[], left: number, right: number) {
  const contentWidth = right - left + 1;
  const desiredSegments = clamp(Math.round(contentWidth / TARGET_SEGMENT_WIDTH_PX), 2, MAX_READING_SEGMENTS);
  if (contentWidth < TARGET_SEGMENT_WIDTH_PX * 1.5 || desiredSegments < 2) return [];
  const searchRadius = Math.max(8, Math.min(24, Math.round(contentWidth / desiredSegments / 3)));
  const boundaries: number[] = [];
  for (let i = 1; i < desiredSegments; i += 1) {
    const target = Math.round(left + (contentWidth * i) / desiredSegments);
    let bestX = target;
    let bestInk = Number.POSITIVE_INFINITY;
    for (let x = Math.max(left + MIN_SEGMENT_WIDTH_PX, target - searchRadius); x <= Math.min(right - MIN_SEGMENT_WIDTH_PX, target + searchRadius); x += 1) {
      if (columnInk[x] < bestInk) { bestInk = columnInk[x]; bestX = x; }
    }
    if (!boundaries.length || bestX - boundaries[boundaries.length - 1] >= MIN_SEGMENT_WIDTH_PX) boundaries.push(bestX);
  }
  return boundaries;
}

function segmentRanges(left: number, right: number, boundaries: number[]) {
  const points = [left, ...[...new Set(boundaries)].sort((a, b) => a - b), right + 1];
  const ranges: Array<{ left: number; right: number }> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const segmentLeft = points[i];
    const segmentRight = points[i + 1] - 1;
    if (segmentRight - segmentLeft + 1 >= MIN_SEGMENT_WIDTH_PX) ranges.push({ left: segmentLeft, right: segmentRight });
  }
  return ranges.length > 1 ? ranges : [{ left, right }];
}

function verticalBoundsForRange(raw: Buffer, width: number, height: number, left: number, right: number) {
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = left; x <= right; x += 1) {
      if (raw[row + x] < DARK_THRESHOLD) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        break;
      }
    }
  }
  if (bottom < top) return { top: 0, bottom: height - 1 };
  return {
    top: Math.max(0, top - SEGMENT_PADDING_PX),
    bottom: Math.min(height - 1, bottom + SEGMENT_PADDING_PX)
  };
}

export async function buildArticleReadingSegments(input: {
  articleId: string;
  compositeBuffer: Buffer;
  compositeWidth: number;
  compositeHeight: number;
  compositeImageSha256: string;
}) {
  if (!input.articleId || !input.compositeBuffer.length || input.compositeWidth < 1 || input.compositeHeight < 1) {
    throw new Error('article reading segment input is incomplete');
  }
  const { data, info } = await sharp(input.compositeBuffer, { failOn: 'error' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== input.compositeWidth || info.height !== input.compositeHeight || info.channels !== 1) {
    throw new Error(`article reading segment raster mismatch: expected=${input.compositeWidth}x${input.compositeHeight} actual=${info.width}x${info.height}x${info.channels}`);
  }
  const ink = findInkBounds(data, info.width, info.height);
  let boundaries = whitespaceBoundaries(ink.columnInk, ink.left, ink.right, info.height);
  let ranges = segmentRanges(ink.left, ink.right, boundaries);
  if (ranges.length === 1) {
    boundaries = fallbackBoundaries(ink.columnInk, ink.left, ink.right);
    ranges = segmentRanges(ink.left, ink.right, boundaries);
  }
  if (ranges.length > MAX_READING_SEGMENTS) {
    ranges = ranges.slice(ranges.length - MAX_READING_SEGMENTS);
  }

  const ordered = [...ranges].sort((a, b) => b.left - a.left);
  const segments: ArticleReadingSegment[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const range = ordered[index];
    const vertical = verticalBoundsForRange(data, info.width, info.height, range.left, range.right);
    const left = Math.max(0, range.left - SEGMENT_PADDING_PX);
    const right = Math.min(info.width - 1, range.right + SEGMENT_PADDING_PX);
    const top = vertical.top;
    const bottom = vertical.bottom;
    const width = right - left + 1;
    const height = bottom - top + 1;
    const scale = clamp(Math.ceil(180 / Math.max(1, width)), 1, MAX_SEGMENT_SCALE);
    let pipeline = sharp(input.compositeBuffer, { failOn: 'error' }).extract({ left, top, width, height });
    if (scale > 1) pipeline = pipeline.resize({ width: width * scale, height: height * scale, kernel: sharp.kernel.lanczos3 });
    const buffer = await pipeline.png().toBuffer();
    segments.push({
      sequence: index + 1,
      left,
      top,
      right,
      bottom,
      width: width * scale,
      height: height * scale,
      buffer,
      mimeType: 'image/png',
      imageSha256: sha256(buffer)
    });
  }

  const segmentationSpecSha256 = sha256(JSON.stringify({
    version: ARTICLE_READING_SEGMENT_VERSION,
    article_id: input.articleId,
    composite_image_sha256: input.compositeImageSha256,
    dark_threshold: DARK_THRESHOLD,
    min_gutter_px: MIN_GUTTER_PX,
    min_segment_width_px: MIN_SEGMENT_WIDTH_PX,
    target_segment_width_px: TARGET_SEGMENT_WIDTH_PX,
    ranges: segments.map((segment) => ({ sequence: segment.sequence, left: segment.left, top: segment.top, right: segment.right, bottom: segment.bottom, image_sha256: segment.imageSha256 }))
  }));

  return {
    version: ARTICLE_READING_SEGMENT_VERSION,
    readingOrder: 'right_to_left_top_to_bottom' as const,
    segmentationSpecSha256,
    segments
  };
}

export async function buildArticleBlockFragments(input: {
  imageBuffer: Buffer;
  expectedWidth: number;
  expectedHeight: number;
  articleId: string;
  rects: ArticleBlockRect[];
}) {
  const composite = await buildArticleBlockComposite(input);
  return [{
    block_index: -1,
    buffer: composite.buffer,
    mimeType: composite.mimeType,
    imageSha256: composite.cropImageSha256
  }];
}

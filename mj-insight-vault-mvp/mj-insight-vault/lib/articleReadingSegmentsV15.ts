import { createHash } from 'node:crypto';
import sharp from 'sharp';

export type ArticleReadingSegmentV15 = {
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

export const ARTICLE_READING_SEGMENT_VERSION_V15 = 'article_vertical_target_segments_v2';
const DARK_THRESHOLD = 220;
const TARGET_SEGMENT_WIDTH_PX = 48;
const MIN_SEGMENT_WIDTH_PX = 24;
const MAX_READING_SEGMENTS = 24;
const SEARCH_RADIUS_PX = 28;
const SEGMENT_PADDING_PX = 3;
const MAX_SEGMENT_SCALE = 4;

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
  return { columnInk, left, right };
}

function chooseBoundaries(columnInk: number[], left: number, right: number) {
  const contentWidth = right - left + 1;
  const desiredSegments = clamp(Math.ceil(contentWidth / TARGET_SEGMENT_WIDTH_PX), 1, MAX_READING_SEGMENTS);
  if (desiredSegments <= 1) return [];

  const boundaries: number[] = [];
  let previous = left;
  for (let i = 1; i < desiredSegments; i += 1) {
    const target = Math.round(left + (contentWidth * i) / desiredSegments);
    const minX = Math.max(previous + MIN_SEGMENT_WIDTH_PX, target - SEARCH_RADIUS_PX);
    const maxX = Math.min(right - MIN_SEGMENT_WIDTH_PX, target + SEARCH_RADIUS_PX);
    if (maxX < minX) continue;

    let bestX = target;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let x = minX; x <= maxX; x += 1) {
      const localInk = columnInk[x]
        + (columnInk[x - 1] ?? columnInk[x]) * 0.5
        + (columnInk[x + 1] ?? columnInk[x]) * 0.5;
      const distancePenalty = Math.abs(x - target) * 0.03;
      const score = localInk + distancePenalty;
      if (score < bestScore) {
        bestScore = score;
        bestX = x;
      }
    }
    if (bestX - previous >= MIN_SEGMENT_WIDTH_PX) {
      boundaries.push(bestX);
      previous = bestX;
    }
  }
  return boundaries;
}

function rangesFromBoundaries(left: number, right: number, boundaries: number[]) {
  const points = [left, ...boundaries, right + 1];
  const ranges: Array<{ left: number; right: number }> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const segmentLeft = points[i];
    const segmentRight = points[i + 1] - 1;
    if (segmentRight - segmentLeft + 1 >= MIN_SEGMENT_WIDTH_PX) {
      ranges.push({ left: segmentLeft, right: segmentRight });
    }
  }
  if (!ranges.length) return [{ left, right }];
  const coveredRight = ranges[ranges.length - 1].right;
  if (coveredRight < right) ranges[ranges.length - 1].right = right;
  return ranges;
}

function verticalBounds(raw: Buffer, width: number, height: number, left: number, right: number) {
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

export async function buildArticleReadingSegmentsV15(input: {
  articleId: string;
  compositeBuffer: Buffer;
  compositeWidth: number;
  compositeHeight: number;
  compositeImageSha256: string;
}) {
  if (!input.articleId || !input.compositeBuffer.length || input.compositeWidth < 1 || input.compositeHeight < 1) {
    throw new Error('article reading segment v15 input is incomplete');
  }
  const { data, info } = await sharp(input.compositeBuffer, { failOn: 'error' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== input.compositeWidth || info.height !== input.compositeHeight || info.channels !== 1) {
    throw new Error(`article reading segment v15 raster mismatch: expected=${input.compositeWidth}x${input.compositeHeight} actual=${info.width}x${info.height}x${info.channels}`);
  }

  const ink = findInkBounds(data, info.width, info.height);
  const boundaries = chooseBoundaries(ink.columnInk, ink.left, ink.right);
  const ranges = rangesFromBoundaries(ink.left, ink.right, boundaries);
  if (ranges.length > MAX_READING_SEGMENTS) throw new Error(`article reading segment v15 count unsafe: ${ranges.length}`);

  const ordered = [...ranges].sort((a, b) => b.left - a.left);
  const segments: ArticleReadingSegmentV15[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const range = ordered[index];
    const vertical = verticalBounds(data, info.width, info.height, range.left, range.right);
    const left = Math.max(0, range.left - SEGMENT_PADDING_PX);
    const right = Math.min(info.width - 1, range.right + SEGMENT_PADDING_PX);
    const top = vertical.top;
    const bottom = vertical.bottom;
    const width = right - left + 1;
    const height = bottom - top + 1;
    const scale = clamp(Math.ceil(220 / Math.max(1, width)), 1, MAX_SEGMENT_SCALE);
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
    version: ARTICLE_READING_SEGMENT_VERSION_V15,
    article_id: input.articleId,
    composite_image_sha256: input.compositeImageSha256,
    dark_threshold: DARK_THRESHOLD,
    target_segment_width_px: TARGET_SEGMENT_WIDTH_PX,
    min_segment_width_px: MIN_SEGMENT_WIDTH_PX,
    max_reading_segments: MAX_READING_SEGMENTS,
    search_radius_px: SEARCH_RADIUS_PX,
    ranges: segments.map((segment) => ({
      sequence: segment.sequence,
      left: segment.left,
      top: segment.top,
      right: segment.right,
      bottom: segment.bottom,
      image_sha256: segment.imageSha256
    }))
  }));

  return {
    version: ARTICLE_READING_SEGMENT_VERSION_V15,
    readingOrder: 'right_to_left_top_to_bottom' as const,
    segmentationSpecSha256,
    segments
  };
}

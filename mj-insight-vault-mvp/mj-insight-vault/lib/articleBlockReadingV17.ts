import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ArticleBlockRect } from '@/lib/articleCrop';

export const ARTICLE_BLOCK_READING_VERSION_V17 = 'article_block_local_vertical_segments_v1';

export type ArticleBlockReadingPieceV17 = {
  sequence: number;
  blockIndex: number;
  blockSequence: number;
  pieceSequence: number;
  pieceCount: number;
  kind: 'whole_block' | 'vertical_segment';
  sourceLeft: number;
  sourceTop: number;
  sourceRight: number;
  sourceBottom: number;
  buffer: Buffer;
  mimeType: 'image/png';
  imageSha256: string;
};

const SOURCE_PADDING = 2;
const Y_BAND_TOLERANCE = 18;
const WIDE_BLOCK_MIN_WIDTH = 100;
const WIDE_BLOCK_MIN_HEIGHT = 55;
const TARGET_COLUMN_WIDTH = 22;
const MIN_SEGMENT_WIDTH = 12;
const SEARCH_RADIUS = 11;
const MAX_LOCAL_SEGMENTS = 32;
const DARK_THRESHOLD = 220;
const PIECE_TARGET_WIDTH = 180;
const MAX_SCALE = 8;

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeRects(rects: ArticleBlockRect[], width: number, height: number) {
  return rects.map((rect) => {
    const left = clamp(Math.round(rect.x_min) - SOURCE_PADDING, 0, width - 1);
    const top = clamp(Math.round(rect.y_min) - SOURCE_PADDING, 0, height - 1);
    const right = clamp(Math.round(rect.x_max) + SOURCE_PADDING, left + 1, width);
    const bottom = clamp(Math.round(rect.y_max) + SOURCE_PADDING, top + 1, height);
    return {
      blockIndex: Number(rect.block_index),
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top
    };
  });
}

function orderBlocks<T extends { top: number; left: number; blockIndex: number }>(blocks: T[]) {
  const sorted = [...blocks].sort((a, b) => a.top - b.top || b.left - a.left || a.blockIndex - b.blockIndex);
  const bands: Array<{ anchorTop: number; blocks: T[] }> = [];
  for (const block of sorted) {
    const band = bands[bands.length - 1];
    if (!band || block.top - band.anchorTop > Y_BAND_TOLERANCE) {
      bands.push({ anchorTop: block.top, blocks: [block] });
    } else {
      band.blocks.push(block);
    }
  }
  return bands.flatMap((band) => band.blocks.sort((a, b) => b.left - a.left || a.top - b.top || a.blockIndex - b.blockIndex));
}

async function localVerticalRanges(buffer: Buffer, width: number, height: number) {
  if (width < WIDE_BLOCK_MIN_WIDTH || height < WIDE_BLOCK_MIN_HEIGHT) return [{ left: 0, right: width - 1 }];
  const { data, info } = await sharp(buffer, { failOn: 'error' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 1) throw new Error('block-local reading raster mismatch');
  const columnInk = new Array<number>(width).fill(0);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x] < DARK_THRESHOLD) columnInk[x] += 1;
    }
  }
  const interior = columnInk.slice(Math.min(4, width - 1), Math.max(5, width - 4));
  const typicalInk = median(interior.filter((value) => value > 0));
  const desired = clamp(Math.ceil(width / TARGET_COLUMN_WIDTH), 2, MAX_LOCAL_SEGMENTS);
  const boundaries: number[] = [];
  let previous = 0;
  for (let i = 1; i < desired; i += 1) {
    const target = Math.round((width * i) / desired);
    const minX = Math.max(previous + MIN_SEGMENT_WIDTH, target - SEARCH_RADIUS);
    const maxX = Math.min(width - MIN_SEGMENT_WIDTH, target + SEARCH_RADIUS);
    if (maxX < minX) continue;
    let bestX = minX;
    let bestInk = Number.POSITIVE_INFINITY;
    for (let x = minX; x <= maxX; x += 1) {
      const score = columnInk[x] + 0.5 * (columnInk[x - 1] ?? columnInk[x]) + 0.5 * (columnInk[x + 1] ?? columnInk[x]);
      if (score < bestInk) { bestInk = score; bestX = x; }
    }
    const normalizedBest = bestInk / 2;
    const gutterEnough = typicalInk <= 0 || normalizedBest <= Math.max(2, typicalInk * 0.55);
    if (gutterEnough && bestX - previous >= MIN_SEGMENT_WIDTH) {
      boundaries.push(bestX);
      previous = bestX;
    }
  }
  if (!boundaries.length) return [{ left: 0, right: width - 1 }];
  const points = [0, ...boundaries, width];
  const ranges: Array<{ left: number; right: number }> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const left = points[i];
    const right = points[i + 1] - 1;
    if (right - left + 1 >= MIN_SEGMENT_WIDTH) ranges.push({ left, right });
  }
  if (!ranges.length || ranges.length > MAX_LOCAL_SEGMENTS) return [{ left: 0, right: width - 1 }];
  if (ranges[ranges.length - 1].right < width - 1) ranges[ranges.length - 1].right = width - 1;
  return ranges;
}

export async function buildArticleBlockReadingPiecesV17(input: {
  imageBuffer: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  articleId: string;
  rects: ArticleBlockRect[];
}) {
  if (!input.articleId || !input.imageBuffer.length || !input.rects.length) throw new Error('block-local reading input incomplete');
  const metadata = await sharp(input.imageBuffer, { failOn: 'error' }).metadata();
  if (metadata.width !== input.sourceWidth || metadata.height !== input.sourceHeight) throw new Error('block-local reading source dimensions changed');
  const blocks = orderBlocks(normalizeRects(input.rects, input.sourceWidth, input.sourceHeight));
  const pieces: ArticleBlockReadingPieceV17[] = [];
  const specBlocks: Array<Record<string, unknown>> = [];

  for (let blockOrder = 0; blockOrder < blocks.length; blockOrder += 1) {
    const block = blocks[blockOrder];
    const blockBuffer = await sharp(input.imageBuffer, { failOn: 'error' })
      .extract({ left: block.left, top: block.top, width: block.width, height: block.height })
      .png().toBuffer();
    const ranges = await localVerticalRanges(blockBuffer, block.width, block.height);
    const orderedRanges = ranges.length > 1 ? [...ranges].sort((a, b) => b.left - a.left) : ranges;
    const blockPieces: Array<Record<string, unknown>> = [];
    for (let pieceIndex = 0; pieceIndex < orderedRanges.length; pieceIndex += 1) {
      const range = orderedRanges[pieceIndex];
      const localLeft = Math.max(0, range.left - 2);
      const localRight = Math.min(block.width - 1, range.right + 2);
      const pieceWidth = localRight - localLeft + 1;
      const scale = clamp(Math.ceil(PIECE_TARGET_WIDTH / Math.max(1, pieceWidth)), 1, MAX_SCALE);
      let pipeline = sharp(blockBuffer, { failOn: 'error' }).extract({ left: localLeft, top: 0, width: pieceWidth, height: block.height });
      if (scale > 1) pipeline = pipeline.resize({ width: pieceWidth * scale, height: block.height * scale, kernel: sharp.kernel.lanczos3 });
      const buffer = await pipeline.png().toBuffer();
      const sourceLeft = block.left + localLeft;
      const sourceRight = block.left + localRight;
      const imageSha256 = sha256(buffer);
      const piece: ArticleBlockReadingPieceV17 = {
        sequence: pieces.length + 1,
        blockIndex: block.blockIndex,
        blockSequence: blockOrder + 1,
        pieceSequence: pieceIndex + 1,
        pieceCount: orderedRanges.length,
        kind: orderedRanges.length > 1 ? 'vertical_segment' : 'whole_block',
        sourceLeft,
        sourceTop: block.top,
        sourceRight,
        sourceBottom: block.bottom - 1,
        buffer,
        mimeType: 'image/png',
        imageSha256
      };
      pieces.push(piece);
      blockPieces.push({ piece_sequence: piece.pieceSequence, kind: piece.kind, source_left: sourceLeft, source_top: block.top, source_right: sourceRight, source_bottom: block.bottom - 1, image_sha256: imageSha256 });
    }
    specBlocks.push({ block_index: block.blockIndex, block_sequence: blockOrder + 1, left: block.left, top: block.top, right: block.right - 1, bottom: block.bottom - 1, pieces: blockPieces });
  }

  const readingSpecSha256 = sha256(JSON.stringify({
    version: ARTICLE_BLOCK_READING_VERSION_V17,
    article_id: input.articleId,
    y_band_tolerance: Y_BAND_TOLERANCE,
    wide_block_min_width: WIDE_BLOCK_MIN_WIDTH,
    wide_block_min_height: WIDE_BLOCK_MIN_HEIGHT,
    target_column_width: TARGET_COLUMN_WIDTH,
    blocks: specBlocks
  }));
  return { version: ARTICLE_BLOCK_READING_VERSION_V17, readingSpecSha256, pieces };
}

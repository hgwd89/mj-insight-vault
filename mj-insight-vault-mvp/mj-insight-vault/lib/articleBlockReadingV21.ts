import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { ArticleBlockRect } from '@/lib/articleCrop';

export const ARTICLE_BLOCK_READING_VERSION_V21 = 'article_block_local_vertical_segments_v2';

export type ArticleBlockReadingPieceV21 = {
  sequence: number;
  blockIndex: number;
  blockSequence: number;
  pieceSequence: number;
  pieceCount: number;
  kind: 'whole_block' | 'vertical_segment' | 'vertical_band' | 'vertical_segment_band';
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
const COLUMN_SEARCH_RADIUS = 11;
const MAX_LOCAL_SEGMENTS = 32;

// A narrow OCR block can span a very long vertical run and even cross an article
// boundary. V17 only split on the x axis, so a ~20px x ~600px block remained one
// contextual image. V21 additionally cuts long columns on low-ink horizontal rows.
const TALL_COLUMN_MIN_HEIGHT = 260;
const TALL_COLUMN_MIN_ASPECT = 4.5;
const TARGET_BAND_HEIGHT = 175;
const MIN_BAND_HEIGHT = 72;
const ROW_SEARCH_RADIUS = 34;
const MAX_VERTICAL_BANDS = 10;

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
  if (info.width !== width || info.height !== height || info.channels !== 1) throw new Error('block-local v21 vertical raster mismatch');
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
    const minX = Math.max(previous + MIN_SEGMENT_WIDTH, target - COLUMN_SEARCH_RADIUS);
    const maxX = Math.min(width - MIN_SEGMENT_WIDTH, target + COLUMN_SEARCH_RADIUS);
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

async function localHorizontalBands(buffer: Buffer, width: number, height: number) {
  if (height < TALL_COLUMN_MIN_HEIGHT || height / Math.max(width, 1) < TALL_COLUMN_MIN_ASPECT) {
    return [{ top: 0, bottom: height - 1 }];
  }

  const { data, info } = await sharp(buffer, { failOn: 'error' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 1) throw new Error('block-local v21 horizontal raster mismatch');

  const rowInk = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let ink = 0;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x] < DARK_THRESHOLD) ink += 1;
    }
    rowInk[y] = ink;
  }

  const typicalInk = median(rowInk.filter((value) => value > 0));
  const desired = clamp(Math.ceil(height / TARGET_BAND_HEIGHT), 2, MAX_VERTICAL_BANDS);
  const boundaries: number[] = [];
  let previous = 0;

  for (let i = 1; i < desired; i += 1) {
    const target = Math.round((height * i) / desired);
    const minY = Math.max(previous + MIN_BAND_HEIGHT, target - ROW_SEARCH_RADIUS);
    const maxY = Math.min(height - MIN_BAND_HEIGHT, target + ROW_SEARCH_RADIUS);
    if (maxY < minY) continue;

    let bestY = minY;
    let bestInk = Number.POSITIVE_INFINITY;
    for (let y = minY; y <= maxY; y += 1) {
      const score = rowInk[y]
        + 0.5 * (rowInk[y - 1] ?? rowInk[y])
        + 0.5 * (rowInk[y + 1] ?? rowInk[y]);
      if (score < bestInk) { bestInk = score; bestY = y; }
    }

    // Only cut on a genuine low-ink row. If a continuous column has no clean
    // inter-glyph/inter-section gap, preserve it rather than slicing glyphs.
    const normalizedBest = bestInk / 2;
    const gutterEnough = typicalInk <= 0 || normalizedBest <= Math.max(1, typicalInk * 0.45);
    if (gutterEnough && bestY - previous >= MIN_BAND_HEIGHT) {
      boundaries.push(bestY);
      previous = bestY;
    }
  }

  if (!boundaries.length) return [{ top: 0, bottom: height - 1 }];
  const points = [0, ...boundaries, height];
  const bands: Array<{ top: number; bottom: number }> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const top = points[i];
    const bottom = points[i + 1] - 1;
    if (bottom - top + 1 >= MIN_BAND_HEIGHT || i === points.length - 2) bands.push({ top, bottom });
  }
  if (bands.length < 2 || bands.length > MAX_VERTICAL_BANDS) return [{ top: 0, bottom: height - 1 }];
  bands[bands.length - 1].bottom = height - 1;
  return bands;
}

export async function buildArticleBlockReadingPiecesV21(input: {
  imageBuffer: Buffer;
  sourceWidth: number;
  sourceHeight: number;
  articleId: string;
  rects: ArticleBlockRect[];
}) {
  if (!input.articleId || !input.imageBuffer.length || !input.rects.length) throw new Error('block-local v21 reading input incomplete');
  const metadata = await sharp(input.imageBuffer, { failOn: 'error' }).metadata();
  if (metadata.width !== input.sourceWidth || metadata.height !== input.sourceHeight) throw new Error('block-local v21 reading source dimensions changed');
  const blocks = orderBlocks(normalizeRects(input.rects, input.sourceWidth, input.sourceHeight));
  const pieces: ArticleBlockReadingPieceV21[] = [];
  const specBlocks: Array<Record<string, unknown>> = [];

  for (let blockOrder = 0; blockOrder < blocks.length; blockOrder += 1) {
    const block = blocks[blockOrder];
    const blockBuffer = await sharp(input.imageBuffer, { failOn: 'error' })
      .extract({ left: block.left, top: block.top, width: block.width, height: block.height })
      .png().toBuffer();

    const xRanges = await localVerticalRanges(blockBuffer, block.width, block.height);
    const orderedXRanges = xRanges.length > 1 ? [...xRanges].sort((a, b) => b.left - a.left) : xRanges;
    const pending: Array<{
      localLeft: number; localRight: number; localTop: number; localBottom: number;
      splitX: boolean; splitY: boolean;
    }> = [];

    for (const range of orderedXRanges) {
      const localLeft = Math.max(0, range.left - 2);
      const localRight = Math.min(block.width - 1, range.right + 2);
      const columnWidth = localRight - localLeft + 1;
      const columnBuffer = await sharp(blockBuffer, { failOn: 'error' })
        .extract({ left: localLeft, top: 0, width: columnWidth, height: block.height })
        .png().toBuffer();
      const yBands = await localHorizontalBands(columnBuffer, columnWidth, block.height);
      for (const band of yBands) {
        pending.push({
          localLeft,
          localRight,
          localTop: band.top,
          localBottom: band.bottom,
          splitX: orderedXRanges.length > 1,
          splitY: yBands.length > 1
        });
      }
    }

    const blockPieces: Array<Record<string, unknown>> = [];
    for (let pieceIndex = 0; pieceIndex < pending.length; pieceIndex += 1) {
      const part = pending[pieceIndex];
      const pieceWidth = part.localRight - part.localLeft + 1;
      const pieceHeight = part.localBottom - part.localTop + 1;
      const scale = clamp(Math.ceil(PIECE_TARGET_WIDTH / Math.max(1, pieceWidth)), 1, MAX_SCALE);
      let pipeline = sharp(blockBuffer, { failOn: 'error' }).extract({
        left: part.localLeft,
        top: part.localTop,
        width: pieceWidth,
        height: pieceHeight
      });
      if (scale > 1) pipeline = pipeline.resize({ width: pieceWidth * scale, height: pieceHeight * scale, kernel: sharp.kernel.lanczos3 });
      const buffer = await pipeline.png().toBuffer();
      const sourceLeft = block.left + part.localLeft;
      const sourceRight = block.left + part.localRight;
      const sourceTop = block.top + part.localTop;
      const sourceBottom = block.top + part.localBottom;
      const imageSha256 = sha256(buffer);
      const kind: ArticleBlockReadingPieceV21['kind'] = part.splitX && part.splitY
        ? 'vertical_segment_band'
        : part.splitX
          ? 'vertical_segment'
          : part.splitY
            ? 'vertical_band'
            : 'whole_block';
      const piece: ArticleBlockReadingPieceV21 = {
        sequence: pieces.length + 1,
        blockIndex: block.blockIndex,
        blockSequence: blockOrder + 1,
        pieceSequence: pieceIndex + 1,
        pieceCount: pending.length,
        kind,
        sourceLeft,
        sourceTop,
        sourceRight,
        sourceBottom,
        buffer,
        mimeType: 'image/png',
        imageSha256
      };
      pieces.push(piece);
      blockPieces.push({
        piece_sequence: piece.pieceSequence,
        kind: piece.kind,
        source_left: sourceLeft,
        source_top: sourceTop,
        source_right: sourceRight,
        source_bottom: sourceBottom,
        image_sha256: imageSha256
      });
    }

    specBlocks.push({
      block_index: block.blockIndex,
      block_sequence: blockOrder + 1,
      left: block.left,
      top: block.top,
      right: block.right - 1,
      bottom: block.bottom - 1,
      pieces: blockPieces
    });
  }

  const readingSpecSha256 = sha256(JSON.stringify({
    version: ARTICLE_BLOCK_READING_VERSION_V21,
    article_id: input.articleId,
    y_band_tolerance: Y_BAND_TOLERANCE,
    wide_block_min_width: WIDE_BLOCK_MIN_WIDTH,
    wide_block_min_height: WIDE_BLOCK_MIN_HEIGHT,
    target_column_width: TARGET_COLUMN_WIDTH,
    tall_column_min_height: TALL_COLUMN_MIN_HEIGHT,
    tall_column_min_aspect: TALL_COLUMN_MIN_ASPECT,
    target_band_height: TARGET_BAND_HEIGHT,
    min_band_height: MIN_BAND_HEIGHT,
    blocks: specBlocks
  }));

  return { version: ARTICLE_BLOCK_READING_VERSION_V21, readingSpecSha256, pieces };
}

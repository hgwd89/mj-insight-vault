// Compatibility bridge for the existing v18 worker import.
// The persisted reading.version returned by this function is V21/v2, so old
// article_block_local_vertical_segments_v1 receipts cannot be silently mixed
// with the new tall-column segmentation evidence.
export {
  ARTICLE_BLOCK_READING_VERSION_V21 as ARTICLE_BLOCK_READING_VERSION_V17,
  buildArticleBlockReadingPiecesV21 as buildArticleBlockReadingPiecesV17
} from '@/lib/articleBlockReadingV21';

export type {
  ArticleBlockReadingPieceV21 as ArticleBlockReadingPieceV17
} from '@/lib/articleBlockReadingV21';

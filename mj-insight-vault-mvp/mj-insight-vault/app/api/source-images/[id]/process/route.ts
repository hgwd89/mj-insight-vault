// Nano-safe operational mode: uploads may be stored and OCR'd, but article segmentation,
// article commits, enrichment, classification, and reporting are intentionally not started here.
// Keep the public endpoint stable for the existing upload UI while delegating to the OCR-only path.
export { POST, runtime, maxDuration } from '../ocr-only/route';

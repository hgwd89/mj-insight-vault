export type MjPipelineMode = 'ocr_only' | 'full';

export function getMjPipelineMode(): MjPipelineMode {
  const value = String(process.env.MJ_PIPELINE_MODE || 'ocr_only').trim().toLowerCase();
  return value === 'full' ? 'full' : 'ocr_only';
}

export function isOcrOnlyMode() {
  return getMjPipelineMode() === 'ocr_only';
}

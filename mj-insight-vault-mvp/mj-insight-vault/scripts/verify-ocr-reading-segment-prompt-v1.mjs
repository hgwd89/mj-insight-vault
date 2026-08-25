import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const worker = fs.readFileSync(path.join(root, 'lib/ocrConsensusWorkerV11.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const callStart = worker.indexOf('async function callIndependentVision');
const bindingStart = worker.indexOf('function inputBinding');
assert(callStart >= 0 && bindingStart > callStart, 'OCR consensus segmented call/binding functions must exist.');

const callFn = worker.slice(callStart, bindingStart);
assert(callFn.includes('segmentation_spec_sha256'), 'Segmented OCR prompt metadata must include segmentation_spec_sha256.');
assert(callFn.includes('segment.imageSha256'), 'Segmented OCR prompt SHA must bind every reading-segment image SHA-256.');
assert(callFn.includes('READING_SEGMENT='), 'Segmented OCR request must label explicit reading segment sequence.');
assert(callFn.includes('rightmost to leftmost'), 'Japanese vertical OCR prompt must lock right-to-left column order.');
assert(callFn.includes('Do not duplicate text merely because it is also visible in the overview'), 'Overview and reading segments must not be double-transcribed.');

console.log('verify-ocr-reading-segment-prompt-v1: ok');

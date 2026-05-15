import vision from '@google-cloud/vision';

function getVisionClient() {
  const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (json) {
    const credentials = JSON.parse(json);
    return new vision.ImageAnnotatorClient({ credentials, projectId: credentials.project_id });
  }
  return new vision.ImageAnnotatorClient();
}

export async function runDocumentOcr(buffer: Buffer) {
  const client = getVisionClient();
  const [result] = await client.documentTextDetection({ image: { content: buffer } });
  const text = result.fullTextAnnotation?.text || '';
  return { text, raw: result };
}

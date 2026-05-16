import { ImageAnnotatorClient } from '@google-cloud/vision';

let visionClient: ImageAnnotatorClient | null = null;

function stringifyVisionError(error: unknown) {
  if (error instanceof Error) {
    const anyError = error as Error & {
      code?: unknown;
      details?: unknown;
      metadata?: unknown;
      statusDetails?: unknown;
    };

    return [
      anyError.code ? `code=${String(anyError.code)}` : null,
      anyError.message ? `message=${anyError.message}` : null,
      anyError.details ? `details=${String(anyError.details)}` : null
    ]
      .filter(Boolean)
      .join(' | ');
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getVisionClient() {
  if (visionClient) return visionClient;

  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS;

  if (!raw) {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is not configured.');
  }

  let credentials: {
    project_id?: string;
    client_email?: string;
    private_key?: string;
  };

  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is not valid JSON.');
  }

  if (!credentials.project_id) {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is missing project_id.');
  }

  if (!credentials.client_email) {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is missing client_email.');
  }

  if (!credentials.private_key) {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is missing private_key.');
  }

  visionClient = new ImageAnnotatorClient({
    projectId: credentials.project_id,
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key.replace(/\\n/g, '\n')
    }
  });

  return visionClient;
}

export async function runDocumentOcr(buffer: Buffer) {
  try {
    const client = getVisionClient();

    const [result] = await client.documentTextDetection({
      image: {
        content: buffer
      }
    });

    return {
      text:
        result.fullTextAnnotation?.text ||
        result.textAnnotations?.[0]?.description ||
        '',
      raw: result
    };
  } catch (error) {
    const message = stringifyVisionError(error);
    console.error('Google Vision OCR failed:', error);
    throw new Error(`Google Vision OCR failed: ${message}`);
  }
}

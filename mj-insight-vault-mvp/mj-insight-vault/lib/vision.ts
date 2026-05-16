import { ImageAnnotatorClient } from '@google-cloud/vision';

let visionClient: ImageAnnotatorClient | null = null;

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
}

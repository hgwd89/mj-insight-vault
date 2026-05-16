import { ImageAnnotatorClient } from '@google-cloud/vision';

let client: ImageAnnotatorClient | null = null;

function getVisionClient() {
  if (client) return client;

  const rawCredentials = process.env.GOOGLE_CLOUD_CREDENTIALS;

  if (!rawCredentials) {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is not configured.');
  }

  let credentials: {
    project_id?: string;
    client_email?: string;
    private_key?: string;
    [key: string]: unknown;
  };

  try {
    credentials = JSON.parse(rawCredentials);
  } catch {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is not valid JSON.');
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS must include client_email and private_key.');
  }

  const privateKey = credentials.private_key.replace(/\\n/g, '\n');

  client = new ImageAnnotatorClient({
    projectId: credentials.project_id,
    credentials: {
      client_email: credentials.client_email,
      private_key: privateKey
    }
  });

  return client;
}

export async function runDocumentOcr(buffer: Buffer) {
  const visionClient = getVisionClient();

  const [result] = await visionClient.documentTextDetection({
    image: {
      content: buffer
    }
  });

  const text =
    result.fullTextAnnotation?.text ||
    result.textAnnotations?.[0]?.description ||
    '';

  return {
    text,
    raw: result
  };
}

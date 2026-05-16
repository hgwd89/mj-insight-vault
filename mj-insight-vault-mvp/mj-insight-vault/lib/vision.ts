import { createSign } from 'node:crypto';

type GoogleServiceAccount = {
  type?: string;
  project_id?: string;
  private_key_id?: string;
  private_key?: string;
  client_email?: string;
  token_uri?: string;
};

let cachedToken: {
  accessToken: string;
  expiresAt: number;
} | null = null;

function base64Url(input: string | Buffer) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getCredentials(): GoogleServiceAccount {
  const raw = process.env.GOOGLE_CLOUD_CREDENTIALS;

  if (!raw) {
    throw new Error('GOOGLE_CLOUD_CREDENTIALS is not configured.');
  }

  let credentials: GoogleServiceAccount;

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

  return credentials;
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);

  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.accessToken;
  }

  const credentials = getCredentials();
  const privateKey = credentials.private_key!.replace(/\\n/g, '\n');

  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const claim = {
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const unsignedJwt = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;

  const signature = createSign('RSA-SHA256')
    .update(unsignedJwt)
    .sign(privateKey);

  const jwt = `${unsignedJwt}.${base64Url(signature)}`;

  const tokenRes = await fetch(credentials.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const tokenText = await tokenRes.text();

  if (!tokenRes.ok) {
    throw new Error(`Google OAuth token request failed: ${tokenRes.status} ${tokenRes.statusText} ${tokenText}`);
  }

  let tokenJson: {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  try {
    tokenJson = JSON.parse(tokenText);
  } catch {
    throw new Error(`Google OAuth token response is not JSON: ${tokenText}`);
  }

  if (!tokenJson.access_token) {
    throw new Error(`Google OAuth token response has no access_token: ${tokenText}`);
  }

  cachedToken = {
    accessToken: tokenJson.access_token,
    expiresAt: now + (tokenJson.expires_in || 3600)
  };

  return cachedToken.accessToken;
}

export async function runDocumentOcr(buffer: Buffer) {
  const accessToken = await getAccessToken();

  const visionRes = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        {
          image: {
            content: buffer.toString('base64')
          },
          features: [
            {
              type: 'DOCUMENT_TEXT_DETECTION'
            }
          ],
          imageContext: {
            languageHints: ['ja']
          }
        }
      ]
    })
  });

  const visionText = await visionRes.text();

  if (!visionRes.ok) {
    throw new Error(`Google Vision API request failed: ${visionRes.status} ${visionRes.statusText} ${visionText}`);
  }

  let visionJson: {
    responses?: Array<{
      fullTextAnnotation?: {
        text?: string;
      };
      textAnnotations?: Array<{
        description?: string;
      }>;
      error?: {
        code?: number;
        message?: string;
        status?: string;
        details?: unknown[];
      };
      [key: string]: unknown;
    }>;
  };

  try {
    visionJson = JSON.parse(visionText);
  } catch {
    throw new Error(`Google Vision API response is not JSON: ${visionText}`);
  }

  const response = visionJson.responses?.[0];

  if (!response) {
    throw new Error(`Google Vision API response has no response object: ${visionText}`);
  }

  if (response.error) {
    throw new Error(
      `Google Vision API returned error: code=${response.error.code} status=${response.error.status} message=${response.error.message}`
    );
  }

  const text =
    response.fullTextAnnotation?.text ||
    response.textAnnotations?.[0]?.description ||
    '';

  return {
    text,
    raw: response
  };
}

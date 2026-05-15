import OpenAI from 'openai';

export function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

export const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

export async function embedText(input: string) {
  const openai = getOpenAI();
  if (!openai || !input.trim()) return null;
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: input.slice(0, 8000) });
  return res.data[0]?.embedding || null;
}

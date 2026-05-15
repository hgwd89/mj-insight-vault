import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.warn('Supabase env vars are not fully configured.');
}

export const supabaseAdmin = createClient(url || 'http://localhost:54321', serviceKey || 'missing', {
  auth: { persistSession: false }
});

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'mj-images';

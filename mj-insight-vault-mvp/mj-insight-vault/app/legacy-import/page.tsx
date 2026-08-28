import { LegacySupabaseImport } from '@/components/LegacySupabaseImport';

// Production redeploy receipt: legacy import remains read-only and idempotent.
export default function LegacyImportPage() {
  return <LegacySupabaseImport />;
}

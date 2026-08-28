import { LegacySupabaseImport } from '@/components/LegacySupabaseImport';
import { LegacySupabaseDbArchive } from '@/components/LegacySupabaseDbArchive';

export default function LegacyImportPage() {
  return (
    <div className="space-y-5">
      <LegacySupabaseImport />
      <LegacySupabaseDbArchive />
    </div>
  );
}

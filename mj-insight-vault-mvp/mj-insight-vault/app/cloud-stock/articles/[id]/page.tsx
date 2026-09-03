import { NeonArticleDetail } from '@/components/NeonArticleDetail';

export default async function NeonArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <NeonArticleDetail articleId={id} />;
}

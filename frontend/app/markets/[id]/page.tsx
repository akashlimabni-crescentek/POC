import { notFound } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { getMarketById } from '@/lib/queries';
import MarketView from '@/components/MarketView';

type MarketPageProps = {
  params: {
    id: string;
  };
};

export default async function MarketPage({ params }: MarketPageProps) {
  const marketId = Number(params.id);
  if (!Number.isFinite(marketId)) {
    notFound();
  }

  const supabase = await createServerClient();
  const market = await getMarketById(supabase, marketId);

  if (!market) {
    notFound();
  }

  return <MarketView market={market} />;
}

import { FeaturedMarket, MarketsProvider, TickerTape } from "../Markets";

// Throwaway preview: the tape and the featured market at the sizes they take on the 1920x1080 screen.
// ?ms=6000 changes how long each market is featured.
export default async function MarketsPreview({ searchParams }: { searchParams: Promise<{ ms?: string }> }) {
  const ms = Number((await searchParams).ms);
  return (
    <MarketsProvider featureMs={ms >= 1000 ? ms : undefined}>
      <main style={{ position: "fixed", left: 0, top: 0, width: 1920, height: 1080, padding: 48, background: "#0b0e13" }}>
        <div style={{ width: 1824, height: 56 }}><TickerTape /></div>
        <div style={{ width: 1280, height: 904, marginTop: 24 }}><FeaturedMarket /></div>
      </main>
    </MarketsProvider>
  );
}

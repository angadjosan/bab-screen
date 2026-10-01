import NoiseMeter from "../NoiseMeter";

// Throwaway preview of NoiseMeter on the page background. Delete after integration.
const SIZES: Array<[number, number]> = [
  [500, 200],
  [500, 120],
  [300, 300],
];

export default function NoisePreview() {
  return (
    <main style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 40, padding: 40 }}>
      {SIZES.map(([width, height]) => (
        <div key={`${width}x${height}`} data-size={`${width}x${height}`} style={{ width, height }}>
          <NoiseMeter />
        </div>
      ))}
    </main>
  );
}

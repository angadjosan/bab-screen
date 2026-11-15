import { SpotifyError, playTracks, searchTracks, type Track } from "./spotify";

export const MULLAH_TRACKS = [
  // Pop favorites and sing-along staples.
  ["Tamally Maak", "Amr Diab"], ["C'est la vie", "Khaled"],
  ["Nour El Ein", "Amr Diab"], ["Wala Ala Balo", "Amr Diab"],
  ["Ah W Noss", "Nancy Ajram"], ["Ya Tabtab", "Nancy Ajram"],
  ["Badna Nwalee El Jaw", "Nancy Ajram"], ["Boushret Kheir", "Hussain Al Jassmi"],
  ["Sidi Mansour", "Saber Rebai"], ["Didi", "Khaled"],
  ["Abdel Kader", "Khaled"], ["Alabina", "Alabina"],
  ["Aayshalak", "Elissa"], ["Hob Kol Hayaty", "Elissa"],
  ["Ajmal Ihssas", "Elissa"], ["Betmoun", "Elissa"],
  ["Aa Bali Habibi", "Elissa"],
  ["Ma Tegi Hena", "Nancy Ajram"], ["El Watar El Hassas", "Sherine"],
  ["Sabry Aalil", "Sherine"], ["Nassam Alayna El Hawa", "Fairuz"],
  ["Ana Wel Shouq", "Assi El Hallani"], ["Albi Eshkha", "Ragheb Alama"],
  // Slower, warmer songs between the bigger dance tracks.
  ["Kifak Inta", "Fairuz"], ["Nesam", "Hamza Namira"],
  ["Dari Ya Alby", "Hamza Namira"], ["Baadak Ala Bali", "Fairuz"],
  ["3 Daqat", "Abu"], ["Masha'er", "Sherine"],
  ["Ya Rayah", "Rachid Taha"],
  // Classic voices, tarab and Lebanese folk favorites.
  ["Ahwak", "Abdel Halim Hafez"], ["Zay El Hawa", "Abdel Halim Hafez"],
  ["Alf Leila We Leila", "Umm Kulthum"], ["Batwanes Beek", "Warda"],
  ["Aal Had Al Hawa", "Wadih El Safi"], ["Ya Ana Ya Ana", "Fairuz"],
  ["Bahebak Ya Lebnan", "Fairuz"],
  // Electronic, disco and modern club energy.
  ["Warni Warni", "Omar Souleyman"], ["Habaytak", "Acid Arab"],
  ["Ala Moj Al Bahr", "Shkoon"], ["Sidi H'bibi", "Fadoul"],
  ["Alech", "Carole Samaha"], ["Lm3allem", "Saad Lamjarred"],
] as const;

type MixDependencies = {
  search: (query: string, limit: number) => Promise<Track[]>;
  play: (ids: string[]) => Promise<void>;
  random: () => number;
};

/** Resolve real catalog IDs; skip unavailable songs, but never hide API/auth failures. */
export async function buildMullahMix({ search, play, random }: MixDependencies): Promise<{ count: number }> {
  const tracks: Track[] = [];
  // Small batches avoid a burst of simultaneous Spotify requests.
  for (let i = 0; i < MULLAH_TRACKS.length; i += 4) {
    const batch = await Promise.all(MULLAH_TRACKS.slice(i, i + 4).map(([title, artist]) =>
      search(`track:${title} artist:${artist}`, 1)));
    for (const matches of batch) if (matches[0] && !tracks.some((track) => track.id === matches[0].id)) tracks.push(matches[0]);
  }
  if (!tracks.length) throw new SpotifyError("mix_empty");
  for (let i = tracks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  }
  await play(tracks.map((track) => track.id));
  return { count: tracks.length };
}

// Coalesce overlapping requests so a second slash command cannot restart an in-flight mix.
let pending: Promise<{ count: number }> | null = null;
export function startMullahMix(): Promise<{ count: number }> {
  pending ??= buildMullahMix({ search: searchTracks, play: playTracks, random: Math.random }).finally(() => { pending = null; });
  return pending;
}

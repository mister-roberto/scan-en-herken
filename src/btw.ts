// Btw-kennis (Wet op de omzetbelasting 1968) als vaste, controleerbare regels.
// De AI doet een voorstel; deze module bepaalt wat dat boekhoudkundig betekent
// en controleert het voorstel onafhankelijk van de AI.

import type { BtwBehandeling, BtwStatus, Profiel } from "./types.ts";

export interface BehandelingInfo {
  code: BtwBehandeling;
  label: string;
  /** Tarief dat op de factuur staat (null = geen vast tarief). */
  tarief: number | null;
  /** Btw op de factuur is (bij een btw-plichtige ondernemer) aftrekbaar. */
  aftrekbaar: boolean;
  /** Afnemer berekent de btw zelf (verlegging / verwerving / invoer art. 23). */
  zelfBerekenen: boolean;
  /** Btw op de factuur wordt onderdeel van de kosten. */
  btwInKosten: boolean;
  rubriekInkoop: string;
  rubriekVerkoop: string;
  richting: "beide" | "inkoop" | "verkoop";
  uitleg: string;
}

export const BEHANDELINGEN: BehandelingInfo[] = [
  { code: "NL_HOOG", label: "NL 21%", tarief: 21, aftrekbaar: true, zelfBerekenen: false, btwInKosten: false, rubriekInkoop: "5b", rubriekVerkoop: "1a", richting: "beide", uitleg: "Algemeen tarief (art. 9 lid 1 Wet OB)." },
  { code: "NL_LAAG", label: "NL 9%", tarief: 9, aftrekbaar: true, zelfBerekenen: false, btwInKosten: false, rubriekInkoop: "5b", rubriekVerkoop: "1b", richting: "beide", uitleg: "Verlaagd tarief, Tabel I (art. 9 lid 2 onder a Wet OB)." },
  { code: "NL_NUL", label: "NL 0%", tarief: 0, aftrekbaar: false, zelfBerekenen: false, btwInKosten: false, rubriekInkoop: "-", rubriekVerkoop: "1e", richting: "beide", uitleg: "Nultarief binnenland, Tabel II." },
  { code: "VRIJGESTELD", label: "Vrijgesteld", tarief: null, aftrekbaar: false, zelfBerekenen: false, btwInKosten: false, rubriekInkoop: "-", rubriekVerkoop: "-", richting: "beide", uitleg: "Vrijgestelde prestatie (art. 11 Wet OB), bv. zorg, onderwijs, verzekeringen, financiële diensten." },
  { code: "GEEN_BTW", label: "Geen btw", tarief: null, aftrekbaar: false, zelfBerekenen: false, btwInKosten: false, rubriekInkoop: "-", rubriekVerkoop: "-", richting: "beide", uitleg: "Buiten de heffing of geen btw berekend (bv. KOR-leverancier, particulier, overheidsheffing)." },
  { code: "VERLEGD_NL", label: "Btw verlegd (NL)", tarief: null, aftrekbaar: true, zelfBerekenen: true, btwInKosten: false, rubriekInkoop: "2a + 5b", rubriekVerkoop: "1e", richting: "beide", uitleg: "Binnenlandse verlegging (art. 12 lid 5 Wet OB, art. 24b/24ba Uitv.besl.), bv. onderaanneming in de bouw." },
  { code: "EU_GOEDEREN", label: "EU goederen (ICV / ICP)", tarief: null, aftrekbaar: true, zelfBerekenen: true, btwInKosten: false, rubriekInkoop: "4b + 5b", rubriekVerkoop: "3b", richting: "beide", uitleg: "Intracommunautaire verwerving (art. 17a) resp. levering (Tabel II a.6)." },
  { code: "EU_DIENSTEN", label: "EU diensten", tarief: null, aftrekbaar: true, zelfBerekenen: true, btwInKosten: false, rubriekInkoop: "4b + 5b", rubriekVerkoop: "3b", richting: "beide", uitleg: "B2B-dienst van/aan ondernemer in andere lidstaat (art. 6 lid 1 jo. art. 12 lid 2 Wet OB)." },
  { code: "NIET_EU_DIENSTEN", label: "Diensten buiten EU", tarief: null, aftrekbaar: true, zelfBerekenen: true, btwInKosten: false, rubriekInkoop: "4a + 5b", rubriekVerkoop: "-", richting: "beide", uitleg: "Dienst van/aan ondernemer buiten de EU (art. 6 lid 1 jo. art. 12 lid 2 Wet OB)." },
  { code: "INVOER", label: "Invoer goederen (buiten EU)", tarief: null, aftrekbaar: true, zelfBerekenen: true, btwInKosten: false, rubriekInkoop: "4a + 5b (art. 23)", rubriekVerkoop: "-", richting: "inkoop", uitleg: "Invoer van goederen. Met art. 23-vergunning via de aangifte; anders loopt de btw via de douane/expediteur." },
  { code: "EXPORT", label: "Export (buiten EU)", tarief: 0, aftrekbaar: false, zelfBerekenen: false, btwInKosten: false, rubriekInkoop: "-", rubriekVerkoop: "3a", richting: "verkoop", uitleg: "Uitvoer van goederen, 0% (Tabel II a.2)." },
  { code: "NIET_AFTREKBAAR", label: "NL btw niet aftrekbaar", tarief: null, aftrekbaar: false, zelfBerekenen: false, btwInKosten: true, rubriekInkoop: "-", rubriekVerkoop: "-", richting: "inkoop", uitleg: "Nederlandse btw die niet in aftrek komt, bv. horeca (art. 15 lid 5 Wet OB), KOR of vrijgestelde prestaties." },
  { code: "BUITENLANDSE_BTW", label: "Buitenlandse btw", tarief: null, aftrekbaar: false, zelfBerekenen: false, btwInKosten: true, rubriekInkoop: "-", rubriekVerkoop: "-", richting: "inkoop", uitleg: "Btw van een ander land; niet aftrekbaar in de NL-aangifte (eventueel terugvragen via het EU-teruggaafverzoek)." },
];

const INDEX = new Map(BEHANDELINGEN.map((b) => [b.code, b]));

export function behandeling(code: BtwBehandeling): BehandelingInfo {
  const info = INDEX.get(code);
  if (!info) throw new Error(`Onbekende btw-behandeling: ${code}`);
  return info;
}

export function isBehandeling(code: unknown): code is BtwBehandeling {
  return typeof code === "string" && INDEX.has(code as BtwBehandeling);
}

export const EU_LANDEN = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

/** Griekse btw-nummers beginnen met EL, Noord-Ierland (goederen) met XI. */
export function landVanBtwNummer(nr: string): string {
  const prefix = normaliseerBtwNummer(nr).slice(0, 2);
  if (prefix === "EL") return "GR";
  return /^[A-Z]{2}$/.test(prefix) ? prefix : "";
}

export function normaliseerBtwNummer(nr: string | null | undefined): string {
  return (nr ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** NL-btw-identificatienummer: NL + 9 cijfers + B + 2 cijfers. */
export function isGeldigNlBtwNummer(nr: string): boolean {
  return /^NL\d{9}B\d{2}$/.test(normaliseerBtwNummer(nr));
}

export function isGeldigeIban(iban: string): boolean {
  const s = iban.toUpperCase().replace(/\s/g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const omgezet = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const cijfer of omgezet) rest = (rest * 10 + Number(cijfer)) % 97;
  return rest === 1;
}

/** Het Nederlandse tarief dat op een datum gold, om oude facturen te herkennen. */
export function nlTarieven(datum: string): { hoog: number; laag: number } {
  if (datum && datum < "2012-10-01") return { hoog: 19, laag: 6 };
  if (datum && datum < "2019-01-01") return { hoog: 21, laag: 6 };
  return { hoog: 21, laag: 9 };
}

export function heeftAftrekrecht(status: BtwStatus): boolean {
  return status === "normaal" || status === "gemengd";
}

/** Deel van de voorbelasting dat de administratie mag aftrekken (0..1). */
export function aftrekFractie(profiel: Pick<Profiel, "btwStatus" | "proRataPercentage">): number {
  if (profiel.btwStatus === "normaal") return 1;
  if (profiel.btwStatus === "gemengd") return Math.min(100, Math.max(0, profiel.proRataPercentage)) / 100;
  return 0;
}

/**
 * Tarief waartegen de afnemer zelf btw berekent bij verlegging/verwerving.
 * Vrijwel altijd het algemene tarief; bij twijfel signaleert de controle dit.
 */
export const TARIEF_ZELF_BEREKENEN = 21;

export function rondAf(bedrag: number): number {
  return Math.round(bedrag);
}

export function centen(euro: number): number {
  return Math.round(euro * 100 + (euro >= 0 ? 1e-7 : -1e-7));
}

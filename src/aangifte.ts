// Btw-overzicht per periode: de goedgekeurde boekingen ingedeeld naar de
// rubrieken van de aangifte omzetbelasting. Bedoeld als controle op wat Exact
// na de import berekent, niet als vervanging van de aangifte.

import { werkRegelUit } from "./boeking.ts";
import type { Boeking, Profiel } from "./types.ts";

export interface Rubriek {
  code: string;
  omschrijving: string;
  /** Centen. Omzet of grondslag waarover de btw is berekend. */
  grondslag: number;
  /** Centen. */
  btw: number;
  aantal: number;
}

const RUBRIEKEN: [string, string][] = [
  ["1a", "Leveringen/diensten belast met hoog tarief"],
  ["1b", "Leveringen/diensten belast met laag tarief"],
  ["1e", "Leveringen/diensten belast met 0% of niet bij u belast"],
  ["2a", "Leveringen/diensten waarbij de btw naar u is verlegd"],
  ["3a", "Leveringen naar landen buiten de EU (uitvoer)"],
  ["3b", "Leveringen naar of diensten in landen binnen de EU"],
  ["4a", "Leveringen/diensten uit landen buiten de EU"],
  ["4b", "Leveringen/diensten uit landen binnen de EU"],
];

const VERKOOP: Partial<Record<Boeking["regels"][number]["btw"], string>> = {
  NL_HOOG: "1a",
  NL_LAAG: "1b",
  NL_NUL: "1e",
  VERLEGD_NL: "1e",
  EXPORT: "3a",
  EU_GOEDEREN: "3b",
  EU_DIENSTEN: "3b",
};
const INKOOP: Partial<Record<Boeking["regels"][number]["btw"], string>> = {
  VERLEGD_NL: "2a",
  NIET_EU_DIENSTEN: "4a",
  INVOER: "4a",
  EU_GOEDEREN: "4b",
  EU_DIENSTEN: "4b",
};

export interface BtwOverzicht {
  rubrieken: Rubriek[];
  /** 5a: verschuldigde btw (som van de rubrieken 1 t/m 4). */
  verschuldigd: number;
  /** 5b: voorbelasting. */
  voorbelasting: number;
  /** Positief = te betalen, negatief = terug te vragen. */
  saldo: number;
  aantalBoekingen: number;
}

export function btwOverzicht(boekingen: Boeking[], profiel: Profiel): BtwOverzicht {
  const index = new Map<string, Rubriek>(RUBRIEKEN.map(([code, omschrijving]) => [code, { code, omschrijving, grondslag: 0, btw: 0, aantal: 0 }]));
  let voorbelasting = 0;
  for (const b of boekingen) {
    const teken = b.creditnota ? -1 : 1;
    for (const r of b.regels) {
      const u = werkRegelUit(r, b.soort, profiel);
      const code = b.soort === "verkoop" ? VERKOOP[r.btw] : r.btw === "INVOER" && !profiel.artikel23 ? undefined : INKOOP[r.btw];
      if (code) {
        const rubriek = index.get(code)!;
        rubriek.grondslag += teken * r.bedragExcl;
        rubriek.btw += teken * u.btwAfTeDragen;
        rubriek.aantal++;
      }
      if (b.soort === "inkoop") voorbelasting += teken * u.btwTeVorderen;
    }
  }
  const rubrieken = [...index.values()];
  const verschuldigd = rubrieken.reduce((t, r) => t + r.btw, 0);
  return { rubrieken, verschuldigd, voorbelasting, saldo: verschuldigd - voorbelasting, aantalBoekingen: boekingen.length };
}

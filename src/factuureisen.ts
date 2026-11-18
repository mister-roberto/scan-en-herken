// Beoordeling of een factuur de wettelijk verplichte vermeldingen bevat
// (art. 35a Wet OB; vereenvoudigde factuur: art. 34d Wet OB).
//
// Voor een inkoopfactuur bepaalt dit of de aftrek van voorbelasting bij een
// controle standhoudt; voor een verkoopfactuur of de eigen factuur in orde is.

import { behandeling, isGeldigNlBtwNummer, normaliseerBtwNummer } from "./btw.ts";
import { isGeldigeDatum } from "./boeking.ts";
import type { Boeking, Extractie } from "./types.ts";

export type Uitkomst = "ja" | "nee" | "nvt" | "onbekend";

export interface Eis {
  code: string;
  omschrijving: string;
  uitkomst: Uitkomst;
  toelichting: string;
}

export interface Factuurbeoordeling {
  soort: "volledig" | "vereenvoudigd";
  oordeel: "voldoet" | "voldoet niet" | "niet volledig beoordeeld";
  eisen: Eis[];
  ontbreekt: string[];
}

/** Grens voor de vereenvoudigde factuur: € 100 inclusief btw. */
const GRENS_VEREENVOUDIGD = 100_00;

export function beoordeelFactuur(ex: Extractie, b: Boeking): Factuurbeoordeling {
  const k = ex.factuurkenmerken;
  const eisen: Eis[] = [];
  const eis = (code: string, omschrijving: string, uitkomst: Uitkomst, toelichting = "") => eisen.push({ code, omschrijving, uitkomst, toelichting });
  const vlag = (waarde: boolean | undefined): Uitkomst => (waarde === undefined ? "onbekend" : waarde ? "ja" : "nee");

  const behandelingen = b.regels.map((r) => behandeling(r.btw));
  const verlegd = behandelingen.some((x) => x.zelfBerekenen) || b.regels.some((r) => r.btw === "EXPORT");
  const metBtw = b.regels.some((r) => r.btwBedrag !== 0);
  const zonderHeffing = b.regels.length > 0 && b.regels.every((r) => r.btw === "VRIJGESTELD" || r.btw === "GEEN_BTW");
  const vrijgesteld = b.regels.some((r) => r.btw === "VRIJGESTELD");
  // Leverancier is de partij die de factuur uitreikt; bij verkoop is dat de eigen administratie.
  const btwLeverancier = normaliseerBtwNummer(b.soort === "inkoop" ? b.relatieBtwNummer : ex.afzender.btwNummer);
  const btwAfnemer = normaliseerBtwNummer(b.soort === "verkoop" ? b.relatieBtwNummer : ex.afnemer.btwNummer);
  const datumOk = isGeldigeDatum(b.datum);

  // Een vereenvoudigde factuur mag tot € 100, maar niet bij verlegging of grensoverschrijdende prestaties.
  const vereenvoudigd = Math.abs(b.totaalIncl) <= GRENS_VEREENVOUDIGD && !verlegd;

  if (vereenvoudigd) {
    eis("datum", "Datum van uitreiking", datumOk ? "ja" : "nee");
    eis("leverancier", "Identiteit van de leverancier", ex.afzender.naam.trim() ? "ja" : "nee");
    eis("aard", "Aard van de geleverde goederen of diensten", vlag(k?.aardEnHoeveelheidVermeld));
    eis(
      "btw",
      "Btw-bedrag, of de gegevens om het te berekenen",
      zonderHeffing ? "nvt" : k ? (k.btwBedragVermeld || k.tariefVermeld ? "ja" : "nee") : metBtw ? "ja" : "onbekend",
      zonderHeffing ? "Er is geen btw berekend." : "",
    );
  } else {
    eis("datum", "Datum van uitreiking", datumOk ? "ja" : "nee");
    eis("nummer", "Opeenvolgend factuurnummer", b.factuurnummer.trim() ? "ja" : "nee");
    eis(
      "btwLeverancier",
      "Btw-identificatienummer van de leverancier",
      btwLeverancier ? (btwLeverancier.startsWith("NL") && !isGeldigNlBtwNummer(btwLeverancier) ? "nee" : "ja") : zonderHeffing ? "nvt" : "nee",
      btwLeverancier && btwLeverancier.startsWith("NL") && !isGeldigNlBtwNummer(btwLeverancier)
        ? "Het vermelde nummer heeft geen geldig formaat."
        : !btwLeverancier && zonderHeffing
          ? "Geen btw berekend; een btw-nummer is dan niet altijd verplicht."
          : "",
    );
    eis(
      "btwAfnemer",
      "Btw-identificatienummer van de afnemer",
      verlegd ? (btwAfnemer ? "ja" : (vlag(k?.btwNummerAfnemerVermeld) === "ja" ? "ja" : "nee")) : "nvt",
      verlegd ? "Verplicht bij verlegging en intracommunautaire prestaties." : "Alleen verplicht bij verlegging en intracommunautaire prestaties.",
    );
    eis(
      "adresLeverancier",
      "Naam en adres van de leverancier",
      !ex.afzender.naam.trim() ? "nee" : k ? vlag(k.adresAfzenderVermeld) : ex.afzender.adres ? "ja" : "onbekend",
    );
    eis(
      "adresAfnemer",
      "Naam en adres van de afnemer",
      !ex.afnemer.naam.trim() ? "nee" : k ? vlag(k.adresAfnemerVermeld) : ex.afnemer.adres ? "ja" : "onbekend",
    );
    eis("aard", "Hoeveelheid en aard van de goederen, of omvang en aard van de diensten", vlag(k?.aardEnHoeveelheidVermeld));
    eis(
      "leverdatum",
      "Datum van de levering of dienst",
      k?.leverdatumVermeld === undefined ? "onbekend" : k.leverdatumVermeld ? "ja" : "nvt",
      k?.leverdatumVermeld === false ? "Niet apart vermeld; alleen verplicht als die afwijkt van de factuurdatum." : "",
    );
    eis("grondslag", "Maatstaf van heffing per tarief en eenheidsprijs exclusief btw", k ? (k.grondslagPerTariefVermeld && k.eenheidsprijsVermeld ? "ja" : "nee") : "onbekend", k && k.grondslagPerTariefVermeld && !k.eenheidsprijsVermeld ? "De eenheidsprijs exclusief btw ontbreekt." : "");
    eis("tarief", "Toegepast btw-tarief", zonderHeffing || (verlegd && !metBtw) ? "nvt" : vlag(k?.tariefVermeld), zonderHeffing || (verlegd && !metBtw) ? "Er is geen btw berekend." : "");
    eis("btwBedrag", "Te betalen bedrag aan btw", zonderHeffing || (verlegd && !metBtw) ? "nvt" : k ? vlag(k.btwBedragVermeld) : metBtw ? "ja" : "onbekend", zonderHeffing || (verlegd && !metBtw) ? "Er is geen btw berekend." : "");
    const heeftVermelding = ex.btwVerlegdVermeld || (ex.vermeldingen ?? []).length > 0;
    eis(
      "vermelding",
      "Vermelding van verlegging, vrijstelling of intracommunautaire levering",
      verlegd || vrijgesteld ? (heeftVermelding ? "ja" : "nee") : "nvt",
      verlegd ? "Bij verlegging moet 'btw verlegd' (of 'reverse charge') op de factuur staan." : vrijgesteld ? "Bij een vrijstelling moet de factuur daarnaar verwijzen." : "Alleen van toepassing bij verlegging of vrijstelling.",
    );
  }

  const ontbreekt = eisen.filter((e) => e.uitkomst === "nee").map((e) => e.omschrijving.toLowerCase());
  const oordeel = ontbreekt.length ? "voldoet niet" : eisen.some((e) => e.uitkomst === "onbekend") ? "niet volledig beoordeeld" : "voldoet";
  return { soort: vereenvoudigd ? "vereenvoudigd" : "volledig", oordeel, eisen, ontbreekt };
}

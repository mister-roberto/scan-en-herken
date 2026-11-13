// Van AI-extractie naar boekingsvoorstel, en van boeking naar journaalpost.

import {
  EU_LANDEN,
  TARIEF_ZELF_BEREKENEN,
  aftrekFractie,
  behandeling,
  centen,
  heeftAftrekrecht,
  isBehandeling,
  landVanBtwNummer,
  normaliseerBtwNummer,
} from "./btw.ts";
import type {
  Boeking,
  BoekingRegel,
  BtwBehandeling,
  Extractie,
  Grootboekrekening,
  Journaalregel,
  Partij,
  Profiel,
  Relatie,
  Signalering,
} from "./types.ts";

function schoon(naam: string): string {
  return naam
    .toLowerCase()
    .replace(/\b(b\.?v\.?|n\.?v\.?|v\.?o\.?f\.?|gmbh|ltd|inc|sarl|bvba|holding)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function zelfdeNaam(a: string, b: string): boolean {
  const x = schoon(a);
  const y = schoon(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 5 && y.length >= 5 && (x.includes(y) || y.includes(x)));
}

export function zoekRelatie(partij: Partij, soort: Relatie["soort"], relaties: Relatie[]): Relatie | null {
  const kandidaten = relaties.filter((r) => r.soort === soort);
  const btw = normaliseerBtwNummer(partij.btwNummer);
  const kvk = (partij.kvkNummer ?? "").replace(/\D/g, "");
  const iban = (partij.iban ?? "").toUpperCase().replace(/\s/g, "");
  return (
    (btw && kandidaten.find((r) => normaliseerBtwNummer(r.btwNummer) === btw)) ||
    (kvk && kandidaten.find((r) => r.kvk.replace(/\D/g, "") === kvk)) ||
    (iban && kandidaten.find((r) => r.iban.toUpperCase().replace(/\s/g, "") === iban)) ||
    kandidaten.find((r) => zelfdeNaam(r.naam, partij.naam)) ||
    null
  );
}

export function landVanPartij(partij: Partij): string {
  const uitBtw = landVanBtwNummer(partij.btwNummer ?? "");
  if (uitBtw) return uitBtw;
  return (partij.landcode ?? "").toUpperCase().slice(0, 2);
}

function isEigenBedrijf(partij: Partij, profiel: Profiel): boolean {
  const btw = normaliseerBtwNummer(partij.btwNummer);
  if (btw && btw === normaliseerBtwNummer(profiel.btwNummer)) return true;
  const kvk = (partij.kvkNummer ?? "").replace(/\D/g, "");
  if (kvk && kvk === profiel.kvk.replace(/\D/g, "")) return true;
  return [profiel.naam, ...profiel.handelsnamen].some((n) => zelfdeNaam(n, partij.naam));
}

/**
 * Zet de AI-extractie om in een boekingsvoorstel en past daarbij de vaste regels toe
 * die niet aan de AI worden overgelaten (aftrekrecht, horeca, buitenlandse btw, verlegging).
 */
export function maakBoeking(
  ex: Extractie,
  profiel: Profiel,
  relaties: Relatie[],
  grootboek: Grootboekrekening[],
): { boeking: Boeking; meldingen: Signalering[] } {
  const meldingen: Signalering[] = [];
  let soort: Boeking["soort"] = ex.documentType === "verkoopfactuur" || ex.documentType === "creditnota_verkoop" ? "verkoop" : "inkoop";
  const creditnota = ex.documentType === "creditnota_inkoop" || ex.documentType === "creditnota_verkoop";

  // De eigen identificatienummers zijn betrouwbaarder dan het oordeel van de AI.
  const afzenderIsEigen = isEigenBedrijf(ex.afzender, profiel);
  const afnemerIsEigen = isEigenBedrijf(ex.afnemer, profiel);
  if (soort === "inkoop" && afzenderIsEigen && !afnemerIsEigen) {
    soort = "verkoop";
    meldingen.push({ niveau: "info", code: "RICHTING", tekst: "De afzender is de eigen administratie: geboekt als verkoopfactuur." });
  } else if (soort === "verkoop" && afnemerIsEigen && !afzenderIsEigen) {
    soort = "inkoop";
    meldingen.push({ niveau: "info", code: "RICHTING", tekst: "De afnemer is de eigen administratie: geboekt als inkoopfactuur." });
  }

  const wederpartij = soort === "inkoop" ? ex.afzender : ex.afnemer;
  const relatie = zoekRelatie(wederpartij, soort === "inkoop" ? "crediteur" : "debiteur", relaties);
  const land = landVanPartij(wederpartij) || relatie?.land || "NL";
  const codes = new Set(grootboek.map((g) => g.code));
  const aftrek = heeftAftrekrecht(profiel.btwStatus);

  const regels: BoekingRegel[] = ex.regels.map((r) => {
    let btw: BtwBehandeling = isBehandeling(r.btwBehandeling) ? r.btwBehandeling : "GEEN_BTW";
    const btwBedrag = centen(r.btwBedrag);
    const wijzig = (naar: BtwBehandeling, reden: string) => {
      if (btw === naar) return;
      meldingen.push({ niveau: "info", code: "BTW_REGEL", tekst: `"${r.omschrijving}": ${behandeling(btw).label} → ${behandeling(naar).label}. ${reden}` });
      btw = naar;
    };

    if (soort === "inkoop") {
      const nlTarief = btw === "NL_HOOG" || btw === "NL_LAAG";
      if (nlTarief && land !== "NL" && btwBedrag !== 0) {
        wijzig("BUITENLANDSE_BTW", `Leverancier is gevestigd in ${land}; buitenlandse btw is niet aftrekbaar in de Nederlandse aangifte.`);
      } else if (ex.btwVerlegdVermeld && btwBedrag === 0 && land === "NL" && (nlTarief || btw === "GEEN_BTW" || btw === "NL_NUL")) {
        wijzig("VERLEGD_NL", "Op de factuur staat dat de btw is verlegd (art. 12 lid 5 Wet OB).");
      } else if (nlTarief && r.categorie === "horeca") {
        wijzig("NIET_AFTREKBAAR", "Btw op eten en drinken in de horeca is niet aftrekbaar (art. 15 lid 5 Wet OB).");
      } else if (nlTarief && !aftrek) {
        wijzig("NIET_AFTREKBAAR", profiel.btwStatus === "kor" ? "De administratie past de KOR toe (art. 25 Wet OB): geen aftrek van voorbelasting." : "De administratie verricht vrijgestelde prestaties: geen aftrek van voorbelasting.");
      }
      if (relatie?.standaardBtw && relatie.vast && btw !== relatie.standaardBtw && !behandeling(btw).btwInKosten) {
        wijzig(relatie.standaardBtw, "Vaste instelling van de relatie.");
      }
    }

    let gb = (r.grootboekCode ?? "").trim();
    if (relatie?.vast && relatie.standaardGrootboek) gb = relatie.standaardGrootboek;
    if (!gb && relatie?.standaardGrootboek) gb = relatie.standaardGrootboek;
    if (!codes.has(gb)) gb = "";

    return { omschrijving: r.omschrijving, grootboek: gb, btw, categorie: r.categorie, bedragExcl: centen(r.bedragExcl), btwBedrag };
  });

  const boeking: Boeking = {
    soort,
    creditnota,
    relatieId: relatie?.id ?? null,
    relatieNaam: relatie?.naam ?? wederpartij.naam,
    relatieBtwNummer: normaliseerBtwNummer(wederpartij.btwNummer) || normaliseerBtwNummer(relatie?.btwNummer),
    relatieLand: land,
    factuurnummer: ex.factuurnummer ?? "",
    datum: ex.factuurdatum ?? "",
    vervaldatum: ex.vervaldatum ?? "",
    omschrijving: ex.omschrijving,
    valuta: (ex.valuta || "EUR").toUpperCase(),
    totaalIncl: centen(ex.totaalIncl),
    betalingskenmerk: ex.betalingskenmerk ?? "",
    regels,
  };
  return { boeking, meldingen };
}

export interface RegelUitwerking {
  /** Bedrag dat op de kosten- of omzetrekening komt. */
  grondslag: number;
  /** Aftrekbare voorbelasting (inkoop) of verschuldigde btw (verkoop). */
  btwTeVorderen: number;
  btwAfTeDragen: number;
  /** Bedrag dat de relatie in rekening brengt of krijgt. */
  relatieBedrag: number;
}

/** Werkt één boekingsregel uit volgens de btw-behandeling. Bedragen ongetekend t.o.v. creditnota. */
export function werkRegelUit(regel: BoekingRegel, soort: Boeking["soort"], profiel: Profiel): RegelUitwerking {
  const info = behandeling(regel.btw);
  const relatieBedrag = regel.bedragExcl + regel.btwBedrag;
  if (soort === "verkoop") {
    return { grondslag: regel.bedragExcl, btwTeVorderen: 0, btwAfTeDragen: regel.btwBedrag, relatieBedrag };
  }
  const fractie = aftrekFractie(profiel);
  if (info.btwInKosten) {
    return { grondslag: relatieBedrag, btwTeVorderen: 0, btwAfTeDragen: 0, relatieBedrag };
  }
  if (info.zelfBerekenen && !(regel.btw === "INVOER" && !profiel.artikel23)) {
    const verschuldigd = Math.round((regel.bedragExcl * TARIEF_ZELF_BEREKENEN) / 100);
    const aftrekbaar = Math.round(verschuldigd * fractie);
    return { grondslag: relatieBedrag + verschuldigd - aftrekbaar, btwTeVorderen: aftrekbaar, btwAfTeDragen: verschuldigd, relatieBedrag };
  }
  if (info.aftrekbaar) {
    const aftrekbaar = Math.round(regel.btwBedrag * fractie);
    return { grondslag: regel.bedragExcl + regel.btwBedrag - aftrekbaar, btwTeVorderen: aftrekbaar, btwAfTeDragen: 0, relatieBedrag };
  }
  return { grondslag: relatieBedrag, btwTeVorderen: 0, btwAfTeDragen: 0, relatieBedrag };
}

/** Volledige journaalpost (dubbel boekhouden). Debet en credit zijn altijd in evenwicht. */
export function maakJournaalpost(boeking: Boeking, profiel: Profiel): Journaalregel[] {
  const teken = (boeking.soort === "inkoop" ? 1 : -1) * (boeking.creditnota ? -1 : 1);
  const regels: Journaalregel[] = [];
  // bedrag > 0 is debet, bedrag < 0 is credit
  const post = (rekening: string, omschrijving: string, bedrag: number) => {
    if (bedrag === 0) return;
    regels.push({ rekening, omschrijving, debet: bedrag > 0 ? bedrag : 0, credit: bedrag < 0 ? -bedrag : 0 });
  };

  let teVorderen = 0;
  let afTeDragen = 0;
  let relatie = 0;
  for (const r of boeking.regels) {
    const u = werkRegelUit(r, boeking.soort, profiel);
    post(r.grootboek, r.omschrijving, teken * u.grondslag);
    teVorderen += u.btwTeVorderen;
    afTeDragen += u.btwAfTeDragen;
    relatie += u.relatieBedrag;
  }
  const inkoopTeken = boeking.creditnota ? -1 : 1;
  if (boeking.soort === "inkoop") {
    post(profiel.rekeningBtwTeVorderen, "Te vorderen btw", inkoopTeken * teVorderen);
    post(profiel.rekeningBtwAfTeDragen, "Af te dragen btw (verlegd)", -inkoopTeken * afTeDragen);
    post(profiel.rekeningCrediteuren, boeking.relatieNaam, -inkoopTeken * relatie);
  } else {
    post(profiel.rekeningBtwAfTeDragen, "Af te dragen btw", -inkoopTeken * afTeDragen);
    post(profiel.rekeningDebiteuren, boeking.relatieNaam, inkoopTeken * relatie);
  }
  return regels;
}

export function isBinnenEu(land: string): boolean {
  return EU_LANDEN.has(land);
}

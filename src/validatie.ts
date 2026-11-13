// Onafhankelijke controles op een boeking. Een boeking met een "fout" kan niet
// worden goedgekeurd; een "waarschuwing" moet door een mens worden beoordeeld.

import {
  EU_LANDEN,
  behandeling,
  heeftAftrekrecht,
  isGeldigNlBtwNummer,
  isGeldigeIban,
  nlTarieven,
  normaliseerBtwNummer,
} from "./btw.ts";
import { maakJournaalpost, zelfdeNaam } from "./boeking.ts";
import type { Boeking, Extractie, Grootboekrekening, Profiel, Signalering } from "./types.ts";

const euro = (c: number) => (c / 100).toLocaleString("nl-NL", { style: "currency", currency: "EUR" });

/** Grens voor de vereenvoudigde factuur (art. 34d Wet OB): € 100 inclusief btw. */
const GRENS_VEREENVOUDIGD = 100_00;

export interface ControleContext {
  /** Er bestaat al een ander document met dezelfde relatie en hetzelfde factuurnummer. */
  dubbel: boolean;
  vandaag: string;
}

export function valideer(
  b: Boeking,
  ex: Extractie | null,
  profiel: Profiel,
  grootboek: Grootboekrekening[],
  ctx: ControleContext,
): Signalering[] {
  const s: Signalering[] = [];
  const fout = (code: string, tekst: string) => s.push({ niveau: "fout", code, tekst });
  const let_op = (code: string, tekst: string) => s.push({ niveau: "waarschuwing", code, tekst });
  const info = (code: string, tekst: string) => s.push({ niveau: "info", code, tekst });
  const codes = new Set(grootboek.map((g) => g.code));
  const inkoop = b.soort === "inkoop";
  const land = b.relatieLand || "NL";
  const btwNr = normaliseerBtwNummer(b.relatieBtwNummer);

  // --- Basisgegevens ---
  if (ex?.documentType === "geen_factuur") fout("GEEN_FACTUUR", "Dit document lijkt geen factuur of bon te zijn.");
  if (!b.relatieNaam.trim()) fout("RELATIE", `Geen ${inkoop ? "leverancier" : "afnemer"} herkend.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.datum) || Number.isNaN(Date.parse(b.datum))) {
    fout("DATUM", "Factuurdatum ontbreekt of is ongeldig.");
  } else {
    if (b.datum > ctx.vandaag) let_op("DATUM_TOEKOMST", "De factuurdatum ligt in de toekomst.");
    if (Number(ctx.vandaag.slice(0, 4)) - Number(b.datum.slice(0, 4)) > 5) {
      let_op("DATUM_OUD", "De factuurdatum is meer dan vijf jaar oud; aftrek/naheffing kan verjaard zijn.");
    }
  }
  if (b.regels.length === 0) fout("REGELS", "Geen boekingsregels.");
  if (b.valuta !== "EUR") let_op("VALUTA", `Factuur in ${b.valuta}. Bedragen moeten naar euro worden omgerekend tegen de koers van de factuurdatum; controleer de bedragen.`);
  if (ctx.dubbel) fout("DUBBEL", "Er is al een document met deze relatie en dit factuurnummer. Mogelijk dubbel geboekt.");

  // --- Rekenkundige controles ---
  const somRegels = b.regels.reduce((t, r) => t + r.bedragExcl + r.btwBedrag, 0);
  if (somRegels !== b.totaalIncl) {
    fout("TOTAAL", `De regels tellen op tot ${euro(somRegels)}, maar het factuurtotaal is ${euro(b.totaalIncl)}.`);
  }
  if (ex) {
    const totaalBtw = Math.round(ex.totaalBtw * 100);
    const somBtw = b.regels.reduce((t, r) => t + r.btwBedrag, 0);
    if (Math.abs(totaalBtw - somBtw) > 1) {
      let_op("BTW_TOTAAL", `Btw volgens de regels (${euro(somBtw)}) wijkt af van het btw-totaal op het document (${euro(totaalBtw)}).`);
    }
  }
  const journaal = maakJournaalpost(b, profiel);
  const saldo = journaal.reduce((t, r) => t + r.debet - r.credit, 0);
  if (saldo !== 0) fout("EVENWICHT", "De journaalpost is niet in evenwicht.");

  // --- Per regel ---
  const tarieven = nlTarieven(b.datum);
  b.regels.forEach((r, i) => {
    const nr = `Regel ${i + 1}`;
    const bh = behandeling(r.btw);
    if (!r.grootboek) fout("GROOTBOEK", `${nr}: geen grootboekrekening gekozen.`);
    else if (!codes.has(r.grootboek)) fout("GROOTBOEK", `${nr}: grootboekrekening ${r.grootboek} bestaat niet in het rekeningschema.`);

    if (bh.richting === "inkoop" && !inkoop) fout("BTW_RICHTING", `${nr}: "${bh.label}" kan niet op een verkoopfactuur.`);
    if (bh.richting === "verkoop" && inkoop) fout("BTW_RICHTING", `${nr}: "${bh.label}" kan niet op een inkoopfactuur.`);

    if (r.btw === "NL_HOOG" || r.btw === "NL_LAAG") {
      const tarief = r.btw === "NL_HOOG" ? tarieven.hoog : tarieven.laag;
      const verwacht = Math.round((r.bedragExcl * tarief) / 100);
      // Bonnen ronden per artikel af; een paar cent verschil is normaal.
      const marge = Math.max(5, Math.round(Math.abs(r.bedragExcl) * 0.002));
      if (Math.abs(verwacht - r.btwBedrag) > marge) {
        fout("BTW_BEDRAG", `${nr}: ${tarief}% over ${euro(r.bedragExcl)} is ${euro(verwacht)}, maar er staat ${euro(r.btwBedrag)} btw.`);
      }
      if (inkoop && land !== "NL" && !btwNr.startsWith("NL")) {
        let_op("BTW_LAND", `${nr}: Nederlands tarief bij een leverancier uit ${land}. Controleer of dit echt Nederlandse btw is.`);
      }
    } else if (!bh.btwInKosten && r.btwBedrag !== 0) {
      fout("BTW_BEDRAG", `${nr}: bij "${bh.label}" hoort geen btw-bedrag, maar er staat ${euro(r.btwBedrag)}.`);
    }
    if (bh.btwInKosten && r.btwBedrag === 0 && r.btw === "BUITENLANDSE_BTW") {
      info("BTW_BEDRAG", `${nr}: geen buitenlandse btw vermeld; het volledige bedrag wordt als kosten geboekt.`);
    }

    // Grensoverschrijdend
    if (inkoop) {
      const buitenland = land !== "NL";
      const eu = EU_LANDEN.has(land);
      if ((r.btw === "EU_GOEDEREN" || r.btw === "EU_DIENSTEN") && (!eu || !buitenland)) {
        fout("BTW_LAND", `${nr}: "${bh.label}" vereist een leverancier in een andere EU-lidstaat (nu: ${land}).`);
      }
      if ((r.btw === "EU_GOEDEREN" || r.btw === "EU_DIENSTEN") && !btwNr) {
        let_op("BTW_NUMMER", `${nr}: btw-identificatienummer van de EU-leverancier ontbreekt.`);
      }
      if ((r.btw === "NIET_EU_DIENSTEN" || r.btw === "INVOER") && (eu || !buitenland)) {
        fout("BTW_LAND", `${nr}: "${bh.label}" vereist een leverancier buiten de EU (nu: ${land}).`);
      }
      if (r.btw === "INVOER" && !profiel.artikel23) {
        let_op("INVOER", `${nr}: invoer zonder art. 23-vergunning. De invoer-btw staat op de aangifte van de douane/expediteur en wordt daar geboekt.`);
      }
      if (buitenland && r.btwBedrag === 0 && ["NL_NUL", "GEEN_BTW", "VRIJGESTELD"].includes(r.btw)) {
        let_op("BTW_VERLEGD", `${nr}: buitenlandse leverancier zonder btw. Meestal is de btw naar de afnemer verlegd (${eu ? "EU-goederen of EU-diensten, rubriek 4b" : "diensten buiten EU, rubriek 4a"}).`);
      }
      if (r.btw === "VERLEGD_NL" && buitenland) {
        fout("BTW_LAND", `${nr}: binnenlandse verlegging bij een leverancier uit ${land}. Kies een EU- of niet-EU-behandeling.`);
      }
      if (bh.zelfBerekenen) {
        info("VERLEGD", `${nr}: btw ${TARIEF_TEKST} wordt zelf berekend en aangegeven (rubriek ${bh.rubriekInkoop}). Valt de prestatie onder het 9%-tarief, pas dit dan aan in Exact.`);
        if (!heeftAftrekrecht(profiel.btwStatus)) {
          let_op("VERLEGD_GEEN_AFTREK", `${nr}: de verlegde btw moet worden aangegeven en afgedragen, maar is voor deze administratie niet aftrekbaar.`);
        }
      }
      // Aftrekbeperkingen
      if (bh.aftrekbaar && !bh.zelfBerekenen) {
        if (r.categorie === "horeca") fout("HORECA", `${nr}: btw op horecabestedingen is niet aftrekbaar (art. 15 lid 5 Wet OB).`);
        if (!heeftAftrekrecht(profiel.btwStatus)) fout("GEEN_AFTREK", `${nr}: deze administratie heeft geen recht op aftrek van voorbelasting.`);
      }
      if (bh.aftrekbaar && r.categorie === "relatiegeschenk") {
        info("BUA", `${nr}: relatiegeschenk. Geen aftrek als de ontvanger zelf geen aftrekrecht zou hebben en de waarde boven € 227 per persoon per jaar komt (BUA).`);
      }
      if (bh.aftrekbaar && r.categorie === "personeelsvoorziening") {
        info("BUA", `${nr}: personeelsvoorziening. Beoordeel aan het einde van het boekjaar of de BUA-grens van € 227 per werknemer wordt overschreden.`);
      }
      if (bh.aftrekbaar && r.categorie === "auto") {
        info("AUTO", `${nr}: autokosten. Houd rekening met de btw-correctie voor privégebruik aan het einde van het jaar.`);
      }
      if (r.categorie === "logies" && r.btw === "NL_LAAG" && b.datum >= "2026-01-01") {
        let_op("LOGIES", `${nr}: logies valt sinds 1 januari 2026 onder 21% (behalve kamperen). Controleer het tarief op de factuur.`);
      }
      if (r.categorie === "investering") {
        info("INVESTERING", `${nr}: mogelijk een investering. Beoordeel activering en eventuele herziening van de aftrek.`);
      }
    } else {
      if ((r.btw === "EU_GOEDEREN" || r.btw === "EU_DIENSTEN") && !btwNr) {
        fout("BTW_NUMMER", `${nr}: voor een intracommunautaire prestatie (rubriek 3b, opgaaf ICP) is het btw-identificatienummer van de afnemer verplicht.`);
      }
      if ((r.btw === "EU_GOEDEREN" || r.btw === "EU_DIENSTEN") && (land === "NL" || !EU_LANDEN.has(land))) {
        fout("BTW_LAND", `${nr}: "${bh.label}" vereist een afnemer in een andere EU-lidstaat (nu: ${land}).`);
      }
      if (r.btw === "EXPORT" && EU_LANDEN.has(land)) fout("BTW_LAND", `${nr}: export vereist een afnemer buiten de EU.`);
      if (profiel.btwStatus === "kor" && r.btwBedrag !== 0) fout("KOR", `${nr}: bij toepassing van de KOR mag geen btw in rekening worden gebracht.`);
    }
  });

  // --- Factuurvereisten voor aftrek (art. 35a Wet OB) ---
  const aftrekGevraagd = inkoop && b.regels.some((r) => behandeling(r.btw).aftrekbaar);
  if (aftrekGevraagd) {
    const vereenvoudigd = Math.abs(b.totaalIncl) <= GRENS_VEREENVOUDIGD;
    const ontbreekt: string[] = [];
    if (!b.factuurnummer.trim() && !vereenvoudigd) ontbreekt.push("factuurnummer");
    if (!btwNr && !vereenvoudigd) ontbreekt.push("btw-identificatienummer van de leverancier");
    if (ex && !vereenvoudigd && !ex.afnemer.naam.trim()) ontbreekt.push("naam en adres van de afnemer");
    if (ontbreekt.length) {
      let_op("FACTUUREISEN", `Voor aftrek van voorbelasting ontbreekt op de factuur: ${ontbreekt.join(", ")} (art. 35a Wet OB).`);
    }
    if (ex && !vereenvoudigd && ex.afnemer.naam.trim() && ![profiel.naam, ...profiel.handelsnamen].some((n) => zelfdeNaam(n, ex.afnemer.naam))) {
      let_op("TENAAMSTELLING", `De factuur staat op naam van "${ex.afnemer.naam}", niet van ${profiel.naam}. Zonder juiste tenaamstelling is er geen recht op aftrek.`);
    }
  }
  if (btwNr.startsWith("NL") && !isGeldigNlBtwNummer(btwNr)) {
    let_op("BTW_NUMMER", `Btw-nummer ${btwNr} heeft geen geldig Nederlands formaat (NL + 9 cijfers + B + 2 cijfers); mogelijk verkeerd gelezen.`);
  }
  const iban = inkoop ? ex?.afzender.iban : null;
  if (iban && !isGeldigeIban(iban)) let_op("IBAN", `IBAN ${iban} doorstaat de controle niet; mogelijk verkeerd gelezen.`);
  if (!inkoop && b.relatieLand === "NL" && b.regels.some((r) => r.btw === "VERLEGD_NL") && !btwNr) {
    let_op("BTW_NUMMER", "Bij een verlegde verkoopfactuur moet het btw-identificatienummer van de afnemer op de factuur staan.");
  }
  if (profiel.btwStatus === "gemengd" && aftrekGevraagd) {
    info("PRO_RATA", `Voorbelasting wordt voor ${profiel.proRataPercentage}% in aftrek gebracht (pro rata). Gebruik in Exact een btw-code met hetzelfde aftrekpercentage.`);
  }

  // --- Wat de AI zelf onzeker vond ---
  if (ex) {
    if (ex.zekerheid === "laag") let_op("AI_ZEKERHEID", "De AI kon dit document moeilijk lezen. Controleer alle velden.");
    for (const o of ex.onzekerheden) let_op("AI_TWIJFEL", o);
  }
  return s;
}

const TARIEF_TEKST = "(21%)";

export function heeftFouten(s: Signalering[]): boolean {
  return s.some((x) => x.niveau === "fout");
}

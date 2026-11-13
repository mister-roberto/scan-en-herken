// Uitlezen van een factuur of bon met Claude. Het bedrijfsprofiel, het
// rekeningschema en de bekende relaties gaan mee als context, zodat de AI
// boekt zoals deze administratie boekt.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BEHANDELINGEN } from "./btw.ts";
import type { Extractie, Feedback, Grootboekrekening, Profiel, Relatie } from "./types.ts";

export const MODEL = process.env.SCAN_MODEL || "claude-opus-5-5";
/** Modellen waarbij de API een geweigerd verzoek zelf op een ander model mag herhalen. */
const MET_FALLBACK = /^claude-(opus-5|fable-5|sonnet-5-5)/;

const Partij = z.object({
  naam: z.string(),
  adres: z.string().nullable(),
  landcode: z.string().nullable().describe("ISO-landcode van twee letters, bv. NL, DE, US"),
  btwNummer: z.string().nullable(),
  kvkNummer: z.string().nullable(),
  iban: z.string().nullable(),
});

const BEHANDELING_CODES = BEHANDELINGEN.map((b) => b.code) as [string, ...string[]];

export const ExtractieSchema = z.object({
  documentType: z.enum(["inkoopfactuur", "verkoopfactuur", "bon", "creditnota_inkoop", "creditnota_verkoop", "geen_factuur"]),
  afzender: Partij.describe("De partij die de factuur of bon heeft uitgereikt"),
  afnemer: Partij.describe("De partij aan wie de factuur is gericht; lege naam als die niet op het document staat"),
  factuurnummer: z.string().nullable(),
  factuurdatum: z.string().nullable().describe("JJJJ-MM-DD"),
  vervaldatum: z.string().nullable().describe("JJJJ-MM-DD"),
  valuta: z.string().describe("ISO-valutacode, bv. EUR"),
  regels: z.array(
    z.object({
      omschrijving: z.string(),
      bedragExcl: z.number().describe("Bedrag exclusief btw in de valuta van het document"),
      btwPercentage: z.number().nullable(),
      btwBedrag: z.number(),
      btwBehandeling: z.enum(BEHANDELING_CODES),
      categorie: z.enum(["overig", "horeca", "logies", "relatiegeschenk", "personeelsvoorziening", "auto", "investering"]),
      grootboekCode: z.string().describe("Code uit het rekeningschema van de administratie; lege tekst als geen rekening past"),
    }),
  ),
  totaalExcl: z.number(),
  totaalBtw: z.number(),
  totaalIncl: z.number(),
  btwVerlegdVermeld: z.boolean().describe("Op het document staat 'btw verlegd', 'reverse charge' of een vergelijkbare vermelding"),
  betaalwijze: z.enum(["onbekend", "bankoverschrijving", "pin", "contant", "creditcard", "automatische_incasso", "ideal"]),
  betalingskenmerk: z.string().nullable(),
  omschrijving: z.string().describe("Korte boekingsomschrijving, maximaal 60 tekens"),
  zekerheid: z.enum(["hoog", "middel", "laag"]),
  onzekerheden: z.array(z.string()).describe("Concrete twijfelpunten die een mens moet controleren; leeg als er geen zijn"),
  vermeldingen: z.array(z.string()).describe("Letterlijke btw-vermeldingen op het document, bv. 'btw verlegd', 'margeregeling', 'vrijgesteld van btw'; leeg als er geen zijn"),
});

const SYSTEEM = `Je verwerkt inkoop- en verkoopdocumenten (facturen, creditnota's en kassabonnen) voor een Nederlandse boekhouding. Jouw uitkomst wordt een boekingsvoorstel dat een boekhouder controleert en daarna in Exact Online importeert. Een fout in een bedrag, datum of btw-behandeling komt dus in de btw-aangifte terecht; nauwkeurigheid gaat boven volledigheid.

## Lezen
- Neem bedragen, nummers en datums letterlijk over van het document. Reken niets "recht" dat er anders staat. Als een cijfer onleesbaar is, vul je beste lezing in en benoem het in onzekerheden.
- Bedragen zijn getallen in de valuta van het document, met een punt als decimaalteken. Op een creditnota zijn de bedragen positief; het documenttype maakt duidelijk dat het een creditnota is. Kortingsregels op een gewone factuur zijn negatief.
- Datums als JJJJ-MM-DD. Nederlandse documenten schrijven dag-maand-jaar.
- Je krijgt het profiel van de administratie. Is die administratie de afzender, dan is het een verkoopfactuur; is zij de afnemer (of is het een kassabon), dan is het een inkoopdocument. Een kassabon zonder afnemer is documenttype "bon".
- Is het document geen factuur, creditnota of bon (bv. een offerte, pakbon, aanmaning of rekeningoverzicht), kies dan "geen_factuur".

## Regels
- Maak één regel per combinatie van grootboekrekening en btw-behandeling, niet één regel per artikel. Tel artikelen met dezelfde rekening en hetzelfde tarief bij elkaar op. Verzendkosten, toeslagen en statiegeld horen bij de regel waar ze boekhoudkundig bij passen, tenzij ze een ander tarief hebben.
- De regels moeten samen exact het factuurtotaal opleveren: de som van bedragExcl plus btwBedrag over alle regels is gelijk aan totaalIncl. Gebruik de btw-specificatie op het document (grondslag en btw per tarief) als die er staat; die is leidend boven eigen berekeningen.
- Staan op een bon alleen prijzen inclusief btw, bereken dan per tarief de grondslag en de btw, en zorg dat ze samen op het bedrag inclusief btw uitkomen.

## Btw-behandeling per regel
Kies de behandeling die bij de feiten op het document past:
- NL_HOOG / NL_LAAG / NL_NUL: Nederlandse btw van 21%, 9% of 0% staat op het document.
- VRIJGESTELD: vrijgestelde prestatie (art. 11 Wet OB), zoals zorg, onderwijs, verzekeringen, bankkosten, verhuur van onroerend goed zonder btw.
- GEEN_BTW: geen btw en geen vrijstelling of verlegging, zoals een leverancier met de kleineondernemersregeling, een particulier, leges, boetes, motorrijtuigenbelasting.
- VERLEGD_NL: Nederlandse leverancier, geen btw, met de vermelding "btw verlegd" (bv. onderaanneming in de bouw, schoonmaak van gebouwen, afval en oude materialen).
- EU_GOEDEREN: goederen van een leverancier in een andere EU-lidstaat zonder btw (intracommunautaire verwerving); bij verkoop: intracommunautaire levering.
- EU_DIENSTEN: dienst van een ondernemer in een andere EU-lidstaat zonder btw (reverse charge); bij verkoop: dienst aan een ondernemer in een andere lidstaat.
- NIET_EU_DIENSTEN: dienst van of aan een ondernemer buiten de EU zonder btw (bv. software-abonnement van een Amerikaanse leverancier).
- INVOER: goederen van een leverancier buiten de EU (alleen inkoop). EXPORT: goederen naar een afnemer buiten de EU (alleen verkoop).
- Staat op het document dat de margeregeling of de reisbureauregeling is toegepast, dan is er geen aftrekbare btw: kies GEEN_BTW en neem de vermelding op in vermeldingen.
- BUITENLANDSE_BTW: er staat btw van een ander land op het document (bv. een Duits hotel of tanken in België). btwBedrag is die buitenlandse btw.
- NIET_AFTREKBAAR: er staat Nederlandse btw op, maar die is niet aftrekbaar. Gebruik dit voor eten en drinken in horeca (restaurant, café, hotelontbijt). Andere aftrekbeperkingen beoordeelt het programma zelf aan de hand van het profiel.
Let op het verschil tussen een buitenlandse leverancier die Nederlandse btw rekent met een Nederlands btw-nummer (dan NL_HOOG/NL_LAAG) en een buitenlandse leverancier die niets rekent (verlegd).

Geef bij categorie aan waar de regel over gaat: horeca (eten en drinken ter plaatse), logies (overnachting), relatiegeschenk, personeelsvoorziening (bv. kerstpakket, personeelsuitje, fiets), auto (brandstof, onderhoud, lease van een personenauto), investering (duurzaam bedrijfsmiddel van enige omvang), anders overig.

## Grootboekrekening
Kies per regel de best passende code uit het rekeningschema van de administratie, op basis van wat er is gekocht of verkocht, de activiteiten van het bedrijf en de instructies in het profiel. Instructies in het profiel en bij een bekende relatie gaan voor op je eigen inschatting.

## Feedback van de boekhouder
Je kunt feedback krijgen op eerder verwerkte documenten: correcties die de boekhouder op een voorstel heeft aangebracht en aanwijzingen die hij heeft opgeschreven. Dat is de belangrijkste bron om van te leren hoe deze administratie boekt. Pas feedback toe op elk document waarvoor zij redelijkerwijs geldt: feedback bij een relatie op documenten van die relatie, algemene feedback op alle vergelijkbare situaties. Feedback gaat voor op je eigen inschatting, maar verandert niets aan wat er feitelijk op het document staat. Staat er geen passende rekening in het schema, laat de code dan leeg; verzin geen codes.

## Onzekerheden
Noem alleen punten die een boekhouder echt moet nakijken: een slecht leesbaar bedrag, een totaal dat niet aansluit op de regels van het document, een ontbrekend btw-nummer bij verlegging, twijfel tussen twee rekeningen of btw-behandelingen. Schrijf ze in het Nederlands, kort en concreet. Zet zekerheid op "laag" als je kernvelden (totaal, btw, datum, leverancier) niet betrouwbaar kon lezen.`;

function contextTekst(profiel: Profiel, grootboek: Grootboekrekening[], relaties: Relatie[], feedback: Feedback[]): string {
  const status = {
    normaal: "btw-plichtig met volledig aftrekrecht",
    kor: "past de kleineondernemersregeling toe (geen btw op verkoop, geen aftrek)",
    vrijgesteld: "verricht alleen vrijgestelde prestaties (geen aftrek)",
    gemengd: `verricht belaste en vrijgestelde prestaties (aftrek pro rata ${profiel.proRataPercentage}%)`,
  }[profiel.btwStatus];
  const regels = [
    "# Profiel van de administratie",
    `Naam: ${profiel.naam}`,
    profiel.handelsnamen.length ? `Handelsnamen: ${profiel.handelsnamen.join(", ")}` : "",
    profiel.adres ? `Adres: ${profiel.adres}` : "",
    profiel.kvk ? `KvK: ${profiel.kvk}` : "",
    profiel.btwNummer ? `Btw-nummer: ${profiel.btwNummer}` : "",
    profiel.ibans.length ? `IBAN: ${profiel.ibans.join(", ")}` : "",
    `Btw-positie: ${status}`,
    profiel.activiteiten ? `\nActiviteiten:\n${profiel.activiteiten}` : "",
    profiel.instructies ? `\nBoekingsinstructies van de boekhouder:\n${profiel.instructies}` : "",
    "\n# Rekeningschema (code - omschrijving)",
    ...grootboek.map((g) => `${g.code} - ${g.omschrijving}`),
  ];
  const bekend = relaties.filter((r) => r.standaardGrootboek || r.instructie).slice(0, 500);
  if (bekend.length) {
    regels.push("\n# Bekende relaties en hoe ze eerder zijn geboekt");
    for (const r of bekend) {
      const delen = [`${r.naam} (${r.soort})`];
      if (r.btwNummer) delen.push(`btw-nr ${r.btwNummer}`);
      if (r.standaardGrootboek) delen.push(`rekening ${r.standaardGrootboek}`);
      if (r.standaardBtw) delen.push(`btw ${r.standaardBtw}`);
      if (r.instructie) delen.push(`instructie: ${r.instructie}`);
      regels.push(`- ${delen.join("; ")}`);
    }
  }
  const actief = feedback.filter((f) => f.actief && f.tekst.trim()).slice(0, 300);
  if (actief.length) {
    regels.push("\n# Feedback van de boekhouder op eerder verwerkte documenten");
    const algemeen = actief.filter((f) => f.bereik === "administratie");
    const perRelatie = actief.filter((f) => f.bereik === "relatie");
    if (algemeen.length) regels.push("Geldt voor alle documenten:", ...algemeen.map((f) => `- ${f.tekst}`));
    if (perRelatie.length) regels.push("Geldt voor documenten van de genoemde relatie:", ...perRelatie.map((f) => `- ${f.relatieNaam}: ${f.tekst}`));
  }
  return regels.filter(Boolean).join("\n");
}

export interface ExtractieInvoer {
  bestand: Buffer;
  bestandsnaam: string;
  mime: string;
  feedback: Feedback[];
  /** Aanwijzing van de boekhouder bij het opnieuw uitlezen van juist dit document. */
  aanwijzing: string;
  profiel: Profiel;
  grootboek: Grootboekrekening[];
  relaties: Relatie[];
}

export type Extractor = (invoer: ExtractieInvoer) => Promise<Extractie>;

export const ONDERSTEUNDE_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];

let client: Anthropic | null = null;

async function vraag(invoer: ExtractieInvoer, herkansing?: string): Promise<Extractie> {
  client ??= new Anthropic();
  const data = invoer.bestand.toString("base64");
  const document: Anthropic.Beta.BetaContentBlockParam =
    invoer.mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
      : { type: "image", source: { type: "base64", media_type: invoer.mime as "image/jpeg" | "image/png" | "image/webp" | "image/gif", data } };

  const fallback = MET_FALLBACK.test(MODEL);
  const antwoord = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(ExtractieSchema) },
    ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    system: SYSTEEM,
    messages: [
      {
        role: "user",
        content: [
          // Profiel eerst en gecachet: het is voor elk document van deze administratie gelijk.
          { type: "text", text: contextTekst(invoer.profiel, invoer.grootboek, invoer.relaties, invoer.feedback), cache_control: { type: "ephemeral" } },
          document,
          {
            type: "text",
            text:
              (herkansing ?? "Lees dit document uit en maak het boekingsvoorstel voor deze administratie.") +
              (invoer.aanwijzing
                ? `\n\nDe boekhouder heeft een eerder voorstel voor dit document afgekeurd en geeft deze aanwijzing; volg die:\n${invoer.aanwijzing}`
                : ""),
          },
        ],
      },
    ],
  });

  if (antwoord.stop_reason === "refusal") throw new Error("De AI heeft dit document geweigerd te verwerken.");
  if (antwoord.stop_reason === "max_tokens") throw new Error("Het document is te omvangrijk om in één keer uit te lezen.");
  if (!antwoord.parsed_output) throw new Error("De AI gaf geen bruikbaar antwoord.");
  return antwoord.parsed_output as Extractie;
}

function sluitAan(ex: Extractie): boolean {
  const som = ex.regels.reduce((t, r) => t + Math.round(r.bedragExcl * 100) + Math.round(r.btwBedrag * 100), 0);
  return som === Math.round(ex.totaalIncl * 100);
}

/** Leest het document uit; sluiten de regels niet op het totaal aan, dan volgt één gerichte herkansing. */
export const extraheerMetClaude: Extractor = async (invoer) => {
  const eerste = await vraag(invoer);
  if (eerste.documentType === "geen_factuur" || sluitAan(eerste)) return eerste;
  const tweede = await vraag(
    invoer,
    `Een eerdere lezing van dit document gaf het resultaat hieronder, maar de regels (bedragExcl + btwBedrag) tellen niet op tot totaalIncl. Lees het document opnieuw, zoek waar het verschil zit en geef een gecorrigeerd boekingsvoorstel. Sluit het document zelf niet, zet dat dan in onzekerheden.\n\n${JSON.stringify(eerste)}`,
  );
  return sluitAan(tweede) ? tweede : eerste;
};

export function vertaalApiFout(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "De API-sleutel van Anthropic ontbreekt of is ongeldig (ANTHROPIC_API_KEY).";
  if (e instanceof Anthropic.RateLimitError) return "De AI-dienst is tijdelijk overbelast. Probeer het later opnieuw.";
  if (e instanceof Anthropic.BadRequestError) return `De AI-dienst kon het bestand niet verwerken: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Geen verbinding met de AI-dienst.";
  if (e instanceof Anthropic.APIError) return `Fout van de AI-dienst (${e.status}): ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Vaste voorbeelden om het programma zonder API-sleutel te kunnen uitproberen (SCAN_DEMO=1).
 * De bestanden in de map voorbeelden/ worden aan hun naam herkend; andere bestanden krijgen
 * om de beurt een voorbeeld. Er wordt niets gelezen: dit laat alleen de werkwijze zien.
 */
let demoTeller = 0;
export const demoExtractor: Extractor = async ({ bestandsnaam, profiel, relaties, feedback, aanwijzing }) => {
  await new Promise((r) => setTimeout(r, 900));
  const leeg = { adres: null, landcode: "NL", btwNummer: null, kvkNummer: null, iban: null };
  const basis = {
    afnemer: { ...leeg, naam: profiel.naam, btwNummer: profiel.btwNummer || null },
    valuta: "EUR",
    btwVerlegdVermeld: false,
    betaalwijze: "bankoverschrijving" as const,
    betalingskenmerk: null,
    zekerheid: "hoog" as const,
    onzekerheden: [],
    vermeldingen: [],
    vervaldatum: null,
  };
  // Net als de echte AI houdt het voorbeeld rekening met wat over de relatie is geleerd.
  const geleerd = (naam: string, standaard: string) => {
    const tekst = [aanwijzing, ...feedback.filter((f) => f.actief && (f.bereik === "administratie" || naam.startsWith(f.relatieNaam.split(" ")[0] ?? "~"))).map((f) => f.tekst)].join(" ");
    const genoemd = /\b(\d{4})\b(?!.*\b\d{4}\b)/.exec(tekst)?.[1];
    return genoemd ?? relaties.find((r) => r.naam === naam)?.standaardGrootboek ?? standaard;
  };
  const tweede = /2/.test(bestandsnaam);
  const voorbeelden: Record<string, Extractie> = {
    pen: {
      ...basis,
      documentType: "inkoopfactuur",
      afzender: { ...leeg, naam: "Kantoorhandel De Pen B.V.", btwNummer: "NL123456789B01", kvkNummer: "12345678", iban: "NL91ABNA0417164300" },
      factuurnummer: "2026-0412",
      factuurdatum: "2026-11-03",
      vervaldatum: "2026-12-03",
      regels: [
        { omschrijving: "Printpapier en toners", bedragExcl: 184.5, btwPercentage: 21, btwBedrag: 38.75, btwBehandeling: "NL_HOOG", categorie: "overig", grootboekCode: "4400" },
        { omschrijving: "Vakliteratuur", bedragExcl: 45, btwPercentage: 9, btwBedrag: 4.05, btwBehandeling: "NL_LAAG", categorie: "overig", grootboekCode: "4450" },
      ],
      totaalExcl: 229.5,
      totaalBtw: 42.8,
      totaalIncl: 272.3,
      omschrijving: "Kantoorartikelen november",
    },
    lepel: {
      ...basis,
      documentType: "bon",
      afzender: { ...leeg, naam: "Restaurant De Gouden Lepel", btwNummer: "NL001234567B02" },
      afnemer: { ...leeg, naam: "" },
      factuurnummer: "B-88213",
      factuurdatum: "2026-11-06",
      regels: [{ omschrijving: "Lunch met relatie", bedragExcl: 61.47, btwPercentage: 9, btwBedrag: 5.53, btwBehandeling: "NL_LAAG", categorie: "horeca", grootboekCode: "4240" }],
      totaalExcl: 61.47,
      totaalBtw: 5.53,
      totaalIncl: 67,
      betaalwijze: "pin",
      omschrijving: "Zakenlunch",
    },
    cloudsoft: {
      ...basis,
      documentType: "inkoopfactuur",
      afzender: { ...leeg, naam: "CloudSoft Ireland Ltd", landcode: "IE", btwNummer: "IE3668997OH" },
      factuurnummer: "INV-778123",
      factuurdatum: "2026-11-01",
      regels: [{ omschrijving: "Software-abonnement november", bedragExcl: 120, btwPercentage: 0, btwBedrag: 0, btwBehandeling: "EU_DIENSTEN", categorie: "overig", grootboekCode: "4420" }],
      totaalExcl: 120,
      totaalBtw: 0,
      totaalIncl: 120,
      btwVerlegdVermeld: true,
      vermeldingen: ["VAT reverse charged"],
      betaalwijze: "creditcard",
      omschrijving: "Software-abonnement",
    },
    shell: {
      ...basis,
      documentType: "bon",
      afzender: { ...leeg, naam: "Shell Station De Meern", btwNummer: "NL004455667B01" },
      afnemer: { ...leeg, naam: "" },
      factuurnummer: tweede ? "T-551204" : "T-550871",
      factuurdatum: tweede ? "2026-11-12" : "2026-11-05",
      regels: [
        {
          omschrijving: "Diesel",
          bedragExcl: tweede ? 70 : 60,
          btwPercentage: 21,
          btwBedrag: tweede ? 14.7 : 12.6,
          btwBehandeling: "NL_HOOG",
          categorie: "auto",
          grootboekCode: geleerd("Shell Station De Meern", "4590"),
        },
      ],
      totaalExcl: tweede ? 70 : 60,
      totaalBtw: tweede ? 14.7 : 12.6,
      totaalIncl: tweede ? 84.7 : 72.6,
      betaalwijze: "pin",
      omschrijving: "Brandstof",
    },
  };
  const sleutels = Object.keys(voorbeelden);
  const sleutel = sleutels.find((k) => bestandsnaam.toLowerCase().includes(k)) ?? sleutels[demoTeller++ % 3]!;
  return voorbeelden[sleutel]!;
};

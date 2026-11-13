// Gedeelde types. Alle bedragen in de boeking zijn in centen (gehele getallen).

export type BtwBehandeling =
  | "NL_HOOG"
  | "NL_LAAG"
  | "NL_NUL"
  | "VRIJGESTELD"
  | "GEEN_BTW"
  | "VERLEGD_NL"
  | "EU_GOEDEREN"
  | "EU_DIENSTEN"
  | "NIET_EU_DIENSTEN"
  | "INVOER"
  | "EXPORT"
  | "NIET_AFTREKBAAR"
  | "BUITENLANDSE_BTW";

export type Categorie =
  | "overig"
  | "horeca"
  | "logies"
  | "relatiegeschenk"
  | "personeelsvoorziening"
  | "auto"
  | "investering";

export type BtwStatus = "normaal" | "kor" | "vrijgesteld" | "gemengd";

export interface Profiel {
  naam: string;
  handelsnamen: string[];
  kvk: string;
  btwNummer: string;
  ibans: string[];
  adres: string;
  activiteiten: string;
  btwStatus: BtwStatus;
  /** Percentage aftrekbare voorbelasting bij gemengde prestaties (pro rata, art. 11 Uitv.besch. OB). */
  proRataPercentage: number;
  /** Vrije instructies voor de AI, bv. "Shell-bonnen altijd op 4310, auto van de zaak". */
  instructies: string;
  dagboekInkoop: string;
  dagboekVerkoop: string;
  rekeningCrediteuren: string;
  rekeningDebiteuren: string;
  rekeningBtwTeVorderen: string;
  rekeningBtwAfTeDragen: string;
  /** Eerste nummer voor relaties die door dit programma worden aangemaakt. */
  relatieStartnummer: number;
  /** Vergunning art. 23 Wet OB (btw bij invoer verleggen naar de aangifte). */
  artikel23: boolean;
}

export interface Grootboekrekening {
  code: string;
  omschrijving: string;
}

export interface Relatie {
  id: number;
  adminId: number;
  soort: "crediteur" | "debiteur";
  code: string;
  naam: string;
  btwNummer: string;
  kvk: string;
  iban: string;
  land: string;
  standaardGrootboek: string;
  standaardBtw: BtwBehandeling | "";
  /** Standaardrekening altijd toepassen, ook als de AI iets anders voorstelt. */
  vast: boolean;
  instructie: string;
  /** Door dit programma aangemaakt en nog niet naar Exact gestuurd. */
  nieuw: boolean;
}

export interface Partij {
  naam: string;
  adres: string | null;
  landcode: string | null;
  btwNummer: string | null;
  kvkNummer: string | null;
  iban: string | null;
}

export interface ExtractieRegel {
  omschrijving: string;
  bedragExcl: number;
  btwPercentage: number | null;
  btwBedrag: number;
  btwBehandeling: BtwBehandeling;
  categorie: Categorie;
  grootboekCode: string;
}

/** Ruwe uitkomst van de AI (bedragen in euro's). */
export interface Extractie {
  documentType: "inkoopfactuur" | "verkoopfactuur" | "bon" | "creditnota_inkoop" | "creditnota_verkoop" | "geen_factuur";
  afzender: Partij;
  afnemer: Partij;
  factuurnummer: string | null;
  factuurdatum: string | null;
  vervaldatum: string | null;
  valuta: string;
  regels: ExtractieRegel[];
  totaalExcl: number;
  totaalBtw: number;
  totaalIncl: number;
  btwVerlegdVermeld: boolean;
  betaalwijze: "onbekend" | "bankoverschrijving" | "pin" | "contant" | "creditcard" | "automatische_incasso" | "ideal";
  betalingskenmerk: string | null;
  omschrijving: string;
  zekerheid: "hoog" | "middel" | "laag";
  onzekerheden: string[];
}

export interface BoekingRegel {
  omschrijving: string;
  grootboek: string;
  btw: BtwBehandeling;
  categorie: Categorie;
  /** Centen, exclusief btw. */
  bedragExcl: number;
  /** Centen, btw zoals op het document vermeld. */
  btwBedrag: number;
}

export interface Boeking {
  soort: "inkoop" | "verkoop";
  creditnota: boolean;
  relatieId: number | null;
  relatieNaam: string;
  relatieBtwNummer: string;
  relatieLand: string;
  factuurnummer: string;
  datum: string;
  vervaldatum: string;
  omschrijving: string;
  valuta: string;
  totaalIncl: number;
  betalingskenmerk: string;
  regels: BoekingRegel[];
}

export interface Signalering {
  niveau: "fout" | "waarschuwing" | "info";
  code: string;
  tekst: string;
}

export type DocumentStatus = "wachtrij" | "bezig" | "controle" | "gereed" | "goedgekeurd" | "geexporteerd" | "fout";

export interface Document {
  id: number;
  adminId: number;
  bestandsnaam: string;
  mime: string;
  pad: string;
  hash: string;
  status: DocumentStatus;
  extractie: Extractie | null;
  boeking: Boeking | null;
  signaleringen: Signalering[];
  fout: string;
  aangemaakt: string;
  geexporteerdOp: string;
}

export interface Journaalregel {
  rekening: string;
  omschrijving: string;
  debet: number;
  credit: number;
}

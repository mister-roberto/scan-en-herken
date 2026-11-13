import assert from "node:assert/strict";
import { test } from "node:test";
import { maakBoeking, maakJournaalpost } from "../src/boeking.ts";
import { isGeldigeIban, isGeldigNlBtwNummer, centen } from "../src/btw.ts";
import { STANDAARD_GROOTBOEK, standaardProfiel } from "../src/defaults.ts";
import { controleerExport, exactCsv, exactRegels, exactXml } from "../src/exact.ts";
import { heeftFouten, valideer } from "../src/validatie.ts";
import type { Boeking, Document, Extractie, ExtractieRegel, Profiel, Relatie } from "../src/types.ts";

const profiel: Profiel = { ...standaardProfiel("Bakkerij Jansen B.V."), btwNummer: "NL861234567B01", kvk: "87654321" };
const ctx = { dubbel: false, vandaag: "2026-11-13" };
const leeg = { adres: null, landcode: "NL", btwNummer: null, kvkNummer: null, iban: null };

function extractie(regels: Partial<ExtractieRegel>[], over: Partial<Extractie> = {}): Extractie {
  const r = regels.map((x) => ({ omschrijving: "Regel", bedragExcl: 100, btwPercentage: 21, btwBedrag: 21, btwBehandeling: "NL_HOOG" as const, categorie: "overig" as const, grootboekCode: "4400", ...x }));
  const excl = r.reduce((t, x) => t + x.bedragExcl, 0);
  const btw = r.reduce((t, x) => t + x.btwBedrag, 0);
  return {
    documentType: "inkoopfactuur",
    afzender: { ...leeg, naam: "Leverancier B.V.", btwNummer: "NL123456789B01" },
    afnemer: { ...leeg, naam: "Bakkerij Jansen BV" },
    factuurnummer: "F-1", factuurdatum: "2026-11-01", vervaldatum: null, valuta: "EUR",
    regels: r, totaalExcl: excl, totaalBtw: btw, totaalIncl: Math.round((excl + btw) * 100) / 100,
    btwVerlegdVermeld: false, betaalwijze: "onbekend", betalingskenmerk: null, omschrijving: "Test", zekerheid: "hoog", onzekerheden: [],
    ...over,
  };
}
const boek = (ex: Extractie, p = profiel, relaties: Relatie[] = []) => maakBoeking(ex, p, relaties, STANDAARD_GROOTBOEK);
const saldo = (b: Boeking, p = profiel) => maakJournaalpost(b, p).reduce((t, j) => t + j.debet - j.credit, 0);
const op = (b: Boeking, rekening: string, p = profiel) => maakJournaalpost(b, p).filter((j) => j.rekening === rekening).reduce((t, j) => t + j.debet - j.credit, 0);

test("gewone inkoopfactuur 21%: kosten, voorbelasting en crediteur", () => {
  const ex = extractie([{}]);
  const { boeking } = boek(ex);
  assert.equal(op(boeking, "4400"), 100_00);
  assert.equal(op(boeking, "1520"), 21_00);
  assert.equal(op(boeking, "1600"), -121_00);
  assert.equal(saldo(boeking), 0);
  assert.deepEqual(valideer(boeking, ex, profiel, STANDAARD_GROOTBOEK, ctx).filter((s) => s.niveau !== "info"), []);
});

test("horeca: btw niet aftrekbaar, kosten inclusief btw (art. 15 lid 5)", () => {
  const ex = extractie([{ bedragExcl: 61.47, btwBedrag: 5.53, btwPercentage: 9, btwBehandeling: "NL_LAAG", categorie: "horeca", grootboekCode: "4240" }]);
  const { boeking } = boek(ex);
  assert.equal(boeking.regels[0]!.btw, "NIET_AFTREKBAAR");
  assert.equal(op(boeking, "4240"), 67_00);
  assert.equal(op(boeking, "1520"), 0);
  assert.equal(saldo(boeking), 0);
});

test("KOR-administratie: geen aftrek van voorbelasting", () => {
  const kor = { ...profiel, btwStatus: "kor" as const };
  const { boeking } = boek(extractie([{}]), kor);
  assert.equal(boeking.regels[0]!.btw, "NIET_AFTREKBAAR");
  assert.equal(op(boeking, "4400", kor), 121_00);
});

test("EU-dienst: btw verlegd, af te dragen en te vorderen", () => {
  const ex = extractie([{ btwBedrag: 0, btwPercentage: 0, btwBehandeling: "EU_DIENSTEN" }], { afzender: { ...leeg, naam: "CloudSoft Ltd", landcode: "IE", btwNummer: "IE3668997OH" }, btwVerlegdVermeld: true });
  const { boeking } = boek(ex);
  assert.equal(boeking.relatieLand, "IE");
  assert.equal(op(boeking, "1520"), 21_00);
  assert.equal(op(boeking, "1500"), -21_00);
  assert.equal(op(boeking, "1600"), -100_00);
  assert.equal(saldo(boeking), 0);
  assert.equal(heeftFouten(valideer(boeking, ex, profiel, STANDAARD_GROOTBOEK, ctx)), false);
});

test("verlegde btw bij vrijgestelde administratie wordt kosten", () => {
  const vrij = { ...profiel, btwStatus: "vrijgesteld" as const };
  const ex = extractie([{ btwBedrag: 0, btwBehandeling: "EU_DIENSTEN" }], { afzender: { ...leeg, naam: "X GmbH", landcode: "DE", btwNummer: "DE123456789" } });
  const { boeking } = boek(ex, vrij);
  assert.equal(op(boeking, "4400", vrij), 121_00);
  assert.equal(op(boeking, "1500", vrij), -21_00);
  assert.equal(saldo(boeking, vrij), 0);
});

test("pro rata: voorbelasting gedeeltelijk in aftrek", () => {
  const gemengd = { ...profiel, btwStatus: "gemengd" as const, proRataPercentage: 60 };
  const { boeking } = boek(extractie([{}]), gemengd);
  assert.equal(op(boeking, "1520", gemengd), 12_60);
  assert.equal(op(boeking, "4400", gemengd), 108_40);
  assert.equal(saldo(boeking, gemengd), 0);
});

test("buitenlandse btw is niet aftrekbaar in Nederland", () => {
  const ex = extractie([{ bedragExcl: 100, btwBedrag: 7, btwPercentage: 7, btwBehandeling: "NL_LAAG", categorie: "logies", grootboekCode: "4230" }], { afzender: { ...leeg, naam: "Hotel Adler", landcode: "DE", btwNummer: "DE811234567" } });
  const { boeking } = boek(ex);
  assert.equal(boeking.regels[0]!.btw, "BUITENLANDSE_BTW");
  assert.equal(op(boeking, "4230"), 107_00);
});

test("binnenlandse verlegging herkend aan vermelding op factuur", () => {
  const ex = extractie([{ btwBedrag: 0, btwPercentage: 0, btwBehandeling: "GEEN_BTW", grootboekCode: "7010" }], { btwVerlegdVermeld: true });
  const { boeking } = boek(ex);
  assert.equal(boeking.regels[0]!.btw, "VERLEGD_NL");
});

test("creditnota keert de journaalpost om", () => {
  const { boeking } = boek(extractie([{}], { documentType: "creditnota_inkoop" }));
  assert.equal(op(boeking, "4400"), -100_00);
  assert.equal(op(boeking, "1600"), 121_00);
  assert.equal(saldo(boeking), 0);
});

test("verkoopfactuur wordt herkend aan het eigen btw-nummer", () => {
  const ex = extractie([{ grootboekCode: "8000" }], { afzender: { ...leeg, naam: "Bakkerij Jansen", btwNummer: "NL861234567B01" }, afnemer: { ...leeg, naam: "Klant B.V.", btwNummer: "NL003456789B01" } });
  const { boeking } = boek(ex);
  assert.equal(boeking.soort, "verkoop");
  assert.equal(op(boeking, "8000"), -100_00);
  assert.equal(op(boeking, "1500"), -21_00);
  assert.equal(op(boeking, "1300"), 121_00);
});

test("controles: totaal sluit niet aan en btw klopt niet met tarief", () => {
  const ex = extractie([{ btwBedrag: 19 }], { totaalIncl: 125 });
  const { boeking } = boek(ex);
  const codes = valideer(boeking, ex, profiel, STANDAARD_GROOTBOEK, ctx).filter((s) => s.niveau === "fout").map((s) => s.code);
  assert.ok(codes.includes("TOTAAL"));
  assert.ok(codes.includes("BTW_BEDRAG"));
});

test("controles: onbekende grootboekrekening, tenaamstelling, dubbel, ICP zonder btw-nummer", () => {
  const ex = extractie([{ grootboekCode: "9999" }], { afnemer: { ...leeg, naam: "Heel Ander Bedrijf" } });
  const { boeking } = boek(ex);
  const s = valideer(boeking, ex, profiel, STANDAARD_GROOTBOEK, { ...ctx, dubbel: true });
  assert.ok(s.some((x) => x.code === "GROOTBOEK" && x.niveau === "fout"));
  assert.ok(s.some((x) => x.code === "TENAAMSTELLING"));
  assert.ok(s.some((x) => x.code === "DUBBEL"));

  const verkoop: Boeking = { ...boeking, soort: "verkoop", relatieLand: "DE", relatieBtwNummer: "", regels: [{ ...boeking.regels[0]!, grootboek: "8030", btw: "EU_GOEDEREN", btwBedrag: 0 }], totaalIncl: 100_00 };
  assert.ok(valideer(verkoop, null, profiel, STANDAARD_GROOTBOEK, ctx).some((x) => x.code === "BTW_NUMMER" && x.niveau === "fout"));
});

test("vaste rekening van een bekende relatie gaat voor op de AI", () => {
  const relatie: Relatie = { id: 7, adminId: 1, soort: "crediteur", code: "123", naam: "Leverancier", btwNummer: "NL123456789B01", kvk: "", iban: "", land: "NL", standaardGrootboek: "7000", standaardBtw: "", vast: true, instructie: "", nieuw: false };
  const { boeking } = boek(extractie([{}]), profiel, [relatie]);
  assert.equal(boeking.relatieId, 7);
  assert.equal(boeking.regels[0]!.grootboek, "7000");
});

test("Exact-export: tekens, btw-codes en ontbrekende instellingen", () => {
  const relatie: Relatie = { id: 1, adminId: 1, soort: "crediteur", code: "90001", naam: "Leverancier & Zn", btwNummer: "NL123456789B01", kvk: "", iban: "", land: "NL", standaardGrootboek: "", standaardBtw: "", vast: false, instructie: "", nieuw: true };
  const { boeking } = boek(extractie([{}, { bedragExcl: 50, btwBedrag: 4.5, btwBehandeling: "NL_LAAG", categorie: "horeca", grootboekCode: "4240" }]), profiel, [relatie]);
  const doc = { id: 5, adminId: 1, bestandsnaam: "f.pdf", boeking } as Document;

  assert.equal(controleerExport([doc], [relatie], {}).length, 2);
  const codes = { "inkoop:NL_HOOG": "2", "inkoop:NIET_AFTREKBAAR": "0" };
  assert.deepEqual(controleerExport([doc], [relatie], codes), []);

  const regels = exactRegels(boeking, profiel, codes);
  assert.deepEqual(regels.map((r) => [r.bedrag, r.btwCode]), [[100_00, "2"], [54_50, "0"]]);

  const xml = exactXml([doc], profiel, [relatie], codes);
  assert.match(xml, /<Journal code="60" type="22"\/>/);
  assert.match(xml, /<Account code="90001" status="C">/);
  assert.match(xml, /Leverancier &amp; Zn/);
  assert.match(xml, /<Value>54\.50<\/Value>\s*<VAT code="0"\/>/);
  assert.match(exactCsv([doc], profiel, [relatie], codes), /60;5;inkoopfactuur;2026-11-01;;90001;/);

  const credit = exactRegels({ ...boeking, creditnota: true }, profiel, codes);
  assert.equal(credit[0]!.bedrag, -100_00);
});

test("hulpfuncties", () => {
  assert.equal(isGeldigeIban("NL91 ABNA 0417 1643 00"), true);
  assert.equal(isGeldigeIban("NL91ABNA0417164301"), false);
  assert.equal(isGeldigNlBtwNummer("NL 1234.56.789.B01"), true);
  assert.equal(isGeldigNlBtwNummer("NL12345678B01"), false);
  assert.equal(centen(272.3), 272_30);
  assert.equal(centen(1.005), 101);
  assert.equal(centen(-61.47), -61_47);
});

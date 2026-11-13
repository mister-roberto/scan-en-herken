import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { btwOverzicht } from "../src/aangifte.ts";
import { Opslag } from "../src/db.ts";
import { standaardProfiel } from "../src/defaults.ts";
import { demoExtractor } from "../src/extract.ts";
import { maakApp } from "../src/server.ts";
import { leesUbl, zonderBijlagen } from "../src/ubl.ts";
import type { Boeking, BoekingRegel } from "../src/types.ts";

const efactuur = fs.readFileSync(new URL("../voorbeelden/efactuur-meelgroothandel.xml", import.meta.url), "utf8");

test("e-factuur: kerngegevens uit het bestand", () => {
  assert.deepEqual(leesUbl(efactuur), { creditnota: false, factuurnummer: "2026-1187", datum: "2026-11-10", valuta: "EUR", totaalIncl: 500_15, totaalBtw: 45_15 });
  assert.equal(leesUbl("<html><body>geen factuur</body></html>"), null);
  // Zonder voorvoegsels en als creditnota.
  const credit = "<CreditNote><ID>C-9</ID><IssueDate>2026-01-02</IssueDate><AccountingSupplierParty><ID>x</ID></AccountingSupplierParty><TaxTotal><TaxAmount>2.10</TaxAmount></TaxTotal><LegalMonetaryTotal><PayableAmount>12.10</PayableAmount></LegalMonetaryTotal><CreditNoteLine><ID>1</ID><TaxTotal><TaxAmount>9.99</TaxAmount></TaxTotal></CreditNoteLine></CreditNote>";
  assert.deepEqual(leesUbl(credit), { creditnota: true, factuurnummer: "C-9", datum: "2026-01-02", valuta: "EUR", totaalIncl: 12_10, totaalBtw: 2_10 });
  const metPdf = '<cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf">JVBERi0xLjQK</cbc:EmbeddedDocumentBinaryObject>';
  assert.equal(zonderBijlagen(metPdf).includes("JVBERi0"), false);
});

const regel = (over: Partial<BoekingRegel>): BoekingRegel => ({ omschrijving: "x", grootboek: "4400", btw: "NL_HOOG", categorie: "overig", bedragExcl: 100_00, btwBedrag: 21_00, ...over });
const boeking = (soort: Boeking["soort"], regels: BoekingRegel[], creditnota = false): Boeking => ({ soort, creditnota, relatieId: null, relatieNaam: "R", relatieBtwNummer: "", relatieLand: "NL", factuurnummer: "1", datum: "2026-11-01", vervaldatum: "", omschrijving: "", valuta: "EUR", totaalIncl: 0, betalingskenmerk: "", regels });

test("btw-overzicht: rubrieken van de aangifte", () => {
  const profiel = standaardProfiel("Test");
  const o = btwOverzicht(
    [
      boeking("verkoop", [regel({ bedragExcl: 1000_00, btwBedrag: 210_00 }), regel({ btw: "NL_LAAG", bedragExcl: 200_00, btwBedrag: 18_00 })]),
      boeking("verkoop", [regel({ bedragExcl: 100_00, btwBedrag: 21_00 })], true),
      boeking("verkoop", [regel({ btw: "EU_GOEDEREN", bedragExcl: 500_00, btwBedrag: 0 })]),
      boeking("inkoop", [regel({ bedragExcl: 300_00, btwBedrag: 63_00 })]),
      boeking("inkoop", [regel({ btw: "EU_DIENSTEN", bedragExcl: 100_00, btwBedrag: 0 })]),
      boeking("inkoop", [regel({ btw: "VERLEGD_NL", bedragExcl: 400_00, btwBedrag: 0 })]),
      boeking("inkoop", [regel({ btw: "NIET_AFTREKBAAR", bedragExcl: 50_00, btwBedrag: 4_50 })]),
    ],
    profiel,
  );
  const r = Object.fromEntries(o.rubrieken.map((x) => [x.code, [x.grondslag, x.btw]]));
  assert.deepEqual(r["1a"], [900_00, 189_00]);
  assert.deepEqual(r["1b"], [200_00, 18_00]);
  assert.deepEqual(r["3b"], [500_00, 0]);
  assert.deepEqual(r["2a"], [400_00, 84_00]);
  assert.deepEqual(r["4b"], [100_00, 21_00]);
  assert.equal(o.verschuldigd, 189_00 + 18_00 + 84_00 + 21_00);
  assert.equal(o.voorbelasting, 63_00 + 21_00 + 84_00);
  assert.equal(o.saldo, o.verschuldigd - o.voorbelasting);
});

test("e-factuur, in één keer goedkeuren, btw-overzicht en wachtwoord via de server", async () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  const server = maakApp(new Opslag(map), demoExtractor, true, "geheim").listen(0);
  const basis = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { authorization: "Basic " + Buffer.from("wie:geheim").toString("base64") };
  const json = async (pad: string, methode = "GET", body?: unknown) => {
    const r = await fetch(`${basis}/api${pad}`, { method: methode, headers: { ...auth, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: (await r.json()) as any };
  };
  try {
    assert.equal((await fetch(`${basis}/api/meta`)).status, 401);
    assert.equal((await fetch(`${basis}/`, { headers: { authorization: "Basic " + Buffer.from("wie:fout").toString("base64") } })).status, 401);
    assert.equal((await fetch(`${basis}/`, { headers: auth })).status, 200);

    const { data: admin } = await json("/administraties", "POST", { naam: "Bakkerij Jansen B.V." });
    const form = new FormData();
    form.append("bestanden", new Blob([efactuur], { type: "text/xml" }), "efactuur-meelgroothandel.xml");
    form.append("bestanden", new Blob(["a"], { type: "application/pdf" }), "kantoorhandel-de-pen.pdf");
    // Een e-factuur waarvan het voorstel niet op het bestand aansluit (demo geeft een ander document terug).
    form.append("bestanden", new Blob([efactuur.replace("2026-1187</cbc:ID>", "2026-9999</cbc:ID>").replaceAll("500.15", "600.15")], { type: "application/xml" }), "efactuur-afwijkend.xml");
    await fetch(`${basis}/api/administraties/${admin.id}/documenten`, { method: "POST", headers: auth, body: form });
    let lijst: any[] = [];
    for (let i = 0; i < 60; i++) {
      lijst = (await json(`/administraties/${admin.id}/documenten`)).data;
      if (lijst.every((d) => d.status !== "wachtrij" && d.status !== "bezig")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const perNaam = Object.fromEntries(lijst.map((d) => [d.bestandsnaam, d]));
    assert.equal(perNaam["efactuur-meelgroothandel.xml"].status, "gereed");
    assert.equal(perNaam["efactuur-meelgroothandel.xml"].efactuur, true);
    assert.equal(perNaam["efactuur-afwijkend.xml"].status, "controle");
    const afwijkend = (await json(`/documenten/${perNaam["efactuur-afwijkend.xml"].id}`)).data;
    assert.equal(afwijkend.boeking.factuurnummer, "2026-9999");
    assert.ok(afwijkend.signaleringen.some((s: any) => s.code === "UBL" && s.niveau === "fout"));

    // De e-factuur wordt als platte tekst getoond.
    const bestand = await fetch(`${basis}/api/documenten/${perNaam["efactuur-meelgroothandel.xml"].id}/bestand`, { headers: auth });
    assert.match(bestand.headers.get("content-type") ?? "", /^text\/plain/);

    const bulk = await json(`/administraties/${admin.id}/goedkeuren-zonder-signalen`, "POST");
    assert.equal(bulk.data.goedgekeurd, 2);
    lijst = (await json(`/administraties/${admin.id}/documenten`)).data;
    assert.deepEqual(lijst.map((d) => d.status).sort(), ["controle", "goedgekeurd", "goedgekeurd"]);
    assert.ok((await json(`/documenten/${perNaam["kantoorhandel-de-pen.pdf"].id}`)).data.goedgekeurdOp);

    const o = (await json(`/administraties/${admin.id}/btw-overzicht?van=2026-10-01&tot=2026-12-31`)).data;
    assert.equal(o.aantalBoekingen, 2);
    assert.equal(o.nogNietGoedgekeurd, 1);
    assert.equal(o.voorbelasting, 45_15 + 42_80);
    assert.equal(o.saldo, -(45_15 + 42_80));
    assert.equal((await json(`/administraties/${admin.id}/btw-overzicht?van=2026-13-01&tot=x`)).status, 400);
  } finally {
    server.close();
    fs.rmSync(map, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { Opslag } from "../src/db.ts";
import { demoExtractor } from "../src/extract.ts";
import { maakApp } from "../src/server.ts";

test("fraudesignalen, wachtstatus, automatisch akkoord, inleesmap en splitsen", async () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  const opslag = new Opslag(map);
  const app = maakApp(opslag, demoExtractor, true);
  const server = app.listen(0);
  const basis = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const json = async (pad: string, methode = "GET", body?: unknown) => {
    const r = await fetch(basis + pad, { method: methode, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: (await r.json()) as any };
  };
  const wachtOpAlles = async (adminId: number) => {
    for (let i = 0; i < 80; i++) {
      const lijst = (await json(`/administraties/${adminId}/documenten`)).data as any[];
      if (lijst.length && lijst.every((d) => d.status !== "wachtrij" && d.status !== "bezig")) return lijst;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("niet uitgelezen");
  };
  const lever = async (adminId: number, naam: string, inhoud: BlobPart = naam) => {
    const f = new FormData();
    f.append("bestanden", new Blob([inhoud], { type: "application/pdf" }), naam);
    const [r] = (await (await fetch(`${basis}/administraties/${adminId}/documenten`, { method: "POST", body: f })).json()) as any[];
    await wachtOpAlles(adminId);
    return (await json(`/documenten/${r.id}`)).data;
  };
  try {
    const { data: admin } = await json("/administraties", "POST", { naam: "Bakkerij Jansen B.V." });

    // Eerste factuur van een leverancier: alleen een informatief signaal, rekeningnummer wordt onthouden.
    const eerste = await lever(admin.id, "kantoorhandel-de-pen.pdf");
    assert.equal(eerste.status, "gereed");
    assert.ok(eerste.signaleringen.some((s: any) => s.code === "NIEUWE_RELATIE" && s.niveau === "info"));
    assert.equal((await json(`/documenten/${eerste.id}/goedkeuren`, "POST")).status, 200);
    let relatie = (await json(`/administraties/${admin.id}`)).data.relaties[0];
    assert.equal(relatie.iban, "NL91ABNA0417164300");

    // Rekeningnummer wijzigt: waarschuwing voor factuurfraude, het bekende nummer blijft staan.
    await json(`/relaties/${relatie.id}`, "PUT", { iban: "NL20INGB0001234567" });
    const tweede = await lever(admin.id, "klusbedrijf-bakker.pdf");
    assert.equal(tweede.signaleringen.some((s: any) => s.code === "IBAN_GEWIJZIGD"), false);
    await json(`/documenten/${tweede.id}/goedkeuren`, "POST");
    const klus = (await json(`/administraties/${admin.id}`)).data.relaties.find((r: any) => r.naam === "Klusbedrijf Bakker");
    await json(`/relaties/${klus.id}`, "PUT", { iban: "NL20INGB0001234567" });
    const heropend = (await json(`/documenten/${tweede.id}/heropenen`, "POST")).data;
    const fraude = heropend.signaleringen.find((s: any) => s.code === "IBAN_GEWIJZIGD");
    assert.equal(fraude.niveau, "waarschuwing");
    assert.match(fraude.tekst, /NL91ABNA0417164300.*NL20INGB0001234567/);

    // In de wacht zetten vraagt een notitie; het document telt dan niet mee bij in één keer goedkeuren.
    assert.equal((await json(`/documenten/${tweede.id}/wacht`, "POST", {})).status, 400);
    const wacht = await json(`/documenten/${tweede.id}/wacht`, "POST", { notitie: "Juiste factuur opgevraagd bij klant" });
    assert.equal(wacht.data.status, "wacht");
    assert.equal((await json(`/documenten/${tweede.id}/boeking`, "PUT", wacht.data.boeking)).data.status, "wacht");
    assert.equal((await json(`/administraties/${admin.id}/goedkeuren-zonder-signalen`, "POST")).data.goedgekeurd, 0);
    assert.equal((await json(`/documenten/${tweede.id}/heropenen`, "POST")).data.status, "controle");

    // Vertrouwde relatie: een voorstel zonder enig signaal wordt direct goedgekeurd.
    const eu = await lever(admin.id, "efactuur-geen-xml.pdf");
    assert.equal(eu.status, "gereed");
    await json(`/documenten/${eu.id}/goedkeuren`, "POST");
    const meel = (await json(`/administraties/${admin.id}`)).data.relaties.find((r: any) => /Meelgroothandel/.test(r.naam));
    await json(`/relaties/${meel.id}`, "PUT", { autoAkkoord: true });
    await json(`/documenten/${eu.id}`, "DELETE");
    const auto = await lever(admin.id, "efactuur-geen-xml-2.pdf", "andere inhoud");
    assert.equal(auto.status, "goedgekeurd");
    assert.match(auto.notitie, /Automatisch goedgekeurd/);

    // Inleesmap: een bestand in de map van de administratie komt vanzelf binnen en wordt verplaatst.
    const inleesmap = (await json(`/administraties/${admin.id}`)).data.inleesmap as string;
    const bestand = path.join(inleesmap, "restaurant-gouden-lepel.pdf");
    fs.writeFileSync(bestand, "bon");
    const oud = new Date(Date.now() - 5000);
    fs.utimesSync(bestand, oud, oud);
    fs.writeFileSync(path.join(inleesmap, "notitie.txt"), "geen factuur");
    fs.utimesSync(path.join(inleesmap, "notitie.txt"), oud, oud);
    assert.equal(app.locals.leesInleesmappen(), 1);
    assert.equal(fs.existsSync(bestand), false);
    assert.equal(fs.readdirSync(path.join(inleesmap, "verwerkt")).length, 1);
    assert.equal(fs.readdirSync(path.join(inleesmap, "overgeslagen")).length, 1);
    const lijst = await wachtOpAlles(admin.id);
    assert.ok(lijst.some((d) => d.bestandsnaam === "restaurant-gouden-lepel.pdf" && d.relatieNaam === "Restaurant De Gouden Lepel"));

    // Splitsen: een verzamelscan van drie pagina's wordt twee losse documenten.
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 3; i++) pdf.addPage([300, 400]).drawText(`pagina ${i + 1}`);
    const verzamel = await lever(admin.id, "verzamelscan.pdf", Buffer.from(await pdf.save()));
    assert.ok(verzamel.signaleringen.some((s: any) => s.code === "MEERDERE"));
    assert.equal((await json(`/documenten/${verzamel.id}/splitsen`, "POST", { delen: "1-2, 9" })).status, 400);
    assert.equal((await json(`/documenten/${verzamel.id}/splitsen`, "POST", { delen: "1" })).status, 400);
    const gesplitst = await json(`/documenten/${verzamel.id}/splitsen`, "POST", { delen: "1-2, 3" });
    assert.equal(gesplitst.data.documenten.length, 2);
    assert.equal((await json(`/documenten/${verzamel.id}`)).status, 404);
    const na = await wachtOpAlles(admin.id);
    const delen = na.filter((d) => /verzamelscan-deel/.test(d.bestandsnaam));
    assert.deepEqual(delen.map((d) => d.bestandsnaam).sort(), ["verzamelscan-deel1.pdf", "verzamelscan-deel2.pdf"]);
    const deel1 = await PDFDocument.load(await (await fetch(`${basis}/documenten/${gesplitst.data.documenten[0]}/bestand`)).arrayBuffer());
    assert.equal(deel1.getPageCount(), 2);
  } finally {
    server.close();
    fs.rmSync(map, { recursive: true, force: true });
  }
});

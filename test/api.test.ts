import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Opslag } from "../src/db.ts";
import { demoExtractor } from "../src/extract.ts";
import { maakApp } from "../src/server.ts";

test("volledige doorloop: aanleveren, uitlezen, goedkeuren, exporteren", async () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  const server = maakApp(new Opslag(map), demoExtractor, true).listen(0);
  const basis = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const json = async (pad: string, methode = "GET", body?: unknown) => {
    const r = await fetch(basis + pad, { method: methode, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: (await r.json()) as any };
  };
  try {
    const { data: admin } = await json("/administraties", "POST", { naam: "Demo B.V." });
    await json(`/administraties/${admin.id}/profiel`, "PUT", { btwNummer: "nl 861234567 b01" });

    // Drie bestanden geven de drie demovoorbeelden.
    const form = new FormData();
    for (const n of [3, 4, 5]) form.append("bestanden", new Blob([new Uint8Array(n).fill(n)], { type: "application/pdf" }), `factuur${n}.pdf`);
    form.append("bestanden", new Blob(["x"], { type: "text/plain" }), "notitie.txt");
    const up = (await (await fetch(`${basis}/administraties/${admin.id}/documenten`, { method: "POST", body: form })).json()) as any[];
    assert.equal(up.filter((u) => u.id).length, 3);
    assert.match(up[3].overgeslagen, /niet ondersteund/);

    let lijst: any[] = [];
    for (let i = 0; i < 50; i++) {
      lijst = (await json(`/administraties/${admin.id}/documenten`)).data;
      if (lijst.every((d) => d.status !== "wachtrij" && d.status !== "bezig")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.deepEqual(lijst.map((d) => d.status).sort(), ["gereed", "gereed", "gereed"]);
    assert.equal(lijst.reduce((t, d) => t + d.fouten, 0), 0);

    for (const d of lijst) assert.equal((await json(`/documenten/${d.id}/goedkeuren`, "POST")).status, 200);
    const { data: detail } = await json(`/administraties/${admin.id}`);
    assert.equal(detail.relaties.length, 3);
    assert.equal(detail.relaties[0].code, "90001");
    assert.equal(detail.relaties[0].nieuw, true);

    // Zonder btw-codes mag er niets naar Exact.
    const geweigerd = await json(`/administraties/${admin.id}/export`, "POST", { formaat: "xml" });
    assert.equal(geweigerd.status, 409);
    assert.ok(geweigerd.data.problemen.length >= 3);

    await json(`/administraties/${admin.id}/btwcodes`, "PUT", { "inkoop:NL_HOOG": "2", "inkoop:NL_LAAG": "4", "inkoop:NIET_AFTREKBAAR": "0", "inkoop:EU_DIENSTEN": "9" });
    const r = await fetch(`${basis}/administraties/${admin.id}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ formaat: "xml" }) });
    assert.equal(r.status, 200);
    const xml = await r.text();
    assert.equal(xml.match(/<GLTransaction>/g)?.length, 3);
    assert.equal(xml.match(/<Account code=/g)?.length, 3 + 4);

    lijst = (await json(`/administraties/${admin.id}/documenten`)).data;
    assert.ok(lijst.every((d) => d.status === "geexporteerd"));
    assert.equal((await json(`/administraties/${admin.id}/export`, "POST", { formaat: "xml" })).status, 400);

    // Een aangepaste boeking met een fout kan niet worden goedgekeurd.
    const doc = (await json(`/documenten/${lijst[0].id}/heropenen`, "POST")).data;
    doc.boeking.totaalIncl += 100;
    const aangepast = await json(`/documenten/${doc.id}/boeking`, "PUT", doc.boeking);
    assert.ok(aangepast.data.signaleringen.some((s: any) => s.code === "TOTAAL"));
    assert.equal((await json(`/documenten/${doc.id}/goedkeuren`, "POST")).status, 409);
  } finally {
    server.close();
    fs.rmSync(map, { recursive: true, force: true });
  }
});

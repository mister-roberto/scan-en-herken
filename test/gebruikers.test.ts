import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hashWachtwoord, klopt, magAdministratie } from "../src/auth.ts";
import { Opslag } from "../src/db.ts";
import { demoExtractor } from "../src/extract.ts";
import { maakApp } from "../src/server.ts";

test("wachtwoorden en toegangsregel", () => {
  const hash = hashWachtwoord("een-lang-wachtwoord");
  assert.equal(klopt("een-lang-wachtwoord", hash), true);
  assert.equal(klopt("een-lang-wachtwoorD", hash), false);
  assert.notEqual(hash, hashWachtwoord("een-lang-wachtwoord"));
  assert.equal(hash.includes("een-lang-wachtwoord"), false);
  assert.equal(magAdministratie({ rol: "beheerder", administraties: [] }, 5), true);
  assert.equal(magAdministratie({ rol: "medewerker", administraties: "alle" }, 5), true);
  assert.equal(magAdministratie({ rol: "medewerker", administraties: [1, 2] }, 2), true);
  assert.equal(magAdministratie({ rol: "medewerker", administraties: [1, 2] }, 5), false);
});

/** Een eenvoudige browser: onthoudt de sessiecookie per gebruiker. */
function sessie(basis: string) {
  let cookie = "";
  return async (pad: string, methode = "GET", body?: unknown, kop: Record<string, string> = {}) => {
    const r = await fetch(`${basis}/api${pad}`, {
      method: methode,
      headers: { ...(body instanceof FormData ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...kop },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    const gezet = r.headers.get("set-cookie");
    if (gezet) cookie = gezet.split(";")[0]!.endsWith("=") ? "" : gezet.split(";")[0]!;
    return { status: r.status, data: (await r.json().catch(() => ({}))) as any, cookie: gezet ?? "" };
  };
}

test("aanmelden, rollen, toegang per administratie en logboek", async () => {
  const map = fs.mkdtempSync(path.join(os.tmpdir(), "scan-"));
  const opslag = new Opslag(map);
  const server = maakApp(opslag, demoExtractor, { demo: true }).listen(0);
  const basis = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const anoniem = sessie(basis);
  const beheerder = sessie(basis);
  const anna = sessie(basis);
  try {
    // Zonder aanmelden is niets van de gegevens bereikbaar; de eerste bezoeker maakt de beheerder aan.
    for (const pad of ["/meta", "/administraties", "/overzicht", "/logboek", "/gebruikers", "/documenten/1", "/documenten/1/bestand"]) {
      assert.equal((await anoniem(pad)).status, 401, pad);
    }
    assert.equal((await anoniem("/auth/ik")).data.setup, true);
    assert.equal((await beheerder("/auth/setup", "POST", { naam: "Roel", email: "Roel@Kantoor.nl", wachtwoord: "kort" })).status, 400);
    const setup = await beheerder("/auth/setup", "POST", { naam: "Roel", email: "Roel@Kantoor.nl", wachtwoord: "beheer-wachtwoord-1" });
    assert.equal(setup.status, 200);
    assert.match(setup.cookie, /HttpOnly; SameSite=Strict/);
    assert.equal(setup.data.rol, "beheerder");
    assert.equal(setup.data.wachtwoordHash, undefined);
    // Een tweede "eerste beheerder" kan niet meer.
    assert.equal((await anoniem("/auth/setup", "POST", { naam: "X", email: "x@y.nl", wachtwoord: "nog-een-wachtwoord" })).status, 403);

    // Twee administraties; medewerker Anna krijgt alleen toegang tot de eerste.
    const a1 = (await beheerder("/administraties", "POST", { naam: "Bakkerij Jansen B.V." })).data.id;
    const a2 = (await beheerder("/administraties", "POST", { naam: "Garage De Wit" })).data.id;
    const nieuw = await beheerder("/gebruikers", "POST", { naam: "Anna", email: "anna@kantoor.nl", rol: "medewerker", administraties: [a1], wachtwoord: "tijdelijk-wachtwoord" });
    assert.equal(nieuw.status, 200);
    assert.equal((await beheerder("/gebruikers", "POST", { naam: "Anna 2", email: "ANNA@kantoor.nl", wachtwoord: "tijdelijk-wachtwoord" })).status, 400);

    // Verkeerd wachtwoord en onbekend account geven dezelfde melding.
    const fout = await anna("/auth/aanmelden", "POST", { email: "anna@kantoor.nl", wachtwoord: "verkeerd-wachtwoord" });
    const onbekend = await anoniem("/auth/aanmelden", "POST", { email: "niemand@kantoor.nl", wachtwoord: "verkeerd-wachtwoord" });
    assert.equal(fout.status, 401);
    assert.equal(fout.data.fout, onbekend.data.fout);

    // Anna moet eerst het tijdelijke wachtwoord wijzigen.
    assert.equal((await anna("/auth/aanmelden", "POST", { email: "Anna@kantoor.nl", wachtwoord: "tijdelijk-wachtwoord" })).status, 200);
    const geblokkeerd = await anna("/administraties");
    assert.equal(geblokkeerd.status, 403);
    assert.equal(geblokkeerd.data.moetWijzigen, true);
    assert.equal((await anna("/auth/wachtwoord", "POST", { huidig: "tijdelijk-wachtwoord", nieuw: "tijdelijk-wachtwoord" })).status, 400);
    assert.equal((await anna("/auth/wachtwoord", "POST", { huidig: "tijdelijk-wachtwoord", nieuw: "eigen-wachtwoord-anna" })).status, 200);

    // Toegang: Anna ziet alleen haar administratie, ook via documenten, relaties en het overzicht.
    assert.deepEqual((await anna("/administraties")).data.map((a: any) => a.id), [a1]);
    assert.equal((await anna(`/administraties/${a1}`)).status, 200);
    assert.equal((await anna(`/administraties/${a2}`)).status, 403);
    assert.equal((await anna(`/administraties/${a2}/documenten`)).status, 403);
    assert.equal((await anna(`/administraties/${a2}/export`, "POST", { formaat: "xml" })).status, 403);
    assert.deepEqual((await anna("/overzicht")).data.map((a: any) => a.naam), ["Bakkerij Jansen B.V."]);
    assert.equal((await beheerder("/overzicht")).data.length, 2);

    const lever = async (wie: ReturnType<typeof sessie>, adminId: number, naam: string) => {
      const f = new FormData();
      f.append("bestanden", new Blob([naam + adminId], { type: "application/pdf" }), naam);
      const [r] = (await wie(`/administraties/${adminId}/documenten`, "POST", f)).data;
      for (let i = 0; i < 60; i++) {
        const d = (await beheerder(`/documenten/${r.id}`)).data;
        if (d.status !== "wachtrij" && d.status !== "bezig") return d;
        await new Promise((x) => setTimeout(x, 200));
      }
      throw new Error("niet uitgelezen");
    };
    const eigen = await lever(anna, a1, "kantoorhandel-de-pen.pdf");
    const vreemd = await lever(beheerder, a2, "restaurant-gouden-lepel.pdf");
    assert.equal((await anna(`/documenten/${eigen.id}`)).status, 200);
    for (const [pad, methode] of [[`/documenten/${vreemd.id}`, "GET"], [`/documenten/${vreemd.id}/bestand`, "GET"], [`/documenten/${vreemd.id}/goedkeuren`, "POST"], [`/documenten/${vreemd.id}`, "DELETE"]] as const) {
      assert.equal((await anna(pad, methode)).status, 403, `${methode} ${pad}`);
    }
    assert.equal((await beheerder(`/documenten/${vreemd.id}/goedkeuren`, "POST")).status, 200);
    const relatieVreemd = (await beheerder(`/administraties/${a2}`)).data.relaties[0];
    assert.equal((await anna(`/relaties/${relatieVreemd.id}`, "PUT", { naam: "Gekaapt" })).status, 403);

    // Alleen de beheerder beheert gebruikers en maakt administraties aan.
    assert.equal((await anna("/gebruikers")).status, 403);
    assert.equal((await anna("/gebruikers", "POST", { naam: "Z", email: "z@kantoor.nl", wachtwoord: "tijdelijk-wachtwoord" })).status, 403);
    assert.equal((await anna("/administraties", "POST", { naam: "Nieuw" })).status, 403);

    // Goedkeuren legt vast wie het deed, bij het document en in het logboek.
    assert.equal((await anna(`/documenten/${eigen.id}/goedkeuren`, "POST")).status, 200);
    const goedgekeurd = (await anna(`/documenten/${eigen.id}`)).data;
    assert.equal(goedgekeurd.goedgekeurdDoor, "Anna");
    assert.deepEqual(goedgekeurd.geschiedenis.map((r: any) => `${r.gebruiker}: ${r.actie}`), ["Anna: Goedgekeurd"]);
    const logAnna = (await anna("/logboek")).data;
    assert.ok(logAnna.some((r: any) => r.actie === "Goedgekeurd" && r.gebruiker === "Anna" && r.administratie === "Bakkerij Jansen B.V."));
    assert.ok(logAnna.every((r: any) => r.adminId === a1), "een medewerker ziet alleen het logboek van eigen administraties");
    const logBeheer = (await beheerder("/logboek")).data.map((r: any) => r.actie);
    for (const actie of ["Eerste beheerder aangemaakt", "Gebruiker toegevoegd", "Aangemeld", "Mislukte aanmelding", "Wachtwoord gewijzigd", "Administratie aangemaakt"]) assert.ok(logBeheer.includes(actie), actie);

    // Een verzoek vanaf een andere website wordt geweigerd, ook met een geldige sessie.
    assert.equal((await beheerder("/administraties", "POST", { naam: "Via andere site" }, { origin: "https://kwaadaardig.example" })).status, 403);

    // De enige beheerder kan niet worden uitgezet; een medewerker wel, en diens sessie vervalt direct.
    const lijst = (await beheerder("/gebruikers")).data;
    const roel = lijst.find((g: any) => g.rol === "beheerder");
    const annaG = lijst.find((g: any) => g.naam === "Anna");
    assert.equal((await beheerder(`/gebruikers/${roel.id}`, "PUT", { actief: false })).status, 400);
    assert.equal((await beheerder(`/gebruikers/${roel.id}`, "PUT", { rol: "medewerker" })).status, 400);
    assert.equal((await beheerder(`/gebruikers/${annaG.id}`, "PUT", { actief: false })).status, 200);
    assert.equal((await anna("/administraties")).status, 401);
    assert.equal((await anna("/auth/aanmelden", "POST", { email: "anna@kantoor.nl", wachtwoord: "eigen-wachtwoord-anna" })).status, 401);

    // Afmelden beëindigt de sessie op de server.
    const oudeCookie = setup.cookie.split(";")[0]!;
    assert.equal((await beheerder("/auth/afmelden", "POST")).status, 200);
    assert.equal((await fetch(`${basis}/api/administraties`, { headers: { cookie: oudeCookie } })).status, 401);

    // Na vijf mislukte pogingen is het account tijdelijk geblokkeerd, ook met het juiste wachtwoord.
    for (let i = 0; i < 5; i++) await anoniem("/auth/aanmelden", "POST", { email: "roel@kantoor.nl", wachtwoord: `fout-wachtwoord-${i}` });
    assert.equal((await anoniem("/auth/aanmelden", "POST", { email: "roel@kantoor.nl", wachtwoord: "beheer-wachtwoord-1" })).status, 429);
  } finally {
    server.close();
    fs.rmSync(map, { recursive: true, force: true });
  }
});

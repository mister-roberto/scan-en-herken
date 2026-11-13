import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BEHANDELINGEN, behandeling, isBehandeling, normaliseerBtwNummer } from "./btw.ts";
import { btwOverzicht } from "./aangifte.ts";
import { isGeldigeDatum, maakBoeking, maakJournaalpost, verschillen, zelfdeNaam, zoekRelatie } from "./boeking.ts";
import { isXml, leesUbl } from "./ubl.ts";
import { NietGevonden, Opslag } from "./db.ts";
import { btwSleutel, controleerExport, exactCsv, exactRegels, exactXml, journaalCsv } from "./exact.ts";
import { MODEL, ONDERSTEUNDE_TYPES, demoExtractor, extraheerMetClaude, vertaalApiFout, type Extractor } from "./extract.ts";
import { heeftFouten, valideer } from "./validatie.ts";
import type { Boeking, Document, Profiel, Relatie, Signalering } from "./types.ts";

const hier = path.dirname(fileURLToPath(import.meta.url));

class Ongeldig extends Error {}

function vandaag(): string {
  return new Date().toISOString().slice(0, 10);
}

export function maakApp(opslag: Opslag, extractor: Extractor, demo = false, wachtwoord = "") {
  const app = express();
  // Met SCAN_WACHTWOORD ingesteld vraagt de browser om een wachtwoord (gebruikersnaam is vrij).
  if (wachtwoord) {
    const verwacht = crypto.createHash("sha256").update(wachtwoord).digest();
    app.use((req, res, next) => {
      const [soort, code] = (req.headers.authorization ?? "").split(" ");
      const gegeven = soort === "Basic" && code ? Buffer.from(code, "base64").toString("utf8").split(":").slice(1).join(":") : "";
      if (crypto.timingSafeEqual(crypto.createHash("sha256").update(gegeven).digest(), verwacht)) return next();
      res.setHeader("WWW-Authenticate", 'Basic realm="Scan & Herken", charset="UTF-8"').status(401).send("Wachtwoord vereist");
    });
  }
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(hier, "..", "public")));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 50 } });

  const id = (v: unknown) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Ongeldig("Ongeldig id");
    return n;
  };

  function isDubbel(doc: Document, b: Boeking): boolean {
    if (!b.factuurnummer.trim()) return false;
    return opslag.documenten(doc.adminId).some(
      (d) =>
        d.id !== doc.id &&
        d.boeking &&
        d.boeking.soort === b.soort &&
        d.boeking.factuurnummer.trim().toLowerCase() === b.factuurnummer.trim().toLowerCase() &&
        zelfdeNaam(d.boeking.relatieNaam, b.relatieNaam),
    );
  }

  function controleer(doc: Document, b: Boeking, extra: Signalering[] = []): Signalering[] {
    const s = valideer(b, doc.extractie, opslag.profiel(doc.adminId), opslag.grootboek(doc.adminId), {
      dubbel: isDubbel(doc, b),
      vandaag: vandaag(),
      ubl: isXml(doc.mime) ? leesUbl(fs.readFileSync(doc.pad, "utf8")) : null,
    });
    return [...s, ...extra];
  }

  const statusNaControle = (s: Signalering[]) => (s.some((x) => x.niveau !== "info") ? "controle" : "gereed");

  // --- Verwerkingswachtrij: documenten worden één voor één op de achtergrond uitgelezen ---
  let bezig = false;
  async function verwerkWachtrij() {
    if (bezig) return;
    bezig = true;
    try {
      for (let doc = opslag.volgendeInWachtrij(); doc; doc = opslag.volgendeInWachtrij()) {
        opslag.werkDocumentBij(doc.id, { status: "bezig", fout: "" });
        try {
          const extractie = await extractor({
            bestand: fs.readFileSync(doc.pad),
            bestandsnaam: doc.bestandsnaam,
            mime: doc.mime,
            feedback: opslag.feedback(doc.adminId),
            aanwijzing: doc.aanwijzing,
            profiel: opslag.profiel(doc.adminId),
            grootboek: opslag.grootboek(doc.adminId),
            relaties: opslag.relaties(doc.adminId),
          });
          // Bij een e-factuur zijn nummer, datum en soort uit het bestand zelf leidend.
          const ubl = isXml(doc.mime) ? leesUbl(fs.readFileSync(doc.pad, "utf8")) : null;
          if (ubl) {
            extractie.factuurnummer = ubl.factuurnummer;
            if (ubl.datum) extractie.factuurdatum = ubl.datum;
            extractie.valuta = ubl.valuta;
            const verkoop = extractie.documentType === "verkoopfactuur" || extractie.documentType === "creditnota_verkoop";
            extractie.documentType = ubl.creditnota ? (verkoop ? "creditnota_verkoop" : "creditnota_inkoop") : verkoop ? "verkoopfactuur" : "inkoopfactuur";
          }
          const { boeking, meldingen } = maakBoeking(extractie, opslag.profiel(doc.adminId), opslag.relaties(doc.adminId), opslag.grootboek(doc.adminId));
          const signaleringen = controleer({ ...doc, extractie }, boeking, meldingen);
          opslag.werkDocumentBij(doc.id, { extractie, boeking, aiVoorstel: boeking, gecorrigeerd: null, signaleringen, status: statusNaControle(signaleringen) });
        } catch (e) {
          console.error(`Document ${doc.id}:`, e);
          opslag.werkDocumentBij(doc.id, { status: "fout", fout: vertaalApiFout(e) });
        }
      }
    } finally {
      bezig = false;
    }
  }

  const uitvoer = (d: Document) => {
    const { pad, hash, aiVoorstel, ...rest } = d;
    const profiel = opslag.profiel(d.adminId);
    return {
      ...rest,
      journaalpost: d.boeking ? maakJournaalpost(d.boeking, profiel) : [],
      correcties: d.boeking && d.aiVoorstel ? verschillen(d.aiVoorstel, d.boeking, opslag.grootboek(d.adminId)) : [],
      feedback: opslag.feedback(d.adminId).filter((f) => f.documentId === d.id),
      exactRegels: d.boeking ? exactRegels(d.boeking, profiel, opslag.btwcodes(d.adminId)) : [],
    };
  };

  // --- Algemeen ---
  app.get("/api/meta", (_req, res) => {
    res.json({ behandelingen: BEHANDELINGEN, model: demo ? "demo (geen AI)" : MODEL, demo });
  });

  // --- Administraties ---
  app.get("/api/administraties", (_req, res) => res.json(opslag.administraties()));
  app.post("/api/administraties", (req, res) => {
    const naam = String(req.body?.naam ?? "").trim();
    if (!naam) throw new Ongeldig("Naam is verplicht");
    res.json({ id: opslag.nieuweAdministratie(naam) });
  });
  app.get("/api/administraties/:id", (req, res) => {
    const a = id(req.params.id);
    res.json({ id: a, profiel: opslag.profiel(a), grootboek: opslag.grootboek(a), btwcodes: opslag.btwcodes(a), relaties: opslag.relaties(a) });
  });
  app.put("/api/administraties/:id/profiel", (req, res) => {
    const a = id(req.params.id);
    const p = { ...opslag.profiel(a), ...(req.body as Partial<Profiel>) };
    if (!p.naam.trim()) throw new Ongeldig("Naam is verplicht");
    if (!["normaal", "kor", "vrijgesteld", "gemengd"].includes(p.btwStatus)) throw new Ongeldig("Ongeldige btw-status");
    p.proRataPercentage = Math.min(100, Math.max(0, Number(p.proRataPercentage) || 0));
    p.relatieStartnummer = Math.max(1, Math.floor(Number(p.relatieStartnummer) || 90001));
    p.btwNummer = normaliseerBtwNummer(p.btwNummer);
    opslag.zetProfiel(a, p);
    res.json(p);
  });
  app.put("/api/administraties/:id/grootboek", (req, res) => {
    const a = id(req.params.id);
    const lijst = (Array.isArray(req.body) ? req.body : [])
      .map((g) => ({ code: String(g.code ?? "").trim(), omschrijving: String(g.omschrijving ?? "").trim() }))
      .filter((g) => g.code);
    if (!lijst.length) throw new Ongeldig("Het rekeningschema mag niet leeg zijn");
    const uniek = [...new Map(lijst.map((g) => [g.code, g])).values()].sort((x, y) => x.code.localeCompare(y.code));
    opslag.zetGrootboek(a, uniek);
    res.json(uniek);
  });
  app.put("/api/administraties/:id/btwcodes", (req, res) => {
    const a = id(req.params.id);
    const codes: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body ?? {})) {
      const [soort, btw] = k.split(":");
      if ((soort === "inkoop" || soort === "verkoop") && isBehandeling(btw) && String(v).trim()) codes[k] = String(v).trim();
    }
    opslag.zetBtwcodes(a, codes);
    res.json(codes);
  });

  // --- Relaties ---
  function relatieUitBody(adminId: number, body: Partial<Relatie>, bestaand?: Relatie): Omit<Relatie, "id"> & { id?: number } {
    const r = {
      id: bestaand?.id,
      adminId,
      soort: body.soort === "debiteur" ? ("debiteur" as const) : ("crediteur" as const),
      code: String(body.code ?? bestaand?.code ?? "").trim(),
      naam: String(body.naam ?? bestaand?.naam ?? "").trim(),
      btwNummer: normaliseerBtwNummer(body.btwNummer ?? bestaand?.btwNummer),
      kvk: String(body.kvk ?? bestaand?.kvk ?? "").trim(),
      iban: String(body.iban ?? bestaand?.iban ?? "").trim(),
      land: String(body.land ?? bestaand?.land ?? "NL").trim().toUpperCase() || "NL",
      standaardGrootboek: String(body.standaardGrootboek ?? bestaand?.standaardGrootboek ?? "").trim(),
      standaardBtw: isBehandeling(body.standaardBtw) ? body.standaardBtw : body.standaardBtw === "" ? ("" as const) : (bestaand?.standaardBtw ?? ("" as const)),
      vast: Boolean(body.vast ?? bestaand?.vast),
      instructie: String(body.instructie ?? bestaand?.instructie ?? "").trim(),
      nieuw: Boolean(body.nieuw ?? bestaand?.nieuw ?? false),
    };
    if (!r.naam) throw new Ongeldig("Naam van de relatie is verplicht");
    return r;
  }
  app.post("/api/administraties/:id/relaties", (req, res) => {
    const a = id(req.params.id);
    opslag.profiel(a);
    res.json(opslag.bewaarRelatie(relatieUitBody(a, req.body ?? {})));
  });
  /** Relaties uit Exact overnemen: regels "code;naam;btw-nummer;soort". */
  app.post("/api/administraties/:id/relaties/import", (req, res) => {
    const a = id(req.params.id);
    const bestaand = opslag.relaties(a);
    let toegevoegd = 0;
    for (const regel of String(req.body?.tekst ?? "").split(/\r?\n/)) {
      const [code, naam, btw, soort] = regel.split(/[;\t]/).map((s) => s?.trim() ?? "");
      if (!code || !naam || /^code$/i.test(code)) continue;
      const s = /^d/i.test(soort ?? "") ? "debiteur" : "crediteur";
      const al = bestaand.find((r) => r.code === code && r.soort === s);
      opslag.bewaarRelatie(relatieUitBody(a, { code, naam, btwNummer: btw, soort: s, nieuw: false }, al));
      toegevoegd++;
    }
    res.json({ toegevoegd });
  });
  app.put("/api/relaties/:id", (req, res) => {
    const r = opslag.relatie(id(req.params.id));
    if (!r) throw new NietGevonden("Relatie niet gevonden");
    res.json(opslag.bewaarRelatie(relatieUitBody(r.adminId, { ...r, ...req.body }, r)));
  });
  app.delete("/api/relaties/:id", (req, res) => {
    opslag.verwijderRelatie(id(req.params.id));
    res.json({ ok: true });
  });

  // --- Documenten ---
  app.get("/api/administraties/:id/documenten", (req, res) => {
    res.json(
      opslag.documenten(id(req.params.id)).map((d) => ({
        id: d.id,
        bestandsnaam: d.bestandsnaam,
        status: d.status,
        fout: d.fout,
        aangemaakt: d.aangemaakt,
        soort: d.boeking?.soort ?? "",
        creditnota: d.boeking?.creditnota ?? false,
        relatieNaam: d.boeking?.relatieNaam ?? "",
        factuurnummer: d.boeking?.factuurnummer ?? "",
        datum: d.boeking?.datum ?? "",
        totaalIncl: d.boeking?.totaalIncl ?? null,
        efactuur: isXml(d.mime),
        fouten: d.signaleringen.filter((s) => s.niveau === "fout").length,
        waarschuwingen: d.signaleringen.filter((s) => s.niveau === "waarschuwing").length,
      })),
    );
  });
  app.post("/api/administraties/:id/documenten", upload.array("bestanden"), (req, res) => {
    const a = id(req.params.id);
    opslag.profiel(a);
    const bestaand = new Set(opslag.documenten(a).map((d) => d.hash));
    const resultaat: { bestandsnaam: string; id?: number; overgeslagen?: string }[] = [];
    for (const f of (req.files as Express.Multer.File[]) ?? []) {
      // Browsers sturen bestandsnamen als latin1; zet terug naar UTF-8.
      const naam = Buffer.from(f.originalname, "latin1").toString("utf8");
      if (!ONDERSTEUNDE_TYPES.includes(f.mimetype)) {
        resultaat.push({ bestandsnaam: naam, overgeslagen: "Bestandstype niet ondersteund (gebruik PDF, JPG, PNG, WEBP of een e-factuur in XML)." });
        continue;
      }
      const hash = crypto.createHash("sha256").update(f.buffer).digest("hex");
      if (bestaand.has(hash)) {
        resultaat.push({ bestandsnaam: naam, overgeslagen: "Dit bestand is al eerder aangeleverd." });
        continue;
      }
      bestaand.add(hash);
      const pad = path.join(opslag.bestandenMap, `${hash}${path.extname(naam).toLowerCase().replace(/[^.a-z0-9]/g, "")}`);
      fs.writeFileSync(pad, f.buffer);
      resultaat.push({ bestandsnaam: naam, id: opslag.nieuwDocument(a, naam, f.mimetype, pad, hash) });
    }
    void verwerkWachtrij();
    res.json(resultaat);
  });
  app.get("/api/documenten/:id", (req, res) => res.json(uitvoer(opslag.document(id(req.params.id)))));
  app.get("/api/documenten/:id/bestand", (req, res) => {
    const d = opslag.document(id(req.params.id));
    // Een e-factuur wordt als platte tekst getoond, zodat de browser de inhoud nooit uitvoert.
    res.type(isXml(d.mime) ? "text/plain; charset=utf-8" : d.mime);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(d.pad);
  });

  function leesBoeking(body: unknown, doc: Document): Boeking {
    const b = body as Partial<Boeking>;
    const centen = (v: unknown) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) throw new Ongeldig("Ongeldig bedrag");
      return n;
    };
    const regels = (Array.isArray(b.regels) ? b.regels : []).map((r) => {
      if (!isBehandeling(r.btw)) throw new Ongeldig("Ongeldige btw-behandeling");
      return {
        omschrijving: String(r.omschrijving ?? "").trim(),
        grootboek: String(r.grootboek ?? "").trim(),
        btw: r.btw,
        categorie: r.categorie ?? "overig",
        bedragExcl: centen(r.bedragExcl),
        // Bij een behandeling zonder btw op de factuur is het btw-bedrag altijd nul.
        btwBedrag: behandeling(r.btw).tarief === null && !behandeling(r.btw).btwInKosten ? 0 : centen(r.btwBedrag),
      };
    });
    const relatieId = b.relatieId ? id(b.relatieId) : null;
    return {
      soort: b.soort === "verkoop" ? "verkoop" : "inkoop",
      creditnota: Boolean(b.creditnota),
      relatieId: relatieId && opslag.relatie(relatieId)?.adminId === doc.adminId ? relatieId : null,
      relatieNaam: String(b.relatieNaam ?? "").trim(),
      relatieBtwNummer: normaliseerBtwNummer(b.relatieBtwNummer),
      relatieLand: String(b.relatieLand ?? "NL").trim().toUpperCase().slice(0, 2) || "NL",
      factuurnummer: String(b.factuurnummer ?? "").trim(),
      datum: String(b.datum ?? "").trim(),
      vervaldatum: String(b.vervaldatum ?? "").trim(),
      omschrijving: String(b.omschrijving ?? "").trim(),
      valuta: String(b.valuta ?? "EUR").trim().toUpperCase() || "EUR",
      totaalIncl: centen(b.totaalIncl),
      betalingskenmerk: String(b.betalingskenmerk ?? "").trim(),
      regels,
    };
  }

  app.put("/api/documenten/:id/boeking", (req, res) => {
    const doc = opslag.document(id(req.params.id));
    if (doc.status === "geexporteerd" || doc.status === "goedgekeurd") throw new Ongeldig("Dit document is al goedgekeurd. Heropen het eerst om het te wijzigen.");
    if (doc.status === "wachtrij" || doc.status === "bezig") throw new Ongeldig("Dit document wordt nog uitgelezen.");
    const boeking = leesBoeking(req.body, doc);
    const signaleringen = controleer(doc, boeking);
    opslag.werkDocumentBij(doc.id, { boeking, signaleringen, status: statusNaControle(signaleringen), fout: "" });
    res.json(uitvoer(opslag.document(doc.id)));
  });

  /** Keurt een document goed. Geeft false terug als er nog fouten in de boeking zitten. */
  function keurGoed(doc: Document): boolean {
    if (!doc.boeking) throw new Ongeldig("Er is nog geen boeking om goed te keuren.");
    if (doc.status === "goedgekeurd" || doc.status === "geexporteerd") throw new Ongeldig("Dit document is al goedgekeurd.");
    const boeking = doc.boeking;
    const signaleringen = controleer(doc, boeking);
    if (heeftFouten(signaleringen)) {
      opslag.werkDocumentBij(doc.id, { signaleringen, status: "controle" });
      return false;
    }
    // Relatie vastleggen en onthouden hoe deze is geboekt, zodat een volgende factuur direct goed gaat.
    const soort = boeking.soort === "inkoop" ? "crediteur" : "debiteur";
    const relaties = opslag.relaties(doc.adminId);
    let relatie =
      relaties.find((r) => r.id === boeking.relatieId) ??
      zoekRelatie({ naam: boeking.relatieNaam, btwNummer: boeking.relatieBtwNummer, adres: null, landcode: null, kvkNummer: null, iban: null }, soort, relaties);
    const grootste = [...boeking.regels].sort((x, y) => Math.abs(y.bedragExcl) - Math.abs(x.bedragExcl))[0]!;
    if (!relatie) {
      const partij = boeking.soort === "inkoop" ? doc.extractie?.afzender : doc.extractie?.afnemer;
      relatie = opslag.bewaarRelatie({
        adminId: doc.adminId,
        soort,
        code: opslag.volgendeRelatiecode(doc.adminId),
        naam: boeking.relatieNaam,
        btwNummer: boeking.relatieBtwNummer,
        kvk: partij?.kvkNummer ?? "",
        iban: partij?.iban ?? "",
        land: boeking.relatieLand,
        standaardGrootboek: grootste.grootboek,
        standaardBtw: grootste.btw,
        vast: false,
        instructie: "",
        nieuw: true,
      });
    } else if (!relatie.vast) {
      relatie = opslag.bewaarRelatie({ ...relatie, standaardGrootboek: grootste.grootboek, standaardBtw: grootste.btw });
    }
    // Correcties op het AI-voorstel worden leerpunten voor volgende documenten van deze relatie.
    const correcties = doc.aiVoorstel ? verschillen(doc.aiVoorstel, boeking, opslag.grootboek(doc.adminId)) : [];
    const bestaand = opslag.feedback(doc.adminId);
    for (const c of correcties.filter((x) => x.soort === "oordeel")) {
      if (bestaand.some((f) => f.tekst === c.tekst && f.relatieNaam === relatie.naam)) continue;
      opslag.bewaarFeedback({ adminId: doc.adminId, documentId: doc.id, bereik: "relatie", relatieNaam: relatie.naam, tekst: c.tekst, bron: "automatisch", actief: true, aangemaakt: new Date().toISOString() });
    }
    opslag.werkDocumentBij(doc.id, { boeking: { ...boeking, relatieId: relatie.id }, signaleringen, status: "goedgekeurd", gecorrigeerd: correcties.length > 0 || doc.aanwijzing !== "", goedgekeurdOp: new Date().toISOString() });
    return true;
  }


  app.post("/api/documenten/:id/goedkeuren", (req, res) => {
    const doc = opslag.document(id(req.params.id));
    if (!keurGoed(doc)) {
      res.status(409).json({ fout: "Los eerst de fouten op voordat u goedkeurt.", document: uitvoer(opslag.document(doc.id)) });
      return;
    }
    res.json(uitvoer(opslag.document(doc.id)));
  });
  /** Keurt in één keer alle documenten goed waarbij geen enkele fout of waarschuwing is gevonden. */
  app.post("/api/administraties/:id/goedkeuren-zonder-signalen", (req, res) => {
    let goedgekeurd = 0;
    // Oudste eerst, zodat een dubbele factuur bij het latere document wordt tegengehouden.
    for (const doc of opslag.documenten(id(req.params.id)).filter((d) => d.status === "gereed").reverse()) {
      const actueel = opslag.document(doc.id);
      if (actueel.boeking && controleer(actueel, actueel.boeking).every((s) => s.niveau === "info") && keurGoed(actueel)) goedgekeurd++;
    }
    res.json({ goedgekeurd });
  });
  app.get("/api/administraties/:id/btw-overzicht", (req, res) => {
    const a = id(req.params.id);
    const van = String(req.query.van ?? "");
    const tot = String(req.query.tot ?? "");
    if (!isGeldigeDatum(van) || !isGeldigeDatum(tot) || van > tot) throw new Ongeldig("Ongeldige periode");
    const inPeriode = opslag.documenten(a).filter((d) => d.boeking && d.boeking.datum >= van && d.boeking.datum <= tot);
    const definitief = inPeriode.filter((d) => d.status === "goedgekeurd" || d.status === "geexporteerd");
    res.json({ ...btwOverzicht(definitief.map((d) => d.boeking!), opslag.profiel(a)), nogNietGoedgekeurd: inPeriode.length - definitief.length });
  });
  app.post("/api/documenten/:id/heropenen", (req, res) => {
    const doc = opslag.document(id(req.params.id));
    if (!doc.boeking) throw new Ongeldig("Geen boeking.");
    const signaleringen = controleer(doc, doc.boeking);
    opslag.werkDocumentBij(doc.id, { signaleringen, status: statusNaControle(signaleringen), geexporteerdOp: "", goedgekeurdOp: "" });
    res.json(uitvoer(opslag.document(doc.id)));
  });
  app.post("/api/documenten/:id/opnieuw", (req, res) => {
    const doc = opslag.document(id(req.params.id));
    if (doc.status === "geexporteerd" || doc.status === "goedgekeurd") throw new Ongeldig("Dit document is al goedgekeurd. Heropen het eerst.");
    opslag.werkDocumentBij(doc.id, { status: "wachtrij", fout: "", aanwijzing: String(req.body?.aanwijzing ?? "").trim() });
    void verwerkWachtrij();
    res.json({ ok: true });
  });
  app.delete("/api/documenten/:id", (req, res) => {
    const doc = opslag.document(id(req.params.id));
    opslag.verwijderDocument(doc.id);
    fs.rmSync(doc.pad, { force: true });
    res.json({ ok: true });
  });

  // --- Feedback: wat de AI van de boekhouder moet leren ---
  app.post("/api/documenten/:id/feedback", (req, res) => {
    const doc = opslag.document(id(req.params.id));
    const tekst = String(req.body?.tekst ?? "").trim();
    if (!tekst) throw new Ongeldig("Schrijf eerst op wat de AI moet leren.");
    const bereik = req.body?.bereik === "administratie" ? "administratie" : "relatie";
    const relatieNaam = doc.boeking?.relatieNaam ?? "";
    if (bereik === "relatie" && !relatieNaam) throw new Ongeldig("Bij dit document is geen relatie bekend; kies 'alle documenten'.");
    res.json(opslag.bewaarFeedback({ adminId: doc.adminId, documentId: doc.id, bereik, relatieNaam: bereik === "relatie" ? relatieNaam : "", tekst, bron: "handmatig", actief: true, aangemaakt: new Date().toISOString() }));
  });
  app.get("/api/administraties/:id/feedback", (req, res) => {
    const a = id(req.params.id);
    const beoordeeld = opslag.documenten(a).filter((d) => d.gecorrigeerd !== null && (d.status === "goedgekeurd" || d.status === "geexporteerd"));
    const zonder = beoordeeld.filter((d) => d.gecorrigeerd === false).length;
    const perRelatie = new Map<string, { naam: string; totaal: number; gecorrigeerd: number }>();
    for (const d of beoordeeld) {
      const naam = d.boeking?.relatieNaam ?? "";
      const r = perRelatie.get(naam) ?? { naam, totaal: 0, gecorrigeerd: 0 };
      r.totaal++;
      if (d.gecorrigeerd) r.gecorrigeerd++;
      perRelatie.set(naam, r);
    }
    res.json({
      feedback: opslag.feedback(a),
      kwaliteit: {
        beoordeeld: beoordeeld.length,
        zonderCorrectie: zonder,
        percentage: beoordeeld.length ? Math.round((zonder / beoordeeld.length) * 100) : null,
        vaakGecorrigeerd: [...perRelatie.values()].filter((r) => r.gecorrigeerd > 0).sort((x, y) => y.gecorrigeerd - x.gecorrigeerd).slice(0, 10),
      },
    });
  });
  app.put("/api/feedback/:id", (req, res) => {
    const f = opslag.feedbackItem(id(req.params.id));
    if (!f) throw new NietGevonden("Feedback niet gevonden");
    const tekst = String(req.body?.tekst ?? f.tekst).trim();
    if (!tekst) throw new Ongeldig("De tekst mag niet leeg zijn.");
    res.json(opslag.bewaarFeedback({ ...f, tekst, actief: Boolean(req.body?.actief ?? f.actief) }));
  });
  app.delete("/api/feedback/:id", (req, res) => {
    opslag.verwijderFeedback(id(req.params.id));
    res.json({ ok: true });
  });

  // --- Export ---
  app.post("/api/administraties/:id/export", (req, res) => {
    const a = id(req.params.id);
    const formaat = String(req.body?.formaat ?? "xml");
    const gekozen: number[] | null = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : null;
    const docs = opslag
      .documenten(a)
      .filter((d) => (gekozen ? gekozen.includes(d.id) && (d.status === "goedgekeurd" || d.status === "geexporteerd") : d.status === "goedgekeurd"))
      .reverse();
    if (!docs.length) throw new Ongeldig("Er zijn geen goedgekeurde documenten om te exporteren.");
    const profiel = opslag.profiel(a);
    const relaties = opslag.relaties(a);
    const codes = opslag.btwcodes(a);
    const stempel = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

    if (formaat === "journaal") {
      res.attachment(`journaalposten-${stempel}.csv`).type("text/csv; charset=utf-8").send(journaalCsv(docs, profiel));
      return;
    }
    const problemen = controleerExport(docs, relaties, codes);
    if (problemen.length) {
      res.status(409).json({ fout: "De export is nog niet compleet.", problemen });
      return;
    }
    if (formaat === "csv") {
      res.attachment(`exact-boekingen-${stempel}.csv`).type("text/csv; charset=utf-8").send(exactCsv(docs, profiel, relaties, codes));
    } else {
      res.attachment(`exact-boekingen-${stempel}.xml`).type("application/xml; charset=utf-8").send(exactXml(docs, profiel, relaties, codes));
      // Meegestuurde relaties bestaan na de import in Exact en worden niet opnieuw aangemaakt.
      for (const d of docs) {
        const r = d.boeking?.relatieId ? opslag.relatie(d.boeking.relatieId) : null;
        if (r?.nieuw) opslag.bewaarRelatie({ ...r, nieuw: false });
      }
    }
    const nu = new Date().toISOString();
    for (const d of docs) opslag.werkDocumentBij(d.id, { status: "geexporteerd", geexporteerdOp: nu });
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof NietGevonden) res.status(404).json({ fout: err.message });
    else if (err instanceof Ongeldig) res.status(400).json({ fout: err.message });
    else if (err instanceof multer.MulterError) res.status(400).json({ fout: err.code === "LIMIT_FILE_SIZE" ? "Bestand is groter dan 30 MB." : err.message });
    else {
      console.error(err);
      res.status(500).json({ fout: "Er ging iets mis op de server." });
    }
  });

  void verwerkWachtrij();
  return app;
}

export { btwSleutel };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.env.SCAN_DEMO === "1";
  const opslag = new Opslag(process.env.SCAN_DATA || path.join(hier, "..", "data"));
  const poort = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "127.0.0.1";
  const wachtwoord = process.env.SCAN_WACHTWOORD || "";
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !wachtwoord) {
    console.error("De server wordt opengezet voor het netwerk (HOST) zonder wachtwoord. Stel SCAN_WACHTWOORD in en start opnieuw.");
    process.exit(1);
  }
  maakApp(opslag, demo ? demoExtractor : extraheerMetClaude, demo, wachtwoord).listen(poort, host, () => {
    console.log(`Scan & Herken draait op http://${host === "0.0.0.0" ? "localhost" : host}:${poort}${demo ? " (demomodus, zonder AI)" : ""}`);
  });
}

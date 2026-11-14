import express from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BEHANDELINGEN, behandeling, isBehandeling, normaliseerBtwNummer } from "./btw.ts";
import { btwOverzicht } from "./aangifte.ts";
import { beoordeelFactuur } from "./factuureisen.ts";
import { isGeldigeDatum, maakBoeking, maakJournaalpost, verschillen, zelfdeNaam, zoekRelatie } from "./boeking.ts";
import { isXml, leesUbl } from "./ubl.ts";
import { NietGevonden, Opslag } from "./db.ts";
import { MIN_WACHTWOORD, geldigEmail, hashWachtwoord, klopt, magAdministratie, nieuwToken, publiek, tokenHash, type Gebruiker } from "./auth.ts";
import { btwSleutel, controleerExport, exactCsv, exactRegels, exactXml, journaalCsv } from "./exact.ts";
import { MODEL, ONDERSTEUNDE_TYPES, demoExtractor, extraheerMetClaude, vertaalApiFout, type Extractor } from "./extract.ts";
import { heeftFouten, valideer } from "./validatie.ts";
import type { Boeking, Document, Profiel, Relatie, Signalering } from "./types.ts";

const hier = path.dirname(fileURLToPath(import.meta.url));

class Ongeldig extends Error {}

function vandaag(): string {
  return new Date().toISOString().slice(0, 10);
}

class Verboden extends Error {}

export interface AppOpties {
  demo?: boolean;
  /** Aanmelden verplicht. Staat alleen uit in geautomatiseerde tests van de boekingslogica. */
  auth?: boolean;
}

const SESSIEDUUR = 12 * 60 * 60 * 1000;
const COOKIE = "scan_sessie";
const SYSTEEM: Gebruiker = { id: 0, naam: "Systeem", email: "", rol: "beheerder", actief: true, administraties: "alle", wachtwoordHash: "", moetWijzigen: false };

/** Welke handelingen in het logboek komen: methode, pad en omschrijving. */
const ACTIES: [string, RegExp, string][] = [
  ["POST", /^\/api\/documenten\/\d+\/goedkeuren$/, "Goedgekeurd"],
  ["POST", /^\/api\/documenten\/\d+\/heropenen$/, "Heropend"],
  ["POST", /^\/api\/documenten\/\d+\/wacht$/, "In de wacht gezet"],
  ["POST", /^\/api\/documenten\/\d+\/opnieuw$/, "Opnieuw laten uitlezen"],
  ["POST", /^\/api\/documenten\/\d+\/splitsen$/, "Gesplitst"],
  ["POST", /^\/api\/documenten\/\d+\/feedback$/, "Feedback gegeven"],
  ["PUT", /^\/api\/documenten\/\d+\/boeking$/, "Boeking gewijzigd"],
  ["PUT", /^\/api\/documenten\/\d+\/notitie$/, "Notitie gewijzigd"],
  ["DELETE", /^\/api\/documenten\/\d+$/, "Document verwijderd"],
  ["POST", /^\/api\/administraties$/, "Administratie aangemaakt"],
  ["POST", /^\/api\/administraties\/\d+\/documenten$/, "Documenten aangeleverd"],
  ["POST", /^\/api\/administraties\/\d+\/export$/, "Exportbestand gemaakt"],
  ["POST", /^\/api\/administraties\/\d+\/goedkeuren-zonder-signalen$/, "In één keer goedgekeurd"],
  ["PUT", /^\/api\/administraties\/\d+\/profiel$/, "Bedrijfsprofiel gewijzigd"],
  ["PUT", /^\/api\/administraties\/\d+\/grootboek$/, "Rekeningschema gewijzigd"],
  ["PUT", /^\/api\/administraties\/\d+\/btwcodes$/, "Btw-codes gewijzigd"],
  ["POST", /^\/api\/administraties\/\d+\/relaties$/, "Relatie toegevoegd"],
  ["POST", /^\/api\/administraties\/\d+\/relaties\/import$/, "Relaties overgenomen"],
  ["PUT", /^\/api\/relaties\/\d+$/, "Relatie gewijzigd"],
  ["DELETE", /^\/api\/relaties\/\d+$/, "Relatie verwijderd"],
  ["PUT", /^\/api\/feedback\/\d+$/, "Leerpunt gewijzigd"],
  ["DELETE", /^\/api\/feedback\/\d+$/, "Leerpunt verwijderd"],
  ["POST", /^\/api\/gebruikers$/, "Gebruiker toegevoegd"],
  ["PUT", /^\/api\/gebruikers\/\d+$/, "Gebruiker gewijzigd"],
];
/** Handelingen die bij elke toetsaanslag terugkomen; hooguit eens per tien minuten vastgelegd. */
const STIL = new Set(["Boeking gewijzigd", "Notitie gewijzigd", "Relatie gewijzigd", "Leerpunt gewijzigd"]);

export function maakApp(opslag: Opslag, extractor: Extractor, opties: AppOpties = {}) {
  const demo = opties.demo ?? false;
  const metAuth = opties.auth ?? true;
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(path.join(hier, "..", "public")));

  // ---------- Aanmelden, sessies en toegang ----------
  type Verzoek = express.Request & { gebruiker?: Gebruiker; sessieHash?: string };
  const wie = (req: express.Request): Gebruiker => (req as Verzoek).gebruiker ?? SYSTEEM;

  function sessieVan(req: express.Request): { gebruiker: Gebruiker; hash: string } | null {
    const token = /(?:^|;\s*)scan_sessie=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (!token) return null;
    const hash = tokenHash(token);
    const sessie = opslag.sessie(hash);
    if (!sessie || sessie.verloopt < Date.now()) return null;
    const gebruiker = opslag.gebruiker(sessie.gebruikerId);
    if (!gebruiker || !gebruiker.actief) return null;
    // De sessie loopt af na twaalf uur zonder activiteit.
    if (sessie.verloopt - Date.now() < SESSIEDUUR - 60_000) opslag.verlengSessie(hash, Date.now() + SESSIEDUUR);
    return { gebruiker, hash };
  }
  function startSessie(req: express.Request, res: express.Response, g: Gebruiker) {
    const token = nieuwToken();
    opslag.nieuweSessie(tokenHash(token), g.id, Date.now() + SESSIEDUUR);
    const veilig = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${veilig ? "; Secure" : ""}`);
  }
  const controleerWachtwoord = (w: unknown): string => {
    if (typeof w !== "string" || w.length < MIN_WACHTWOORD) throw new Ongeldig(`Het wachtwoord moet minstens ${MIN_WACHTWOORD} tekens hebben.`);
    return w;
  };

  // Verzoeken die iets wijzigen moeten van de eigen pagina komen, niet van een andere website.
  app.use("/api", (req, res, next) => {
    const origin = req.headers.origin;
    if (!["GET", "HEAD"].includes(req.method) && origin) {
      let host = "";
      try {
        host = new URL(origin).host;
      } catch {
        /* ongeldige herkomst telt als vreemd */
      }
      if (host !== req.headers.host) {
        res.status(403).json({ fout: "Verzoek van een andere website geweigerd." });
        return;
      }
    }
    next();
  });

  app.get("/api/auth/ik", (req, res) => {
    if (!metAuth) return void res.json({ ...publiek(SYSTEEM), zonderAanmelden: true });
    const s = sessieVan(req);
    if (!s) return void res.status(401).json({ fout: "Niet aangemeld", setup: opslag.gebruikers().length === 0 });
    res.json(publiek(s.gebruiker));
  });
  // Eerste gebruik: zolang er nog geen gebruikers zijn, maakt de eerste bezoeker de beheerder aan.
  app.post("/api/auth/setup", (req, res) => {
    if (opslag.gebruikers().length > 0) throw new Verboden("Er is al een beheerder. Meld u aan.");
    const naam = String(req.body?.naam ?? "").trim();
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!naam) throw new Ongeldig("Vul uw naam in.");
    if (!geldigEmail(email)) throw new Ongeldig("Vul een geldig e-mailadres in.");
    const g = opslag.bewaarGebruiker({ naam, email, rol: "beheerder", actief: true, administraties: "alle", wachtwoordHash: hashWachtwoord(controleerWachtwoord(req.body?.wachtwoord)), moetWijzigen: false });
    opslag.log(g.naam, "Eerste beheerder aangemaakt", null, null, g.email);
    startSessie(req, res, g);
    res.json(publiek(g));
  });
  // Na vijf mislukte pogingen is een account een kwartier geblokkeerd.
  const pogingen = new Map<string, { aantal: number; tot: number }>();
  const LOOS = hashWachtwoord("geen-echt-wachtwoord");
  app.post("/api/auth/aanmelden", (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const wachtwoord = String(req.body?.wachtwoord ?? "");
    const stand = pogingen.get(email);
    if (stand && stand.aantal >= 5 && stand.tot > Date.now()) {
      res.status(429).json({ fout: "Te veel mislukte pogingen. Probeer het over een kwartier opnieuw." });
      return;
    }
    const g = opslag.gebruikers().find((x) => x.email === email && x.actief);
    // Ook bij een onbekend account wordt een wachtwoord nagerekend, zodat de reactietijd niets verraadt.
    const goed = klopt(wachtwoord, g?.wachtwoordHash ?? LOOS) && Boolean(g);
    if (!g || !goed) {
      const aantal = stand && stand.tot > Date.now() ? stand.aantal + 1 : 1;
      pogingen.set(email, { aantal, tot: Date.now() + 15 * 60_000 });
      if (g) opslag.log(g.naam, "Mislukte aanmelding", null, null, "");
      res.status(401).json({ fout: "E-mailadres of wachtwoord is onjuist." });
      return;
    }
    pogingen.delete(email);
    startSessie(req, res, g);
    opslag.log(g.naam, "Aangemeld", null, null, "");
    res.json(publiek(g));
  });
  app.post("/api/auth/afmelden", (req, res) => {
    const s = sessieVan(req);
    if (s) opslag.beeindigSessie(s.hash);
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });
  app.post("/api/auth/wachtwoord", (req, res) => {
    const s = sessieVan(req);
    if (!s) return void res.status(401).json({ fout: "Niet aangemeld" });
    if (!klopt(String(req.body?.huidig ?? ""), s.gebruiker.wachtwoordHash)) throw new Ongeldig("Het huidige wachtwoord is onjuist.");
    const nieuw = controleerWachtwoord(req.body?.nieuw);
    if (nieuw === req.body?.huidig) throw new Ongeldig("Kies een ander wachtwoord dan het huidige.");
    opslag.bewaarGebruiker({ ...s.gebruiker, wachtwoordHash: hashWachtwoord(nieuw), moetWijzigen: false });
    // Andere sessies van deze gebruiker vervallen.
    opslag.beeindigSessiesVan(s.gebruiker.id, s.hash);
    opslag.log(s.gebruiker.naam, "Wachtwoord gewijzigd", null, null, "");
    res.json({ ok: true });
  });

  // Alles hieronder vraagt een aangemelde gebruiker.
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth/") || !metAuth) return next();
    const s = sessieVan(req);
    if (!s) return void res.status(401).json({ fout: "Niet aangemeld", setup: opslag.gebruikers().length === 0 });
    (req as Verzoek).gebruiker = s.gebruiker;
    (req as Verzoek).sessieHash = s.hash;
    if (s.gebruiker.moetWijzigen) return void res.status(403).json({ fout: "Wijzig eerst uw wachtwoord.", moetWijzigen: true });
    next();
  });

  // Logboek: geslaagde wijzigingen worden vastgelegd met de naam van de gebruiker.
  app.use("/api", (req, res, next) => {
    if (req.method === "GET") return next();
    const pad = req.originalUrl.split("?")[0]!;
    res.on("finish", () => {
      if (res.statusCode >= 400 || res.locals.geenLog) return;
      const actie = ACTIES.find(([methode, patroon]) => methode === req.method && patroon.test(pad))?.[2];
      if (!actie) return;
      const naam = wie(req).naam;
      const documentId: number | null = res.locals.documentId ?? null;
      if (STIL.has(actie)) {
        const laatste = opslag.logboek(documentId ? { documentId, limiet: 1 } : { limiet: 1 })[0];
        if (laatste && laatste.actie === actie && laatste.gebruiker === naam && laatste.detail === (res.locals.detail ?? "") && Date.now() - Date.parse(laatste.tijd) < 10 * 60_000) return;
      }
      opslag.log(naam, actie, res.locals.adminId ?? null, documentId, res.locals.detail ?? "");
    });
    next();
  });

  // Toegang per administratie, centraal afgedwongen voor alle paden.
  const weiger = (res: express.Response) => void res.status(403).json({ fout: "U heeft geen toegang tot deze administratie." });
  app.use("/api/administraties/:id", (req, res, next) => {
    const a = Number(req.params.id);
    res.locals.adminId = a;
    if (!magAdministratie(wie(req), a)) return weiger(res);
    next();
  });
  app.use("/api/documenten/:id", (req, res, next) => {
    let doc: Document | null = null;
    try {
      doc = opslag.document(Number(req.params.id));
    } catch {
      return next(); // onbekend document: het pad zelf geeft "niet gevonden"
    }
    res.locals.adminId = doc.adminId;
    res.locals.documentId = doc.id;
    res.locals.detail = doc.bestandsnaam;
    if (!magAdministratie(wie(req), doc.adminId)) return weiger(res);
    next();
  });
  app.use("/api/relaties/:id", (req, res, next) => {
    const r = opslag.relatie(Number(req.params.id));
    if (!r) return next();
    res.locals.adminId = r.adminId;
    res.locals.detail = r.naam;
    if (!magAdministratie(wie(req), r.adminId)) return weiger(res);
    next();
  });
  app.use("/api/feedback/:id", (req, res, next) => {
    const f = opslag.feedbackItem(Number(req.params.id));
    if (!f) return next();
    res.locals.adminId = f.adminId;
    res.locals.documentId = f.documentId;
    if (!magAdministratie(wie(req), f.adminId)) return weiger(res);
    next();
  });
  const alleenBeheerder = (req: express.Request) => {
    if (wie(req).rol !== "beheerder") throw new Verboden("Alleen een beheerder kan dit.");
  };

  // ---------- Gebruikersbeheer (beheerder) ----------
  const leesAdministraties = (v: unknown): "alle" | number[] => (v === "alle" ? "alle" : Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : []);
  app.get("/api/gebruikers", (req, res) => {
    alleenBeheerder(req);
    res.json(opslag.gebruikers().map(publiek));
  });
  app.post("/api/gebruikers", (req, res) => {
    alleenBeheerder(req);
    const naam = String(req.body?.naam ?? "").trim();
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!naam) throw new Ongeldig("Vul een naam in.");
    if (!geldigEmail(email)) throw new Ongeldig("Vul een geldig e-mailadres in.");
    if (opslag.gebruikers().some((g) => g.email === email)) throw new Ongeldig("Er is al een gebruiker met dit e-mailadres.");
    const g = opslag.bewaarGebruiker({
      naam,
      email,
      rol: req.body?.rol === "beheerder" ? "beheerder" : "medewerker",
      actief: true,
      administraties: leesAdministraties(req.body?.administraties),
      wachtwoordHash: hashWachtwoord(controleerWachtwoord(req.body?.wachtwoord)),
      moetWijzigen: true,
    });
    res.locals.detail = `${g.naam} (${g.rol})`;
    res.json(publiek(g));
  });
  app.put("/api/gebruikers/:id", (req, res) => {
    alleenBeheerder(req);
    const g = opslag.gebruiker(id(req.params.id));
    if (!g) throw new NietGevonden("Gebruiker niet gevonden");
    const nieuw: Gebruiker = {
      ...g,
      naam: String(req.body?.naam ?? g.naam).trim() || g.naam,
      rol: req.body?.rol === undefined ? g.rol : req.body.rol === "beheerder" ? "beheerder" : "medewerker",
      actief: req.body?.actief === undefined ? g.actief : Boolean(req.body.actief),
      administraties: req.body?.administraties === undefined ? g.administraties : leesAdministraties(req.body.administraties),
    };
    // Er moet altijd een actieve beheerder overblijven.
    const wasBeheerder = g.rol === "beheerder" && g.actief;
    const blijftBeheerder = nieuw.rol === "beheerder" && nieuw.actief;
    if (wasBeheerder && !blijftBeheerder && !opslag.gebruikers().some((x) => x.id !== g.id && x.rol === "beheerder" && x.actief)) {
      throw new Ongeldig("Dit is de enige actieve beheerder; die kan niet worden uitgezet of medewerker worden.");
    }
    const wijzigingen: string[] = [];
    if (nieuw.rol !== g.rol) wijzigingen.push(`rol ${nieuw.rol}`);
    if (nieuw.actief !== g.actief) wijzigingen.push(nieuw.actief ? "geactiveerd" : "uitgezet");
    if (JSON.stringify(nieuw.administraties) !== JSON.stringify(g.administraties)) wijzigingen.push("toegang gewijzigd");
    if (req.body?.wachtwoord !== undefined) {
      nieuw.wachtwoordHash = hashWachtwoord(controleerWachtwoord(req.body.wachtwoord));
      nieuw.moetWijzigen = true;
      wijzigingen.push("wachtwoord opnieuw ingesteld");
    }
    opslag.bewaarGebruiker(nieuw);
    // Na uitzetten of een nieuw wachtwoord vervallen alle sessies van die gebruiker.
    if (!nieuw.actief || req.body?.wachtwoord !== undefined) opslag.beeindigSessiesVan(g.id);
    res.locals.detail = `${nieuw.naam}${wijzigingen.length ? `: ${wijzigingen.join(", ")}` : ""}`;
    res.json(publiek(nieuw));
  });

  // ---------- Overzicht over alle administraties en logboek ----------
  app.get("/api/overzicht", (req, res) => {
    res.json(
      opslag
        .administraties()
        .filter((a) => magAdministratie(wie(req), a.id))
        .map((a) => {
          const docs = opslag.documenten(a.id);
          const aantal = (...statussen: string[]) => docs.filter((d) => statussen.includes(d.status)).length;
          return { id: a.id, naam: a.naam, open: aantal("controle", "gereed", "fout"), wacht: aantal("wacht"), goedgekeurd: aantal("goedgekeurd"), geexporteerd: aantal("geexporteerd"), bezig: aantal("wachtrij", "bezig"), laatst: docs[0]?.aangemaakt ?? "" };
        }),
    );
  });
  app.get("/api/logboek", (req, res) => {
    const g = wie(req);
    const namen = new Map(opslag.administraties().map((a) => [a.id, a.naam]));
    const eigen = g.rol === "beheerder" ? null : [...namen.keys()].filter((a) => magAdministratie(g, a));
    res.json(opslag.logboek({ adminIds: eigen, limiet: 500 }).map((r) => ({ ...r, administratie: r.adminId ? (namen.get(r.adminId) ?? "") : "" })));
  });
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

  function relatieVan(adminId: number, b: Boeking): Relatie | null {
    const relaties = opslag.relaties(adminId);
    const soort = b.soort === "inkoop" ? "crediteur" : "debiteur";
    return relaties.find((r) => r.id === b.relatieId) ?? zoekRelatie({ naam: b.relatieNaam, btwNummer: b.relatieBtwNummer, adres: null, landcode: null, kvkNummer: null, iban: null }, soort, relaties);
  }
  function controleer(doc: Document, b: Boeking, extra: Signalering[] = []): Signalering[] {
    const s = valideer(b, doc.extractie, opslag.profiel(doc.adminId), opslag.grootboek(doc.adminId), {
      dubbel: isDubbel(doc, b),
      vandaag: vandaag(),
      ubl: isXml(doc.mime) ? leesUbl(fs.readFileSync(doc.pad, "utf8")) : null,
      relatie: relatieVan(doc.adminId, b),
      eerdereBedragen: opslag
        .documenten(doc.adminId)
        .filter((d) => d.id !== doc.id && d.boeking && (d.status === "goedgekeurd" || d.status === "geexporteerd") && d.boeking.soort === b.soort && zelfdeNaam(d.boeking.relatieNaam, b.relatieNaam))
        .map((d) => d.boeking!.totaalIncl),
    });
    return [...s, ...extra];
  }

  const statusNaControle = (s: Signalering[]) => (s.some((x) => x.niveau !== "info") ? "controle" : "gereed");

  /** Neemt een aangeleverd bestand op in de wachtrij. Geeft het documentnummer of de reden van overslaan. */
  function neemOp(adminId: number, naam: string, mime: string, inhoud: Buffer): { id?: number; overgeslagen?: string } {
    if (!ONDERSTEUNDE_TYPES.includes(mime)) return { overgeslagen: "Bestandstype niet ondersteund (gebruik PDF, JPG, PNG, WEBP of een e-factuur in XML)." };
    const hash = crypto.createHash("sha256").update(inhoud).digest("hex");
    if (opslag.documenten(adminId).some((d) => d.hash === hash)) return { overgeslagen: "Dit bestand is al eerder aangeleverd." };
    const pad = path.join(opslag.bestandenMap, `${hash}${path.extname(naam).toLowerCase().replace(/[^.a-z0-9]/g, "")}`);
    fs.writeFileSync(pad, inhoud);
    return { id: opslag.nieuwDocument(adminId, naam, mime, pad, hash) };
  }

  // --- Inleesmap: bestanden die in de map van een administratie worden gezet, komen vanzelf binnen ---
  const TYPE_BIJ_EXTENSIE: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".xml": "text/xml" };
  const inleesmap = (adminId: number) => path.join(opslag.inleesMap, String(adminId));
  function leesInleesmappen(): number {
    let aantal = 0;
    for (const a of opslag.administraties()) {
      const map = inleesmap(a.id);
      fs.mkdirSync(path.join(map, "verwerkt"), { recursive: true });
      for (const naam of fs.readdirSync(map)) {
        const bron = path.join(map, naam);
        const stat = fs.statSync(bron);
        // Even wachten tot een bestand volledig is weggeschreven (scanner, synchronisatie).
        if (!stat.isFile() || naam.startsWith(".") || Date.now() - stat.mtimeMs < 2000) continue;
        const r = neemOp(a.id, naam, TYPE_BIJ_EXTENSIE[path.extname(naam).toLowerCase()] ?? "", fs.readFileSync(bron));
        const doel = path.join(map, r.id ? "verwerkt" : "overgeslagen");
        fs.mkdirSync(doel, { recursive: true });
        fs.renameSync(bron, path.join(doel, `${Date.now()}-${naam}`));
        if (r.id) aantal++;
      }
    }
    if (aantal) void verwerkWachtrij();
    return aantal;
  }

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
          // Vertrouwde relatie: een voorstel zonder fout of waarschuwing wordt direct goedgekeurd.
          const relatie = relatieVan(doc.adminId, boeking);
          if (relatie?.autoAkkoord && extractie.zekerheid === "hoog" && signaleringen.every((x) => x.niveau === "info") && keurGoed(opslag.document(doc.id), "automatisch")) {
            opslag.log("Systeem", "Automatisch goedgekeurd", doc.adminId, doc.id, doc.bestandsnaam);
            opslag.werkDocumentBij(doc.id, { notitie: "Automatisch goedgekeurd: vertrouwde relatie, geen fouten of waarschuwingen." });
          }
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
      factuureisen: d.boeking && d.extractie ? beoordeelFactuur(d.extractie, d.boeking) : null,
      geschiedenis: opslag.logboek({ documentId: d.id, limiet: 50 }),
      exactRegels: d.boeking ? exactRegels(d.boeking, profiel, opslag.btwcodes(d.adminId)) : [],
    };
  };

  // --- Algemeen ---
  app.get("/api/meta", (_req, res) => {
    res.json({ behandelingen: BEHANDELINGEN, model: demo ? "demo (geen AI)" : MODEL, demo });
  });

  // --- Administraties ---
  app.get("/api/administraties", (req, res) => res.json(opslag.administraties().filter((a) => magAdministratie(wie(req), a.id))));
  app.post("/api/administraties", (req, res) => {
    alleenBeheerder(req);
    const naam = String(req.body?.naam ?? "").trim();
    if (!naam) throw new Ongeldig("Naam is verplicht");
    const nieuw = opslag.nieuweAdministratie(naam);
    res.locals.adminId = nieuw;
    res.locals.detail = naam;
    res.json({ id: nieuw });
  });
  app.get("/api/administraties/:id", (req, res) => {
    const a = id(req.params.id);
    fs.mkdirSync(inleesmap(a), { recursive: true });
    res.json({ id: a, profiel: opslag.profiel(a), grootboek: opslag.grootboek(a), btwcodes: opslag.btwcodes(a), relaties: opslag.relaties(a), inleesmap: inleesmap(a) });
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
      autoAkkoord: Boolean(body.autoAkkoord ?? bestaand?.autoAkkoord ?? false),
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
        notitie: d.notitie,
        fouten: d.signaleringen.filter((s) => s.niveau === "fout").length,
        waarschuwingen: d.signaleringen.filter((s) => s.niveau === "waarschuwing").length,
      })),
    );
  });
  app.post("/api/administraties/:id/documenten", upload.array("bestanden"), (req, res) => {
    const a = id(req.params.id);
    opslag.profiel(a);
    const resultaat: { bestandsnaam: string; id?: number; overgeslagen?: string }[] = [];
    for (const f of (req.files as Express.Multer.File[]) ?? []) {
      // Browsers sturen bestandsnamen als latin1; zet terug naar UTF-8.
      const naam = Buffer.from(f.originalname, "latin1").toString("utf8");
      resultaat.push({ bestandsnaam: naam, ...neemOp(a, naam, f.mimetype, f.buffer) });
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
    // Opslaan zonder inhoudelijke wijziging (bv. vlak voor het goedkeuren) hoort niet in het logboek.
    if (JSON.stringify(boeking) === JSON.stringify(doc.boeking)) res.locals.geenLog = true;
    const signaleringen = controleer(doc, boeking);
    opslag.werkDocumentBij(doc.id, { boeking, signaleringen, status: doc.status === "wacht" ? "wacht" : statusNaControle(signaleringen), fout: "" });
    res.json(uitvoer(opslag.document(doc.id)));
  });

  /** Keurt een document goed. Geeft false terug als er nog fouten in de boeking zitten. */
  function keurGoed(doc: Document, door: string): boolean {
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
    } else {
      // Een nog onbekend rekeningnummer wordt vastgelegd; een afwijkend nummer nooit stilzwijgend overschreven.
      const iban = boeking.soort === "inkoop" ? (doc.extractie?.afzender.iban ?? "") : "";
      relatie = opslag.bewaarRelatie({
        ...relatie,
        iban: relatie.iban || iban,
        ...(relatie.vast ? {} : { standaardGrootboek: grootste.grootboek, standaardBtw: grootste.btw }),
      });
    }
    // Correcties op het AI-voorstel worden leerpunten voor volgende documenten van deze relatie.
    const correcties = doc.aiVoorstel ? verschillen(doc.aiVoorstel, boeking, opslag.grootboek(doc.adminId)) : [];
    const bestaand = opslag.feedback(doc.adminId);
    for (const c of correcties.filter((x) => x.soort === "oordeel")) {
      if (bestaand.some((f) => f.tekst === c.tekst && f.relatieNaam === relatie.naam)) continue;
      opslag.bewaarFeedback({ adminId: doc.adminId, documentId: doc.id, bereik: "relatie", relatieNaam: relatie.naam, tekst: c.tekst, bron: "automatisch", actief: true, aangemaakt: new Date().toISOString() });
    }
    opslag.werkDocumentBij(doc.id, { boeking: { ...boeking, relatieId: relatie.id }, signaleringen, status: "goedgekeurd", gecorrigeerd: correcties.length > 0 || doc.aanwijzing !== "", goedgekeurdOp: new Date().toISOString(), goedgekeurdDoor: door });
    return true;
  }


  app.post("/api/documenten/:id/goedkeuren", (req, res) => {
    const doc = opslag.document(id(req.params.id));
    if (!keurGoed(doc, wie(req).naam)) {
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
      if (actueel.boeking && controleer(actueel, actueel.boeking).every((s) => s.niveau === "info") && keurGoed(actueel, wie(req).naam)) {
        goedgekeurd++;
        opslag.log(wie(req).naam, "Goedgekeurd", actueel.adminId, actueel.id, actueel.bestandsnaam);
      }
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
    opslag.werkDocumentBij(doc.id, { signaleringen, status: statusNaControle(signaleringen), geexporteerdOp: "", goedgekeurdOp: "", goedgekeurdDoor: "" });
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

  // --- Opvolging: notitie en in de wacht zetten ---
  app.put("/api/documenten/:id/notitie", (req, res) => {
    const doc = opslag.document(id(req.params.id));
    opslag.werkDocumentBij(doc.id, { notitie: String(req.body?.notitie ?? "").trim().slice(0, 2000) });
    res.json(uitvoer(opslag.document(doc.id)));
  });
  app.post("/api/documenten/:id/wacht", (req, res) => {
    const doc = opslag.document(id(req.params.id));
    if (!doc.boeking) throw new Ongeldig("Dit document heeft nog geen boeking.");
    if (doc.status === "goedgekeurd" || doc.status === "geexporteerd") throw new Ongeldig("Dit document is al goedgekeurd.");
    const notitie = String(req.body?.notitie ?? doc.notitie).trim().slice(0, 2000);
    if (!notitie) throw new Ongeldig("Noteer waarop wordt gewacht, zodat een collega weet waarom dit document openstaat.");
    opslag.werkDocumentBij(doc.id, { status: "wacht", notitie });
    res.json(uitvoer(opslag.document(doc.id)));
  });

  // --- Splitsen van een pdf die meer dan één factuur bevat ---
  app.post("/api/documenten/:id/splitsen", async (req, res) => {
    const doc = opslag.document(id(req.params.id));
    if (doc.mime !== "application/pdf") throw new Ongeldig("Alleen een pdf kan worden gesplitst.");
    if (doc.status === "goedgekeurd" || doc.status === "geexporteerd") throw new Ongeldig("Dit document is al goedgekeurd.");
    const bron = await PDFDocument.load(fs.readFileSync(doc.pad), { ignoreEncryption: true });
    const paginas = bron.getPageCount();
    const delen = String(req.body?.delen ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [van, tot = van] = d.split("-").map((n) => Number(n.trim()));
        if (!Number.isInteger(van) || !Number.isInteger(tot) || van! < 1 || tot! < van! || tot! > paginas) throw new Ongeldig(`Ongeldig paginabereik "${d}". Het bestand heeft ${paginas} pagina's.`);
        return [van!, tot!] as const;
      });
    if (delen.length < 2) throw new Ongeldig("Geef minstens twee delen op, bv. 1-2, 3.");
    const stam = doc.bestandsnaam.replace(/\.pdf$/i, "");
    const nieuw: number[] = [];
    for (const [i, [van, tot]] of delen.entries()) {
      const deel = await PDFDocument.create();
      const indexen = Array.from({ length: tot - van + 1 }, (_, k) => van - 1 + k);
      for (const pagina of await deel.copyPages(bron, indexen)) deel.addPage(pagina);
      const r = neemOp(doc.adminId, `${stam}-deel${i + 1}.pdf`, "application/pdf", Buffer.from(await deel.save()));
      if (r.id) nieuw.push(r.id);
    }
    opslag.verwijderDocument(doc.id);
    fs.rmSync(doc.pad, { force: true });
    void verwerkWachtrij();
    res.json({ documenten: nieuw });
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
    else if (err instanceof Verboden) res.status(403).json({ fout: err.message });
    else if (err instanceof multer.MulterError) res.status(400).json({ fout: err.code === "LIMIT_FILE_SIZE" ? "Bestand is groter dan 30 MB." : err.message });
    else {
      console.error(err);
      res.status(500).json({ fout: "Er ging iets mis op de server." });
    }
  });

  void verwerkWachtrij();
  // De inleesmappen worden regelmatig nagekeken; de timer houdt het programma niet in leven.
  setInterval(() => {
    try {
      leesInleesmappen();
    } catch (e) {
      console.error("Inleesmap:", e);
    }
  }, 10_000).unref();
  app.locals.leesInleesmappen = leesInleesmappen;
  return app;
}

export { btwSleutel };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.env.SCAN_DEMO === "1";
  const opslag = new Opslag(process.env.SCAN_DATA || path.join(hier, "..", "data"));
  const poort = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "127.0.0.1";
  // Eerste beheerder vooraf aanmaken via SCAN_BEHEERDER="e-mailadres:wachtwoord" (nodig bij openzetten voor het netwerk).
  const beheerder = process.env.SCAN_BEHEERDER || "";
  if (opslag.gebruikers().length === 0 && beheerder.includes(":")) {
    const email = beheerder.slice(0, beheerder.indexOf(":")).trim().toLowerCase();
    const wachtwoord = beheerder.slice(beheerder.indexOf(":") + 1);
    if (!geldigEmail(email) || wachtwoord.length < MIN_WACHTWOORD) {
      console.error(`SCAN_BEHEERDER is ongeldig: gebruik "e-mailadres:wachtwoord" met een wachtwoord van minstens ${MIN_WACHTWOORD} tekens.`);
      process.exit(1);
    }
    opslag.bewaarGebruiker({ naam: "Beheerder", email, rol: "beheerder", actief: true, administraties: "alle", wachtwoordHash: hashWachtwoord(wachtwoord), moetWijzigen: true });
    console.log(`Beheerder ${email} aangemaakt; wijzig het wachtwoord bij de eerste aanmelding.`);
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && opslag.gebruikers().length === 0) {
    console.error('De server wordt opengezet voor het netwerk (HOST) terwijl er nog geen beheerder is. Start eerst lokaal om de beheerder aan te maken, of stel SCAN_BEHEERDER="e-mailadres:wachtwoord" in.');
    process.exit(1);
  }
  maakApp(opslag, demo ? demoExtractor : extraheerMetClaude, { demo }).listen(poort, host, () => {
    console.log(`Scan & Herken draait op http://${host === "0.0.0.0" ? "localhost" : host}:${poort}${demo ? " (demomodus, zonder AI)" : ""}`);
  });
}

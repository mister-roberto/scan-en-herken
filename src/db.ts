import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { STANDAARD_GROOTBOEK, standaardProfiel } from "./defaults.ts";
import type { BtwCodes } from "./exact.ts";
import type { Boeking, Document, DocumentStatus, Extractie, Feedback, Grootboekrekening, Profiel, Relatie, Signalering } from "./types.ts";

export class Opslag {
  db: DatabaseSync;
  bestandenMap: string;

  constructor(map: string) {
    map = path.resolve(map);
    this.bestandenMap = path.join(map, "bestanden");
    fs.mkdirSync(this.bestandenMap, { recursive: true });
    this.db = new DatabaseSync(path.join(map, "scan-en-herken.db"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS administraties (
        id INTEGER PRIMARY KEY, profiel TEXT NOT NULL, grootboek TEXT NOT NULL, btwcodes TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relaties (
        id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL, gegevens TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documenten (
        id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL, bestandsnaam TEXT NOT NULL, mime TEXT NOT NULL,
        pad TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, extractie TEXT, boeking TEXT,
        signaleringen TEXT NOT NULL DEFAULT '[]', fout TEXT NOT NULL DEFAULT '',
        aangemaakt TEXT NOT NULL, geexporteerd_op TEXT NOT NULL DEFAULT '');
    `);
    this.db.exec("CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL, gegevens TEXT NOT NULL)");
    // Kolommen die in een latere versie zijn toegevoegd.
    const kolommen = new Set(this.db.prepare("PRAGMA table_info(documenten)").all().map((k) => String(k.name)));
    if (!kolommen.has("ai_voorstel")) this.db.exec("ALTER TABLE documenten ADD COLUMN ai_voorstel TEXT");
    if (!kolommen.has("aanwijzing")) this.db.exec("ALTER TABLE documenten ADD COLUMN aanwijzing TEXT NOT NULL DEFAULT ''");
    if (!kolommen.has("gecorrigeerd")) this.db.exec("ALTER TABLE documenten ADD COLUMN gecorrigeerd INTEGER");
    // Na een herstart staan onderbroken documenten weer in de wachtrij.
    this.db.exec("UPDATE documenten SET status = 'wachtrij' WHERE status = 'bezig'");
  }

  // --- Administraties ---
  administraties(): { id: number; naam: string }[] {
    return this.db
      .prepare("SELECT id, profiel FROM administraties ORDER BY id")
      .all()
      .map((r) => ({ id: Number(r.id), naam: (JSON.parse(String(r.profiel)) as Profiel).naam }));
  }
  nieuweAdministratie(naam: string): number {
    const r = this.db
      .prepare("INSERT INTO administraties (profiel, grootboek, btwcodes) VALUES (?, ?, '{}')")
      .run(JSON.stringify(standaardProfiel(naam)), JSON.stringify(STANDAARD_GROOTBOEK));
    return Number(r.lastInsertRowid);
  }
  private adminVeld(id: number, veld: "profiel" | "grootboek" | "btwcodes"): unknown {
    const r = this.db.prepare(`SELECT ${veld} AS v FROM administraties WHERE id = ?`).get(id);
    if (!r) throw new NietGevonden("Administratie niet gevonden");
    return JSON.parse(String(r.v));
  }
  private zetAdminVeld(id: number, veld: "profiel" | "grootboek" | "btwcodes", waarde: unknown) {
    this.db.prepare(`UPDATE administraties SET ${veld} = ? WHERE id = ?`).run(JSON.stringify(waarde), id);
  }
  profiel(id: number): Profiel {
    return { ...standaardProfiel(""), ...(this.adminVeld(id, "profiel") as Partial<Profiel>) };
  }
  zetProfiel(id: number, p: Profiel) {
    this.zetAdminVeld(id, "profiel", p);
  }
  grootboek(id: number): Grootboekrekening[] {
    return this.adminVeld(id, "grootboek") as Grootboekrekening[];
  }
  zetGrootboek(id: number, g: Grootboekrekening[]) {
    this.zetAdminVeld(id, "grootboek", g);
  }
  btwcodes(id: number): BtwCodes {
    return this.adminVeld(id, "btwcodes") as BtwCodes;
  }
  zetBtwcodes(id: number, c: BtwCodes) {
    this.zetAdminVeld(id, "btwcodes", c);
  }

  // --- Relaties ---
  relaties(adminId: number): Relatie[] {
    return this.db
      .prepare("SELECT id, gegevens FROM relaties WHERE admin_id = ? ORDER BY id")
      .all(adminId)
      .map((r) => ({ ...(JSON.parse(String(r.gegevens)) as Relatie), id: Number(r.id), adminId }));
  }
  relatie(id: number): Relatie | null {
    const r = this.db.prepare("SELECT id, admin_id, gegevens FROM relaties WHERE id = ?").get(id);
    return r ? { ...(JSON.parse(String(r.gegevens)) as Relatie), id: Number(r.id), adminId: Number(r.admin_id) } : null;
  }
  bewaarRelatie(r: Omit<Relatie, "id"> & { id?: number }): Relatie {
    const { id, ...gegevens } = r;
    if (id) {
      this.db.prepare("UPDATE relaties SET gegevens = ? WHERE id = ?").run(JSON.stringify(gegevens), id);
      return { ...gegevens, id };
    }
    const res = this.db.prepare("INSERT INTO relaties (admin_id, gegevens) VALUES (?, ?)").run(r.adminId, JSON.stringify(gegevens));
    return { ...gegevens, id: Number(res.lastInsertRowid) };
  }
  verwijderRelatie(id: number) {
    this.db.prepare("DELETE FROM relaties WHERE id = ?").run(id);
  }
  volgendeRelatiecode(adminId: number): string {
    const start = this.profiel(adminId).relatieStartnummer;
    const gebruikt = this.relaties(adminId).map((r) => Number(r.code)).filter((n) => Number.isInteger(n) && n >= start);
    return String(gebruikt.length ? Math.max(...gebruikt) + 1 : start);
  }

  // --- Documenten ---
  private rij(r: Record<string, unknown>): Document {
    return {
      id: Number(r.id),
      adminId: Number(r.admin_id),
      bestandsnaam: String(r.bestandsnaam),
      mime: String(r.mime),
      pad: String(r.pad),
      hash: String(r.hash),
      status: String(r.status) as DocumentStatus,
      extractie: r.extractie ? (JSON.parse(String(r.extractie)) as Extractie) : null,
      boeking: r.boeking ? (JSON.parse(String(r.boeking)) as Boeking) : null,
      signaleringen: JSON.parse(String(r.signaleringen)) as Signalering[],
      fout: String(r.fout),
      aangemaakt: String(r.aangemaakt),
      geexporteerdOp: String(r.geexporteerd_op),
      aiVoorstel: r.ai_voorstel ? (JSON.parse(String(r.ai_voorstel)) as Boeking) : null,
      aanwijzing: String(r.aanwijzing ?? ""),
      gecorrigeerd: r.gecorrigeerd == null ? null : Boolean(r.gecorrigeerd),
    };
  }
  documenten(adminId: number): Document[] {
    return this.db.prepare("SELECT * FROM documenten WHERE admin_id = ? ORDER BY id DESC").all(adminId).map((r) => this.rij(r));
  }
  document(id: number): Document {
    const r = this.db.prepare("SELECT * FROM documenten WHERE id = ?").get(id);
    if (!r) throw new NietGevonden("Document niet gevonden");
    return this.rij(r);
  }
  nieuwDocument(adminId: number, bestandsnaam: string, mime: string, pad: string, hash: string): number {
    const r = this.db
      .prepare("INSERT INTO documenten (admin_id, bestandsnaam, mime, pad, hash, status, aangemaakt) VALUES (?, ?, ?, ?, ?, 'wachtrij', ?)")
      .run(adminId, bestandsnaam, mime, pad, hash, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }
  werkDocumentBij(id: number, velden: Partial<Pick<Document, "status" | "extractie" | "boeking" | "signaleringen" | "fout" | "geexporteerdOp" | "aiVoorstel" | "aanwijzing" | "gecorrigeerd">>) {
    const kolommen: Record<string, string> = { geexporteerdOp: "geexporteerd_op", aiVoorstel: "ai_voorstel" };
    for (const [k, v] of Object.entries(velden)) {
      const waarde = v !== null && typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? Number(v) : (v as string | null);
      this.db.prepare(`UPDATE documenten SET ${kolommen[k] ?? k} = ? WHERE id = ?`).run(waarde, id);
    }
  }
  verwijderDocument(id: number) {
    this.db.prepare("DELETE FROM documenten WHERE id = ?").run(id);
  }
  // --- Feedback ---
  feedback(adminId: number): Feedback[] {
    return this.db
      .prepare("SELECT id, gegevens FROM feedback WHERE admin_id = ? ORDER BY id DESC")
      .all(adminId)
      .map((r) => ({ ...(JSON.parse(String(r.gegevens)) as Feedback), id: Number(r.id), adminId }));
  }
  feedbackItem(id: number): Feedback | null {
    const r = this.db.prepare("SELECT id, admin_id, gegevens FROM feedback WHERE id = ?").get(id);
    return r ? { ...(JSON.parse(String(r.gegevens)) as Feedback), id: Number(r.id), adminId: Number(r.admin_id) } : null;
  }
  bewaarFeedback(f: Omit<Feedback, "id"> & { id?: number }): Feedback {
    const { id, ...gegevens } = f;
    if (id) {
      this.db.prepare("UPDATE feedback SET gegevens = ? WHERE id = ?").run(JSON.stringify(gegevens), id);
      return { ...gegevens, id };
    }
    const res = this.db.prepare("INSERT INTO feedback (admin_id, gegevens) VALUES (?, ?)").run(f.adminId, JSON.stringify(gegevens));
    return { ...gegevens, id: Number(res.lastInsertRowid) };
  }
  verwijderFeedback(id: number) {
    this.db.prepare("DELETE FROM feedback WHERE id = ?").run(id);
  }

  volgendeInWachtrij(): Document | null {
    const r = this.db.prepare("SELECT * FROM documenten WHERE status = 'wachtrij' ORDER BY id LIMIT 1").get();
    return r ? this.rij(r) : null;
  }
}

export class NietGevonden extends Error {}

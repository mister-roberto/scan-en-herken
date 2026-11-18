// Gebruikers, wachtwoorden en sessies voor medewerkers.

import crypto from "node:crypto";

export type Rol = "beheerder" | "medewerker";

export interface Gebruiker {
  id: number;
  naam: string;
  /** Inlognaam; altijd in kleine letters. */
  email: string;
  rol: Rol;
  actief: boolean;
  /** Administraties waar een medewerker bij mag; een beheerder mag altijd overal bij. */
  administraties: "alle" | number[];
  wachtwoordHash: string;
  /** Het wachtwoord is door een beheerder ingesteld en moet bij de eerste aanmelding worden gewijzigd. */
  moetWijzigen: boolean;
}

export type PubliekeGebruiker = Omit<Gebruiker, "wachtwoordHash">;

export function publiek(g: Gebruiker): PubliekeGebruiker {
  const { wachtwoordHash, ...rest } = g;
  return rest;
}

export const MIN_WACHTWOORD = 10;

export function hashWachtwoord(wachtwoord: string): string {
  const zout = crypto.randomBytes(16);
  return `scrypt$${zout.toString("hex")}$${crypto.scryptSync(wachtwoord, zout, 64).toString("hex")}`;
}

export function klopt(wachtwoord: string, opgeslagen: string): boolean {
  const [soort, zout, hash] = opgeslagen.split("$");
  if (soort !== "scrypt" || !zout || !hash) return false;
  const verwacht = Buffer.from(hash, "hex");
  const gegeven = crypto.scryptSync(wachtwoord, Buffer.from(zout, "hex"), verwacht.length);
  return crypto.timingSafeEqual(gegeven, verwacht);
}

export function nieuwToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Alleen de hash van een sessietoken wordt bewaard, zodat een gelekte database geen sessies oplevert. */
export function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function magAdministratie(g: Pick<Gebruiker, "rol" | "administraties">, adminId: number): boolean {
  return g.rol === "beheerder" || g.administraties === "alle" || g.administraties.includes(adminId);
}

export function geldigEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

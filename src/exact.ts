// Export naar Exact Online: XML (Import/Export > XML > Importeren) en CSV.
//
// Bedragen in het Exact-XML zijn debet-positief: kosten op een inkoopfactuur
// positief, omzet op een verkoopfactuur negatief. Exact berekent de btw en de
// crediteuren-/debiteurenregel zelf uit de btw-code en het dagboek.

import { behandeling } from "./btw.ts";
import { maakJournaalpost, werkRegelUit } from "./boeking.ts";
import type { Boeking, BtwBehandeling, Document, Profiel, Relatie } from "./types.ts";

/** Sleutel "inkoop:NL_HOOG" → btw-code in Exact. */
export type BtwCodes = Record<string, string>;

export function btwSleutel(soort: Boeking["soort"], btw: BtwBehandeling): string {
  return `${soort}:${btw}`;
}

export interface ExactRegel {
  grootboek: string;
  omschrijving: string;
  /** Centen, debet-positief. */
  bedrag: number;
  btwCode: string;
  btwBedrag: number;
}

export function exactRegels(b: Boeking, profiel: Profiel, codes: BtwCodes): ExactRegel[] {
  const teken = (b.soort === "inkoop" ? 1 : -1) * (b.creditnota ? -1 : 1);
  return b.regels.map((r) => {
    const info = behandeling(r.btw);
    // Niet-aftrekbare btw gaat mee in het kostenbedrag; de btw-code is dan een code zonder btw.
    const bedrag = info.btwInKosten ? werkRegelUit(r, b.soort, profiel).grondslag : r.bedragExcl;
    return {
      grootboek: r.grootboek,
      omschrijving: r.omschrijving,
      bedrag: teken * bedrag,
      btwCode: codes[btwSleutel(b.soort, r.btw)] ?? "",
      btwBedrag: info.btwInKosten ? 0 : teken * r.btwBedrag,
    };
  });
}

export interface ExportProbleem {
  documentId: number;
  tekst: string;
}

/** Controleert of alles aanwezig is wat Exact nodig heeft. */
export function controleerExport(docs: Document[], relaties: Relatie[], codes: BtwCodes): ExportProbleem[] {
  const problemen: ExportProbleem[] = [];
  const relatieIndex = new Map(relaties.map((r) => [r.id, r]));
  for (const d of docs) {
    const b = d.boeking;
    if (!b) {
      problemen.push({ documentId: d.id, tekst: "Geen boeking." });
      continue;
    }
    const relatie = b.relatieId ? relatieIndex.get(b.relatieId) : undefined;
    if (!relatie?.code) problemen.push({ documentId: d.id, tekst: `Relatie "${b.relatieNaam}" heeft geen relatiecode.` });
    for (const btw of new Set(b.regels.map((r) => r.btw))) {
      if (!codes[btwSleutel(b.soort, btw)]) {
        problemen.push({ documentId: d.id, tekst: `Geen Exact-btw-code ingesteld voor ${b.soort} "${behandeling(btw).label}".` });
      }
    }
  }
  return problemen;
}

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const bedragTekst = (c: number) => (c / 100).toFixed(2);

export function exactXml(docs: Document[], profiel: Profiel, relaties: Relatie[], codes: BtwCodes): string {
  const relatieIndex = new Map(relaties.map((r) => [r.id, r]));
  const uit: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<eExact xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="eExact-XML.xsd">',
  ];

  // Alleen relaties die dit programma heeft aangemaakt worden meegestuurd, zodat
  // bestaande relaties in Exact nooit worden overschreven.
  const nieuw = new Map<number, Relatie>();
  for (const d of docs) {
    const r = d.boeking?.relatieId ? relatieIndex.get(d.boeking.relatieId) : undefined;
    if (r?.nieuw) nieuw.set(r.id, r);
  }
  if (nieuw.size) {
    uit.push("  <Accounts>");
    for (const r of nieuw.values()) {
      uit.push(`    <Account code="${x(r.code)}" status="C">`);
      uit.push(`      <Name>${x(r.naam)}</Name>`);
      if (r.soort === "crediteur") uit.push("      <IsSupplier>true</IsSupplier>");
      if (r.btwNummer) uit.push(`      <VATNumber>${x(r.btwNummer)}</VATNumber>`);
      if (r.kvk) uit.push(`      <ChamberOfCommerce>${x(r.kvk)}</ChamberOfCommerce>`);
      if (r.land) uit.push(`      <Address type="V"><Country code="${x(r.land)}"/></Address>`);
      uit.push("    </Account>");
    }
    uit.push("  </Accounts>");
  }

  uit.push("  <GLTransactions>");
  for (const d of docs) {
    const b = d.boeking!;
    const relatie = relatieIndex.get(b.relatieId!)!;
    // 20 = verkoopboeking, 21 = verkoopcreditnota, 30 = inkoopboeking, 31 = inkoopcreditnota
    const type = (b.soort === "inkoop" ? 30 : 20) + (b.creditnota ? 1 : 0);
    const dagboek = b.soort === "inkoop" ? profiel.dagboekInkoop : profiel.dagboekVerkoop;
    uit.push("    <GLTransaction>");
    uit.push(`      <TransactionType number="${type}"/>`);
    uit.push(`      <Journal code="${x(dagboek)}" type="${b.soort === "inkoop" ? 22 : 20}"/>`);
    exactRegels(b, profiel, codes).forEach((r, i) => {
      uit.push(`      <GLTransactionLine type="${type}" linetype="0" line="${i + 1}">`);
      uit.push(`        <Date>${b.datum}</Date>`);
      uit.push(`        <GLAccount code="${x(r.grootboek)}"/>`);
      uit.push(`        <Description>${x((b.omschrijving || r.omschrijving).slice(0, 60))}</Description>`);
      uit.push(`        <Account code="${x(relatie.code)}"/>`);
      uit.push("        <Amount>");
      uit.push(`          <Currency code="${x(b.valuta)}"/>`);
      uit.push(`          <Value>${bedragTekst(r.bedrag)}</Value>`);
      uit.push(`          <VAT code="${x(r.btwCode)}"/>`);
      uit.push("        </Amount>");
      if (b.factuurnummer) {
        uit.push(`        <References><YourRef>${x(b.factuurnummer.slice(0, 30))}</YourRef></References>`);
      }
      uit.push("      </GLTransactionLine>");
    });
    uit.push("    </GLTransaction>");
  }
  uit.push("  </GLTransactions>", "</eExact>", "");
  return uit.join("\n");
}

const csvVeld = (v: string | number) => {
  const s = String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvBedrag = (c: number) => (c / 100).toFixed(2).replace(".", ",");

/** Eén rij per boekingsregel; geschikt voor de CSV-import van Exact met een eigen importdefinitie. */
export function exactCsv(docs: Document[], profiel: Profiel, relaties: Relatie[], codes: BtwCodes): string {
  const relatieIndex = new Map(relaties.map((r) => [r.id, r]));
  const rijen: (string | number)[][] = [
    ["Dagboek", "Boekstuk", "Soort", "Datum", "Vervaldatum", "Relatiecode", "Relatienaam", "Factuurnummer", "Omschrijving", "Grootboek", "Bedrag", "BtwCode", "BtwBedrag", "Valuta", "Betalingskenmerk", "Bestand"],
  ];
  for (const d of docs) {
    const b = d.boeking!;
    const relatie = b.relatieId ? relatieIndex.get(b.relatieId) : undefined;
    for (const r of exactRegels(b, profiel, codes)) {
      rijen.push([
        b.soort === "inkoop" ? profiel.dagboekInkoop : profiel.dagboekVerkoop,
        d.id,
        `${b.soort}${b.creditnota ? "creditnota" : "factuur"}`,
        b.datum,
        b.vervaldatum,
        relatie?.code ?? "",
        b.relatieNaam,
        b.factuurnummer,
        r.omschrijving,
        r.grootboek,
        csvBedrag(r.bedrag),
        r.btwCode,
        csvBedrag(r.btwBedrag),
        b.valuta,
        b.betalingskenmerk,
        d.bestandsnaam,
      ]);
    }
  }
  return "﻿" + rijen.map((r) => r.map(csvVeld).join(";")).join("\r\n") + "\r\n";
}

/** Volledige journaalposten (debet/credit), los van Exact: voor controle of andere pakketten. */
export function journaalCsv(docs: Document[], profiel: Profiel): string {
  const rijen: (string | number)[][] = [["Boekstuk", "Datum", "Relatie", "Factuurnummer", "Rekening", "Omschrijving", "Debet", "Credit"]];
  for (const d of docs) {
    const b = d.boeking!;
    for (const j of maakJournaalpost(b, profiel)) {
      rijen.push([d.id, b.datum, b.relatieNaam, b.factuurnummer, j.rekening, j.omschrijving, csvBedrag(j.debet), csvBedrag(j.credit)]);
    }
  }
  return "﻿" + rijen.map((r) => r.map(csvVeld).join(";")).join("\r\n") + "\r\n";
}

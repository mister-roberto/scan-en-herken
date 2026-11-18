// E-facturen (UBL 2.1, zoals SI-UBL en Peppol BIS). De kerngegevens staan
// gestructureerd in het bestand en worden rechtstreeks gelezen, zodat de
// boeking daartegen kan worden gecontroleerd. De AI kiest alleen nog de
// grootboekrekening en de btw-behandeling.

export interface UblKern {
  creditnota: boolean;
  factuurnummer: string;
  datum: string;
  valuta: string;
  /** Centen. */
  totaalIncl: number;
  /** Centen. */
  totaalBtw: number;
}

const tag = (naam: string) => new RegExp(`<(?:[\\w.-]+:)?${naam}\\b[^>]*>([^<]*)</(?:[\\w.-]+:)?${naam}>`);
const blok = (xml: string, naam: string) => new RegExp(`<(?:[\\w.-]+:)?${naam}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${naam}>`).exec(xml)?.[1] ?? "";
const centen = (s: string | undefined) => (s && Number.isFinite(Number(s)) ? Math.round(Number(s) * 100) : NaN);

export function isXml(mime: string): boolean {
  return mime === "text/xml" || mime === "application/xml";
}

/** Geeft de kerngegevens van een UBL-factuur of -creditnota, of null als het geen UBL is. */
export function leesUbl(xml: string): UblKern | null {
  const wortel = /<(?:[\w.-]+:)?(Invoice|CreditNote)\b/.exec(xml)?.[1];
  if (!wortel) return null;
  // Regels en partijen hebben eigen ID's; de kop staat vóór de eerste partij.
  const kop = xml.split(/<(?:[\w.-]+:)?AccountingSupplierParty\b/)[0] ?? xml;
  const totalen = blok(xml, "LegalMonetaryTotal");
  const totaalIncl = centen(tag("PayableAmount").exec(totalen)?.[1] ?? tag("TaxInclusiveAmount").exec(totalen)?.[1]);
  // Het btw-totaal op factuurniveau staat buiten de factuurregels.
  const zonderRegels = xml.replace(/<(?:[\w.-]+:)?(InvoiceLine|CreditNoteLine)\b[\s\S]*?<\/(?:[\w.-]+:)?\1>/g, "");
  const totaalBtw = centen(tag("TaxAmount").exec(blok(zonderRegels, "TaxTotal"))?.[1]);
  const factuurnummer = tag("ID").exec(kop)?.[1]?.trim() ?? "";
  const datum = tag("IssueDate").exec(kop)?.[1]?.trim() ?? "";
  if (!factuurnummer || Number.isNaN(totaalIncl)) return null;
  return {
    creditnota: wortel === "CreditNote",
    factuurnummer,
    datum,
    valuta: tag("DocumentCurrencyCode").exec(kop)?.[1]?.trim() || "EUR",
    totaalIncl,
    totaalBtw: Number.isNaN(totaalBtw) ? 0 : totaalBtw,
  };
}

/** Een meegestuurde pdf (base64) is voor het uitlezen niet nodig en maakt het bestand onnodig groot. */
export function zonderBijlagen(xml: string): string {
  return xml.replace(/(<(?:[\w.-]+:)?EmbeddedDocumentBinaryObject\b[^>]*>)[\s\S]*?(<\/(?:[\w.-]+:)?EmbeddedDocumentBinaryObject>)/g, "$1[bijlage weggelaten]$2");
}

// Scan & Herken - schermlogica (zonder framework).

const $ = (s) => document.querySelector(s);
const inhoud = $("#inhoud");

/** Bouwt een DOM-element: h("div", {class: "x", onclick: f}, kind1, "tekst") */
function h(tag, attrs = {}, ...kinderen) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  vulAan(el, kinderen);
  return el;
}
function vulAan(el, kinderen) {
  for (const k of kinderen.flat(Infinity)) if (k != null && k !== false) el.append(k);
}
/** Vervangt de inhoud van een element; lege waarden worden overgeslagen. */
function vul(el, ...kinderen) {
  el.replaceChildren();
  vulAan(el, kinderen);
}

let lopend = 0;
let laderTimer;
// De voortgangsbalk verschijnt alleen als een verzoek merkbaar lang duurt.
const lader = (d) => {
  lopend += d;
  clearTimeout(laderTimer);
  if (lopend > 0) laderTimer = setTimeout(() => $("#lader").classList.add("bezig"), 250);
  else $("#lader").classList.remove("bezig");
};
async function api(pad, methode = "GET", body) {
  lader(1);
  const r = await fetch("/api" + pad, {
    method: methode,
    headers: body instanceof FormData || body === undefined ? {} : { "content-type": "application/json" },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  }).finally(() => lader(-1));
  const data = await r.json().catch(() => ({}));
  // Sessie verlopen of nog niet aangemeld: terug naar het aanmeldscherm.
  if (r.status === 401 && !pad.startsWith("/auth/")) toonAanmelden(data.setup ? "setup" : "aanmelden");
  if (r.status === 403 && data.moetWijzigen) toonAanmelden("wijzigen");
  if (!r.ok) throw Object.assign(new Error(data.fout || `Fout ${r.status}`), { data, status: r.status });
  return data;
}

let meldingTimer;
function meld(tekst, fout = false) {
  const m = $("#melding");
  m.textContent = tekst;
  m.className = fout ? "fout" : "";
  m.hidden = false;
  clearTimeout(meldingTimer);
  meldingTimer = setTimeout(() => (m.hidden = true), fout ? 6000 : 2500);
}
const probeer = (f) => async (...a) => {
  try {
    return await f(...a);
  } catch (e) {
    meld(e.message, true);
  }
};

const euro = (c) => (c == null ? "" : (c / 100).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
/** "1.234,56" of "1234.56" → centen */
function centen(tekst) {
  let s = String(tekst).trim().replace(/[€\s]/g, "");
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  // "1.234" zonder komma is in Nederlandse notatie een duizendtal, geen € 1,23.
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const STATUS = { wachtrij: "In wachtrij", bezig: "Wordt uitgelezen…", controle: "Controleren", gereed: "Klaar voor akkoord", wacht: "In de wacht", goedgekeurd: "Goedgekeurd", geexporteerd: "Geëxporteerd", fout: "Mislukt" };
const chip = (status) => h("span", { class: `chip ${status}` }, STATUS[status] ?? status);

// ---------- Toestand ----------
let meta = { behandelingen: [], model: "" };
let adminId = Number(localStorage.getItem("adminId")) || null;
let admin = null; // { profiel, grootboek, btwcodes, relaties }
let verversTimer;

async function laadAdmins() {
  const lijst = await api("/administraties");
  const keuze = $("#adminKeuze");
  vul(keuze, ...lijst.map((a) => h("option", { value: a.id }, a.naam)));
  if (!lijst.some((a) => a.id === adminId)) adminId = lijst[0]?.id ?? null;
  if (adminId) keuze.value = adminId;
  return lijst;
}
async function laadAdmin() {
  admin = adminId ? await api(`/administraties/${adminId}`) : null;
}

$("#adminKeuze").addEventListener("change", async (e) => {
  adminId = Number(e.target.value);
  localStorage.setItem("adminId", adminId);
  await laadAdmin();
  location.hash = "#/start";
  toon();
});
$("#nieuweAdmin").addEventListener(
  "click",
  probeer(async () => {
    const naam = prompt("Naam van de nieuwe administratie (bedrijfsnaam):");
    if (!naam?.trim()) return;
    const r = await api("/administraties", "POST", { naam });
    adminId = r.id;
    localStorage.setItem("adminId", adminId);
    await laadAdmins();
    await laadAdmin();
    location.hash = "#/profiel";
    toon();
  }),
);

// ---------- Routering ----------
const paginas = { overzicht: paginaOverzicht, gebruikers: paginaGebruikers, logboek: paginaLogboek, account: paginaAccount, start: paginaStart, documenten: paginaDocumenten, document: paginaDocument, feedback: paginaFeedback, btw: paginaBtw, export: paginaExport, profiel: paginaProfiel, grootboek: paginaGrootboek, btwcodes: paginaBtwcodes, relaties: paginaRelaties };

let vorigeRoute = "";
/** Niet-opgeslagen wijzigingen op een instellingenpagina. */
let onopgeslagen = false;
let vasteHash = location.hash;
async function werkTellerBij() {
  if (!adminId) return;
  const n = (await api(`/administraties/${adminId}/documenten`)).filter((d) => ["controle", "gereed", "fout"].includes(d.status)).length;
  const t = $("#teller");
  t.textContent = n;
  t.hidden = n === 0;
}
async function toon() {
  clearTimeout(verversTimer);
  const [, naam = "start", arg] = location.hash.split("/");
  if (location.hash !== vorigeRoute) {
    vorigeRoute = location.hash;
    inhoud.classList.add("wissel");
    setTimeout(() => inhoud.classList.remove("wissel"), 250);
    window.scrollTo(0, 0);
  }
  werkTellerBij().catch(() => {});
  document.querySelectorAll("#menu a").forEach((a) => a.classList.toggle("actief", a.getAttribute("href") === `#/${naam === "document" ? "documenten" : naam}`));
  // Pagina's van het kantoor werken ook zonder gekozen administratie.
  const kantoor = ["overzicht", "gebruikers", "logboek", "account"].includes(naam);
  if (!adminId && !kantoor) {
    vul(
      inhoud,
      ik?.rol === "beheerder"
        ? h("div", { class: "kaart leeg" }, h("h1", {}, "Welkom bij Scan & Herken"), h("p", {}, "Maak eerst een administratie aan voor het bedrijf waarvan u facturen en bonnen wilt verwerken."), h("button", { class: "knop hoofd", onclick: () => $("#nieuweAdmin").click() }, "Administratie aanmaken"))
        : h("div", { class: "kaart leeg" }, h("h1", {}, "Nog geen administraties"), h("p", {}, "U heeft nog geen toegang tot een administratie. Vraag een beheerder om u toegang te geven.")),
    );
    return;
  }
  try {
    await (paginas[naam] ?? paginaStart)(arg);
  } catch (e) {
    vul(inhoud, h("div", { class: "kaart leeg" }, e.message));
  }
}
window.addEventListener("hashchange", () => {
  if (location.hash === vasteHash) return;
  if (onopgeslagen && !confirm("U heeft wijzigingen die nog niet zijn opgeslagen. Toch de pagina verlaten?")) {
    location.hash = vasteHash;
    return;
  }
  onopgeslagen = false;
  vasteHash = location.hash;
  toon();
});
window.addEventListener("beforeunload", (e) => onopgeslagen && e.preventDefault());
// Op de instellingenpagina's telt elke invoer als een niet-opgeslagen wijziging.
inhoud.addEventListener("input", () => {
  if (/^#\/(profiel|grootboek|btwcodes)/.test(location.hash)) onopgeslagen = true;
});
// Ctrl+Enter keurt het geopende document goed.
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") document.getElementById("goedkeurKnop")?.click();
});

const kop = (titel, uitleg, ...rechts) => h("div", { class: "paginakop" }, h("div", {}, h("div", { class: "kicker" }, admin?.profiel.naam ?? ""), h("h1", {}, titel), uitleg && h("div", { class: "zacht" }, uitleg)), h("div", { class: "knoppen" }, rechts));
const veld = (label, invoer, klasse = "") => h("label", { class: `veld ${klasse}` }, h("span", {}, label), invoer);

// ---------- Start ----------
async function paginaStart() {
  await laadAdmin();
  const [docs, fb] = await Promise.all([api(`/administraties/${adminId}/documenten`), api(`/administraties/${adminId}/feedback`)]);
  const aantal = (...s) => docs.filter((d) => s.includes(d.status)).length;
  const open = aantal("controle", "gereed", "fout");
  const klaar = aantal("goedgekeurd");
  const bezig = aantal("wachtrij", "bezig");
  const p = admin.profiel;
  const stappen = [
    { klaar: Boolean(p.btwNummer && p.activiteiten), titel: "Bedrijfsprofiel invullen", uitleg: "Btw-nummer, activiteiten en boekingsinstructies: hieraan herkent de AI het bedrijf.", link: "#/profiel" },
    { klaar: admin.grootboek.length > 0, titel: "Rekeningschema controleren", uitleg: `${admin.grootboek.length} grootboekrekeningen. Plak het schema uit Exact als het afwijkt.`, link: "#/grootboek" },
    { klaar: Object.keys(admin.btwcodes).length > 0, titel: "Btw-codes van Exact koppelen", uitleg: "Nodig voor de export; zonder code gaat een boeking niet mee.", link: "#/btwcodes" },
    { klaar: admin.relaties.some((r) => !r.nieuw), titel: "Relaties uit Exact overnemen", uitleg: "Optioneel: voorkomt dubbele relaties in Exact.", link: "#/relaties" },
  ];
  const volgende = bezig
    ? { titel: `${bezig} document${bezig === 1 ? " wordt" : "en worden"} uitgelezen…`, uitleg: "Dit duurt meestal enkele seconden per document.", knop: "Naar documenten", link: "#/documenten" }
    : open
      ? { titel: `${open} document${open === 1 ? " wacht" : "en wachten"} op beoordeling`, uitleg: "Controleer het voorstel en keur goed. Ctrl+Enter gaat direct door naar het volgende.", knop: "Start met beoordelen", link: `#/document/${[...docs].reverse().find((d) => ["controle", "gereed", "fout"].includes(d.status)).id}` }
      : klaar
        ? { titel: `${klaar} boeking${klaar === 1 ? " staat" : "en staan"} klaar voor Exact`, uitleg: "Alles is beoordeeld. Exporteer de goedgekeurde boekingen.", knop: "Naar export", link: "#/export" }
        : { titel: "Lever facturen en bonnen aan", uitleg: "PDF, foto of e-factuur. De AI maakt per document een boekingsvoorstel.", knop: "Documenten aanleveren", link: "#/documenten" };
  const tegel = (groot, klein, link) => h("a", { class: "tegel", href: link }, h("div", { class: "getal-groot" }, groot), h("div", { class: "zacht" }, klein));
  vul(
    inhoud,
    kop("Start", "Overzicht van deze administratie"),
    h("div", { class: "kaart volgende" }, h("div", {}, h("h2", {}, volgende.titel), h("div", { class: "zacht" }, volgende.uitleg)), h("a", { class: "knop hoofd", href: volgende.link }, volgende.knop)),
    h(
      "div",
      { class: "tegels", style: "margin-bottom:16px" },
      tegel(String(open), "te beoordelen", "#/documenten"),
      tegel(String(klaar), "goedgekeurd, klaar voor export", "#/export"),
      tegel(String(aantal("wacht")), "in de wacht", "#/documenten"),
      tegel(String(aantal("geexporteerd")), "geëxporteerd naar Exact", "#/documenten"),
      tegel(fb.kwaliteit.percentage == null ? "–" : `${fb.kwaliteit.percentage}%`, "in één keer goed", "#/feedback"),
    ),
    h(
      "div",
      { class: "kaart" },
      h("h2", {}, "Inrichting van de administratie"),
      h("ul", { class: "stappen" }, stappen.map((s, i) => h("li", { class: s.klaar ? "klaar" : "" }, h("span", { class: "bol" }, s.klaar ? "✓" : i + 1), h("span", {}, s.titel, h("small", {}, s.uitleg)), h("a", { class: "knop klein", href: s.link }, s.klaar ? "Bekijken" : "Invullen")))),
    ),
  );
  if (bezig) verversTimer = setTimeout(toon, 2000);
}

// ---------- Documenten ----------
let filter = "alle";
let zoekterm = "";

/** Verkleint grote foto's in de browser, zodat een telefoonfoto snel en binnen de limieten wordt verwerkt. */
async function verklein(bestand) {
  if (!bestand.type.startsWith("image/") || bestand.type === "image/gif") return bestand;
  try {
    const bitmap = await createImageBitmap(bestand);
    const max = 2400;
    const schaal = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (schaal === 1 && bestand.size < 3_000_000) return bestand;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * schaal);
    canvas.height = Math.round(bitmap.height * schaal);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return new File([blob], bestand.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return bestand;
  }
}

async function lever(bestanden) {
  if (!bestanden.length) return;
  const form = new FormData();
  for (const b of bestanden) form.append("bestanden", await verklein(b));
  const res = await api(`/administraties/${adminId}/documenten`, "POST", form);
  const over = res.filter((r) => r.overgeslagen);
  meld(over.length ? `${res.length - over.length} aangeleverd, ${over.length} overgeslagen: ${over[0].overgeslagen}` : `${res.length} document(en) aangeleverd`, over.length > 0);
  toon();
}

async function paginaDocumenten() {
  const docs = await api(`/administraties/${adminId}/documenten`);
  const kies = h("input", { type: "file", multiple: true, accept: "application/pdf,image/*,.xml,text/xml", hidden: true, onchange: probeer((e) => lever([...e.target.files])) });
  const camera = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, onchange: probeer((e) => lever([...e.target.files])) });
  const vak = h(
    "div",
    {
      id: "sleepvak",
      ondragover: (e) => (e.preventDefault(), vak.classList.add("boven")),
      ondragleave: () => vak.classList.remove("boven"),
      ondrop: probeer((e) => (e.preventDefault(), vak.classList.remove("boven"), lever([...e.dataTransfer.files]))),
    },
    h("b", {}, "Sleep facturen en bonnen hierheen"),
    h("div", { class: "zacht" }, "PDF, foto (JPG, PNG, WEBP) of e-factuur (UBL/XML) · meerdere bestanden tegelijk"),
    h("div", { class: "knoppen" }, h("button", { class: "knop hoofd", onclick: () => kies.click() }, "Bestanden kiezen"), h("button", { class: "knop", onclick: () => camera.click() }, "Foto maken"), kies, camera),
  );

  const groepen = {
    alle: () => true,
    controleren: (d) => ["controle", "gereed", "fout"].includes(d.status),
    wacht: (d) => d.status === "wacht",
    goedgekeurd: (d) => d.status === "goedgekeurd",
    geexporteerd: (d) => d.status === "geexporteerd",
  };
  const namen = { alle: "Alle", controleren: "Te beoordelen", wacht: "In de wacht", goedgekeurd: "Goedgekeurd", geexporteerd: "Geëxporteerd" };
  const tabs = h("div", { class: "tabs" }, Object.keys(groepen).map((g) => h("button", { class: filter === g ? "actief" : "", onclick: () => ((filter = g), toon()) }, `${namen[g]} (${docs.filter(groepen[g]).length})`)));
  const past = (d) => !zoekterm || [d.relatieNaam, d.factuurnummer, d.bestandsnaam, d.datum, euro(d.totaalIncl)].join(" ").toLowerCase().includes(zoekterm.toLowerCase());
  const zichtbaar = docs.filter(groepen[filter]).filter(past);
  const zonderSignalen = docs.filter((d) => d.status === "gereed").length;
  const zoek = h("input", { type: "search", placeholder: "Zoek op relatie, factuurnummer, bedrag of bestand", value: zoekterm, style: "max-width:340px", oninput: (e) => { zoekterm = e.target.value; clearTimeout(verversTimer); verversTimer = setTimeout(async () => { await toon(); const z = document.querySelector("input[type=search]"); z?.focus(); z?.setSelectionRange(z.value.length, z.value.length); }, 250); } });
  const balk = h(
    "div",
    { class: "knoppen", style: "margin-bottom:12px; justify-content:space-between" },
    zoek,
    zonderSignalen
      ? h("button", { class: "knop", title: "Documenten met een waarschuwing of fout blijven staan voor beoordeling", onclick: probeer(async () => { if (!confirm(`${zonderSignalen} document(en) zonder fouten of waarschuwingen in één keer goedkeuren?`)) return; const r = await api(`/administraties/${adminId}/goedkeuren-zonder-signalen`, "POST"); await laadAdmin(); meld(`${r.goedgekeurd} document(en) goedgekeurd`); toon(); }) }, `Keur ${zonderSignalen} zonder signalen goed`)
      : null,
  );

  const tabel = zichtbaar.length
    ? h(
        "div",
        { class: "tabelrol" },
        h(
          "table",
          { class: "lijst" },
          h("thead", {}, h("tr", {}, ["Status", "Relatie", "Factuurnr.", "Datum", "Soort"].map((t) => h("th", {}, t)), h("th", { class: "getal" }, "Bedrag incl."), h("th", {}, "Signalen"), h("th", {}, "Bestand"))),
          h(
            "tbody",
            {},
            zichtbaar.map((d) =>
              h(
                "tr",
                { class: "klikbaar", onclick: () => (location.hash = `#/document/${d.id}`) },
                h("td", {}, chip(d.status)),
                h("td", {}, d.relatieNaam || (d.status === "fout" ? d.fout : "")),
                h("td", {}, d.factuurnummer),
                h("td", {}, d.datum),
                h("td", {}, d.soort ? `${d.soort}${d.creditnota ? " (credit)" : ""}` : ""),
                h("td", { class: "getal" }, euro(d.totaalIncl)),
                h("td", { title: d.notitie || null, style: "max-width:220px;overflow:hidden;text-overflow:ellipsis" }, d.status === "wacht" && d.notitie ? d.notitie : [d.fouten ? `${d.fouten} fout${d.fouten > 1 ? "en" : ""}` : "", d.waarschuwingen ? `${d.waarschuwingen} let op` : ""].filter(Boolean).join(", ")),
                h("td", { class: "zacht", title: d.bestandsnaam }, d.efactuur ? h("span", { class: "label leert", style: "margin:0 6px 0 0" }, "e-factuur") : null, d.bestandsnaam),
              ),
            ),
          ),
        ),
      )
    : h("div", { class: "leeg" }, docs.length ? "Geen documenten in deze weergave." : "Nog geen documenten. Lever hierboven de eerste factuur of bon aan.");

  vul(inhoud, kop("Documenten", "Aanleveren, laten uitlezen en beoordelen"), h("div", { class: "kaart" }, vak, h("p", { class: "uitleg", style: "margin:10px 0 0" }, "Of zet bestanden in de inleesmap van deze administratie (bv. vanaf de scanner of een e-mailregel); ze komen dan vanzelf binnen: ", h("code", {}, admin.inleesmap))), h("div", { class: "kaart" }, balk, tabs, tabel));
  if (docs.some((d) => d.status === "wachtrij" || d.status === "bezig")) verversTimer = setTimeout(toon, 2000);
}

// ---------- Eén document ----------
async function paginaDocument(arg) {
  const id = Number(arg);
  let doc = await api(`/documenten/${id}`);
  if (doc.status === "wachtrij" || doc.status === "bezig") {
    vul(inhoud, kop(doc.bestandsnaam, "", h("a", { class: "knop", href: "#/documenten" }, "← Terug")), h("div", { class: "kaart leeg" }, "Dit document wordt uitgelezen…"));
    verversTimer = setTimeout(toon, 1500);
    return;
  }
  const vast = doc.status === "goedgekeurd" || doc.status === "geexporteerd";
  const b = doc.boeking;
  const bron = `/api/documenten/${id}/bestand`;
  const voorbeeld = h("div", { class: "voorbeeld", title: "Klik op de afbeelding om in of uit te zoomen", onclick: (e) => e.target.tagName === "IMG" && voorbeeld.classList.toggle("groot") }, doc.mime !== "application/pdf" && !/xml/.test(doc.mime) ? h("img", { src: bron, alt: "Document" }) : h("iframe", { src: bron, title: "Document", style: /xml/.test(doc.mime) ? "background:#fff" : "" }) );

  const signalenVak = h("div", {});
  const eisenVak = h("div", {});
  const journaalVak = h("div", {});
  const feedbackVak = h("div", {});
  const statusVak = h("span", {});
  function tekenUitkomst() {
    vul(statusVak, chip(doc.status));
    tekenFeedback();
    const fe = doc.factuureisen;
    if (fe) {
      const teken = { ja: "✓", nee: "✕", nvt: "–", onbekend: "?" };
      const klasse = { voldoet: "leert", "voldoet niet": "slecht", "niet volledig beoordeeld": "letop" }[fe.oordeel];
      vul(
        eisenVak,
        h("div", { class: "kopregel" }, h("h2", {}, "Factuurvereisten"), h("span", { class: `label ${klasse}` }, fe.oordeel[0].toUpperCase() + fe.oordeel.slice(1))),
        h("p", { class: "uitleg" }, fe.soort === "vereenvoudigd" ? "Vereenvoudigde factuur (tot € 100 inclusief btw): er gelden minder eisen (art. 34d Wet OB)." : "Volledige factuur: de verplichte vermeldingen van art. 35a Wet OB."),
        h("ul", { class: "eisen" }, fe.eisen.map((e) => h("li", { class: e.uitkomst }, h("span", { class: "teken" }, teken[e.uitkomst]), h("span", {}, e.omschrijving, e.toelichting ? h("small", {}, e.toelichting) : null)))),
        fe.eisen.some((e) => e.uitkomst === "onbekend") ? h("p", { class: "uitleg", style: "margin:8px 0 0" }, "? = niet beoordeeld; lees het document opnieuw uit om ook deze punten te laten toetsen.") : null,
      );
    } else vul(eisenVak);
    const volgorde = { fout: 0, waarschuwing: 1, info: 2 };
    const titel = { fout: "Fout", waarschuwing: "Let op", info: "Info" };
    const s = [...doc.signaleringen].sort((x, y) => volgorde[x.niveau] - volgorde[y.niveau]);
    vul(signalenVak, 
      h("h2", {}, "Controles"),
      doc.fout ? h("ul", { class: "signalen" }, h("li", { class: "fout" }, h("b", {}, "Uitlezen mislukt"), doc.fout)) : null,
      s.length ? h("ul", { class: "signalen" }, s.map((x) => h("li", { class: x.niveau }, h("b", {}, titel[x.niveau]), x.tekst))) : !doc.fout && h("div", { class: "geen-signalen" }, "✓ Alle controles doorstaan"),
    );
    const gb = Object.fromEntries(admin.grootboek.map((g) => [g.code, g.omschrijving]));
    vul(journaalVak, 
      h("h2", {}, "Journaalpost"),
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Rekening"), h("th", {}, "Omschrijving"), h("th", { class: "getal" }, "Debet"), h("th", { class: "getal" }, "Credit"))),
        h(
          "tbody",
          {},
          doc.journaalpost.map((j) => h("tr", {}, h("td", {}, `${j.rekening} ${gb[j.rekening] ?? ""}`), h("td", {}, j.omschrijving), h("td", { class: "getal" }, j.debet ? euro(j.debet) : ""), h("td", { class: "getal" }, j.credit ? euro(j.credit) : ""))),
          h("tr", { class: "totaalrij" }, h("td", { colspan: 2 }, "Totaal"), h("td", { class: "getal" }, euro(doc.journaalpost.reduce((t, j) => t + j.debet, 0))), h("td", { class: "getal" }, euro(doc.journaalpost.reduce((t, j) => t + j.credit, 0)))),
        ),
      ),
    );
  }

  // Feedback: wat is er aangepast ten opzichte van het AI-voorstel, en wat moet de AI ervan leren?
  const feedbackTekst = h("textarea", { rows: 3, placeholder: "Bv. Tankbonnen van Shell altijd op 4300 Brandstof. Of: servicekosten van deze verhuurder apart boeken op 4110." });
  const feedbackBereik = h("select", { style: "width:auto" }, h("option", { value: "relatie" }, "Geldt voor deze relatie"), h("option", { value: "administratie" }, "Geldt voor alle documenten"));
  const stuurFeedback = (opnieuw) =>
    probeer(async () => {
      const tekst = feedbackTekst.value.trim();
      if (!tekst) return meld("Schrijf eerst op wat de AI moet leren.", true);
      await api(`/documenten/${id}/feedback`, "POST", { tekst, bereik: feedbackBereik.value });
      if (opnieuw) {
        await api(`/documenten/${id}/opnieuw`, "POST", { aanwijzing: tekst });
        meld("Feedback opgeslagen; het document wordt opnieuw uitgelezen");
        return toon();
      }
      feedbackTekst.value = "";
      doc = await api(`/documenten/${id}`);
      tekenUitkomst();
      meld("Feedback opgeslagen. De AI gebruikt dit bij volgende documenten.");
    });
  function tekenFeedback() {
    const c = doc.correcties ?? [];
    vul(
      feedbackVak,
      h("h2", {}, "Feedback voor de AI"),
      c.length
        ? [
            h("div", { class: "uitleg" }, vast ? "Uw correcties op het AI-voorstel:" : "U heeft het AI-voorstel aangepast. Bij goedkeuren wordt dit onthouden:"),
            h("ul", { class: "correcties" }, c.map((x) => h("li", {}, x.tekst, x.soort === "oordeel" ? h("span", { class: "label leert" }, "leerpunt voor deze relatie") : h("span", { class: "label" }, "leesfout")))),
          ]
        : h("p", { class: "uitleg" }, "Past u de boeking aan, dan onthoudt het programma uw keuze van rekening en btw vanzelf voor deze relatie. Wilt u de AI iets uitleggen, schrijf het dan hieronder op."),
      (doc.feedback ?? []).length ? [h("div", { class: "uitleg" }, "Opgeslagen feedback bij dit document:"), h("ul", { class: "correcties" }, doc.feedback.map((f) => h("li", {}, f.tekst, h("span", { class: "label" }, f.bereik === "relatie" ? "deze relatie" : "alle documenten"))))] : null,
      feedbackTekst,
      h("div", { class: "knoppen", style: "margin-top:8px" }, feedbackBereik, h("button", { class: "knop", onclick: stuurFeedback(false) }, "Feedback opslaan"), !vast && h("button", { class: "knop", onclick: stuurFeedback(true) }, "Opslaan en opnieuw uitlezen")),
    );
  }

  let bewaarTimer;
  let bezigMetBewaren = Promise.resolve();
  const bewaarNu = () => {
    clearTimeout(bewaarTimer);
    bezigMetBewaren = bezigMetBewaren.then(
      probeer(async () => {
        doc = await api(`/documenten/${id}/boeking`, "PUT", b);
        tekenUitkomst();
      }),
    );
    return bezigMetBewaren;
  };
  const gewijzigd = () => {
    clearTimeout(bewaarTimer);
    bewaarTimer = setTimeout(bewaarNu, 500);
  };

  // Vorige/volgende: binnen de documenten die nog beoordeeld moeten worden, of anders binnen alle documenten.
  const alle = (await api(`/administraties/${adminId}/documenten`)).reverse();
  const open = alle.filter((d) => ["controle", "gereed", "fout"].includes(d.status));
  const reeks = open.some((d) => d.id === id) ? open : alle;
  const plek = reeks.findIndex((d) => d.id === id);
  const stap = (d, tekst) => h("a", { class: `knop klein ${d ? "" : "uit"}`, href: d ? `#/document/${d.id}` : null }, tekst);
  const kopKnoppen = [
    h("a", { class: "knop klein", href: "#/documenten" }, "Overzicht"),
    stap(reeks[plek - 1], "← Vorige"),
    h("span", { class: "zacht" }, `${plek + 1} van ${reeks.length}${reeks === open ? " te beoordelen" : ""}`),
    stap(reeks[plek + 1], "Volgende →"),
    statusVak,
  ];
  if (!b) {
    tekenUitkomst();
    vul(inhoud, 
      kop(doc.bestandsnaam, "", kopKnoppen),
      h("div", { class: "splits" }, voorbeeld, h("div", {}, h("div", { class: "kaart" }, signalenVak), h("div", { class: "knoppen" }, h("button", { class: "knop hoofd", onclick: probeer(async () => (await api(`/documenten/${id}/opnieuw`, "POST"), toon())) }, "Opnieuw uitlezen"), verwijderKnop(id)))),
    );
    return;
  }

  const tekst = (sleutel, type = "text") => h("input", { type, value: b[sleutel] ?? "", disabled: vast, oninput: (e) => ((b[sleutel] = e.target.value), gewijzigd()) });
  const keuze = (opties, waarde, bijKeuze) => {
    const s = h("select", { disabled: vast, onchange: (e) => (bijKeuze(e.target.value), gewijzigd()) }, opties.map(([v, t]) => h("option", { value: v }, t)));
    s.value = waarde;
    return s;
  };
  const bedrag = (waarde, bijInvoer) => h("input", { value: euro(waarde), disabled: vast, inputmode: "decimal", style: "text-align:right", onchange: (e) => (bijInvoer(centen(e.target.value)), (e.target.value = euro(centen(e.target.value))), gewijzigd()) });

  const regelsBody = h("tbody", {});
  const somCel = h("td", { class: "getal" });
  function tekenRegels() {
    const richting = b.soort;
    const opties = meta.behandelingen.filter((x) => x.richting === "beide" || x.richting === richting).map((x) => [x.code, x.label]);
    const gbOpties = [["", "— kies —"], ...admin.grootboek.map((g) => [g.code, `${g.code} ${g.omschrijving}`])];
    vul(regelsBody, 
      ...b.regels.map((r, i) =>
        h(
          "tr",
          {},
          h("td", {}, h("input", { value: r.omschrijving, disabled: vast, oninput: (e) => ((r.omschrijving = e.target.value), gewijzigd()) })),
          h("td", {}, keuze(gbOpties.some(([c]) => c === r.grootboek) ? gbOpties : [...gbOpties, [r.grootboek, `${r.grootboek} (onbekend)`]], r.grootboek, (v) => (r.grootboek = v))),
          h("td", {}, keuze(opties.some(([c]) => c === r.btw) ? opties : [...opties, [r.btw, r.btw]], r.btw, (v) => (r.btw = v))),
          h("td", {}, bedrag(r.bedragExcl, (v) => ((r.bedragExcl = v), tekenSom()))),
          h("td", {}, bedrag(r.btwBedrag, (v) => ((r.btwBedrag = v), tekenSom()))),
          h("td", {}, !vast && h("button", { class: "knop klein gevaar", title: "Regel verwijderen", onclick: () => (b.regels.splice(i, 1), tekenRegels(), gewijzigd()) }, "×")),
        ),
      ),
    );
    tekenSom();
  }
  function tekenSom() {
    somCel.textContent = euro(b.regels.reduce((t, r) => t + r.bedragExcl + r.btwBedrag, 0));
  }

  const relatieLabel = h("span", {}, b.soort === "inkoop" ? "Leverancier" : "Afnemer");
  const relatieLijst = h("datalist", { id: "relatieLijst" }, admin.relaties.map((r) => h("option", { value: r.naam }, `${r.code} · ${r.soort}`)));
  const btwVeld = tekst("relatieBtwNummer");
  const landVeld = tekst("relatieLand");
  const betaald = { pin: "pin", contant: "contant", creditcard: "creditcard", ideal: "iDEAL", automatische_incasso: "automatische incasso" }[doc.extractie?.betaalwijze];
  const formulier = h(
    "div",
    { class: "kaart" },
    h(
      "div",
      { class: "rooster" },
      veld("Soort", keuze([["inkoop", "Inkoop"], ["verkoop", "Verkoop"]], b.soort, (v) => ((b.soort = v), (b.relatieId = null), (relatieLabel.textContent = v === "inkoop" ? "Leverancier" : "Afnemer"), tekenRegels()))),
      h("label", { class: "veld vink" }, h("input", { type: "checkbox", checked: b.creditnota, disabled: vast, onchange: (e) => ((b.creditnota = e.target.checked), gewijzigd()) }), h("span", {}, "Creditnota")),
      h("label", { class: "veld breed" }, relatieLabel, relatieLijst, h("input", { list: "relatieLijst", value: b.relatieNaam, disabled: vast, oninput: (e) => {
        b.relatieNaam = e.target.value;
        b.relatieId = null;
        // Kiest u een bestaande relatie uit de lijst, dan worden btw-nummer en land overgenomen.
        const bekend = admin.relaties.find((r) => r.naam === b.relatieNaam && r.soort === (b.soort === "inkoop" ? "crediteur" : "debiteur"));
        if (bekend) {
          b.relatieId = bekend.id;
          if (bekend.btwNummer) b.relatieBtwNummer = btwVeld.value = bekend.btwNummer;
          if (bekend.land) b.relatieLand = landVeld.value = bekend.land;
        }
        gewijzigd();
      } })),
      veld("Btw-nummer relatie", btwVeld),
      veld("Land (ISO)", landVeld),
      veld("Factuurnummer", tekst("factuurnummer")),
      veld("Factuurdatum", tekst("datum", "date")),
      veld("Vervaldatum", tekst("vervaldatum", "date")),
      veld("Totaal incl. btw", bedrag(b.totaalIncl, (v) => (b.totaalIncl = v))),
      veld("Omschrijving", tekst("omschrijving"), "breed"),
    ),
    betaald ? h("p", { class: "uitleg", style: "margin:10px 0 0" }, `Volgens het document al betaald per ${betaald}. De boeking loopt via de ${b.soort === "inkoop" ? "crediteur" : "debiteur"}; de betaling wordt in Exact afgeletterd met de bank of kas.`) : null,
    doc.goedgekeurdOp ? h("p", { class: "uitleg", style: "margin:10px 0 0" }, `Goedgekeurd op ${new Date(doc.goedgekeurdOp).toLocaleString("nl-NL")}${doc.goedgekeurdDoor ? ` door ${doc.goedgekeurdDoor}` : ""}${doc.geexporteerdOp ? ` · geëxporteerd op ${new Date(doc.geexporteerdOp).toLocaleString("nl-NL")}` : ""}`) : null,
  );
  const regelsKaart = h(
    "div",
    { class: "kaart" },
    h("h2", {}, "Boekingsregels"),
    h(
      "div",
      { class: "tabelrol" },
      h(
        "table",
        { class: "regels" },
        h("thead", {}, h("tr", {}, h("th", {}, "Omschrijving"), h("th", {}, "Grootboek"), h("th", {}, "Btw"), h("th", { class: "getal" }, "Excl. btw"), h("th", { class: "getal" }, "Btw"), h("th", {}))),
        regelsBody,
        h("tfoot", {}, h("tr", { class: "totaalrij" }, h("td", { colspan: 3 }, "Totaal regels incl. btw"), somCel, h("td", {}), h("td", {}))),
      ),
    ),
    !vast && h("div", { class: "knoppen", style: "margin-top:10px" }, h("button", { class: "knop klein", onclick: () => (b.regels.push({ omschrijving: "", grootboek: "", btw: "NL_HOOG", categorie: "overig", bedragExcl: 0, btwBedrag: 0 }), tekenRegels(), gewijzigd()) }, "+ Regel")),
  );

  const acties = h(
    "div",
    { class: "knoppen" },
    vast
      ? h("button", { class: "knop", onclick: probeer(async () => (await api(`/documenten/${id}/heropenen`, "POST"), toon())) }, "Heropenen om te wijzigen")
      : [
          h(
            "button",
            {
              class: "knop hoofd",
              id: "goedkeurKnop",
              title: "Sneltoets: Ctrl+Enter",
              onclick: async () => {
                await bewaarNu();
                try {
                  await api(`/documenten/${id}/goedkeuren`, "POST");
                  await laadAdmin();
                  // Door naar het eerstvolgende document dat nog beoordeeld moet worden.
                  const rest = (await api(`/administraties/${adminId}/documenten`)).filter((d) => ["controle", "gereed"].includes(d.status)).reverse();
                  const volgend = rest.find((d) => d.id > id) ?? rest[0];
                  meld(volgend ? "Goedgekeurd — door naar het volgende document" : "Goedgekeurd — alles is beoordeeld");
                  location.hash = volgend ? `#/document/${volgend.id}` : "#/documenten";
                } catch (e) {
                  if (e.data?.document) ((doc = e.data.document), tekenUitkomst());
                  meld(e.message, true);
                }
              },
            },
            "Goedkeuren",
          ),
          h("button", { class: "knop", onclick: probeer(async () => (confirm("Het document opnieuw laten uitlezen? Uw wijzigingen gaan verloren.") && (await api(`/documenten/${id}/opnieuw`, "POST"), toon()))) }, "Opnieuw uitlezen"),
          doc.mime === "application/pdf"
            ? h(
                "button",
                {
                  class: "knop",
                  title: "Voor een pdf die meer dan één factuur bevat",
                  onclick: probeer(async () => {
                    const voorstel = (doc.extractie?.documentenInBestand ?? []).map((d) => (d.vanPagina === d.totPagina ? d.vanPagina : `${d.vanPagina}-${d.totPagina}`)).join(", ");
                    const delen = prompt("Splits deze pdf in losse documenten. Geef per document de pagina's, gescheiden door komma's (bv. 1-2, 3, 4-5):", voorstel || "1, 2");
                    if (!delen) return;
                    const r = await api(`/documenten/${id}/splitsen`, "POST", { delen });
                    meld(`Gesplitst in ${r.documenten.length} documenten; ze worden uitgelezen`);
                    location.hash = "#/documenten";
                  }),
                },
                "Splitsen…",
              )
            : null,
          verwijderKnop(id),
        ],
  );

  // Opvolging: notitie, in de wacht zetten en een concept-mail aan de klant.
  const notitieVeld = h("textarea", { rows: 2, style: "min-height:0", placeholder: "Bv. juiste factuur opgevraagd bij de klant op 14-11.", onchange: probeer(async (e) => { doc.notitie = (await api(`/documenten/${id}/notitie`, "PUT", { notitie: e.target.value })).notitie; }) }, doc.notitie);
  const mailKlant = () => {
    const ontbreekt = doc.factuureisen?.ontbreekt ?? [];
    const regels = [
      "Beste relatie,",
      "",
      `Bij het verwerken van de factuur van ${b.relatieNaam}${b.factuurnummer ? ` met nummer ${b.factuurnummer}` : ""}${b.datum ? ` van ${b.datum.split("-").reverse().join("-")}` : ""} (${euro(b.totaalIncl)} euro) hebben wij een vraag.`,
      "",
      ...(ontbreekt.length ? ["De factuur voldoet niet aan de wettelijke factuurvereisten. Op de factuur ontbreekt:", ...ontbreekt.map((o) => `- ${o}`), "", "Zonder juiste factuur kan de aftrek van btw bij een controle worden geweigerd. Wilt u bij de leverancier een gecorrigeerde factuur opvragen en die aan ons doorsturen?"] : [notitieVeld.value || "[Vul hier uw vraag in]"]),
      "",
      "Met vriendelijke groet,",
      "Beuk Accountants & Belastingadviseurs",
    ];
    location.href = `mailto:?subject=${encodeURIComponent(`Vraag over factuur ${b.relatieNaam} ${b.factuurnummer}`.trim())}&body=${encodeURIComponent(regels.join("\n"))}`;
  };
  const opvolging = h(
    "div",
    { class: "kaart" },
    h("h2", {}, "Notitie en opvolging"),
    notitieVeld,
    h(
      "div",
      { class: "knoppen", style: "margin-top:8px" },
      doc.status === "wacht"
        ? h("button", { class: "knop", onclick: probeer(async () => (await api(`/documenten/${id}/heropenen`, "POST"), meld("Uit de wacht gehaald"), toon())) }, "Uit de wacht halen")
        : !vast && h("button", { class: "knop", onclick: probeer(async () => { await bewaarNu(); await api(`/documenten/${id}/wacht`, "POST", { notitie: notitieVeld.value }); meld("In de wacht gezet"); const rest = (await api(`/administraties/${adminId}/documenten`)).filter((d) => ["controle", "gereed"].includes(d.status)).reverse(); const v = rest.find((d) => d.id > id) ?? rest[0]; location.hash = v ? `#/document/${v.id}` : "#/documenten"; }) }, "Zet in de wacht"),
      h("button", { class: "knop", onclick: mailKlant, title: "Opent uw e-mailprogramma met een concepttekst" }, "Concept-mail aan klant"),
    ),
  );

  tekenRegels();
  tekenUitkomst();
  vul(inhoud, 
    kop(`${b.relatieNaam || doc.bestandsnaam}`, doc.bestandsnaam, kopKnoppen),
    h("div", { class: "splits" }, voorbeeld, h("div", {}, formulier, regelsKaart, h("div", { class: "kaart" }, signalenVak), doc.factuureisen ? h("div", { class: "kaart" }, eisenVak) : null, h("div", { class: "kaart" }, journaalVak), h("div", { class: "kaart" }, feedbackVak), opvolging, (doc.geschiedenis ?? []).length ? h("div", { class: "kaart" }, h("h2", {}, "Geschiedenis"), h("table", {}, h("tbody", {}, doc.geschiedenis.map((r) => h("tr", {}, h("td", { class: "zacht", style: "white-space:nowrap" }, new Date(r.tijd).toLocaleString("nl-NL")), h("td", {}, r.gebruiker), h("td", {}, r.actie)))))) : null, acties)),
  );
}

const verwijderKnop = (id) =>
  h("button", { class: "knop gevaar", onclick: probeer(async () => (confirm("Dit document verwijderen?") && (await api(`/documenten/${id}`, "DELETE"), (location.hash = "#/documenten")))) }, "Verwijderen");

// ---------- Feedback & kwaliteit ----------
async function paginaFeedback() {
  const { feedback, kwaliteit: k } = await api(`/administraties/${adminId}/feedback`);
  const wijzig = probeer(async (f, velden) => {
    Object.assign(f, velden);
    await api(`/feedback/${f.id}`, "PUT", f);
  });
  const tegel = (groot, klein) => h("div", { class: "tegel" }, h("div", { class: "getal-groot" }, groot), h("div", { class: "zacht" }, klein));
  const rijen = feedback.map((f) =>
    h(
      "tr",
      {},
      h("td", { style: "text-align:center" }, h("input", { type: "checkbox", checked: f.actief, title: "Meegeven aan de AI", onchange: (e) => wijzig(f, { actief: e.target.checked }) })),
      h("td", {}, h("textarea", { rows: 2, style: "min-height:0;min-width:320px", onchange: (e) => wijzig(f, { tekst: e.target.value }) }, f.tekst)),
      h("td", {}, f.bereik === "relatie" ? f.relatieNaam : h("i", {}, "alle documenten")),
      h("td", {}, h("span", { class: `label ${f.bron === "handmatig" ? "leert" : ""}` }, f.bron === "handmatig" ? "door u geschreven" : "uit een correctie")),
      h("td", {}, f.documentId ? h("a", { href: `#/document/${f.documentId}` }, `document ${f.documentId}`) : ""),
      h("td", {}, h("button", { class: "knop klein gevaar", onclick: probeer(async () => (confirm("Deze feedback verwijderen?") && (await api(`/feedback/${f.id}`, "DELETE"), toon()))) }, "×")),
    ),
  );
  vul(
    inhoud,
    kop("Feedback & kwaliteit", "Wat de AI van uw correcties en aanwijzingen heeft geleerd, en hoe goed de voorstellen zijn."),
    h(
      "div",
      { class: "tegels", style: "margin-bottom:16px" },
      tegel(k.percentage == null ? "–" : `${k.percentage}%`, "van de goedgekeurde boekingen zonder correctie"),
      tegel(String(k.beoordeeld), "boekingen goedgekeurd"),
      tegel(String(k.beoordeeld - k.zonderCorrectie), "daarvan door u aangepast"),
      tegel(String(feedback.filter((f) => f.actief).length), "actieve leerpunten"),
    ),
    k.vaakGecorrigeerd.length
      ? h("div", { class: "kaart" }, h("h2", {}, "Relaties waarbij u het vaakst corrigeert"), h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Relatie"), h("th", { class: "getal" }, "Gecorrigeerd"), h("th", { class: "getal" }, "Totaal"))), h("tbody", {}, k.vaakGecorrigeerd.map((r) => h("tr", {}, h("td", {}, r.naam), h("td", { class: "getal" }, r.gecorrigeerd), h("td", { class: "getal" }, r.totaal))))))
      : null,
    h(
      "div",
      { class: "kaart" },
      h("h2", {}, "Leerpunten"),
      h("p", { class: "uitleg" }, "Elk actief leerpunt gaat mee naar de AI bij het uitlezen van volgende documenten. Leerpunten ‘uit een correctie’ ontstaan vanzelf wanneer u bij het goedkeuren een andere rekening, btw-behandeling of indeling kiest dan de AI voorstelde. U kunt de tekst aanscherpen, een leerpunt uitzetten of verwijderen. Feedback geven doet u bij het document zelf."),
      rijen.length ? h("div", { class: "tabelrol" }, h("table", {}, h("thead", {}, h("tr", {}, ["Actief", "Wat de AI moet weten", "Geldt voor", "Herkomst", "Bron", ""].map((t) => h("th", {}, t)))), h("tbody", {}, rijen))) : h("div", { class: "leeg" }, "Nog geen leerpunten."),
    ),
  );
}

// ---------- Btw-overzicht ----------
let btwPeriode = null;
async function paginaBtw() {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const kwartaal = (jaar, k) => ({ van: iso(new Date(jaar, (k - 1) * 3, 1)), tot: iso(new Date(jaar, k * 3, 0)), naam: `${k}e kwartaal ${jaar}` });
  const nu = new Date();
  const k = Math.floor(nu.getMonth() / 3) + 1;
  const dit = kwartaal(nu.getFullYear(), k);
  const vorig = k === 1 ? kwartaal(nu.getFullYear() - 1, 4) : kwartaal(nu.getFullYear(), k - 1);
  const maand = { van: iso(new Date(nu.getFullYear(), nu.getMonth(), 1)), tot: iso(new Date(nu.getFullYear(), nu.getMonth() + 1, 0)), naam: "deze maand" };
  const jaar = { van: `${nu.getFullYear()}-01-01`, tot: `${nu.getFullYear()}-12-31`, naam: `heel ${nu.getFullYear()}` };
  btwPeriode ??= dit;
  const o = await api(`/administraties/${adminId}/btw-overzicht?van=${btwPeriode.van}&tot=${btwPeriode.tot}`);
  const kies = (p) => h("button", { class: `knop klein ${p.van === btwPeriode.van && p.tot === btwPeriode.tot ? "hoofd" : ""}`, onclick: () => ((btwPeriode = p), toon()) }, p.naam[0].toUpperCase() + p.naam.slice(1));
  const datum = (sleutel) => h("input", { type: "date", value: btwPeriode[sleutel], style: "width:auto", onchange: (e) => e.target.value && ((btwPeriode = { ...btwPeriode, [sleutel]: e.target.value, naam: "eigen periode" }), toon()) });
  const rij = (code, omschrijving, grondslag, btw, klasse = "") => h("tr", { class: klasse }, h("td", {}, h("b", {}, code)), h("td", {}, omschrijving), h("td", { class: "getal" }, grondslag == null ? "" : euro(grondslag)), h("td", { class: "getal" }, btw == null ? "" : euro(btw)));
  vul(
    inhoud,
    kop("Btw-overzicht", "De goedgekeurde boekingen ingedeeld naar de rubrieken van de aangifte omzetbelasting."),
    h("div", { class: "kaart" }, h("div", { class: "knoppen" }, kies(dit), kies(vorig), kies(maand), kies(jaar), h("span", { class: "zacht" }, "of van"), datum("van"), h("span", { class: "zacht" }, "t/m"), datum("tot"))),
    o.nogNietGoedgekeurd ? h("ul", { class: "signalen", style: "margin-bottom:16px" }, h("li", { class: "waarschuwing" }, h("b", {}, "Let op"), `${o.nogNietGoedgekeurd} document(en) in deze periode ${o.nogNietGoedgekeurd === 1 ? "is" : "zijn"} nog niet goedgekeurd en ${o.nogNietGoedgekeurd === 1 ? "telt" : "tellen"} niet mee.`)) : null,
    h(
      "div",
      { class: "kaart" },
      o.aantalBoekingen
        ? h(
            "div",
            { class: "tabelrol" },
            h(
              "table",
              {},
              h("thead", {}, h("tr", {}, h("th", {}, "Rubriek"), h("th", {}, "Omschrijving"), h("th", { class: "getal" }, "Omzet / grondslag"), h("th", { class: "getal" }, "Btw"))),
              h(
                "tbody",
                {},
                o.rubrieken.map((r) => rij(r.code, r.omschrijving, r.grondslag, ["1e", "3a", "3b"].includes(r.code) ? null : r.btw)),
                rij("5a", "Verschuldigde btw (rubrieken 1 t/m 4)", null, o.verschuldigd, "totaalrij"),
                rij("5b", "Voorbelasting", null, o.voorbelasting),
                rij("", o.saldo >= 0 ? "Te betalen" : "Terug te vragen", null, Math.abs(o.saldo), "totaalrij"),
              ),
            ),
          )
        : h("div", { class: "leeg" }, "Geen goedgekeurde boekingen met een factuurdatum in deze periode."),
    ),
    h(
      "div",
      { class: "kaart uitleg" },
      h("h2", {}, "Waarvoor dit overzicht is"),
      h("p", {}, `Gebaseerd op ${o.aantalBoekingen} goedgekeurde boeking(en), ingedeeld op factuurdatum. Gebruik het als controle op wat Exact na de import berekent.`),
      h("p", {}, "Het is geen aangifte: boekingen die buiten dit programma om in Exact komen (bank, kas, memoriaal, privégebruik, correcties) zitten er niet in. De aangifte zelf rondt af op hele euro's. Verlegde btw is gerekend tegen 21%."),
    ),
  );
}

// ---------- Export ----------
async function paginaExport() {
  const docs = await api(`/administraties/${adminId}/documenten`);
  const klaar = docs.filter((d) => d.status === "goedgekeurd");
  const open = docs.filter((d) => ["controle", "gereed"].includes(d.status)).length;
  const problemenVak = h("div", {});

  const download = (formaat) =>
    probeer(async () => {
      const r = await fetch(`/api/administraties/${adminId}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ formaat }) });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        if (data.problemen) {
          const uniek = [...new Set(data.problemen.map((p) => p.tekst))];
          vul(problemenVak, 
            h("ul", { class: "signalen", style: "margin-top:12px" }, uniek.map((t) => h("li", { class: "fout" }, t))),
            h("p", { class: "uitleg", style: "margin-top:8px" }, "Vul de ontbrekende codes in onder ", h("a", { href: "#/btwcodes" }, "Btw-codes"), " of ", h("a", { href: "#/relaties" }, "Relaties"), "."),
          );
        }
        throw new Error(data.fout || "Export mislukt");
      }
      const naam = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "export";
      const a = h("a", { href: URL.createObjectURL(await r.blob()), download: naam });
      a.click();
      URL.revokeObjectURL(a.href);
      meld("Exportbestand gedownload");
      toon();
    });

  vul(inhoud, 
    kop("Export naar Exact", "Goedgekeurde boekingen klaarzetten voor import in Exact Online"),
    h(
      "div",
      { class: "kaart" },
      h("h2", {}, `${klaar.length} goedgekeurde boeking${klaar.length === 1 ? "" : "en"} klaar voor export`),
      open ? h("p", { class: "zacht" }, `${open} document${open === 1 ? " wacht" : "en wachten"} nog op beoordeling en ${open === 1 ? "gaat" : "gaan"} niet mee.`) : null,
      h(
        "div",
        { class: "knoppen" },
        h("button", { class: "knop hoofd", disabled: !klaar.length, onclick: download("xml") }, "Exact Online XML"),
        h("button", { class: "knop", disabled: !klaar.length, onclick: download("csv") }, "Exact CSV"),
        h("button", { class: "knop", disabled: !klaar.length, onclick: download("journaal") }, "Journaalposten (CSV, ter controle)"),
      ),
      problemenVak,
    ),
    h(
      "div",
      { class: "kaart uitleg" },
      h("h2", {}, "Zo importeert u in Exact Online"),
      h("p", {}, h("b", {}, "XML: "), "Import/Export → XML → Importeren, onderwerp ‘Boekingen’ (GLTransactions). Nieuwe relaties gaan in hetzelfde bestand mee. Exact berekent de btw en de crediteuren- of debiteurenregel zelf uit de btw-code en het dagboek."),
      h("p", {}, h("b", {}, "CSV: "), "één rij per boekingsregel, te gebruiken met een eigen importdefinitie. Relaties moeten dan al in Exact bestaan."),
      h("p", {}, "Na een XML- of CSV-export krijgen de documenten de status ‘Geëxporteerd’, zodat ze niet dubbel worden aangeboden. Het journaalpostenoverzicht verandert de status niet."),
      h("p", {}, "Doe de eerste keer een proefimport met één of twee boekingen en controleer die in Exact, voordat u grotere aantallen importeert."),
    ),
  );
}

// ---------- Bedrijfsprofiel ----------
async function paginaProfiel() {
  await laadAdmin();
  const p = structuredClone(admin.profiel);
  const t = (sleutel, attrs = {}) => h("input", { value: p[sleutel] ?? "", oninput: (e) => (p[sleutel] = e.target.value), ...attrs });
  const lijst = (sleutel, attrs = {}) => h("input", { value: p[sleutel].join(", "), oninput: (e) => (p[sleutel] = e.target.value.split(",").map((s) => s.trim()).filter(Boolean)), ...attrs });
  const gebied = (sleutel, placeholder) => h("textarea", { rows: 5, placeholder, oninput: (e) => (p[sleutel] = e.target.value) }, p[sleutel]);
  const status = h("select", { onchange: (e) => ((p.btwStatus = e.target.value), (proRata.hidden = p.btwStatus !== "gemengd")) }, [["normaal", "Btw-plichtig, volledige aftrek"], ["gemengd", "Belaste én vrijgestelde prestaties (pro rata)"], ["kor", "Kleineondernemersregeling (KOR)"], ["vrijgesteld", "Alleen vrijgestelde prestaties"]].map(([v, l]) => h("option", { value: v }, l)));
  status.value = p.btwStatus;
  const proRata = veld("Aftrekpercentage pro rata (%)", t("proRataPercentage", { type: "number", min: 0, max: 100 }));
  proRata.hidden = p.btwStatus !== "gemengd";
  const gbKeuze = (sleutel) => {
    const s = h("select", { onchange: (e) => (p[sleutel] = e.target.value) }, admin.grootboek.map((g) => h("option", { value: g.code }, `${g.code} ${g.omschrijving}`)));
    if (!admin.grootboek.some((g) => g.code === p[sleutel])) s.prepend(h("option", { value: p[sleutel] }, `${p[sleutel]} (niet in schema)`));
    s.value = p[sleutel];
    return s;
  };
  const bewaar = probeer(async () => {
    await api(`/administraties/${adminId}/profiel`, "PUT", p);
    await laadAdmins();
    await laadAdmin();
    onopgeslagen = false;
    meld("Bedrijfsprofiel opgeslagen");
  });

  vul(inhoud, 
    kop("Bedrijfsprofiel", "Hoe meer de AI over het bedrijf weet, hoe beter facturen worden herkend en geboekt.", h("button", { class: "knop hoofd", onclick: bewaar }, "Opslaan")),
    h(
      "div",
      { class: "kaart" },
      h("h2", {}, "Identificatie"),
      h("p", { class: "uitleg" }, "Aan deze gegevens herkent het programma of een document een inkoop- of een verkoopfactuur is en of de factuur op de juiste naam staat."),
      h("div", { class: "rooster" }, veld("Bedrijfsnaam", t("naam")), veld("Handelsnamen (komma-gescheiden)", lijst("handelsnamen")), veld("KvK-nummer", t("kvk")), veld("Btw-identificatienummer", t("btwNummer", { placeholder: "NL123456789B01" })), veld("IBAN(s), komma-gescheiden", lijst("ibans")), veld("Adres", t("adres"))),
    ),
    h(
      "div",
      { class: "kaart" },
      h("h2", {}, "Btw-positie"),
      h("div", { class: "rooster" }, veld("Btw-status", status), proRata, h("label", { class: "veld vink" }, h("input", { type: "checkbox", checked: p.artikel23, onchange: (e) => (p.artikel23 = e.target.checked) }), h("span", {}, "Vergunning artikel 23 (invoer-btw via de aangifte)"))),
    ),
    h(
      "div",
      { class: "kaart" },
      h("h2", {}, "Kennis voor de AI"),
      h("div", { class: "rooster" }, veld("Activiteiten van het bedrijf", gebied("activiteiten", "Bv. Bakkerij met twee winkels en bezorging aan horeca. Koopt grondstoffen in bij groothandels, heeft twee bestelbussen en vijf medewerkers."), "breed"), veld("Boekingsinstructies", gebied("instructies", "Bv. Meel en grondstoffen op 7000. Brandstof altijd op 4300 (bestelbussen, geen privégebruik). Facturen van de verhuurder: huur op 4100, servicekosten op 4110."), "breed")),
    ),
    h(
      "div",
      { class: "kaart" },
      h("h2", {}, "Koppeling met het rekeningschema en Exact"),
      h("div", { class: "rooster" }, veld("Dagboek inkoop (Exact-code)", t("dagboekInkoop")), veld("Dagboek verkoop (Exact-code)", t("dagboekVerkoop")), veld("Crediteuren", gbKeuze("rekeningCrediteuren")), veld("Debiteuren", gbKeuze("rekeningDebiteuren")), veld("Te vorderen btw", gbKeuze("rekeningBtwTeVorderen")), veld("Af te dragen btw", gbKeuze("rekeningBtwAfTeDragen")), veld("Startnummer nieuwe relaties", t("relatieStartnummer", { type: "number", min: 1 }))),
      h("p", { class: "uitleg", style: "margin-top:10px" }, "Nieuwe relaties krijgen een code vanaf het startnummer. Kies een reeks die in Exact nog vrij is."),
    ),
  );
}

// ---------- Rekeningschema ----------
async function paginaGrootboek() {
  await laadAdmin();
  const gebied = h("textarea", { rows: 24, spellcheck: "false", style: "font-family: ui-monospace, monospace" }, admin.grootboek.map((g) => `${g.code};${g.omschrijving}`).join("\n"));
  const bewaar = probeer(async () => {
    const lijst = gebied.value.split(/\r?\n/).map((r) => r.split(/[;\t]/)).filter((d) => d[0]?.trim() && !/^code$/i.test(d[0].trim())).map(([code, ...rest]) => ({ code: code.trim(), omschrijving: rest.join(" ").trim() }));
    const res = await api(`/administraties/${adminId}/grootboek`, "PUT", lijst);
    await laadAdmin();
    gebied.value = res.map((g) => `${g.code};${g.omschrijving}`).join("\n");
    onopgeslagen = false;
    meld(`${res.length} rekeningen opgeslagen`);
  });
  vul(inhoud, 
    kop("Rekeningschema", "De AI kiest alleen uit deze grootboekrekeningen.", h("button", { class: "knop hoofd", onclick: bewaar }, "Opslaan")),
    h("div", { class: "kaart" }, h("p", { class: "uitleg" }, "Eén rekening per regel als ", h("code", {}, "code;omschrijving"), ". U kunt het schema uit Exact (export naar Excel/CSV) hier rechtstreeks plakken; tabs worden ook herkend. Een duidelijke omschrijving helpt de AI de juiste rekening te kiezen."), gebied),
  );
}

// ---------- Btw-codes ----------
async function paginaBtwcodes() {
  await laadAdmin();
  const codes = { ...admin.btwcodes };
  const cel = (soort, b) => (b.richting === "beide" || b.richting === soort ? h("input", { value: codes[`${soort}:${b.code}`] ?? "", style: "width:90px", oninput: (e) => (codes[`${soort}:${b.code}`] = e.target.value) }) : h("span", { class: "zacht" }, "n.v.t."));
  const bewaar = probeer(async () => {
    await api(`/administraties/${adminId}/btwcodes`, "PUT", codes);
    await laadAdmin();
    onopgeslagen = false;
    meld("Btw-codes opgeslagen");
  });
  vul(inhoud, 
    kop("Btw-codes", "Welke btw-code in Exact hoort bij elke btw-behandeling?", h("button", { class: "knop hoofd", onclick: bewaar }, "Opslaan")),
    h(
      "div",
      { class: "kaart" },
      h("p", { class: "uitleg" }, "Btw-codes verschillen per Exact-administratie (Stamgegevens → Btw-codes). Vul hier de code in die bij elke behandeling hoort. Zonder code wordt een boeking met die behandeling niet geëxporteerd, zodat er nooit een verkeerde btw-code in de aangifte komt. Voor ‘niet aftrekbaar’ en ‘buitenlandse btw’ kiest u een code zonder btw: het bedrag inclusief btw wordt als kosten aangeboden."),
      h(
        "div",
        { class: "tabelrol" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "Btw-behandeling"), h("th", {}, "Rubriek aangifte (inkoop / verkoop)"), h("th", {}, "Exact-code inkoop"), h("th", {}, "Exact-code verkoop"))),
          h("tbody", {}, meta.behandelingen.map((b) => h("tr", {}, h("td", {}, h("b", {}, b.label), h("div", { class: "uitleg" }, b.uitleg)), h("td", {}, `${b.rubriekInkoop} / ${b.rubriekVerkoop}`), h("td", {}, cel("inkoop", b)), h("td", {}, cel("verkoop", b))))),
        ),
      ),
    ),
  );
}

// ---------- Relaties ----------
async function paginaRelaties() {
  await laadAdmin();
  const gbOpties = [["", "—"], ...admin.grootboek.map((g) => [g.code, `${g.code} ${g.omschrijving}`])];
  const btwOpties = [["", "—"], ...meta.behandelingen.map((b) => [b.code, b.label])];
  const kies = (opties, r, sleutel) => {
    const s = h("select", { onchange: (e) => wijzig(r, { [sleutel]: e.target.value }) }, opties.map(([v, t]) => h("option", { value: v }, t)));
    s.value = r[sleutel];
    return s;
  };
  const wijzig = probeer(async (r, velden) => {
    Object.assign(r, velden);
    await api(`/relaties/${r.id}`, "PUT", r);
  });
  const inv = (r, sleutel, stijl = "") => h("input", { value: r[sleutel], style: stijl, onchange: (e) => wijzig(r, { [sleutel]: e.target.value }) });

  const importVak = h("textarea", { rows: 4, placeholder: "code;naam;btw-nummer;soort (crediteur of debiteur)\n1001;Kantoorhandel De Pen B.V.;NL123456789B01;crediteur", style: "font-family: ui-monospace, monospace" });
  const rijen = admin.relaties.map((r) =>
    h(
      "tr",
      {},
      h("td", {}, inv(r, "code", "width:80px")),
      h("td", {}, inv(r, "naam", "min-width:160px"), r.nieuw ? h("div", { class: "uitleg" }, "nieuw — gaat mee in de XML-export") : null),
      h("td", {}, r.soort),
      h("td", {}, inv(r, "btwNummer", "width:150px")),
      h("td", {}, inv(r, "iban", "width:190px")),
      h("td", {}, kies(gbOpties, r, "standaardGrootboek")),
      h("td", {}, kies(btwOpties, r, "standaardBtw")),
      h("td", { style: "text-align:center" }, h("input", { type: "checkbox", checked: r.vast, title: "Altijd deze rekening en btw gebruiken", onchange: (e) => wijzig(r, { vast: e.target.checked }) })),
      h("td", { style: "text-align:center" }, h("input", { type: "checkbox", checked: r.autoAkkoord, title: "Documenten zonder fout of waarschuwing direct goedkeuren", onchange: (e) => wijzig(r, { autoAkkoord: e.target.checked }) })),
      h("td", {}, inv(r, "instructie", "min-width:160px")),
      h("td", {}, h("button", { class: "knop klein gevaar", onclick: probeer(async () => (confirm(`Relatie ${r.naam} verwijderen?`) && (await api(`/relaties/${r.id}`, "DELETE"), toon()))) }, "×")),
    ),
  );
  vul(inhoud, 
    kop("Relaties", "Leveranciers en afnemers, en hoe ze worden geboekt."),
    h(
      "div",
      { class: "kaart" },
      h("p", { class: "uitleg" }, "Bij elke goedkeuring onthoudt het programma op welke rekening en met welke btw een relatie is geboekt; de AI gebruikt dat bij de volgende factuur. Met ‘Auto-akkoord’ worden documenten van een vertrouwde relatie zonder fout of waarschuwing direct goedgekeurd. Het IBAN wordt gebruikt om een gewijzigd rekeningnummer te signaleren. Zet ‘Vast’ aan om de rekening en btw-behandeling af te dwingen, en gebruik ‘Instructie’ voor uitzonderingen (bv. “servicekosten apart op 4110”)."),
      rijen.length ? h("div", { class: "tabelrol" }, h("table", {}, h("thead", {}, h("tr", {}, ["Code", "Naam", "Soort", "Btw-nummer", "IBAN", "Standaardrekening", "Standaard btw", "Vast", "Auto-akkoord", "Instructie voor de AI", ""].map((t) => h("th", {}, t)))), h("tbody", {}, rijen))) : h("div", { class: "leeg" }, "Nog geen relaties. Ze ontstaan vanzelf bij het goedkeuren, of neem ze hieronder over uit Exact."),
    ),
    h(
      "div",
      { class: "kaart" },
      h("h2", {}, "Relaties overnemen uit Exact"),
      h("p", { class: "uitleg" }, "Plak de relaties met hun Exact-code, zodat boekingen op de bestaande relatie terechtkomen en er geen dubbele relaties ontstaan."),
      importVak,
      h("div", { class: "knoppen", style: "margin-top:10px" }, h("button", { class: "knop", onclick: probeer(async () => { const r = await api(`/administraties/${adminId}/relaties/import`, "POST", { tekst: importVak.value }); meld(`${r.toegevoegd} relaties overgenomen`); toon(); }) }, "Overnemen")),
    ),
  );
}

// ---------- Start ----------
// ---------- Alle administraties ----------
async function paginaOverzicht() {
  const rijen = await api("/overzicht");
  const kies = async (a) => {
    adminId = a.id;
    localStorage.setItem("adminId", adminId);
    $("#adminKeuze").value = adminId;
    await laadAdmin();
    location.hash = "#/start";
  };
  const som = (sleutel) => rijen.reduce((t, r) => t + r[sleutel], 0);
  const tegel = (groot, klein) => h("div", { class: "tegel" }, h("div", { class: "getal-groot" }, groot), h("div", { class: "zacht" }, klein));
  vul(
    inhoud,
    h("div", { class: "paginakop" }, h("div", {}, h("div", { class: "kicker" }, "Kantoor"), h("h1", {}, "Alle administraties"), h("div", { class: "zacht" }, "De werkvoorraad per administratie waar u toegang toe heeft"))),
    h("div", { class: "tegels", style: "margin-bottom:16px" }, tegel(String(rijen.length), "administraties"), tegel(String(som("open")), "documenten te beoordelen"), tegel(String(som("wacht")), "in de wacht"), tegel(String(som("goedgekeurd")), "goedgekeurd, klaar voor export")),
    h(
      "div",
      { class: "kaart" },
      rijen.length
        ? h(
            "div",
            { class: "tabelrol" },
            h(
              "table",
              { class: "lijst" },
              h("thead", {}, h("tr", {}, h("th", {}, "Administratie"), ["Te beoordelen", "In de wacht", "Klaar voor export", "Geëxporteerd"].map((t) => h("th", { class: "getal" }, t)), h("th", {}, "Laatst aangeleverd"))),
              h(
                "tbody",
                {},
                [...rijen]
                  .sort((x, y) => y.open - x.open || x.naam.localeCompare(y.naam))
                  .map((r) =>
                    h(
                      "tr",
                      { class: "klikbaar", onclick: () => kies(r) },
                      h("td", {}, h("b", {}, r.naam), r.bezig ? h("span", { class: "label" }, `${r.bezig} wordt uitgelezen`) : null),
                      h("td", { class: "getal" }, r.open ? h("span", { class: "chip controle" }, r.open) : "0"),
                      h("td", { class: "getal" }, r.wacht || "0"),
                      h("td", { class: "getal" }, r.goedgekeurd || "0"),
                      h("td", { class: "getal" }, r.geexporteerd || "0"),
                      h("td", { class: "zacht" }, r.laatst ? new Date(r.laatst).toLocaleDateString("nl-NL") : "–"),
                    ),
                  ),
              ),
            ),
          )
        : h("div", { class: "leeg" }, ik?.rol === "beheerder" ? "Nog geen administraties. Maak er links een aan." : "U heeft nog geen toegang tot een administratie."),
    ),
  );
}

// ---------- Gebruikers (beheerder) ----------
async function paginaGebruikers() {
  const [gebruikers, admins] = await Promise.all([api("/gebruikers"), api("/administraties")]);
  const wijzig = probeer(async (g, velden) => {
    Object.assign(g, await api(`/gebruikers/${g.id}`, "PUT", velden));
    meld("Opgeslagen");
    toon();
  });
  const toegang = (g) => {
    if (g.rol === "beheerder") return h("span", { class: "zacht" }, "alle (beheerder)");
    const alle = h("label", { style: "display:flex;gap:6px;align-items:center" }, h("input", { type: "checkbox", checked: g.administraties === "alle", onchange: (e) => wijzig(g, { administraties: e.target.checked ? "alle" : [] }) }), "Alle administraties");
    if (g.administraties === "alle") return alle;
    return h("div", {}, alle, admins.map((a) => h("label", { style: "display:flex;gap:6px;align-items:center" }, h("input", { type: "checkbox", checked: g.administraties.includes(a.id), onchange: (e) => wijzig(g, { administraties: e.target.checked ? [...g.administraties, a.id] : g.administraties.filter((x) => x !== a.id) }) }), a.naam)));
  };
  const rol = (g) => {
    const s = h("select", { style: "width:auto", onchange: (e) => wijzig(g, { rol: e.target.value }) }, h("option", { value: "medewerker" }, "Medewerker"), h("option", { value: "beheerder" }, "Beheerder"));
    s.value = g.rol;
    return s;
  };
  const nieuw = { naam: "", email: "", rol: "medewerker", wachtwoord: "", administraties: "alle" };
  const veldNieuw = (sleutel, attrs = {}) => h("input", { oninput: (e) => (nieuw[sleutel] = e.target.value), ...attrs });
  const rolNieuw = h("select", { onchange: (e) => (nieuw.rol = e.target.value) }, h("option", { value: "medewerker" }, "Medewerker"), h("option", { value: "beheerder" }, "Beheerder"));
  vul(
    inhoud,
    h("div", { class: "paginakop" }, h("div", {}, h("div", { class: "kicker" }, "Kantoor"), h("h1", {}, "Gebruikers"), h("div", { class: "zacht" }, "Wie mag aanmelden, met welke rol en bij welke administraties"))),
    h(
      "div",
      { class: "kaart" },
      h(
        "div",
        { class: "tabelrol" },
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Naam", "E-mailadres", "Rol", "Toegang tot", "Actief", ""].map((t) => h("th", {}, t)))),
          h(
            "tbody",
            {},
            gebruikers.map((g) =>
              h(
                "tr",
                { style: g.actief ? "" : "opacity:.55" },
                h("td", {}, h("b", {}, g.naam), g.id === ik.id ? h("span", { class: "label leert" }, "u") : null, g.moetWijzigen ? h("span", { class: "label letop" }, "tijdelijk wachtwoord") : null),
                h("td", {}, g.email),
                h("td", {}, rol(g)),
                h("td", {}, toegang(g)),
                h("td", {}, h("input", { type: "checkbox", checked: g.actief, title: "Uitgezette gebruikers kunnen niet meer aanmelden", onchange: (e) => wijzig(g, { actief: e.target.checked }) })),
                h("td", {}, h("button", { class: "knop klein", onclick: probeer(async () => { const w = prompt(`Nieuw tijdelijk wachtwoord voor ${g.naam} (minstens 10 tekens). De gebruiker moet het bij de volgende aanmelding wijzigen.`); if (w) await wijzig(g, { wachtwoord: w }); }) }, "Wachtwoord instellen")),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "kaart" },
      h("h2", {}, "Gebruiker toevoegen"),
      h("div", { class: "rooster" }, veld("Naam", veldNieuw("naam")), veld("E-mailadres (inlognaam)", veldNieuw("email", { type: "email", autocomplete: "off" })), veld("Rol", rolNieuw), veld("Tijdelijk wachtwoord (minstens 10 tekens)", veldNieuw("wachtwoord", { type: "text", autocomplete: "off" }))),
      h("p", { class: "uitleg", style: "margin:10px 0" }, "De nieuwe gebruiker krijgt toegang tot alle administraties; u kunt dat daarna in de tabel beperken. Geef het tijdelijke wachtwoord persoonlijk door; bij de eerste aanmelding moet het worden gewijzigd."),
      h("button", { class: "knop hoofd", onclick: probeer(async () => { await api("/gebruikers", "POST", nieuw); meld("Gebruiker toegevoegd"); toon(); }) }, "Toevoegen"),
    ),
    h("div", { class: "kaart uitleg" }, h("h2", {}, "Rollen"), h("p", {}, h("b", {}, "Beheerder: "), "alle administraties, gebruikers beheren en administraties aanmaken."), h("p", {}, h("b", {}, "Medewerker: "), "documenten verwerken, instellingen en export van de administraties waartoe toegang is gegeven.")),
  );
}

// ---------- Logboek ----------
async function paginaLogboek() {
  const regels = await api("/logboek");
  let zoek = "";
  const body = h("tbody", {});
  const teken = () =>
    vul(
      body,
      regels
        .filter((r) => !zoek || [r.gebruiker, r.actie, r.administratie, r.detail].join(" ").toLowerCase().includes(zoek.toLowerCase()))
        .map((r) => h("tr", {}, h("td", { class: "zacht", style: "white-space:nowrap" }, new Date(r.tijd).toLocaleString("nl-NL")), h("td", {}, r.gebruiker), h("td", {}, r.actie), h("td", {}, r.administratie), h("td", { class: "zacht" }, r.documentId ? h("a", { href: `#/document/${r.documentId}` }, r.detail || `document ${r.documentId}`) : r.detail))),
    );
  teken();
  vul(
    inhoud,
    h("div", { class: "paginakop" }, h("div", {}, h("div", { class: "kicker" }, "Kantoor"), h("h1", {}, "Logboek"), h("div", { class: "zacht" }, ik?.rol === "beheerder" ? "Wie wat heeft gedaan, in alle administraties" : "Wie wat heeft gedaan in uw administraties"))),
    h("div", { class: "kaart" }, h("input", { type: "search", placeholder: "Zoek op gebruiker, handeling of administratie", style: "max-width:340px;margin-bottom:12px", oninput: (e) => ((zoek = e.target.value), teken()) }), regels.length ? h("div", { class: "tabelrol" }, h("table", {}, h("thead", {}, h("tr", {}, ["Tijdstip", "Gebruiker", "Handeling", "Administratie", "Betreft"].map((t) => h("th", {}, t)))), body)) : h("div", { class: "leeg" }, "Nog niets vastgelegd."), h("p", { class: "uitleg", style: "margin:10px 0 0" }, "De laatste 500 handelingen. Het logboek kan niet worden gewijzigd of gewist vanuit het programma.")),
  );
}

// ---------- Mijn account ----------
async function paginaAccount() {
  const w = { huidig: "", nieuw: "", herhaal: "" };
  const veldW = (sleutel, auto) => h("input", { type: "password", autocomplete: auto, oninput: (e) => (w[sleutel] = e.target.value) });
  vul(
    inhoud,
    h("div", { class: "paginakop" }, h("div", {}, h("div", { class: "kicker" }, "Kantoor"), h("h1", {}, "Mijn account"), h("div", { class: "zacht" }, `${ik.naam} · ${ik.email} · ${ik.rol}`))),
    h(
      "div",
      { class: "kaart", style: "max-width:520px" },
      h("h2", {}, "Wachtwoord wijzigen"),
      h("div", { style: "display:flex;flex-direction:column;gap:12px" }, veld("Huidig wachtwoord", veldW("huidig", "current-password")), veld("Nieuw wachtwoord (minstens 10 tekens)", veldW("nieuw", "new-password")), veld("Nieuw wachtwoord nogmaals", veldW("herhaal", "new-password"))),
      h("button", { class: "knop hoofd", style: "margin-top:14px", onclick: probeer(async () => { if (w.nieuw !== w.herhaal) return meld("De twee nieuwe wachtwoorden zijn niet gelijk.", true); await api("/auth/wachtwoord", "POST", w); meld("Wachtwoord gewijzigd"); toon(); }) }, "Wachtwoord wijzigen"),
    ),
  );
}

// ---------- Aanmelden ----------
let ik = null;
function toonAanmelden(soort) {
  clearTimeout(verversTimer);
  if (document.body.classList.contains("aanmelden") && $("#aanmeldvak").dataset.soort === soort) return;
  document.body.classList.add("aanmelden");
  const vak = $("#aanmeldvak");
  vak.dataset.soort = soort;
  const fout = h("div", { class: "foutregel", role: "alert" });
  const invoer = (label, attrs) => veld(label, h("input", { required: true, ...attrs }));
  const teksten = {
    aanmelden: ["Aanmelden", "Meld u aan met uw e-mailadres en wachtwoord.", "Aanmelden"],
    setup: ["Eerste gebruik", "Maak de eerste beheerder aan. Deze kan daarna collega's toevoegen.", "Beheerder aanmaken"],
    wijzigen: ["Nieuw wachtwoord kiezen", "U heeft een tijdelijk wachtwoord. Kies nu een eigen wachtwoord van minstens 10 tekens.", "Wachtwoord opslaan"],
  }[soort];
  const velden = {
    aanmelden: [invoer("E-mailadres", { name: "email", type: "email", autocomplete: "username", autofocus: true }), invoer("Wachtwoord", { name: "wachtwoord", type: "password", autocomplete: "current-password" })],
    setup: [invoer("Uw naam", { name: "naam", autocomplete: "name", autofocus: true }), invoer("E-mailadres (inlognaam)", { name: "email", type: "email", autocomplete: "username" }), invoer("Wachtwoord (minstens 10 tekens)", { name: "wachtwoord", type: "password", autocomplete: "new-password", minlength: 10 })],
    wijzigen: [invoer("Tijdelijk wachtwoord", { name: "huidig", type: "password", autocomplete: "current-password", autofocus: true }), invoer("Nieuw wachtwoord", { name: "nieuw", type: "password", autocomplete: "new-password", minlength: 10 }), invoer("Nieuw wachtwoord nogmaals", { name: "herhaal", type: "password", autocomplete: "new-password", minlength: 10 })],
  }[soort];
  const formulier = h(
    "form",
    {
      onsubmit: async (e) => {
        e.preventDefault();
        fout.textContent = "";
        const d = Object.fromEntries(new FormData(formulier));
        try {
          if (soort === "wijzigen" && d.nieuw !== d.herhaal) throw new Error("De twee nieuwe wachtwoorden zijn niet gelijk.");
          await api({ aanmelden: "/auth/aanmelden", setup: "/auth/setup", wijzigen: "/auth/wachtwoord" }[soort], "POST", d);
          delete vak.dataset.soort;
          await begin();
        } catch (err) {
          fout.textContent = err.message;
        }
      },
    },
    velden,
    fout,
    h("button", { class: "knop hoofd", type: "submit" }, teksten[2]),
    soort === "wijzigen" ? h("button", { class: "knop", type: "button", onclick: afmelden }, "Afmelden") : null,
  );
  vul(vak, h("img", { src: "img/beuk.png", alt: "Beuk Accountants & Belastingadviseurs" }), h("div", { class: "kicker" }, "Scan & Herken"), h("h1", {}, teksten[0]), h("div", { class: "zacht" }, teksten[1]), formulier);
  vak.querySelector("[autofocus]")?.focus();
}
async function afmelden() {
  await api("/auth/afmelden", "POST").catch(() => {});
  ik = null;
  onopgeslagen = false;
  toonAanmelden("aanmelden");
}

// ---------- Start van het programma ----------
async function begin() {
  try {
    ik = await api("/auth/ik");
  } catch (e) {
    if (e.status === 401) return toonAanmelden(e.data.setup ? "setup" : "aanmelden");
    return vul(inhoud, h("div", { class: "kaart leeg" }, `Kan de server niet bereiken: ${e.message}`));
  }
  if (ik.moetWijzigen) return toonAanmelden("wijzigen");
  document.body.classList.remove("aanmelden");
  try {
    meta = await api("/meta");
    $("#model").textContent = `AI-model: ${meta.model}`;
    vul($("#wie"), ik.zonderAanmelden ? null : [h("b", {}, ik.naam), h("a", { href: "#/account" }, "Mijn account"), h("a", { onclick: afmelden }, "Afmelden")]);
    $("#menuGebruikers").hidden = ik.rol !== "beheerder";
    $("#nieuweAdmin").hidden = ik.rol !== "beheerder";
    const lijst = await laadAdmins();
    await laadAdmin();
    // Met meer dan één administratie begint een medewerker bij het overzicht van de werkvoorraad.
    if (!location.hash || location.hash === "#/") location.hash = lijst.length > 1 ? "#/overzicht" : "#/start";
    vasteHash = location.hash;
    toon();
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) vul(inhoud, h("div", { class: "kaart leeg" }, `Kan de server niet bereiken: ${e.message}`));
  }
}
begin();

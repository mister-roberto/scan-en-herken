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

async function api(pad, methode = "GET", body) {
  const r = await fetch("/api" + pad, {
    method: methode,
    headers: body instanceof FormData || body === undefined ? {} : { "content-type": "application/json" },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
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
const STATUS = { wachtrij: "In wachtrij", bezig: "Wordt uitgelezen…", controle: "Controleren", gereed: "Klaar voor akkoord", goedgekeurd: "Goedgekeurd", geexporteerd: "Geëxporteerd", fout: "Mislukt" };
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
  location.hash = "#/documenten";
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
const paginas = { documenten: paginaDocumenten, document: paginaDocument, feedback: paginaFeedback, btw: paginaBtw, export: paginaExport, profiel: paginaProfiel, grootboek: paginaGrootboek, btwcodes: paginaBtwcodes, relaties: paginaRelaties };

async function toon() {
  clearTimeout(verversTimer);
  const [, naam = "documenten", arg] = location.hash.split("/");
  document.querySelectorAll("#menu a").forEach((a) => a.classList.toggle("actief", a.getAttribute("href") === `#/${naam === "document" ? "documenten" : naam}`));
  if (!adminId) {
    vul(inhoud, 
      h("div", { class: "kaart leeg" }, h("h1", {}, "Welkom bij Scan & Herken"), h("p", {}, "Maak eerst een administratie aan voor het bedrijf waarvan u facturen en bonnen wilt verwerken."), h("button", { class: "knop hoofd", onclick: () => $("#nieuweAdmin").click() }, "Administratie aanmaken")),
    );
    return;
  }
  try {
    await (paginas[naam] ?? paginaDocumenten)(arg);
  } catch (e) {
    vul(inhoud, h("div", { class: "kaart leeg" }, e.message));
  }
}
window.addEventListener("hashchange", toon);
// Ctrl+Enter keurt het geopende document goed.
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") document.getElementById("goedkeurKnop")?.click();
});

const kop = (titel, uitleg, ...rechts) => h("div", { class: "paginakop" }, h("div", {}, h("h1", {}, titel), uitleg && h("div", { class: "zacht" }, uitleg)), h("div", { class: "knoppen" }, rechts));
const veld = (label, invoer, klasse = "") => h("label", { class: `veld ${klasse}` }, h("span", {}, label), invoer);

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
    goedgekeurd: (d) => d.status === "goedgekeurd",
    geexporteerd: (d) => d.status === "geexporteerd",
  };
  const namen = { alle: "Alle", controleren: "Te beoordelen", goedgekeurd: "Goedgekeurd", geexporteerd: "Geëxporteerd" };
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
          {},
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
                h("td", {}, [d.fouten ? `${d.fouten} fout${d.fouten > 1 ? "en" : ""}` : "", d.waarschuwingen ? `${d.waarschuwingen} let op` : ""].filter(Boolean).join(", ")),
                h("td", { class: "zacht" }, d.bestandsnaam, d.efactuur ? h("span", { class: "label leert" }, "e-factuur") : null),
              ),
            ),
          ),
        ),
      )
    : h("div", { class: "leeg" }, docs.length ? "Geen documenten in deze weergave." : "Nog geen documenten. Lever hierboven de eerste factuur of bon aan.");

  vul(inhoud, kop("Documenten", admin.profiel.naam), h("div", { class: "kaart" }, vak), h("div", { class: "kaart" }, balk, tabs, tabel));
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
  const voorbeeld = h("div", { class: "voorbeeld" }, doc.mime !== "application/pdf" && !/xml/.test(doc.mime) ? h("img", { src: bron, alt: "Document" }) : h("iframe", { src: bron, title: "Document", style: /xml/.test(doc.mime) ? "background:#fff" : "" }) );

  const signalenVak = h("div", {});
  const journaalVak = h("div", {});
  const feedbackVak = h("div", {});
  const statusVak = h("span", {});
  function tekenUitkomst() {
    vul(statusVak, chip(doc.status));
    tekenFeedback();
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

  const kopKnoppen = [h("a", { class: "knop", href: "#/documenten" }, "← Terug"), statusVak];
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
    doc.goedgekeurdOp ? h("p", { class: "uitleg", style: "margin:10px 0 0" }, `Goedgekeurd op ${new Date(doc.goedgekeurdOp).toLocaleString("nl-NL")}${doc.geexporteerdOp ? ` · geëxporteerd op ${new Date(doc.geexporteerdOp).toLocaleString("nl-NL")}` : ""}`) : null,
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
                  const rest = (await api(`/administraties/${adminId}/documenten`)).filter((d) => ["controle", "gereed"].includes(d.status));
                  meld("Goedgekeurd");
                  location.hash = rest.length ? `#/document/${rest[rest.length - 1].id}` : "#/documenten";
                } catch (e) {
                  if (e.data?.document) ((doc = e.data.document), tekenUitkomst());
                  meld(e.message, true);
                }
              },
            },
            "Goedkeuren",
          ),
          h("button", { class: "knop", onclick: probeer(async () => (confirm("Het document opnieuw laten uitlezen? Uw wijzigingen gaan verloren.") && (await api(`/documenten/${id}/opnieuw`, "POST"), toon()))) }, "Opnieuw uitlezen"),
          verwijderKnop(id),
        ],
  );

  tekenRegels();
  tekenUitkomst();
  vul(inhoud, 
    kop(`${b.relatieNaam || doc.bestandsnaam}`, doc.bestandsnaam, kopKnoppen),
    h("div", { class: "splits" }, voorbeeld, h("div", {}, formulier, regelsKaart, h("div", { class: "kaart" }, signalenVak), h("div", { class: "kaart" }, journaalVak), h("div", { class: "kaart" }, feedbackVak), acties)),
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
    kop("Export naar Exact", admin.profiel.naam),
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
      h("td", {}, kies(gbOpties, r, "standaardGrootboek")),
      h("td", {}, kies(btwOpties, r, "standaardBtw")),
      h("td", { style: "text-align:center" }, h("input", { type: "checkbox", checked: r.vast, title: "Altijd deze rekening en btw gebruiken", onchange: (e) => wijzig(r, { vast: e.target.checked }) })),
      h("td", {}, inv(r, "instructie", "min-width:160px")),
      h("td", {}, h("button", { class: "knop klein gevaar", onclick: probeer(async () => (confirm(`Relatie ${r.naam} verwijderen?`) && (await api(`/relaties/${r.id}`, "DELETE"), toon()))) }, "×")),
    ),
  );
  vul(inhoud, 
    kop("Relaties", "Leveranciers en afnemers, en hoe ze worden geboekt."),
    h(
      "div",
      { class: "kaart" },
      h("p", { class: "uitleg" }, "Bij elke goedkeuring onthoudt het programma op welke rekening en met welke btw een relatie is geboekt; de AI gebruikt dat bij de volgende factuur. Zet ‘Vast’ aan om de rekening en btw-behandeling af te dwingen, en gebruik ‘Instructie’ voor uitzonderingen (bv. “servicekosten apart op 4110”)."),
      rijen.length ? h("div", { class: "tabelrol" }, h("table", {}, h("thead", {}, h("tr", {}, ["Code", "Naam", "Soort", "Btw-nummer", "Standaardrekening", "Standaard btw", "Vast", "Instructie voor de AI", ""].map((t) => h("th", {}, t)))), h("tbody", {}, rijen))) : h("div", { class: "leeg" }, "Nog geen relaties. Ze ontstaan vanzelf bij het goedkeuren, of neem ze hieronder over uit Exact."),
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
(async () => {
  try {
    meta = await api("/meta");
    $("#model").textContent = `AI-model: ${meta.model}`;
    await laadAdmins();
    await laadAdmin();
    if (!location.hash) location.hash = "#/documenten";
    toon();
  } catch (e) {
    vul(inhoud, h("div", { class: "kaart leeg" }, `Kan de server niet bereiken: ${e.message}`));
  }
})();

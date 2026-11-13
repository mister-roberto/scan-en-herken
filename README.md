# Scan & Herken

Facturen en bonnen aanleveren, met AI laten uitlezen, omzetten in journaalposten en exporteren naar Exact Online.

## Wat het doet

1. **Aanleveren** – sleep PDF's of foto's in het scherm, of maak op een telefoon direct een foto.
2. **Uitlezen met AI** – Claude leest het document en maakt een boekingsvoorstel: relatie, factuurnummer, datums, regels per grootboekrekening en btw-behandeling.
3. **Bedrijfsprofiel** – per administratie legt u vast wat het bedrijf doet, de btw-positie, het rekeningschema, boekingsinstructies en bekende relaties. De AI krijgt dit bij elk document mee.
4. **Controle volgens de Wet OB** – vaste regels, los van de AI, controleren elk voorstel (zie hieronder).
5. **Beoordelen** – document en boeking naast elkaar; aanpassen, journaalpost bekijken, goedkeuren.
6. **Leren** – bij goedkeuring onthoudt het programma hoe een relatie is geboekt.
7. **Export** – Exact Online XML, CSV, en een journaalpostenoverzicht ter controle.

## Starten

Vereist: Node.js 22.18 of hoger.

```bash
npm install
```

Uitproberen zonder AI (vaste voorbeelddocumenten):

```bash
npm run demo
```

Met AI: zet een API-sleutel van Anthropic in de omgevingsvariabele `ANTHROPIC_API_KEY` en start:

```bash
npm start
```

Open daarna http://localhost:3000.

| Variabele | Betekenis | Standaard |
|---|---|---|
| `ANTHROPIC_API_KEY` | API-sleutel voor het uitlezen | – |
| `SCAN_MODEL` | AI-model | `claude-opus-5-5` |
| `SCAN_DATA` | Map voor database en bestanden | `./data` |
| `PORT` / `HOST` | Adres van de webserver | `3000` / `127.0.0.1` |
| `SCAN_DEMO=1` | Demomodus zonder AI | uit |

## Eerste inrichting van een administratie

1. **Bedrijfsprofiel**: naam, handelsnamen, KvK- en btw-nummer (hieraan wordt inkoop of verkoop en de tenaamstelling herkend), btw-status, activiteiten en boekingsinstructies.
2. **Rekeningschema**: plak het schema uit Exact als `code;omschrijving`.
3. **Btw-codes**: vul per btw-behandeling de btw-code uit Exact in (Stamgegevens → Btw-codes). Zonder code wordt een boeking niet geëxporteerd.
4. **Relaties**: plak de bestaande relaties uit Exact als `code;naam;btw-nummer;soort`, zodat er geen dubbele relaties ontstaan. Nieuwe relaties krijgen een code vanaf het startnummer in het profiel en gaan eenmalig mee in de XML-export.

## Btw-controles

De regels staan in `src/btw.ts`, `src/boeking.ts` en `src/validatie.ts`:

- tarieven 21% / 9% / 0% (ook oude tarieven op basis van de factuurdatum), btw-bedrag rekenkundig gecontroleerd;
- regels moeten optellen tot het factuurtotaal; journaalpost altijd in evenwicht;
- binnenlandse verlegging (art. 12 lid 5), intracommunautaire verwerving, diensten uit EU en van buiten de EU, invoer met of zonder art. 23: af te dragen én te vorderen btw;
- buitenlandse btw: niet aftrekbaar, als kosten geboekt;
- horeca (art. 15 lid 5): geen aftrek; signalen voor BUA, autokosten, logies (21% sinds 2026) en investeringen;
- KOR, vrijgestelde prestaties en pro rata-aftrek op basis van het bedrijfsprofiel;
- factuurvereisten voor aftrek (art. 35a), vereenvoudigde factuur tot € 100, tenaamstelling;
- formaat btw-nummer, IBAN-controle, dubbele facturen, datums.

Een **fout** blokkeert de goedkeuring; een **let op** vraagt om een bewuste beoordeling.

## Over "100% juist"

Geen enkele AI leest elk document gegarandeerd foutloos. Het programma is daarom zo opgezet dat een fout niet ongemerkt in de administratie komt: de AI kent het bedrijf, vaste regels controleren elk voorstel, twijfel wordt gemeld, en niets gaat naar Exact zonder goedkeuring.

## Exact

- **XML**: Import/Export → XML → Importeren (Boekingen/GLTransactions). Per boeking het dagboek, de relatie, de grootboekrekening, het bedrag exclusief btw en de btw-code; Exact berekent de btw en de tegenregel.
- **CSV**: één rij per boekingsregel, voor een eigen importdefinitie.
- Doe eerst een **proefimport** met één of twee boekingen. Het XML-formaat is opgezet volgens de Exact Online-structuur maar nog niet tegen een echte Exact-omgeving getest.
- **Directe koppeling (later)**: de export staat los in `src/exact.ts`. Een koppeling met de Exact Online REST-API (OAuth, boekingen en bijlagen direct inschieten, rekeningschema en relaties ophalen) kan daar naast worden gezet zonder de rest te wijzigen.

## Privacy en beveiliging

- Documenten worden voor het uitlezen naar de API van Anthropic gestuurd. Regel dit in de verwerkersafspraken met klanten.
- De database en de bestanden staan lokaal in de datamap.
- Er is nog geen inlogscherm. De server luistert daarom standaard alleen op de eigen computer. Zet hem niet open op een netwerk of internet zonder eerst toegangsbeveiliging toe te voegen.

## Ontwikkelen

```bash
npm test
```

```bash
npm run typecheck
```

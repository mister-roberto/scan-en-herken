# Scan & Herken

Facturen en bonnen aanleveren, met AI laten uitlezen, omzetten in journaalposten en exporteren naar Exact Online.

## Wat het doet

1. **Aanleveren** – sleep PDF's of foto's in het scherm, of maak op een telefoon direct een foto.
2. **Uitlezen met AI** – Claude leest het document en maakt een boekingsvoorstel: relatie, factuurnummer, datums, regels per grootboekrekening en btw-behandeling.
3. **Bedrijfsprofiel** – per administratie legt u vast wat het bedrijf doet, de btw-positie, het rekeningschema, boekingsinstructies en bekende relaties. De AI krijgt dit bij elk document mee.
4. **Controle volgens de Wet OB** – vaste regels, los van de AI, controleren elk voorstel (zie hieronder).
5. **Beoordelen** – document en boeking naast elkaar; aanpassen, journaalpost bekijken, goedkeuren.
6. **Feedback en leren** – elke correctie op een AI-voorstel wordt een leerpunt, en u kunt de AI in eigen woorden iets uitleggen. Zie hieronder.
7. **Export** – Exact Online XML, CSV, en een journaalpostenoverzicht ter controle.
8. **Btw-overzicht** – de goedgekeurde boekingen per periode ingedeeld naar de rubrieken van de aangifte, als controle op Exact.

## Starten

**Eenvoudig:** dubbelklik op `start.bat` (Windows) of voer `./start.sh` uit (Mac/Linux). De browser opent op http://localhost:3000. Zonder API-sleutel start het programma in demomodus. Voor het uitlezen met AI kopieert u `.env.voorbeeld` naar `.env` en vult u daarin de API-sleutel van Anthropic in.

**Handmatig:**

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
| `SCAN_WACHTWOORD` | Wachtwoord voor de webapplicatie (verplicht zodra `HOST` niet de eigen computer is) | – |
| `SCAN_DEMO=1` | Demomodus zonder AI | uit |

## Eerste inrichting van een administratie

1. **Bedrijfsprofiel**: naam, handelsnamen, KvK- en btw-nummer (hieraan wordt inkoop of verkoop en de tenaamstelling herkend), btw-status, activiteiten en boekingsinstructies.
2. **Rekeningschema**: plak het schema uit Exact als `code;omschrijving`.
3. **Btw-codes**: vul per btw-behandeling de btw-code uit Exact in (Stamgegevens → Btw-codes). Zonder code wordt een boeking niet geëxporteerd.
4. **Relaties**: plak de bestaande relaties uit Exact als `code;naam;btw-nummer;soort`, zodat er geen dubbele relaties ontstaan. Nieuwe relaties krijgen een code vanaf het startnummer in het profiel en gaan eenmalig mee in de XML-export.

## Factuurvereisten

Bij elk document staat een paneel **Factuurvereisten** dat per wettelijk verplichte vermelding laat zien of die op de factuur staat (art. 35a Wet OB):

- datum van uitreiking en opeenvolgend factuurnummer;
- btw-identificatienummer van de leverancier, en van de afnemer bij verlegging of intracommunautaire prestaties;
- naam en adres van leverancier en afnemer;
- hoeveelheid en aard van de goederen of diensten, en de datum van levering als die afwijkt;
- maatstaf van heffing per tarief, eenheidsprijs exclusief btw, tarief en btw-bedrag;
- de vermelding bij verlegging of vrijstelling.

Tot € 100 inclusief btw gelden de lichtere eisen van de vereenvoudigde factuur (art. 34d Wet OB), behalve bij verlegging. Het oordeel is "voldoet", "voldoet niet" of "niet volledig beoordeeld". Ontbreekt er iets op een inkoopfactuur waarvan btw wordt afgetrokken, dan volgt een waarschuwing dat de aftrek bij een controle kan worden geweigerd; de boeking kan wel worden goedgekeurd, dat blijft uw afweging. Dezelfde toets werkt voor de eigen verkoopfacturen.

Of een vermelding op het document staat, stelt de AI vast; de toets zelf is een vaste regel. Documenten die vóór deze versie zijn uitgelezen tonen "niet volledig beoordeeld" tot ze opnieuw worden uitgelezen.

## Feedback en kwaliteit

- **Automatisch**: kiest u bij het goedkeuren een andere rekening, btw-behandeling of indeling dan de AI voorstelde, dan wordt dat vastgelegd als leerpunt voor die relatie.
- **In eigen woorden**: bij elk document kunt u opschrijven wat de AI moet leren, voor die relatie of voor alle documenten. Met "Opslaan en opnieuw uitlezen" wordt het document direct opnieuw verwerkt met uw aanwijzing.
- **Feedback & kwaliteit**: laat zien welk deel van de boekingen zonder correctie is goedgekeurd, bij welke relaties u het vaakst corrigeert en alle leerpunten. Leerpunten kunt u aanscherpen, uitzetten of verwijderen.
- Actieve leerpunten gaan bij elk volgend document mee naar de AI. Leesfouten (een verkeerd gelezen bedrag of nummer) tellen mee in de kwaliteitscijfers, maar worden geen leerpunt.

## E-facturen (UBL)

Naast PDF's en foto's kunt u e-facturen in XML aanleveren (UBL 2.1, zoals SI-UBL en Peppol). Factuurnummer, datum en soort komen dan rechtstreeks uit het bestand, en de boeking wordt gecontroleerd tegen het totaal en de btw in het bestand zelf. Een afwijking blokkeert de goedkeuring. De AI kiest alleen nog de grootboekrekening en de btw-behandeling.

## Sneller werken

- **Startpagina** met de volgende stap, de aantallen per status en een controlelijst voor de inrichting.
- **Vorige/volgende** bij een document, met de teller "2 van 5 te beoordelen"; na goedkeuren opent het eerstvolgende document.
- Klik op een foto om in of uit te zoomen. Instellingenpagina's waarschuwen bij niet-opgeslagen wijzigingen.
- **Zoeken** in de documentenlijst op relatie, factuurnummer, bedrag of bestandsnaam.
- **In één keer goedkeuren** van alle documenten zonder fout of waarschuwing; de rest blijft staan voor beoordeling.
- **Ctrl+Enter** keurt het geopende document goed en opent het volgende.
- **Bestaande relatie kiezen** bij een document: btw-nummer en land worden overgenomen.
- Bij elk document staat wanneer het is goedgekeurd en geëxporteerd.

## Voorbeelddocumenten

In de map `voorbeelden/` staan zeven oefendocumenten, waaronder een e-factuur en een factuur die niet aan de factuurvereisten voldoet. In de demomodus worden ze aan hun bestandsnaam herkend; de tankbonnen laten zien hoe feedback werkt.

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

### Wat nog niet is verwerkt

Het programma dekt de regels die bij gewone inkoop- en verkoopfacturen het meest voorkomen, niet de volledige Wet OB. Onder meer deze onderwerpen zijn niet of alleen als signaal aanwezig en vragen dus altijd een eigen beoordeling:

- margeregeling en reisbureauregeling (alleen herkend aan de vermelding op het document);
- onroerend goed: optie belaste verhuur of levering, herziening van aftrek;
- bijzondere plaats-van-dienstregels (art. 6a e.v.), afstandsverkopen en het éénloketsysteem (OSS), ketentransacties en vereenvoudigde ABC-levering;
- verlegging per sector in detail (bv. mobiele telefoons boven de drempel), en verlegde of zelf berekende btw tegen 9%;
- BUA-drempel en privégebruik auto: alleen een signaal, geen berekening;
- fiscale eenheid, kasstelsel, oninbare vorderingen, vouchers, nieuwe vervoermiddelen, accijnsgoederen, landbouwregeling;
- welke goederen en diensten precies onder Tabel I (9%) vallen: het tarief op de factuur wordt gevolgd en rekenkundig gecontroleerd, niet inhoudelijk getoetst;
- suppletie en de aangifte zelf.

## Over "100% juist"

Geen enkele AI leest elk document gegarandeerd foutloos. Het programma is daarom zo opgezet dat een fout niet ongemerkt in de administratie komt: de AI kent het bedrijf, vaste regels controleren elk voorstel, twijfel wordt gemeld, en niets gaat naar Exact zonder goedkeuring.

## Exact

- **XML**: Import/Export → XML → Importeren (Boekingen/GLTransactions). Per boeking het dagboek, de relatie, de grootboekrekening, het bedrag exclusief btw en de btw-code; Exact berekent de btw en de tegenregel.
- **CSV**: één rij per boekingsregel, voor een eigen importdefinitie.
- Doe eerst een **proefimport** met één of twee boekingen. Het XML-formaat is opgezet volgens de Exact Online-structuur maar nog niet tegen een echte Exact-omgeving getest.
- **Directe koppeling (later)**: de export staat los in `src/exact.ts`. Een koppeling met de Exact Online REST-API (OAuth, boekingen en bijlagen direct inschieten, rekeningschema en relaties ophalen) kan daar naast worden gezet zonder de rest te wijzigen.

## Huisstijl

De interface volgt de huisstijl van Beuk Accountants & Belastingadviseurs (kleuren en logo in `public/style.css` en `public/img/`).

## Privacy en beveiliging

- Documenten worden voor het uitlezen naar de API van Anthropic gestuurd. Regel dit in de verwerkersafspraken met klanten.
- De database en de bestanden staan lokaal in de datamap.
- De server luistert standaard alleen op de eigen computer. Wilt u hem via het netwerk bereikbaar maken (`HOST=0.0.0.0`), dan is `SCAN_WACHTWOORD` verplicht; de browser vraagt dan om dat wachtwoord (de gebruikersnaam is vrij). Dit is één gedeeld wachtwoord, geen gebruikersbeheer, en het beschermt alleen goed achter een https-verbinding.

## Ontwikkelen

```bash
npm test
```

```bash
npm run typecheck
```

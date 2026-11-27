# ioBroker.cortex – Konzept

> **Cortex beobachtet wiederkehrende manuelle Aktionen und schlägt die Automatisierungen vor,
> die dem Benutzer die meisten Handgriffe sparen.**

Stand: 2026-11-27 · Phase: Konzeption · ✅ entschieden · ❓ offen · 🔬 im Prototyp zu prüfen

## Was Cortex ist

Cortex beobachtet, wie die Bewohner ihr Smart Home **von Hand** bedienen, und schlägt daraus höchstens
**5 Automatisierungen** vor, die sich lohnen würden. Cortex handelt nie eigenmächtig – die Entscheidung trifft der
Benutzer. Ab Version 0.2 kann er einen Vorschlag mit einem Klick umsetzen; Cortex führt die Automation dann selbst
aus und prüft, ob sie passt (siehe „Umsetzen mit einem Klick“).

Cortex nutzt keine Cloud-KI. Alle Entscheidungen werden lokal aus den Beobachtungen des Smart Homes abgeleitet.
Dadurch bleiben die Daten im Haus und jede Empfehlung ist nachvollziehbar („an 14 von 17 Werktagen …“).

Leitfragen des Benutzers:

- Was hat mein Smart Home gelernt?
- Welche Automatisierung sollte ich erstellen?

## Wie Cortex lernt

1. **Beobachten** – Aktionen (Licht, Schalter, Dimmer, Rollladen) und Auslöser (Bewegung, Tür, Fenster)
2. **Unterscheiden** – hat ein **Mensch** oder ein **Skript** geschaltet? Nur menschliche Handgriffe zählen.
3. **Muster finden** (nachts, einmal am Tag)
   - Zeitmuster: „Wohnzimmerlicht werktags ca. 20 Min. nach Sonnenuntergang“
   - Auslöser → Aktion: „Bewegung im Flur → Flurlicht an, wenn es dunkel ist“
4. **Vorschlagen** – sortiert nach eingesparten Handgriffen pro Woche

## Oberflächen

| | Rolle |
|---|---|
| ioBroker-Admin | Konfiguration. Die erste Version wird **vollständig** im Admin bedient – auch Vorschläge annehmen, bearbeiten, ablehnen. |
| SmartVis | Langfristig die **bevorzugte Benutzeroberfläche** für Cortex. Anbindung über ein Cortex-Profil in SmartVis. |
| States | Alle Ergebnisse stehen als ioBroker-States bereit – für andere VIS und Skripte. |

## Rahmenentscheidungen ✅

| Thema | Entscheidung |
|---|---|
| Unabhängigkeit | Cortex läuft eigenständig auf jedem ioBroker-System; setzt weder SmartVis noch einen History-Adapter voraus |
| Generisch | Keine Sonderlogik für einzelne Adapter oder Installationen. Probleme wie Szenen/Gruppen oder Automationen außerhalb von ioBroker werden allgemein gelöst (Standard-Rollen, `ack`/`from`, Zeitverhalten, Einstellungen) |
| Erkennung | Eigene Erkennung in Cortex über Standard-Rollen (`common.role`) und `enum.rooms`; kein gemeinsames Paket mit SmartVis. `@iobroker/type-detector` nur, falls Rollen in der Praxis nicht reichen |
| Hardware | Raspberry Pi bis Intel NUC; keine hardwareabhängigen Modi (die Last ist klein, siehe Datenhaltung) |
| Altdaten | Kein Import aus history/influxdb/sql; Cortex sammelt selbst |
| Technik | TypeScript, Node ≥ 22; Werkzeuge, Workflows und Konventionen wie ioBroker.smartvis (zentraler Workflow, Verteilung über npm) |
| Analyse | Statistische Auswertung (Zählen, Zeitfenster, Verhältnisse) – keine neuronalen Netze, keine Blackbox |
| Qualität | Lieber kein Vorschlag als ein schlechter: konservative Standard-Schwellwerte |

## Kernproblem: Mensch oder Skript?

Nur **manuelle** Aktionen sind Kandidaten für Vorschläge – sonst schlägt Cortex bestehende Automationen erneut vor.
Version 0.0.1 dient ausschließlich dazu, zu beweisen, dass diese Unterscheidung zuverlässig funktioniert.
Gelingt das nicht, ist jede spätere Mustererkennung wertlos.

Einstufung jedes Ereignisses beim Eingang:

| Signal | Einstufung |
|---|---|
| `ack=false`, `from=system.adapter.javascript.*` / Szenen- und Logik-Adapter | `script` (automatisch) |
| `ack=false`, `from=system.adapter.{web,admin,smartvis,alexa2,…}.*` oder `from=system.user.*` | `ui` (manuell) |
| `ack=true` vom Geräte-Adapter **ohne** vorangegangenen Befehl | `device` – physischer Schalter oder Hersteller-App (manuell) |
| wie `device`, aber höchstens 3 s nach einem Sensor **derselben Instanz** | `external` – Automation der Bridge/Zentrale (Hue-Bewegungsmelder, CCU-Programm); automatisch. Solche Systeme steuern nur eigene Geräte, und ein Mensch braucht länger vom Bewegungsmelder bis zum Schalter |
| `ack=true` vom Geräte-Adapter **nach** einem Befehl | Bestätigung – kein eigenes Ereignis, erbt die Einstufung des Befehls |
| Sensor-Rollen (`sensor.motion`, `sensor.door`, `sensor.window`, …) | `sensor` |
| Befehl eines Adapters, der in keiner Liste steht | `other` – wird in `stats.unknownSenders` angezeigt, damit der Benutzer ihn zuordnen kann |

Mehrere Änderungen eines Adapters innerhalb kurzer Zeit (Standard 2 s) zählen als **eine** Aktion – so werden
Szenen und Gruppen allgemein behandelt, ohne Adapter-Sonderlogik.

Folgen eines Befehls übernehmen dessen Herkunft:

- Meldungen **desselben Geräts** (Status-Kanal, Zwischenstände eines fahrenden Rollladens), solange sie weiterkommen
  (Fenster 10 s, verlängert sich mit jeder Meldung)
- Meldungen **anderer Geräte derselben Instanz** nur unmittelbar danach (2 s): Lampen einer Gruppe oder Szene.
  Länger wäre falsch – eine ganze CCU ist eine Instanz, und ein Wandtaster-Druck kurz nach einem fremden Befehl
  wurde im ersten Test sonst dem Befehl zugeschlagen.

Bekanntes Restrisiko: Mehrere Ausgänge eines Aktors sind *ein* Gerät (z. B. 4 Rollläden an einem HmIPW-DRBL4).
Ein Tastendruck, während ein anderer Rollladen desselben Aktors noch fährt, wird dessen Befehl zugeordnet.

Erkenntnisse aus dem ersten echten System (Homematic IP, Philips Hue, eufy, Alexa, KEBA, Toshiba):

- Die Rolle `switch` wird auch für Einstellungen genutzt (eufy: 78 Kamera-Optionen). Bei `switch` und `state`
  zählen daher nur typische Ausgangs-Schlüssel (`STATE`, `on`, `POWER`, `Switch` …).
- Schreibgeschützte Ist-Zustände (`value.blind`, Status-Kanal mit `STATE`) müssen beobachtet werden: Ein Druck auf
  einen direkt verknüpften Wandtaster ist nur dort sichtbar.
- Die eigenen States von Oberflächen und Sprachassistenten (z. B. Bluetooth-Verbindungen eines Echo) sind keine Geräte.
- Homematic IP legt je Ausgang mehrere virtuelle Kanäle an; ohne Namensabgleich mit der CCU haben Kanäle nur
  Seriennummern als Namen. ❓ Vor 0.1 klären, wie Vorschläge diese Ausgänge benennen.

🔬 Offene Risiken, die der Rekorder klären soll:

- Nicht jeder Adapter setzt `from` zuverlässig (z. B. Polling-Adapter).
- Automationen außerhalb von ioBroker, die nicht auf einen Sensor reagieren (Zeitpläne der Bridge, Licht aus nach
  Ablauf einer Nachlaufzeit), bleiben `device`. Idee für 0.0.x: Zeitpläne sind präzise (täglich 07:00:00 ± wenige
  Sekunden), Menschen streuen.

Die Zuordnung „Adapter → Einstufung“ ist im Admin überschreibbar. Ein **anonymer Export** (ohne Namen, Räume
und Objekt-IDs) erlaubt, die Einstufung auch mit Daten anderer Installationen zu prüfen.

## Bausteine v0.1

### 1. Relevanz-Filter

Regelbasiert:

- **Auslöser**: diskrete Sensoren (Bewegung, Tür, Fenster, Taster)
- **Aktionen**: Licht, Schalter, Dimmer, Rollladen – **einschließlich Stellwerten** (Helligkeit, Position),
  damit Vorschläge wie „Licht auf 30 %“ möglich sind
- **Ausgeschlossen**: Messwerte (Temperatur, Leistung, Feuchte …)
- Raum und lesbarer Name aus `enum.rooms` und den Objektnamen von Gerät/Kanal
- Im Admin: Ein-/Ausschlussliste und Übersicht „was wird beobachtet“

### 2. Zeitmuster

- Bewertung über **Tage** („an 14 von 17 Werktagen“), nicht über Ereignisanzahl
- Gruppen: Werktag / Wochenende
- **Uhrzeit vs. Sonnenstand**: die Bezugsgröße mit der kleineren Streuung gewinnt
  („20 Min. nach Sonnenuntergang“); Koordinaten aus `system.config`

### 3. Auslöser → Aktion und Aktion ↔ Aktion

- Paare: Auslöser → manuelle Aktion innerhalb Δt (Standard 2 Min.); keine längeren Ketten in v0.1
- **Auch zwei Handgriffe bilden ein Paar, Reihenfolge egal**: „Licht Terrasse und Rollladen Terrassentür schaltest du
  abends fast immer zusammen“ – mal zuerst das Licht, mal zuerst den Rollladen. Gleiches Verfahren, nur ungeordnet.
  Vorschlag z. B.: „Licht automatisch mitschalten, wenn du den Rollladen nach Sonnenuntergang hochfährst – und beim
  Runterfahren wieder aus?“
- Kennzahlen: Konfidenz P(Aktion | Auslöser) und **Lift** gegenüber der Grundrate der Aktion
- Bedingung **„nur bei Dunkelheit“** (Sonnenstand) wird automatisch geprüft
- Seltene Paare (z. B. nur an Sommerabenden) brauchen genug Wiederholungen (Richtwert 8–10 in einigen Wochen);
  darunter erscheinen sie als Erkenntnis, nicht als Vorschlag

### 3a. Bedingung → Aktion (nach 0.2)

Dritte Musterart für Handgriffe, die weder an eine Uhrzeit noch an ein Ereignis gebunden sind, sondern an einen
**Zustand** – Beispiel Hitzeschutz: „Du fährst den Rollladen Wohnzimmer Süd an 18 von 21 Tagen herunter, wenn es
draußen über 26 °C hat und die Sonne auf der Südseite steht – an kühleren Tagen nie.“

- Vergleich der Umgebungswerte zum Zeitpunkt der Handgriffe mit den Werten, wenn nicht gehandelt wurde → Schwellwert
- Umgebungswerte: **Sonnenstand** (Höhe, Himmelsrichtung – berechnet aus Zeitstempel und Standort, wird nicht
  gespeichert), **Außentemperatur** und **Helligkeit** (vom Benutzer im Admin gewählte States, da sich nicht
  zuverlässig erkennen lässt, welcher Sensor „außen“ ist)
- ✅ **Die Aufzeichnung der Umgebungswerte läuft bereits im Rekorder** (alle 15 Minuten, eigenes Log). Grund: Ohne
  Altdaten-Import kann Cortex nur aus selbst gesammelten Daten lernen – wer erst später aufzeichnet, verliert einen
  Sommer.
- Hinweis: Übernimmt bereits shuttercontrol o. Ä. den Hitzeschutz, gibt es keine Handgriffe und keinen Vorschlag

### 4. Vorschläge

- Höchstens **5** gleichzeitig, sortiert nach **eingesparten Handgriffen pro Woche**
- Zeitmuster und Auslöser zur selben Aktion werden zu einem Vorschlag zusammengeführt
- Jeder Vorschlag hat eine Begründung in Klartext

Reaktionen des Benutzers:

| Reaktion | Bedeutung |
|---|---|
| **Annehmen** | 0.1: Der Benutzer setzt die Automation selbst um. Ab 0.2: „Umsetzen“ – Cortex führt sie als eigene Regel aus. |
| **Bearbeiten** | „Gute Idee, aber anders“: Zielwert (z. B. 30 %), Zeitfenster oder Bedingung (z. B. nur nachts) anpassen; danach gilt der Vorschlag als angenommen. Die Änderung fließt als Wissen zurück. |
| **Ablehnen** | Dauerhaft unterdrückt, solange sich die zugrunde liegenden Daten nicht wesentlich ändern (siehe unten). |
| **Später** | Ausgeblendet für einen Zeitraum (Standard 7 Tage). |

**Wann ein abgelehnter Vorschlag zurückkommen darf** – alle Bedingungen müssen erfüllt sein:

- seit der Ablehnung mindestens **doppelt so viele** Beobachtungen wie zum Zeitpunkt der Ablehnung,
- die Sicherheit liegt **deutlich höher** als damals (Standard +15 Prozentpunkte),
- mindestens **90 Tage** seit der Ablehnung.

Cortex sagt dann offen: „Du hast das früher abgelehnt, inzwischen habe ich deutlich mehr Daten.“
Eine **zweite** Ablehnung ist endgültig.

🔬 Bearbeiten im Admin: Umfang auf die Parameter beschränken, die Cortex selbst versteht (Zielwert, Zeitfenster,
Dunkelheit). Freie Regeln sind nicht vorgesehen.

### 5. State-API

| Zweck | States |
|---|---|
| SmartVis, Skripte | `suggestions.json` (atomar aktualisiert); `suggestions.feedback` (beschreibbar, `{"id":"…","action":"accept\|edit\|reject\|snooze", …}`) |
| Admin, vis-2, Jarvis … | feste Slots `suggestions.1` … `suggestions.5` mit `title`, `reason`, `savingsPerWeek` und Buttons |
| Status | `info.status` (`learning` / `ready`), `info.learningSinceDays`, `info.eventsToday`, `info.manualShare` |
| Erkenntnisse | `insights.json` – erkannte Muster unterhalb der Vorschlagsschwelle („Was hat mein Smart Home gelernt?“) |

Die feste Obergrenze von 5 Vorschlägen erlaubt die Darstellung im Admin (jsonConfig) ohne eigene Oberfläche.
🔬 Reicht jsonConfig nicht, gibt es einen schlichten Admin-Tab.

### 6. Datenhaltung und Analyse

- Eigenes Ereignis-Log: tägliche JSONL-Dateien im Instanz-Datenverzeichnis, rollierend (Standard 60 Tage)
- Umgebungswerte: eigenes Log je Tag (`<datum>.context.jsonl`), Stichprobe alle 15 Minuten
- ❓ Für Bedingung → Aktion reichen 60 Tage nicht (Sommer vs. Winter). Vor 0.3 klären: längere Aufbewahrung oder
  verdichtete Langzeitdaten (z. B. Handgriffe je Tag mit Umgebungswerten)
- Keine nativen Abhängigkeiten (kein SQLite) – problemlose Installation auf ARM
- Analyse einmal nachts; Vorschläge bleiben tagsüber stabil
- Größenordnung: einige tausend Ereignisse/Tag, < 1 Mio. in 60 Tagen → Analyse im Sekundenbereich, auch auf einem Pi

### 7. Kaltstart

Zeitmuster brauchen 2–3 Wochen Daten. Cortex sagt das offen:
„Ich lerne seit 5 Tagen. Erste Vorschläge ca. ab Tag 14.“

## Umsetzen mit einem Klick (ab 0.2) ✅

Entschieden: **Cortex führt angenommene Vorschläge als eigene Regeln aus** (Weg B), statt Skripte für den
javascript-Adapter zu erzeugen (Weg A).

| | Begründung |
|---|---|
| Läuft überall | Keine Voraussetzung wie der javascript-Adapter |
| Klein | Nur die Regeltypen, die Cortex auch erkennt: **Zeit/Sonne → Aktion** und **Auslöser → Aktion** (optional „nur bei Dunkelheit“). Keine allgemeine Regel-Engine. |
| Transparent | Jede Regel ist im Admin (und in SmartVis) sichtbar, mit Begründung, ein-/ausschaltbar und löschbar |
| Lernend | Cortex beobachtet seine eigenen Regeln: Schaltet der Benutzer nach einer Cortex-Aktion regelmäßig zurück oder um, schlägt Cortex eine Anpassung vor („Soll ich das Licht auf 30 % statt 100 % schalten?“) oder die Abschaltung der Regel |

Weitere Festlegungen:

- Cortex schaltet **nur** über angenommene Regeln, nie eigenmächtig
- Eigene Schaltbefehle sind `script`-Ereignisse mit Absender `cortex` – sie zählen nie als Handgriff
- Hauptschalter „Alle Cortex-Regeln pausieren“ (z. B. Urlaub, Gäste)
- Optional für Bastler: Regel „als Skript exportieren“ (Blockly/JavaScript), danach verwaltet der Benutzer sie selbst
- Sicherheitsrelevante Geräte (Schloss, Alarmanlage, Garagentor): Cortex **erkennt und schlägt vor** wie bei allen
  anderen Geräten – die Grenze liegt bei der Umsetzung:

  | | Licht, Schalter, Dimmer, Rollladen | Schloss, Alarm, Garagentor |
  |---|---|---|
  | Erkennen und vorschlagen | ✅ | ✅ |
  | Als Cortex-Regel umsetzen | ✅ | nur **sichernde** Richtung (abschließen, scharf schalten, Tor zu), mit ausdrücklicher zweiter Bestätigung und deutlicher Kennzeichnung |
  | Öffnende Richtung (aufschließen, unscharf, Tor auf) | ✅ | **nur als Skript-Export** – nie als Cortex-Regel |

  Begründung: Fällt Cortex aus oder liegt ein Muster falsch, bleibt die Tür eher zu als offen.
  Sicherheitsrelevante Geräte werden erst in einer späteren Version beobachtet (der Rekorder erfasst sie noch nicht).

Erwartung an das Produkt: Ein Haushalt bekommt in den ersten Monaten etwa 5–15 gute Vorschläge, danach weniger –
jede umgesetzte Automation entfernt die Handgriffe, aus denen Cortex lernt. Das ist das Ziel, kein Mangel. Cortex
zeigt den Nutzen offen an („Seit Cortex sparst du ~40 Handgriffe pro Woche“).

## Bewusst nicht in v0.1

Messwerte als Auslöser · Bedingung → Aktion (→ nach 0.2; Aufzeichnung läuft schon) · Ketten mit mehr als zwei
Gliedern · Anwesenheit/Personen · Umsetzen mit einem Klick (→ 0.2) · Import von Altdaten

## Fahrplan

| Version | Inhalt | Ziel |
|---|---|---|
| **0.0.1 Rekorder** | Gerüst, Relevanz-Filter, Einstufung Mensch/Skript/Sensor, Ereignis-Log, Statistik-States, Admin-Konfiguration | **Beweisen, dass „Mensch oder Skript“ zuverlässig erkannt wird** – wichtigster Meilenstein des Projekts |
| 0.0.x | Einstufungsregeln an realen Daten nachschärfen | Datenqualität |
| 0.1.0 | Zeitmuster, Auslöser → Aktion, Vorschläge mit Feedback, State-API, Admin-Ansicht | MVP: Sind die Vorschläge gut? |
| 0.2.0 | Umsetzen mit einem Klick: Cortex-Regeln, Hauptschalter, Beobachtung der eigenen Regeln | Nutzen ohne Skript-Kenntnisse |
| 0.3.0 | Bedingung → Aktion (Hitzeschutz u. Ä.) aus Umgebungswerten | Muster, die vom Wetter abhängen |
| danach | Cortex in SmartVis | bevorzugte Oberfläche |

## Offene Fragen

- ❓ Gruppen (Hue-Raum „Alle Lichter“ vs. Einzellampen): nur eine Aktion zählen
- ❓ Welche Adapter gelten standardmäßig als Automation (javascript, scenes, shuttercontrol, node-red …)?
- 🔬 Reicht jsonConfig für Vorschläge inkl. Bearbeiten im Admin?

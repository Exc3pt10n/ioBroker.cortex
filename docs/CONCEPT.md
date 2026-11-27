# ioBroker.cortex – Konzept

> **Cortex beobachtet wiederkehrende manuelle Aktionen und schlägt die Automatisierungen vor,
> die dem Benutzer die meisten Handgriffe sparen.**

Stand: 2026-11-27 · Phase: Konzeption · ✅ entschieden · ❓ offen · 🔬 im Prototyp zu prüfen

## Was Cortex ist

Cortex beobachtet, wie die Bewohner ihr Smart Home **von Hand** bedienen, und schlägt daraus höchstens
**5 Automatisierungen** vor, die sich lohnen würden. Cortex schaltet selbst nichts und legt keine Skripte an –
die Entscheidung trifft der Benutzer.

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
| `ack=true` vom Geräte-Adapter **ohne** vorangegangenen Befehl | `device` – physischer Schalter, Hersteller-App **oder** Automation außerhalb von ioBroker (Hue-Routine, CCU-Programm, Shelly-Zeitplan); zählt vorläufig als manuell |
| `ack=true` vom Geräte-Adapter **nach** einem Befehl | Bestätigung – kein eigenes Ereignis, erbt die Einstufung des Befehls |
| Sensor-Rollen (`sensor.motion`, `sensor.door`, `sensor.window`, …) | `sensor` |
| Befehl eines Adapters, der in keiner Liste steht | `other` – wird in `stats.unknownSenders` angezeigt, damit der Benutzer ihn zuordnen kann |

Mehrere Änderungen eines Adapters innerhalb kurzer Zeit (Standard 2 s) zählen als **eine** Aktion – so werden
Szenen und Gruppen allgemein behandelt, ohne Adapter-Sonderlogik.

🔬 Offene Risiken, die der Rekorder klären soll:

- Nicht jeder Adapter setzt `from` zuverlässig (z. B. Polling-Adapter).
- `device` vermischt Menschen am Gerät mit Automationen außerhalb von ioBroker. Idee für 0.0.x: Automationen
  sind zeitlich präzise (täglich 07:00:00 ± wenige Sekunden), Menschen streuen.

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

### 3. Auslöser → Aktion

- Paare: Auslöser → manuelle Aktion innerhalb Δt (Standard 2 Min.); keine längeren Ketten in v0.1
- Kennzahlen: Konfidenz P(Aktion | Auslöser) und **Lift** gegenüber der Grundrate der Aktion
- Bedingung **„nur bei Dunkelheit“** (Sonnenstand) wird automatisch geprüft

### 4. Vorschläge

- Höchstens **5** gleichzeitig, sortiert nach **eingesparten Handgriffen pro Woche**
- Zeitmuster und Auslöser zur selben Aktion werden zu einem Vorschlag zusammengeführt
- Jeder Vorschlag hat eine Begründung in Klartext

Reaktionen des Benutzers:

| Reaktion | Bedeutung |
|---|---|
| **Annehmen** | Der Benutzer setzt die Automation um. Cortex legt sie nicht selbst an. |
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
- Keine nativen Abhängigkeiten (kein SQLite) – problemlose Installation auf ARM
- Analyse einmal nachts; Vorschläge bleiben tagsüber stabil
- Größenordnung: einige tausend Ereignisse/Tag, < 1 Mio. in 60 Tagen → Analyse im Sekundenbereich, auch auf einem Pi

### 7. Kaltstart

Zeitmuster brauchen 2–3 Wochen Daten. Cortex sagt das offen:
„Ich lerne seit 5 Tagen. Erste Vorschläge ca. ab Tag 14.“

## Bewusst nicht in v0.1

Messwerte · Ketten mit mehr als zwei Gliedern · Anwesenheit/Personen · Saisonalität jenseits des Sonnenstands ·
automatisches Anlegen von Skripten · Import von Altdaten

## Fahrplan

| Version | Inhalt | Ziel |
|---|---|---|
| **0.0.1 Rekorder** | Gerüst, Relevanz-Filter, Einstufung Mensch/Skript/Sensor, Ereignis-Log, Statistik-States, Admin-Konfiguration | **Beweisen, dass „Mensch oder Skript“ zuverlässig erkannt wird** – wichtigster Meilenstein des Projekts |
| 0.0.x | Einstufungsregeln an realen Daten nachschärfen | Datenqualität |
| 0.1.0 | Zeitmuster, Auslöser → Aktion, Vorschläge mit Feedback, State-API, Admin-Ansicht | MVP |
| danach | Cortex in SmartVis | bevorzugte Oberfläche |

## Offene Fragen

- ❓ Gruppen (Hue-Raum „Alle Lichter“ vs. Einzellampen): nur eine Aktion zählen
- ❓ Welche Adapter gelten standardmäßig als Automation (javascript, scenes, shuttercontrol, node-red …)?
- 🔬 Reicht jsonConfig für Vorschläge inkl. Bearbeiten im Admin?

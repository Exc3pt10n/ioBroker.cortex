# ioBroker.cortex – Konzept

Stand: 2026-11-27 · Phase: Konzeption · Status der Entscheidungen: ✅ entschieden · ❓ offen · 🔬 im Prototyp zu prüfen

## Vision

Cortex lernt aus dem tatsächlichen Verhalten der Bewohner und schlägt sinnvolle Automatisierungen vor.
Cortex steuert nichts selbst. Cortex liefert Entscheidungen, nicht Daten.

Leitfragen des Benutzers:

- Was hat mein Smart Home gelernt?
- Welche Automatisierung sollte ich erstellen?

## Grundprinzipien

- Keine Cloud, keine externen KI-Dienste, ausschließlich lokale Analyse
- Erklärbar: jeder Vorschlag hat eine nachvollziehbare Begründung („an 14 von 17 Werktagen …“)
- Keine Blackbox: Zählen, Zeitfenster, Verhältnisse – kein Machine Learning
- Lieber kein Vorschlag als ein schlechter (konservative Standard-Schwellwerte)

## Rahmenentscheidungen

| | Entscheidung | Status |
|---|---|---|
| Unabhängigkeit | Cortex läuft eigenständig auf jedem ioBroker-System, ohne andere Adapter vorauszusetzen | ✅ |
| Steuerung | **Alles** ist über den ioBroker-Admin konfigurierbar und bedienbar (auch Vorschläge annehmen/ablehnen) | ✅ |
| Oberflächen | Admin = vollständig; SmartVis = zusätzliche, komfortable Oberfläche über ein Cortex-Profil in SmartVis; andere VIS über States | ✅ |
| Hardware | Raspberry Pi bis Intel NUC; keine hardwareabhängigen Modi (die Last ist klein, siehe unten) | ✅ |
| Altdaten | Kein Import aus history/influxdb/sql | ✅ |
| Technik | TypeScript, Node ≥ 22, Werkzeuge, Workflows und Konventionen wie ioBroker.smartvis (zentraler Workflow, Verteilung über npm) | ✅ |
| Erkennung | Eigene Erkennung in Cortex (`@iobroker/type-detector` + Rollen + Enums); kein gemeinsames Paket mit SmartVis | ✅ |

## Kernproblem: Mensch oder Automation?

Nur **manuelle** Aktionen sind Kandidaten für Vorschläge. Sonst „entdeckt“ Cortex bestehende Skripte und schlägt sie erneut vor.

Jedes Ereignis wird beim Eingang eingestuft:

| Signal | Einstufung |
|---|---|
| `ack=false`, `from=system.adapter.javascript.*` / Szenen- und Logik-Adapter | `automated` |
| `ack=false`, `from=system.adapter.{web,admin,smartvis,alexa2,…}.*` oder `from=system.user.*` | `manual` |
| `ack=true` vom Geräte-Adapter **ohne** vorangegangenen Befehl (Zeitfenster wenige Sekunden) | `manual` (physischer Schalter) |
| `ack=true` vom Geräte-Adapter **nach** einem Befehl | Bestätigung – kein eigenes Ereignis, erbt die Einstufung des Befehls |
| Sensor-Rollen (`sensor.motion`, `sensor.door`, `sensor.window`, …) | `sensor` |

🔬 Größtes technisches Risiko: Nicht jeder Adapter setzt `from` zuverlässig (z. B. Polling-Adapter). Muss an realen Daten
geprüft werden – deshalb ist der Rekorder (v0.0.1) der erste Schritt. Die Zuordnung `from`-Adapter → Einstufung
ist im Admin überschreibbar.

## Bausteine v0.1

### 1. Relevanz-Filter (statt „Engine“)

Regelbasiert, keine Bewertungsmodelle:

- Nur **diskrete** States (boolean, wenige Zustände). Numerische Messwerte sind in v0.1 ausgeschlossen.
- Klassifizierung über `common.role` bzw. type-detector: **Auslöser** (Bewegung, Tür, Fenster, Taster) und **Aktionen** (Licht, Schalter, Dimmer, Rollladen)
- Raum und lesbarer Name aus `enum.rooms` und den Objektnamen von Gerät/Kanal
- Im Admin: Ein-/Ausschlussliste (Adapter, Objekt-IDs), Übersicht „was wird beobachtet“

### 2. Zeitmuster

- Pro manueller Aktion: Bewertung über **Tage** („an 14 von 17 Werktagen“), nicht über Ereignisanzahl
- Gruppen: Werktag / Wochenende (nicht 7 Wochentage – dafür reichen die Daten nicht)
- **Uhrzeit vs. Sonnenstand**: Streuung relativ zur Uhrzeit und relativ zum Sonnenuntergang/-aufgang vergleichen,
  die kleinere gewinnt („20 Min. nach Sonnenuntergang“). Koordinaten aus `system.config`.

### 3. Ereignisketten (nur Paare)

- Auslöser → manuelle Aktion innerhalb Δt (Standard 2 Min.)
- Kennzahlen: Konfidenz P(Aktion | Auslöser) und **Lift** gegenüber der Grundrate der Aktion
- Optionale Bedingung **„nur bei Dunkelheit“** (Sonnenstand) – hebt z. B. Bewegung → Licht von ~40 % auf ~90 %
- Ketten mit mehr als zwei Gliedern: nicht in v0.1

### 4. Vorschläge

- Höchstens **5** gleichzeitig
- Ranking nach **eingesparten Handgriffen pro Woche**
- Zeitmuster und Kette zur selben Aktion werden zu einem Vorschlag zusammengeführt
- Feedback: annehmen / ablehnen / später. Abgelehnte Vorschläge kommen nie wieder.
- Angenommen = vom Benutzer umgesetzt; Cortex legt **keine** Automation an

### 5. State-API

Zwei Darstellungen derselben Ergebnisse:

| Zweck | States |
|---|---|
| SmartVis, Skripte | `suggestions.json` (atomar aktualisiert), `suggestions.feedback` (beschreibbar, `{"id":"…","action":"accept\|reject\|snooze"}`) |
| Admin, vis-2, Jarvis … | feste Slots `suggestions.1` … `suggestions.5` mit `title`, `reason`, `savingsPerWeek`, `accept`, `reject`, `snooze` |
| Status | `info.status` (`learning` / `ready`), `info.learningSinceDays`, `info.eventsToday`, `info.manualShare` |
| Erkenntnisse | `insights.json` – erkannte Muster unterhalb der Vorschlagsschwelle („Was hat mein Smart Home gelernt?“) |

Warum beides: Die feste Obergrenze von 5 Vorschlägen erlaubt, sie im Admin (jsonConfig) ohne eigene
Oberfläche darzustellen und zu bedienen. 🔬 Zu prüfen: Darstellung über die jsonConfig-Komponente `state`
bzw. `sendTo`-Buttons; reicht das nicht, ein schlichter Admin-Tab.

### 6. Datenhaltung und Analyse

- **Eigenes Ereignis-Log**: tägliche JSONL-Dateien im Instanz-Datenverzeichnis, rollierend (Standard 60 Tage)
- Keine nativen Abhängigkeiten (kein SQLite) – problemlose Installation auf ARM
- **Analyse einmal nachts als Batch**; Vorschläge bleiben tagsüber stabil
- Größenordnung: einige tausend Ereignisse/Tag, < 1 Mio. in 60 Tagen → Analyse im Sekundenbereich, auch auf einem Pi

### 7. Kaltstart

Zeitmuster brauchen 2–3 Wochen Daten. Cortex kommuniziert das offen
(„Ich lerne seit 5 Tagen. Erste Vorschläge ca. ab Tag 14.“).

## Bewusst nicht in v0.1

Numerische Sensoren · Ketten > 2 · Anwesenheit/Personen · Saisonalität jenseits des Sonnenstands ·
automatisches Anlegen von Skripten · Import von Altdaten · ML

## Fahrplan

| Version | Inhalt | Ziel |
|---|---|---|
| 0.0.1 | **Rekorder**: Gerüst, Relevanz-Filter, Einstufung manuell/automatisch/Sensor, JSONL-Log, Statistik-States, Admin-Konfiguration | Einstufung an realen Daten validieren; Daten sammeln, während die Lernzeit ohnehin läuft |
| 0.0.x | Auswertung der Rekorder-Daten, Korrektur der Einstufungsregeln | Datenqualität |
| 0.1.0 | Zeitmuster, Paare, Vorschläge, Feedback, State-API, Admin-Ansicht | MVP |
| danach | Cortex-Profil in SmartVis | komfortable Oberfläche |

## Offene Fragen

- ❓ Wie werden Gruppen behandelt (Hue-Raum „Alle Lichter“ vs. Einzellampen), damit nicht beide als Aktion zählen?
- ❓ Welche Adapter gelten standardmäßig als „Automation“ (javascript, scenes, shuttercontrol, …)?
- 🔬 Lässt sich die Vorschlagsansicht im Admin mit jsonConfig allein ausreichend gut umsetzen?

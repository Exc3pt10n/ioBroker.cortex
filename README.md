![Logo](admin/cortex.svg)

# ioBroker.cortex

[![Test and Release](https://github.com/Exc3pt10n/ioBroker.cortex/actions/workflows/test-and-release.yml/badge.svg?branch=main)](https://github.com/Exc3pt10n/ioBroker.cortex/actions/workflows/test-and-release.yml)

**Cortex observes recurring manual actions and suggests the automations that save you the most effort.**

Cortex uses no cloud AI. All decisions are derived locally from what happens in your smart home, so your data stays at home and every recommendation can be explained ("on 14 of 17 working days …"). Cortex never switches anything itself – you decide which automation to create.

> **Status: 0.0.x – recorder.** This version only records and classifies. It does not make suggestions yet.
> Its purpose is to prove the foundation of Cortex on real installations: telling apart whether a person or an
> automation switched something. Suggestions follow in 0.1.

## What the recorder does

- **Observes** lights, switches, dimmers and blinds (actions) as well as motion, door and window sensors (triggers), found by their standard ioBroker roles – independent of the adapter. This includes read-only actual states of outputs (`value.blind`, status channels): a press on a directly linked wall switch only shows up there. Measured values (temperature, power …), settings that merely use the role `switch` (camera LED, privacy mode …) and the own states of user interfaces and voice assistants are not observed.
- **Classifies** every change by its origin:

  | Origin | Meaning | Counts as |
  |---|---|---|
  | `ui` | command from a user interface or voice assistant (Admin, VIS, SmartVis, Alexa …) | manual |
  | `device` | reported by the device without a command from ioBroker – a physical switch or the manufacturer's app | manual |
  | `external` | like `device`, but within seconds after a sensor of the same adapter instance – an automation of the bridge or central unit (Hue motion sensor, CCU program) | automated |
  | `script` | command from a logic adapter (JavaScript, Scenes, shuttercontrol …) | automated |
  | `other` | command from an adapter in neither list – see `stats.unknownSenders` | unknown |
  | `sensor` | change of a trigger | – |

  A device report shortly after a command only confirms it and is not counted again. Reports of the same device after a command (status channel, a blind that is still moving) and reports of other devices of the same adapter instance right after it (lamps of a group or scene) take over the origin of the command. Several changes of one adapter within a short time (scene, group) count as one action.
- **Keeps a local event log** (one file per day in the instance data directory, 60 days by default).
- **Records context values (optional):** outdoor temperature and brightness, chosen in the settings, every 15 minutes. Later versions use them to recognise actions that depend on the weather (e.g. blinds down on hot days).
- **Shows statistics** as states: manual/automated actions today, share of manual actions, adapters with unknown origin, the most recent actions in plain text (`stats.recentText`).

## Helping to check the detection

Look at `cortex.0.stats.recentText` from time to time: does the origin of each action match what really happened? If you would like to help improve Cortex, create an **anonymous export** in the instance settings and attach it to an issue. The export contains times, values, roles and the origin of each event – **no names, rooms or object IDs** (IDs are replaced by a hash with a random secret of your installation).

## Configuration

| Setting | Default | Description |
|---|---|---|
| User interfaces and voice assistants | `admin,web,vis,…` | Commands from these adapters count as manual |
| Logic adapters | `javascript,scenes,shuttercontrol,…` | Commands from these adapters count as automated |
| Confirmation window | 10 s | A device report within this time after a command confirms it |
| Group window | 2 s | Changes of one adapter within this time count as one action |
| Reaction window for automations outside ioBroker | 3 s | A device changing this soon after a sensor of the same instance counts as `external` |
| Ignored adapters | `alias,javascript,…` | States of these adapters are never observed (aliases would record every action twice) |
| Additional / excluded states | – | Observe IDs without a matching role, or never observe them (prefix, `*` as wildcard) |
| Outdoor temperature / brightness | – | Optional states recorded every 15 minutes as context values |
| Keep events | 60 days | Older days are deleted |

Requirements: js-controller ≥ 6.0.11, Admin ≥ 7.6.20, Node.js ≥ 22.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md). The product concept (German) is in [docs/CONCEPT.md](docs/CONCEPT.md).

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.0.1 (2026-11-27)

- (Exc3pt10n) First version: recorder. Observes actions and triggers by their roles, classifies every change as manual, automated or device, keeps a local event log, statistics as states, anonymous export

## License

MIT License – see [LICENSE](LICENSE).

Copyright (c) 2026 Exc3pt10n <kontakt@jansesoft.de>

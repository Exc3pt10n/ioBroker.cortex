# Development

Notes for contributors. User documentation: [README.md](README.md). Product concept (German): [docs/CONCEPT.md](docs/CONCEPT.md).

## Setup and checks

```bash
npm install
npm run build              # TypeScript → build/
npm test                   # unit and package tests
npm run test:integration   # adapter in a real js-controller test instance
npm run lint && npm run check
```

## Architecture (recorder)

```
ioBroker objects ──► relevance (roles, enum.rooms)  ──► subscriptions
ioBroker states  ──► classify (ack, from, ts, lc)   ──► eventlog (JSONL per day) ──► export (anonymous)
                                                    └─► stats ──► cortex.0.stats.*
```

## Project structure

```
src/
  main.ts           life cycle, subscriptions, timers, export command
  lib/relevance     which states are observed (pure function, tested)
  lib/classify      origin of a change: ui / script / device / other / sensor (tested)
  lib/eventlog      JSONL files per day in the instance data directory
  lib/stats         daily statistics, derived from the log after a restart
  lib/export        anonymous export (hashed IDs, no names or rooms)
admin/              jsonConfig of the instance settings and translations
docs/CONCEPT.md     product concept and roadmap
```

import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedEvent } from './classify';
import { EventLog } from './eventlog';
import { buildExport } from './export';
import { StatsCollector, dayKey, manualShare } from './stats';

const DAY = 24 * 60 * 60 * 1000;

function event(t: number, o: RecordedEvent['o'], id = 'hue.0.a.on', b = t): RecordedEvent {
    return { t, id, v: true, o, s: o === 'script' ? 'javascript' : 'hue', b };
}

describe('EventLog', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'cortex-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('writes one file per day and reads it back', async () => {
        const log = new EventLog(dir);
        const now = Date.now();
        log.append(event(now - DAY, 'ui'));
        log.append(event(now, 'device'));
        log.append(event(now + 1, 'script'));
        await log.flush();
        assert.deepEqual(await log.days(), [dayKey(now - DAY), dayKey(now)]);
        assert.deepEqual(
            (await log.readDay(dayKey(now))).map(e => e.o),
            ['device', 'script'],
        );
    });

    it('skips broken lines and deletes old days', async () => {
        const log = new EventLog(dir);
        const now = Date.now();
        await writeFile(join(dir, `${dayKey(now)}.jsonl`), `${JSON.stringify(event(now, 'ui'))}\n{"t":`);
        await writeFile(join(dir, `${dayKey(now - 100 * DAY)}.jsonl`), '');
        assert.equal((await log.readDay(dayKey(now))).length, 1);
        assert.equal(await log.cleanup(60, now), 1);
        assert.deepEqual(await log.days(), [dayKey(now)]);
    });
});

describe('StatsCollector', () => {
    it('counts a scene/group once and computes the manual share', () => {
        const stats = new StatsCollector('2026-11-27');
        stats.addEvent(event(1000, 'device', 'hue.0.a.on', 1000), undefined);
        stats.addEvent(event(1500, 'device', 'hue.0.b.on', 1000), undefined);
        stats.addEvent(event(5000, 'script', 'hue.0.a.on', 5000), undefined);
        stats.addEvent(event(6000, 'sensor', 'hm-rpc.0.x', 6000), undefined);
        stats.addEvent({ ...event(7000, 'other'), s: 'mqtt' }, undefined);
        const today = stats.today;
        assert.equal(today.events, 5);
        assert.deepEqual(today.actions, { ui: 0, device: 1, script: 1, other: 1, sensor: 1 });
        assert.deepEqual(today.unknownSenders, { mqtt: 1 });
        assert.equal(manualShare(today), 33);
    });
});

describe('buildExport', () => {
    it('contains no IDs, names or rooms', () => {
        const text = buildExport(
            [
                {
                    id: 'hue.0.Living_room.on',
                    kind: 'action',
                    category: 'light',
                    role: 'switch.light',
                    instance: 'hue.0',
                    name: 'Ceiling light',
                    room: 'Living room',
                },
            ],
            [event(1000, 'device', 'hue.0.Living_room.on')],
            'secret',
            {},
        );
        assert.equal(text.includes('Living_room'), false);
        assert.equal(text.includes('Ceiling'), false);
        const [header, line] = text
            .trim()
            .split('\n')
            .map(l => JSON.parse(l));
        assert.equal(header.states[0].key, line.key);
        assert.equal(header.states[0].instance, 'hue.0');
    });
});

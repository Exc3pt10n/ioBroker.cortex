import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedEvent } from './classify';
import { ContextLog, EventLog } from './eventlog';
import { buildExport } from './export';
import type { ObservedState } from './relevance';
import { StatsCollector, dayKey, describe as describeAction, manualShare } from './stats';

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

describe('ContextLog', () => {
    it('keeps context values in their own files next to the events', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'cortex-'));
        try {
            const now = Date.now();
            const events = new EventLog(dir);
            const context = new ContextLog(dir);
            events.append(event(now, 'ui'));
            context.append({ t: now, k: 'room.temperature', id: 'hm-rpc.0.X.1.ACTUAL_TEMPERATURE', v: 21 });
            await events.flush();
            await context.flush();
            assert.deepEqual(await events.days(), [dayKey(now)]);
            assert.deepEqual(await context.readDay(dayKey(now)), [
                { t: now, k: 'room.temperature', id: 'hm-rpc.0.X.1.ACTUAL_TEMPERATURE', v: 21 },
            ]);
            assert.equal((await events.readDay(dayKey(now))).length, 1);
            assert.equal(await context.cleanup(60, now + 100 * DAY), 1);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('StatsCollector', () => {
    it('counts a scene/group once and computes the manual share', () => {
        const stats = new StatsCollector('2026-11-27');
        stats.addEvent(event(1000, 'device', 'hue.0.a.on', 1000), () => undefined);
        stats.addEvent(event(1500, 'device', 'hue.0.b.on', 1000), () => undefined);
        stats.addEvent(event(5000, 'script', 'hue.0.a.on', 5000), () => undefined);
        stats.addEvent(event(6000, 'sensor', 'hm-rpc.0.x', 6000), () => undefined);
        stats.addEvent({ ...event(7000, 'other'), s: 'mqtt' }, () => undefined);
        const today = stats.today;
        assert.equal(today.events, 5);
        assert.deepEqual(today.actions, { ui: 0, device: 1, script: 1, external: 0, other: 1, sensor: 1 });
        assert.deepEqual(today.unknownSenders, { mqtt: 1 });
        assert.equal(manualShare(today), 33);
    });
});

describe('recent actions', () => {
    it('leave out sensors and name the sensor behind an external action', () => {
        const stats = new StatsCollector('2026-11-27');
        const names: Record<string, string> = { 'hue.0.hall.motion': 'Hall motion', 'hue.0.hall.on': 'Hall light' };
        const lookup = (id: string): ObservedState | undefined =>
            names[id] ? ({ id, name: names[id], instance: 'hue.0' } as ObservedState) : undefined;
        stats.addEvent(event(1000, 'sensor', 'hue.0.hall.motion'), lookup);
        stats.addEvent({ ...event(1400, 'external', 'hue.0.hall.on'), x: 'hue.0.hall.motion' }, lookup);
        assert.equal(stats.recentActions.length, 1);
        assert.equal(stats.recentActions[0].trigger, 'Hall motion');
        assert.match(describeAction(stats.recentActions[0]), /Hall light → true \(external, hue, after Hall motion\)$/);
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
                    device: 'hue.0.Living_room',
                },
            ],
            [event(1000, 'device', 'hue.0.Living_room.on')],
            [
                { t: 1000, k: 'outdoor.temperature', id: 'hm-rpc.0.WEATHER.1.ACTUAL_TEMPERATURE', v: 27.5 },
                // Presence never leaves the system
                { t: 2000, k: 'mode.presence', id: 'ping.0.phone', v: false },
            ],
            'secret',
            {},
        );
        assert.equal(text.includes('Living_room'), false);
        assert.equal(text.includes('Ceiling'), false);
        const [header, line, context] = text
            .trim()
            .split('\n')
            .map(l => JSON.parse(l));
        assert.equal(header.states[0].key, line.key);
        assert.equal(header.states[0].instance, 'hue.0');
        assert.equal(text.includes('WEATHER'), false);
        assert.equal(text.includes('mode.'), false);
        assert.deepEqual(
            { ...context, key: undefined },
            {
                type: 'context',
                key: undefined,
                t: 1000,
                k: 'outdoor.temperature',
                v: 27.5,
            },
        );
    });
});

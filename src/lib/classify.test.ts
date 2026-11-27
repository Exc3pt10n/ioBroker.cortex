import { strict as assert } from 'node:assert';
import { Classifier, senderOf, type ClassifyResult, type StateChange } from './classify';
import type { ObservedState } from './relevance';

const light: ObservedState = {
    id: 'hue.0.Living_room.on',
    kind: 'action',
    category: 'light',
    role: 'switch.light',
    instance: 'hue.0',
    name: 'Ceiling light',
};
const lamp2: ObservedState = { ...light, id: 'hue.0.Kitchen.on', name: 'Kitchen' };
const motion: ObservedState = {
    id: 'hm-rpc.0.ABC.1.MOTION',
    kind: 'trigger',
    category: 'motion',
    role: 'sensor.motion',
    instance: 'hm-rpc.0',
    name: 'Hall motion',
};

function classifier(): Classifier {
    return new Classifier({
        uiAdapters: ['admin', 'web', 'smartvis', 'alexa2'],
        scriptAdapters: ['javascript', 'scenes', 'shuttercontrol'],
        confirmWindowMs: 10_000,
        burstWindowMs: 2_000,
    });
}

/** Changed value: lc === ts */
function change(ts: number, val: ioBroker.StateValue, ack: boolean, from?: string, changed = true): StateChange {
    return { ts, lc: changed ? ts : ts - 1000, val, ack, from };
}

function origin(result: ClassifyResult): string {
    return result.type === 'event' ? result.event.o : result.type;
}

describe('senderOf', () => {
    it('reads the adapter name from "from"', () => {
        assert.equal(senderOf('system.adapter.javascript.0'), 'javascript');
        assert.equal(senderOf('system.adapter.hue.1'), 'hue');
        assert.equal(senderOf('system.user.admin'), 'user');
        assert.equal(senderOf(undefined), '');
    });
});

describe('Classifier', () => {
    it('command from a user interface = ui', () => {
        assert.equal(
            origin(classifier().classify(light, change(1000, true, false, 'system.adapter.smartvis.0'))),
            'ui',
        );
    });

    it('command from a script = script', () => {
        assert.equal(
            origin(classifier().classify(light, change(1000, true, false, 'system.adapter.javascript.0'))),
            'script',
        );
    });

    it('command from an unknown adapter = other', () => {
        assert.equal(origin(classifier().classify(light, change(1000, true, false, 'system.adapter.mqtt.0'))), 'other');
    });

    it('device report after a command is only a confirmation', () => {
        const c = classifier();
        c.classify(light, change(1000, true, false, 'system.adapter.javascript.0'));
        assert.equal(origin(c.classify(light, change(3000, true, true, 'system.adapter.hue.0'))), 'confirmation');
    });

    it('device report without a command = device (physical switch, app, bridge)', () => {
        assert.equal(origin(classifier().classify(light, change(1000, true, true, 'system.adapter.hue.0'))), 'device');
    });

    it('device report long after a command is a new device event', () => {
        const c = classifier();
        c.classify(light, change(1000, true, false, 'system.adapter.javascript.0'));
        assert.equal(origin(c.classify(light, change(60_000, false, true, 'system.adapter.hue.0'))), 'device');
    });

    it('unchanged device reports (polling) are ignored', () => {
        assert.equal(
            origin(classifier().classify(light, change(1000, true, true, 'system.adapter.hue.0', false))),
            'ignored',
        );
    });

    it('a repeated command counts even without a change', () => {
        assert.equal(
            origin(classifier().classify(light, change(1000, true, false, 'system.adapter.web.0', false))),
            'ui',
        );
    });

    it('ack=true written by a script into a foreign state = script', () => {
        assert.equal(
            origin(classifier().classify(light, change(1000, true, true, 'system.adapter.javascript.0'))),
            'script',
        );
    });

    it('sensors: only changes, origin sensor', () => {
        const c = classifier();
        assert.equal(origin(c.classify(motion, change(1000, true, true, 'system.adapter.hm-rpc.0'))), 'sensor');
        assert.equal(origin(c.classify(motion, change(2000, true, true, 'system.adapter.hm-rpc.0', false))), 'ignored');
    });

    it('changes of one instance in quick succession share a burst (scene, group)', () => {
        const c = classifier();
        const a = c.classify(light, change(1000, true, true, 'system.adapter.hue.0'));
        const b = c.classify(lamp2, change(1800, true, true, 'system.adapter.hue.0'));
        const d = c.classify(lamp2, change(10_000, false, true, 'system.adapter.hue.0'));
        assert.ok(a.type === 'event' && b.type === 'event' && d.type === 'event');
        assert.equal(a.event.b, b.event.b);
        assert.notEqual(b.event.b, d.event.b);
    });
});

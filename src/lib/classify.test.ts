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
    device: 'hue.0.Living_room',
};
const lamp2: ObservedState = { ...light, id: 'hue.0.Kitchen.on', name: 'Kitchen', device: 'hue.0.Kitchen' };
const hueMotion: ObservedState = {
    id: 'hue.0.sensors.Hall.motion',
    kind: 'trigger',
    category: 'motion',
    role: 'sensor.motion',
    instance: 'hue.0',
    name: 'Hall motion',
    device: 'hue.0.sensors.Hall',
};
/** Homematic IP blind actuator: virtual channel (command) and status channel (actual position) of one device */
const blindCommand: ObservedState = {
    id: 'hm-rpc.0.BLIND.10.LEVEL',
    kind: 'action',
    category: 'blind',
    role: 'level.blind',
    instance: 'hm-rpc.0',
    name: 'Bathroom blind',
    device: 'hm-rpc.0.BLIND',
};
const blindStatus: ObservedState = { ...blindCommand, id: 'hm-rpc.0.BLIND.9.LEVEL', role: 'value.blind' };
const otherSwitch: ObservedState = {
    ...blindCommand,
    id: 'hm-rpc.0.SWITCH.14.STATE',
    category: 'switch',
    role: 'switch',
    device: 'hm-rpc.0.SWITCH',
};
const motion: ObservedState = {
    id: 'hm-rpc.0.ABC.1.MOTION',
    kind: 'trigger',
    category: 'motion',
    role: 'sensor.motion',
    instance: 'hm-rpc.0',
    name: 'Hall motion',
    device: 'hm-rpc.0.ABC',
};

function classifier(): Classifier {
    return new Classifier({
        uiAdapters: ['admin', 'web', 'smartvis', 'alexa2'],
        scriptAdapters: ['javascript', 'scenes', 'shuttercontrol'],
        confirmWindowMs: 10_000,
        burstWindowMs: 2_000,
        externalWindowMs: 3_000,
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

    it('reports of the same device keep belonging to a command (status channel, moving blind)', () => {
        const c = classifier();
        c.classify(blindCommand, change(1000, 100, false, 'system.adapter.shuttercontrol.0'));
        let t = 1000;
        for (const level of [90, 78.5, 86, 100]) {
            t += 5000;
            const result = c.classify(blindStatus, change(t, level, true, 'system.adapter.hm-rpc.0'));
            assert.ok(result.type === 'event');
            assert.equal(result.event.o, 'script');
            assert.equal(result.event.c, 1);
        }
        // A report after a quiet period is a new device event
        assert.equal(origin(c.classify(blindStatus, change(t + 60_000, 0, true, 'system.adapter.hm-rpc.0'))), 'device');
    });

    it('real case: wall switch 10 s after an unrelated command on the same CCU stays a device action', () => {
        const c = classifier();
        c.classify(otherSwitch, change(23_000, true, false, 'system.adapter.smartvis.0'));
        c.classify(otherSwitch, change(24_000, false, false, 'system.adapter.smartvis.0'));
        assert.equal(origin(c.classify(blindStatus, change(34_000, 90, true, 'system.adapter.hm-rpc.0'))), 'device');
        assert.equal(origin(c.classify(blindCommand, change(35_000, 0, true, 'system.adapter.hm-rpc.0'))), 'device');
    });

    it('lamps of a group switched by a command take over its origin, but only right after it', () => {
        const c = classifier();
        c.classify(light, change(1000, true, false, 'system.adapter.javascript.0'));
        assert.equal(origin(c.classify(lamp2, change(1800, true, true, 'system.adapter.hue.0'))), 'script');
        assert.equal(origin(c.classify(lamp2, change(9000, false, true, 'system.adapter.hue.0'))), 'device');
    });

    it('real case: Hue motion sensor switches the hall light on the bridge = external', () => {
        const c = classifier();
        c.classify(hueMotion, change(19_000, true, true, 'system.adapter.hue.0'));
        assert.equal(origin(c.classify(light, change(19_400, true, true, 'system.adapter.hue.0'))), 'external');
        assert.equal(origin(c.classify(lamp2, change(20_100, true, true, 'system.adapter.hue.0'))), 'external');
        // Pressing a switch long after walking past the sensor is a person
        assert.equal(origin(c.classify(lamp2, change(40_000, false, true, 'system.adapter.hue.0'))), 'device');
    });

    it('sensors of another instance do not make device changes external', () => {
        const c = classifier();
        c.classify(motion, change(1000, true, true, 'system.adapter.hm-rpc.0'));
        assert.equal(origin(c.classify(light, change(1500, true, true, 'system.adapter.hue.0'))), 'device');
    });
});

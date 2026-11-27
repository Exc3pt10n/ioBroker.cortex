import { strict as assert } from 'node:assert';
import { findRelevant, matchesAny, type ObjectMap, type RelevanceOptions } from './relevance';

function state(role: string, type: ioBroker.CommonType, write: boolean, name: string): ioBroker.Object {
    return {
        _id: '',
        type: 'state',
        common: { name, role, type, read: true, write },
        native: {},
    };
}

function channel(name: string): ioBroker.Object {
    return { _id: '', type: 'channel', common: { name }, native: {} };
}

const objects: ObjectMap = {
    'hm-rpc.0.ABC': { _id: '', type: 'device', common: { name: 'Hall light' }, native: {} },
    'hm-rpc.0.ABC.1': channel('Hall light:1'),
    'hm-rpc.0.ABC.1.STATE': state('switch', 'boolean', true, 'STATE'),
    'hm-rpc.0.ABC.1.WORKING': state('indicator.working', 'boolean', false, 'WORKING'),
    'hm-rpc.0.DEF.1.MOTION': state('sensor.motion', 'boolean', false, 'MOTION'),
    'hm-rpc.0.DEF.1.TEMPERATURE': state('value.temperature', 'number', false, 'TEMPERATURE'),
    'hue.0.Living_room': channel('Living room ceiling'),
    'hue.0.Living_room.on': state('switch.light', 'boolean', true, 'on'),
    'hue.0.Living_room.bri': state('level.dimmer', 'number', true, 'bri'),
    'alias.0.Light.on': state('switch.light', 'boolean', true, 'on'),
    'shelly.0.SHSW.Relay0.Switch': state('switch', 'boolean', true, 'Switch'),
    'cortex.0.stats.manualActions': state('value', 'number', false, 'x'),
    '0_userdata.0.holiday': state('state', 'boolean', true, 'Holiday mode'),
    // Settings that use the plain role "switch"
    'eufy-next.0.T1.settings.statusLed': state('switch', 'boolean', true, 'Status LED'),
    // Homematic IP: status channel (read-only actual state) and virtual receiver channel
    'hm-rpc.0.XYZ': { _id: '', type: 'device', common: { name: 'Blind actuator' }, native: {} },
    'hm-rpc.0.XYZ.1': channel('XYZ0000000001:1'),
    'hm-rpc.0.XYZ.1.LEVEL': state('value.blind', 'number', false, 'XYZ0000000001:1.LEVEL'),
    'hm-rpc.0.XYZ.2': channel('Living room blind'),
    'hm-rpc.0.XYZ.2.LEVEL': state('level.blind', 'number', true, 'XYZ0000000001:2.LEVEL'),
    'hm-rpc.0.SW.9': channel('SW00000000009:9'),
    'hm-rpc.0.SW.9.STATE': state('state', 'boolean', false, 'STATE'),
    'philips-hue.0.lights.Leuchte_Einfahrt.on': state('switch.light', 'boolean', true, 'On'),
    'enum.rooms.hall': {
        _id: '',
        type: 'enum',
        common: { name: { en: 'Hall', de: 'Flur' }, members: ['hm-rpc.0.ABC', 'hm-rpc.0.DEF'] },
        native: {},
    },
};

const options: RelevanceOptions = {
    ignoreAdapters: ['alias'],
    include: [],
    exclude: [],
    lang: 'de',
    namespace: 'cortex.0',
};

describe('findRelevant', () => {
    it('observes actions and triggers by standard roles only', () => {
        const ids = [...findRelevant(objects, options).keys()].sort();
        assert.deepEqual(ids, [
            'hm-rpc.0.ABC.1.STATE',
            'hm-rpc.0.DEF.1.MOTION',
            'hm-rpc.0.SW.9.STATE',
            'hm-rpc.0.XYZ.1.LEVEL',
            'hm-rpc.0.XYZ.2.LEVEL',
            'hue.0.Living_room.bri',
            'hue.0.Living_room.on',
            'philips-hue.0.lights.Leuchte_Einfahrt.on',
            'shelly.0.SHSW.Relay0.Switch',
        ]);
    });

    it('takes names from the channel and rooms from enum.rooms of a parent', () => {
        const result = findRelevant(objects, options);
        const hall = result.get('hm-rpc.0.ABC.1.STATE')!;
        assert.equal(hall.name, 'Hall light:1');
        assert.equal(hall.room, 'Flur');
        assert.equal(hall.kind, 'action');
        assert.equal(result.get('hm-rpc.0.DEF.1.MOTION')!.kind, 'trigger');
        // Generic state name without a parent object: the key of the parent
        assert.equal(result.get('shelly.0.SHSW.Relay0.Switch')!.name, 'Relay0');
        assert.equal(result.get('hue.0.Living_room.bri')!.name, 'Living room ceiling');
        // Technical channel names (serial numbers): device name plus channel
        assert.equal(result.get('hm-rpc.0.XYZ.1.LEVEL')!.name, 'Blind actuator (1)');
        assert.equal(result.get('hm-rpc.0.XYZ.2.LEVEL')!.name, 'Living room blind');
        // No parent object: the key of the parent
        assert.equal(result.get('philips-hue.0.lights.Leuchte_Einfahrt.on')!.name, 'Leuchte Einfahrt');
    });

    it('include adds states without a matching role, exclude removes them', () => {
        const result = findRelevant(objects, {
            ...options,
            include: ['0_userdata.0.holiday'],
            exclude: ['shelly.0.*'],
        });
        assert.equal(result.get('0_userdata.0.holiday')?.kind, 'action');
        assert.equal(result.has('shelly.0.SHSW.Relay0.Switch'), false);
    });

    it('never observes ignored adapters or its own states', () => {
        const result = findRelevant(objects, options);
        assert.equal(result.has('alias.0.Light.on'), false);
        assert.equal(result.has('cortex.0.stats.manualActions'), false);
    });
});

describe('matchesAny', () => {
    it('matches prefixes at dot boundaries and wildcards', () => {
        assert.equal(matchesAny('hue.0.a.on', ['hue.0']), true);
        assert.equal(matchesAny('hue.10.a.on', ['hue.1']), false);
        assert.equal(matchesAny('hue.0.a.on', ['hue.*.on']), true);
        assert.equal(matchesAny('hue.0.a.bri', ['hue.*.on']), false);
    });
});

import { strict as assert } from 'node:assert';
import { findContextSources, type ContextOptions } from './context';
import type { ObjectMap } from './relevance';

function state(role: string, type: ioBroker.CommonType, name: string): ioBroker.Object {
    return {
        _id: '',
        type: 'state',
        common: { name, role, type, read: true, write: false },
        native: {},
    };
}

const objects: ObjectMap = {
    'hm-rpc.0.WTH.1': {
        _id: '',
        type: 'channel',
        common: { name: 'Wall thermostat kitchen' },
        native: {},
    },
    'hm-rpc.0.WTH.1.ACTUAL_TEMPERATURE': state('value.temperature', 'number', 'ACTUAL_TEMPERATURE'),
    'hm-rpc.0.WTH.1.HUMIDITY': state('value.humidity', 'number', 'HUMIDITY'),
    'hm-rpc.0.WTH.1.SET_POINT_TEMPERATURE': state('level.temperature', 'number', 'SET_POINT'),
    // Without a room: not linked to any actions
    'zigbee.0.abc.temperature': state('value.temperature', 'number', 'Temperature'),
    'hm-rpc.0.SWO.1.ACTUAL_TEMPERATURE': state('value.temperature', 'number', 'Weather station'),
    'enum.rooms.kitchen': {
        _id: '',
        type: 'enum',
        common: { name: 'Kitchen', members: ['hm-rpc.0.WTH.1', 'hm-rpc.0.SWO.1'] },
        native: {},
    },
};

const options: ContextOptions = { configured: [], autoRooms: true, ignoreAdapters: [], exclude: [], lang: 'en' };

describe('findContextSources', () => {
    it('finds room temperature and humidity of sensors with a room', () => {
        const sources = findContextSources(objects, options);
        assert.deepEqual(
            sources.map(s => [s.id, s.kind, s.room]),
            [
                ['hm-rpc.0.SWO.1.ACTUAL_TEMPERATURE', 'room.temperature', 'Kitchen'],
                ['hm-rpc.0.WTH.1.HUMIDITY', 'room.humidity', 'Kitchen'],
                ['hm-rpc.0.WTH.1.ACTUAL_TEMPERATURE', 'room.temperature', 'Kitchen'],
            ].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])),
        );
        assert.equal(sources.find(s => s.id.endsWith('WTH.1.ACTUAL_TEMPERATURE'))!.name, 'Wall thermostat kitchen');
    });

    it('outdoor values chosen by the user take precedence over the automatic room values', () => {
        const sources = findContextSources(objects, {
            ...options,
            configured: [
                { id: 'hm-rpc.0.SWO.1.ACTUAL_TEMPERATURE', kind: 'temperature' },
                { id: 'x.0.lux', kind: 'nonsense' },
                { id: '', kind: 'wind' },
            ],
        });
        assert.equal(sources.find(s => s.id === 'hm-rpc.0.SWO.1.ACTUAL_TEMPERATURE')!.kind, 'outdoor.temperature');
        assert.equal(sources.find(s => s.id === 'x.0.lux')!.kind, 'outdoor.other');
        assert.equal(sources.length, 4);
    });

    it('records no room values when switched off', () => {
        assert.deepEqual(findContextSources(objects, { ...options, autoRooms: false }), []);
    });

    it('presence and modes are recorded on change', () => {
        const sources = findContextSources(objects, {
            ...options,
            autoRooms: false,
            modes: [
                { id: '0_userdata.0.holiday', kind: 'holiday' },
                { id: 'ping.0.phone', kind: 'unknown' },
            ],
        });
        assert.deepEqual(
            sources.map(s => [s.id, s.kind, s.onChange]),
            [
                ['0_userdata.0.holiday', 'mode.holiday', true],
                ['ping.0.phone', 'mode.other', true],
            ],
        );
    });
});

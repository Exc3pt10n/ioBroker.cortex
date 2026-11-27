/**
 * Context values: measured values that may explain an action (it is hot, it is dark, the room is warm).
 *
 * Collected broadly, evaluated narrowly: Cortex records outdoor values chosen by the user and all room values it can
 * find, but later only checks plausible combinations per kind of action (see docs/CONCEPT.md).
 * Values that can be calculated from the timestamp (season, sun position, weekday) are not recorded.
 */
import { instanceOf, matchesAny, readableName, roomIndex, findRoom, type ObjectMap } from './relevance';

/** Kinds the user can choose for presence and mode states (recorded on every change, never exported) */
export const MODE_KINDS = ['presence', 'holiday', 'guests', 'alarm', 'other'] as const;
export type ModeKind = (typeof MODE_KINDS)[number];

/** Kinds the user can choose for outdoor values */
export const OUTDOOR_KINDS = ['temperature', 'brightness', 'humidity', 'wind', 'rain', 'other'] as const;
export type OutdoorKind = (typeof OUTDOOR_KINDS)[number];

export interface ContextSource {
    id: string;
    /** "outdoor.temperature", "room.humidity", "mode.presence" … */
    kind: string;
    /** Recorded on every change instead of every 15 minutes (presence, modes) */
    onChange?: boolean;
    name: string;
    room?: string;
}

export interface ConfiguredContextValue {
    id?: string;
    kind?: string;
}

/** Room values found automatically by role: indoor temperature and humidity of sensors with a room */
const ROOM_ROLES: Record<string, string> = {
    'value.temperature': 'room.temperature',
    'value.humidity': 'room.humidity',
};

export interface ContextOptions {
    configured: ConfiguredContextValue[];
    /** Presence and mode states chosen by the user */
    modes?: ConfiguredContextValue[];
    /** Find room temperature and humidity automatically */
    autoRooms: boolean;
    ignoreAdapters: string[];
    exclude: string[];
    lang: string;
}

export function findContextSources(objects: ObjectMap, options: ContextOptions): ContextSource[] {
    const rooms = roomIndex(objects, options.lang);
    const result = new Map<string, ContextSource>();

    // Outdoor values chosen by the user – which sensor is "outside" cannot be recognised reliably
    for (const entry of options.configured) {
        const id = entry.id?.trim();
        if (!id) {
            continue;
        }
        const kind = OUTDOOR_KINDS.includes(entry.kind as OutdoorKind) ? entry.kind : 'other';
        result.set(id, {
            id,
            kind: `outdoor.${kind}`,
            name: readableName(id, objects, options.lang),
            room: findRoom(id, rooms),
        });
    }

    // Presence and modes: states, not numbers; the moment of the change matters
    for (const entry of options.modes ?? []) {
        const id = entry.id?.trim();
        if (!id) {
            continue;
        }
        const kind = MODE_KINDS.includes(entry.kind as ModeKind) ? entry.kind : 'other';
        result.set(id, {
            id,
            kind: `mode.${kind}`,
            name: readableName(id, objects, options.lang),
            room: findRoom(id, rooms),
            onChange: true,
        });
    }

    if (options.autoRooms) {
        const ignored = new Set(options.ignoreAdapters);
        for (const [id, obj] of Object.entries(objects)) {
            if (obj.type !== 'state' || result.has(id)) {
                continue;
            }
            const common = obj.common as ioBroker.StateCommon;
            const kind = ROOM_ROLES[common.role ?? ''];
            if (!kind || common.type !== 'number' || common.read === false) {
                continue;
            }
            const adapter = instanceOf(id).split('.')[0];
            if (adapter === 'system' || ignored.has(adapter) || matchesAny(id, options.exclude)) {
                continue;
            }
            // Only sensors with a room: they can be linked to the actions in that room
            const room = findRoom(id, rooms);
            if (!room) {
                continue;
            }
            result.set(id, { id, kind, name: readableName(id, objects, options.lang), room });
        }
    }
    return [...result.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/**
 * Relevance filter: decides which states Cortex observes.
 *
 * Rule-based and adapter-neutral: only the standard ioBroker roles count, so every adapter that
 * follows the role conventions is covered without special code. Measured values (temperature,
 * power …) are never observed.
 */

export type ObjectMap = Record<string, ioBroker.Object>;

/** Trigger = something that happens (sensor); action = something a person switches */
export type Kind = 'trigger' | 'action';

export type Category = 'light' | 'switch' | 'dimmer' | 'blind' | 'motion' | 'door' | 'window' | 'other';

export interface ObservedState {
    id: string;
    kind: Kind;
    category: Category;
    role: string;
    /** Adapter instance, e.g. "hue.0" */
    instance: string;
    /** Readable name (channel/device name, otherwise state name, otherwise id) */
    name: string;
    room?: string;
    /** Device the state belongs to: nearest parent of type device, otherwise channel, otherwise the parent */
    device: string;
}

export interface RelevanceOptions {
    /** Adapters whose states are never observed (e.g. "alias", "shuttercontrol") */
    ignoreAdapters: string[];
    /** Additional state IDs to observe, even without a matching role (prefix match, "*" as wildcard) */
    include: string[];
    /** State IDs never to observe (prefix match, "*" as wildcard) */
    exclude: string[];
    lang: string;
    /** Own namespace, e.g. "cortex.0" – never observed */
    namespace: string;
}

interface RoleRule {
    kind: Kind;
    category: Category;
    types: ioBroker.CommonType[];
    /** Role is also used for settings: only data point keys of real outputs count (ACTUATOR_KEYS) */
    keyed?: boolean;
    /** Actual state of an output, reported read-only (e.g. status channel of a Homematic IP actuator) */
    status?: boolean;
}

/** Exact roles. Kept deliberately small: a missing role is fixed with "include", noise is hard to get rid of. */
const ROLE_RULES: Record<string, RoleRule> = {
    'switch.light': { kind: 'action', category: 'light', types: ['boolean'] },
    switch: { kind: 'action', category: 'switch', types: ['boolean'], keyed: true },
    'switch.power': { kind: 'action', category: 'switch', types: ['boolean'] },
    'level.dimmer': { kind: 'action', category: 'dimmer', types: ['number'] },
    'level.brightness': { kind: 'action', category: 'dimmer', types: ['number'] },
    'level.blind': { kind: 'action', category: 'blind', types: ['number'] },
    'level.curtain': { kind: 'action', category: 'blind', types: ['number'] },
    // Actual state of outputs: the only place where a press on a directly linked wall switch becomes visible
    'value.blind': { kind: 'action', category: 'blind', types: ['number'], status: true },
    state: { kind: 'action', category: 'switch', types: ['boolean'], keyed: true, status: true },
    'sensor.motion': { kind: 'trigger', category: 'motion', types: ['boolean'] },
    'sensor.occupancy': { kind: 'trigger', category: 'motion', types: ['boolean'] },
    'sensor.door': { kind: 'trigger', category: 'door', types: ['boolean'] },
    'sensor.window': { kind: 'trigger', category: 'window', types: ['boolean'] },
    'value.window': { kind: 'trigger', category: 'window', types: ['number'] },
};

/**
 * Data point keys of real on/off outputs. Only checked for the plain role "switch", which many adapters also use for
 * settings. Covers the conventions of common device adapters (STATE, on, POWER, Switch, state, relay …).
 */
const ACTUATOR_KEYS = /^(state|on|power|switch|relay|onoff)[_-]?\d*$/i;

/** Names that say nothing on their own – the channel/device name is used instead */
const GENERIC_NAMES =
    /^(state|on|switch|level|bri|brightness|value|power|motion|presence|occupancy|open|opened|contact)$/i;

export function getName(obj: ioBroker.Object | undefined, lang: string): string | undefined {
    const name = obj?.common?.name;
    if (!name) {
        return undefined;
    }
    if (typeof name === 'string') {
        return name.trim() || undefined;
    }
    const translated = (name as Record<string, string>)[lang] ?? name.en ?? Object.values(name)[0];
    return typeof translated === 'string' && translated.trim() ? translated.trim() : undefined;
}

/** "hm-rpc.0.ABC.1.STATE" → "hm-rpc.0" */
export function instanceOf(id: string): string {
    return id.split('.', 2).join('.');
}

/** Parses a comma- or newline-separated list */
export function parseList(text: string | undefined): string[] {
    return (text ?? '')
        .split(/[,\n;]/)
        .map(s => s.trim())
        .filter(Boolean);
}

/** Prefix match; "*" matches any characters */
export function matchesAny(id: string, patterns: string[]): boolean {
    return patterns.some(pattern => {
        if (!pattern.includes('*')) {
            return id === pattern || id.startsWith(`${pattern}.`);
        }
        const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
        return regex.test(id);
    });
}

function escapeRegex(text: string): string {
    return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** Parent objects of a state, nearest first ("a.b.c.d" → "a.b.c", "a.b") */
function parents(id: string): string[] {
    const parts = id.split('.');
    const result: string[] = [];
    for (let i = parts.length - 1; i > 2; i--) {
        result.push(parts.slice(0, i).join('.'));
    }
    return result;
}

/** Names that only repeat the data point key or contain a serial number ("001658A98F60D0:2.LEVEL") */
function isTechnical(name: string, id: string): boolean {
    const key = id.split('.').pop() ?? '';
    return GENERIC_NAMES.test(name) || name.toLowerCase() === key.toLowerCase() || /[0-9A-F]{10,}/.test(name);
}

/**
 * Readable name: the nearest meaningful name of the state, its parent or grandparent (any object type).
 * Fallback: the key of the parent with spaces ("Leuchte_Einfahrt" → "Leuchte Einfahrt").
 */
function readableName(id: string, objects: ObjectMap, lang: string): string {
    const own = getName(objects[id], lang);
    const ownUseful = own && !isTechnical(own, id) ? own : undefined;
    const [parentId, grandParentId] = parents(id);
    const parentName = parentId ? getName(objects[parentId], lang) : undefined;
    if (parentName && !isTechnical(parentName, parentId)) {
        return ownUseful && ownUseful !== parentName ? `${parentName} ${ownUseful}` : parentName;
    }
    const grandParentName = grandParentId ? getName(objects[grandParentId], lang) : undefined;
    if (grandParentName && !isTechnical(grandParentName, grandParentId)) {
        // Device name for an unnamed channel: keep the channel apart from its siblings ("Switch actuator (9)")
        const channel = parentId.split('.').pop();
        return objects[parentId]?.type === 'channel' ? `${grandParentName} (${channel})` : grandParentName;
    }
    if (ownUseful) {
        return ownUseful;
    }
    const parentKey = parents(id)[0]?.split('.').pop();
    if (parentKey && !/[0-9A-F]{10,}/.test(parentKey) && !/^\d+$/.test(parentKey)) {
        return parentKey.replace(/_/g, ' ');
    }
    return own ?? id;
}

function deviceOf(id: string, objects: ObjectMap): string {
    const ancestors = parents(id);
    return (
        ancestors.find(p => objects[p]?.type === 'device') ??
        ancestors.find(p => objects[p]?.type === 'channel') ??
        ancestors[0] ??
        id
    );
}

/** Room per state from enum.rooms (members may be the state itself or one of its parents) */
function roomIndex(objects: ObjectMap, lang: string): Map<string, string> {
    const index = new Map<string, string>();
    for (const [id, obj] of Object.entries(objects)) {
        if (!id.startsWith('enum.rooms.') || obj.type !== 'enum') {
            continue;
        }
        const roomName = getName(obj, lang) ?? id.slice('enum.rooms.'.length);
        for (const member of (obj.common as ioBroker.EnumCommon).members ?? []) {
            index.set(member, roomName);
        }
    }
    return index;
}

function findRoom(id: string, rooms: Map<string, string>): string | undefined {
    return (
        rooms.get(id) ??
        parents(id)
            .map(p => rooms.get(p))
            .find(Boolean)
    );
}

/** Fallback for "include" entries without a known role: writable = action, read-only = trigger */
function guessRule(common: ioBroker.StateCommon): RoleRule {
    return { kind: common.write === false ? 'trigger' : 'action', category: 'other', types: [] };
}

export function findRelevant(objects: ObjectMap, options: RelevanceOptions): Map<string, ObservedState> {
    const rooms = roomIndex(objects, options.lang);
    const ignored = new Set(options.ignoreAdapters);
    const result = new Map<string, ObservedState>();

    for (const [id, obj] of Object.entries(objects)) {
        if (obj.type !== 'state') {
            continue;
        }
        const instance = instanceOf(id);
        const adapter = instance.split('.')[0];
        if (
            id.startsWith(`${options.namespace}.`) ||
            adapter === 'system' ||
            ignored.has(adapter) ||
            matchesAny(id, options.exclude)
        ) {
            continue;
        }
        const common = obj.common as ioBroker.StateCommon;
        const role = common.role ?? '';
        let rule: RoleRule | undefined = ROLE_RULES[role];
        if (rule?.keyed && !ACTUATOR_KEYS.test(id.split('.').pop() ?? '')) {
            // Plain roles like "switch" are also used for settings (camera LED, privacy mode, wallbox options …)
            rule = undefined;
        }
        if (rule) {
            const typeOk = rule.types.includes(common.type);
            // Actions must be writable, triggers readable
            const accessOk = rule.kind === 'action' && !rule.status ? common.write !== false : common.read !== false;
            if (!typeOk || !accessOk) {
                rule = undefined;
            }
        }
        if (!rule && matchesAny(id, options.include)) {
            rule = guessRule(common);
        }
        if (!rule) {
            continue;
        }
        result.set(id, {
            id,
            kind: rule.kind,
            category: rule.category,
            role,
            instance,
            name: readableName(id, objects, options.lang),
            room: findRoom(id, rooms),
            device: deviceOf(id, objects),
        });
    }
    return result;
}

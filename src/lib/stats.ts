/**
 * Daily statistics of the recorder. They exist to answer one question on a real installation:
 * does the classification "person or automation" match what actually happened?
 */
import { MANUAL_ORIGINS, type Origin, type RecordedEvent } from './classify';
import type { ObservedState } from './relevance';

export type OriginCounts = Record<Origin, number>;

export interface DayStats {
    /** Local date YYYY-MM-DD */
    date: string;
    /** Recorded events (actions and sensors) */
    events: number;
    /** Actions, changes of a scene/group counted once */
    actions: OriginCounts;
    /** Device reports that confirmed a command from ioBroker (not recorded as events) */
    confirmations: number;
    /** Actions per adapter instance of the switched state, e.g. { "hue.0": { device: 12, ui: 3 } } */
    byInstance: Record<string, Partial<OriginCounts>>;
    /** Senders that are in neither adapter list (origin "other") – candidates for the settings */
    unknownSenders: Record<string, number>;
}

export interface RecentAction {
    t: number;
    name: string;
    room?: string;
    value: ioBroker.StateValue;
    origin: Origin;
    sender: string;
    /** Origin "external": name of the sensor that changed just before */
    trigger?: string;
}

/** Looks up an observed state by its ID (names and rooms for the recent actions) */
export type StateLookup = (id: string) => ObservedState | undefined;

const MAX_RECENT = 30;

function emptyCounts(): OriginCounts {
    return { ui: 0, script: 0, device: 0, external: 0, other: 0, sensor: 0 };
}

/** Local date of a timestamp as YYYY-MM-DD */
export function dayKey(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function emptyStats(date: string): DayStats {
    return { date, events: 0, actions: emptyCounts(), confirmations: 0, byInstance: {}, unknownSenders: {} };
}

export class StatsCollector {
    private stats: DayStats;
    private recent: RecentAction[] = [];
    /** Last burst per instance/origin – an action of a scene/group is counted once */
    private readonly countedBursts = new Map<string, number>();

    public constructor(date: string) {
        this.stats = emptyStats(date);
    }

    public get today(): DayStats {
        return this.stats;
    }

    public get recentActions(): RecentAction[] {
        return this.recent;
    }

    /** Starts a new day (keeps the recent actions) */
    public reset(date: string): void {
        this.stats = emptyStats(date);
        this.countedBursts.clear();
    }

    public addConfirmation(): void {
        this.stats.confirmations++;
    }

    public addEvent(event: RecordedEvent, lookup: StateLookup): void {
        const state = lookup(event.id);
        this.stats.events++;
        if (event.o === 'sensor') {
            this.stats.actions.sensor++;
            return;
        }
        if (event.o === 'other') {
            this.stats.unknownSenders[event.s || '?'] = (this.stats.unknownSenders[event.s || '?'] ?? 0) + 1;
        }
        const instance = state?.instance ?? event.id.split('.', 2).join('.');
        const key = `${instance}|${event.o}`;
        if (this.countedBursts.get(key) !== event.b) {
            this.countedBursts.set(key, event.b);
            this.stats.actions[event.o]++;
            const perInstance = (this.stats.byInstance[instance] ??= {});
            perInstance[event.o] = (perInstance[event.o] ?? 0) + 1;
        }
        this.remember(event, state, lookup);
    }

    /**
     * Recent actions, so that the origin can be checked against what really happened. Sensors are left out: outdoor
     * motion sensors report every few seconds and would push the actions out of the list.
     */
    private remember(event: RecordedEvent, state: ObservedState | undefined, lookup: StateLookup): void {
        this.recent.unshift({
            t: event.t,
            name: state?.name ?? event.id,
            room: state?.room,
            value: event.v,
            origin: event.o,
            sender: event.s,
            trigger: event.x ? (lookup(event.x)?.name ?? event.x) : undefined,
        });
        if (this.recent.length > MAX_RECENT) {
            this.recent.length = MAX_RECENT;
        }
    }
}

/** Share of manual actions among all actions in percent (null without actions) */
export function manualShare(stats: DayStats): number | null {
    const { ui, device, script, external, other } = stats.actions;
    const total = ui + device + script + external + other;
    if (!total) {
        return null;
    }
    const manual = MANUAL_ORIGINS.reduce((sum, origin) => sum + stats.actions[origin], 0);
    return Math.round((manual * 100) / total);
}

/** "17:32 Living room · Ceiling light → true (device, hue)" */
export function describe(action: RecentAction): string {
    const d = new Date(action.t);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const where = action.room ? `${action.room} · ${action.name}` : action.name;
    let via = action.sender ? `${action.origin}, ${action.sender}` : action.origin;
    if (action.trigger) {
        via += `, after ${action.trigger}`;
    }
    return `${time} ${where} → ${String(action.value)} (${via})`;
}

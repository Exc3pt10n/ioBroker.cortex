/**
 * Classification: who caused a state change – a person or an automation?
 *
 * This is the core question of Cortex. Only the generic fields every ioBroker state carries are used
 * (ack, from, ts, lc), so the rules work for every adapter. Everything that cannot be decided reliably
 * is kept as its own origin instead of being guessed, so that it can be checked against real data.
 */
import { instanceOf, type ObservedState } from './relevance';

/**
 * - ui: command from a user interface or voice assistant (admin, web/vis, smartvis, alexa2 …)
 * - script: command from a logic adapter (javascript, scenes, shuttercontrol …)
 * - device: change reported by the device without a preceding command from ioBroker –
 *   a physical switch, an app of the manufacturer, or an automation outside ioBroker (bridge, CCU)
 * - other: command from an adapter that is in neither list
 * - sensor: change of a trigger (motion, door, window)
 */
export type Origin = 'ui' | 'script' | 'device' | 'other' | 'sensor';

/** Origins that count as manual actions */
export const MANUAL_ORIGINS: readonly Origin[] = ['ui', 'device'];

export interface ClassifierOptions {
    uiAdapters: string[];
    scriptAdapters: string[];
    /** A device report within this time after a command confirms the command */
    confirmWindowMs: number;
    /** Changes of one adapter instance with the same origin closer than this belong to one action (scene, group) */
    burstWindowMs: number;
}

export interface StateChange {
    val: ioBroker.StateValue;
    ack: boolean;
    from?: string;
    ts: number;
    lc: number;
}

export interface RecordedEvent {
    /** Timestamp (ms) */
    t: number;
    id: string;
    v: ioBroker.StateValue;
    /** Origin */
    o: Origin;
    /** Sender: adapter name from "from" ("javascript", "hue", "user" …) */
    s: string;
    /** Burst: timestamp of the first event of the same action */
    b: number;
}

export type ClassifyResult = { type: 'event'; event: RecordedEvent } | { type: 'confirmation' } | { type: 'ignored' };

/** "system.adapter.javascript.0" → "javascript", "system.user.admin" → "user" */
export function senderOf(from: string | undefined): string {
    if (!from) {
        return '';
    }
    if (from.startsWith('system.adapter.')) {
        return from.slice('system.adapter.'.length).split('.')[0];
    }
    if (from.startsWith('system.user.')) {
        return 'user';
    }
    if (from.startsWith('system.host.')) {
        return 'host';
    }
    return from.split('.')[0];
}

interface Pending {
    ts: number;
}

interface LastBurst {
    ts: number;
    burst: number;
}

export class Classifier {
    private readonly pending = new Map<string, Pending>();
    private readonly bursts = new Map<string, LastBurst>();

    public constructor(private options: ClassifierOptions) {}

    public setOptions(options: ClassifierOptions): void {
        this.options = options;
    }

    public classify(state: ObservedState, change: StateChange): ClassifyResult {
        const sender = senderOf(change.from);
        const changed = change.lc === change.ts;

        if (state.kind === 'trigger') {
            if (!changed) {
                return { type: 'ignored' };
            }
            return { type: 'event', event: this.event(state, change, 'sensor', sender) };
        }

        if (!change.ack) {
            // Command: also counts when the value does not change (a person pressed "on" again)
            const origin = this.commandOrigin(sender);
            this.pending.set(state.id, { ts: change.ts });
            return { type: 'event', event: this.event(state, change, origin, sender) };
        }

        const pending = this.pending.get(state.id);
        if (pending && change.ts - pending.ts <= this.options.confirmWindowMs) {
            this.pending.delete(state.id);
            return { type: 'confirmation' };
        }
        if (pending) {
            this.pending.delete(state.id);
        }
        if (!changed) {
            return { type: 'ignored' };
        }
        return { type: 'event', event: this.event(state, change, this.deviceOrigin(state, sender), sender) };
    }

    /** Confirmed value written by the device adapter itself (or without sender) = device; otherwise by sender */
    private deviceOrigin(state: ObservedState, sender: string): Origin {
        if (!sender || sender === instanceOf(state.id).split('.')[0]) {
            return 'device';
        }
        return this.commandOrigin(sender);
    }

    private commandOrigin(sender: string): Origin {
        if (sender === 'user' || this.options.uiAdapters.includes(sender)) {
            return 'ui';
        }
        if (this.options.scriptAdapters.includes(sender)) {
            return 'script';
        }
        return 'other';
    }

    private event(state: ObservedState, change: StateChange, origin: Origin, sender: string): RecordedEvent {
        const key = `${state.instance}|${origin}`;
        const last = this.bursts.get(key);
        const burst = last && change.ts - last.ts <= this.options.burstWindowMs ? last.burst : change.ts;
        this.bursts.set(key, { ts: change.ts, burst });
        return { t: change.ts, id: state.id, v: change.val, o: origin, s: sender, b: burst };
    }
}

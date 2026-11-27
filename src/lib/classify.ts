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
 *   a physical switch or an app of the manufacturer
 * - external: like device, but within seconds after a sensor of the same adapter instance changed – an automation
 *   outside ioBroker (Hue bridge, CCU program, Shelly). Such systems only control their own devices, and a person
 *   needs longer from walking past a motion sensor to pressing a switch.
 * - other: command from an adapter that is in neither list
 * - sensor: change of a trigger (motion, door, window)
 */
export type Origin = 'ui' | 'script' | 'device' | 'external' | 'other' | 'sensor';

/** Origins that count as manual actions */
export const MANUAL_ORIGINS: readonly Origin[] = ['ui', 'device'];

export interface ClassifierOptions {
    uiAdapters: string[];
    scriptAdapters: string[];
    /** A device report within this time after a command confirms the command */
    confirmWindowMs: number;
    /** Changes of one adapter instance with the same origin closer than this belong to one action (scene, group) */
    burstWindowMs: number;
    /** A device change this soon after a sensor change of the same instance is an automation outside ioBroker */
    externalWindowMs: number;
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
    /** 1 = device report caused by a preceding command to the same adapter instance (origin taken from the command) */
    c?: 1;
    /** Origin "external": the sensor that changed just before */
    x?: string;
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

interface LastCommand {
    ts: number;
    origin: Origin;
    sender: string;
}

interface LastBurst {
    ts: number;
    burst: number;
}

export class Classifier {
    private readonly pending = new Map<string, Pending>();
    private readonly bursts = new Map<string, LastBurst>();
    /** Last command per device: its reports belong to the command as long as they keep coming */
    private readonly commands = new Map<string, LastCommand>();
    /** Last command per adapter instance: reports of other devices right after it (group, scene) belong to it */
    private readonly instanceCommands = new Map<string, LastCommand>();
    /** Last sensor change per adapter instance */
    private readonly sensors = new Map<string, { ts: number; id: string }>();

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
            this.sensors.set(state.instance, { ts: change.ts, id: state.id });
            return { type: 'event', event: this.event(state, change, 'sensor', sender) };
        }

        if (!change.ack) {
            // Command: also counts when the value does not change (a person pressed "on" again)
            const origin = this.commandOrigin(sender);
            this.pending.set(state.id, { ts: change.ts });
            this.commands.set(state.device, { ts: change.ts, origin, sender });
            this.instanceCommands.set(state.instance, { ts: change.ts, origin, sender });
            return { type: 'event', event: this.event(state, change, origin, sender) };
        }

        const command = this.commands.get(state.device);
        const followsCommand = !!command && change.ts - command.ts <= this.options.confirmWindowMs;
        // Other devices of the instance only right after the command: a whole CCU is one instance, and a wall switch
        // pressed a few seconds after an unrelated command must stay a manual action
        const instanceCommand = this.instanceCommands.get(state.instance);
        const followsInstanceCommand =
            !!instanceCommand && change.ts - instanceCommand.ts <= this.options.burstWindowMs;
        const pending = this.pending.get(state.id);
        this.pending.delete(state.id);
        if (pending && change.ts - pending.ts <= this.options.confirmWindowMs) {
            if (followsCommand) {
                this.slide(command, change.ts);
            }
            return { type: 'confirmation' };
        }
        if (!changed) {
            return { type: 'ignored' };
        }
        const origin = this.deviceOrigin(state, sender);
        if (origin === 'device' && followsCommand) {
            // Consequence of a command to the same device: status channel, virtual channels, a moving blind
            this.slide(command, change.ts);
            const event = this.event(state, change, command.origin, command.sender);
            return { type: 'event', event: { ...event, c: 1 } };
        }
        if (origin === 'device' && followsInstanceCommand) {
            // Consequence of a command to another device of the instance: lamps of a group or scene
            const event = this.event(state, change, instanceCommand.origin, instanceCommand.sender);
            return { type: 'event', event: { ...event, c: 1 } };
        }
        const sensor = this.sensors.get(state.instance);
        if (origin === 'device' && sensor && change.ts - sensor.ts <= this.options.externalWindowMs) {
            return { type: 'event', event: { ...this.event(state, change, 'external', sender), x: sensor.id } };
        }
        return { type: 'event', event: this.event(state, change, origin, sender) };
    }

    /** Reports that keep coming (a moving blind) keep belonging to the command */
    private slide(command: LastCommand | undefined, ts: number): void {
        if (command && ts > command.ts) {
            command.ts = ts;
        }
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

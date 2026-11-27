import * as utils from '@iobroker/adapter-core';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Classifier, type ClassifierOptions } from './lib/classify';
import { findContextSources, type ContextSource } from './lib/context';
import { ContextLog, EventLog, type ContextSample } from './lib/eventlog';
import { buildExport } from './lib/export';
import { findRelevant, parseList, type ObservedState, type RelevanceOptions } from './lib/relevance';
import { StatsCollector, dayKey, describe, manualShare } from './lib/stats';

/** Write buffered events and update the statistics states */
const FLUSH_INTERVAL_MS = 60_000;
/** Look for new or removed devices */
const RESCAN_INTERVAL_MS = 60 * 60_000;
/** Sample the context values (outdoor temperature …) */
const CONTEXT_INTERVAL_MS = 15 * 60_000;

class Cortex extends utils.Adapter {
    private observed = new Map<string, ObservedState>();
    private classifier?: Classifier;
    private log_?: EventLog;
    private context?: ContextLog;
    private lastContextSample = 0;
    private contextSources: ContextSource[] = [];
    /** Presence and mode states, recorded on every change */
    private modes = new Map<string, ContextSource>();
    private subscribed = new Set<string>();
    private stats = new StatsCollector(dayKey(Date.now()));
    private flushTimer?: ioBroker.Interval;
    private rescanTimer?: ioBroker.Interval;
    private lang = 'en';
    private statsDirty = true;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'cortex' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        this.lang = await this.systemLanguage();
        this.classifier = new Classifier(this.classifierOptions());
        this.log_ = new EventLog(utils.getAbsoluteInstanceDataDir(this));
        this.context = new ContextLog(utils.getAbsoluteInstanceDataDir(this));

        // Meta object for the file storage of the instance (anonymous export)
        await this.setForeignObjectNotExistsAsync(this.namespace, {
            type: 'meta',
            common: { name: 'Cortex', type: 'meta.user' },
            native: {},
        });
        await this.ensureInstanceObjects();
        await this.restoreToday();
        await this.ensureRecordingSince();
        await this.rescan();
        await this.log_.cleanup(this.retentionDays());
        await this.context.cleanup(this.retentionDays());
        await this.sampleContext();
        await this.setStateAsync('info.status', 'recording', true);
        await this.updateStatsStates();

        this.flushTimer = this.setInterval(() => void this.tick(), FLUSH_INTERVAL_MS);
        this.rescanTimer = this.setInterval(() => void this.rescan(), RESCAN_INTERVAL_MS);
    }

    /**
     * Creates missing objects of the instance. ioBroker creates them only when the instance is created or upgraded
     * through ioBroker – not when a newer package is installed with npm directly (testers, manual updates).
     */
    private async ensureInstanceObjects(): Promise<void> {
        try {
            const ioPackage = JSON.parse(await readFile(join(__dirname, '..', 'io-package.json'), 'utf8')) as {
                instanceObjects?: (ioBroker.SettableObject & { _id: string })[];
            };
            for (const { _id, ...obj } of ioPackage.instanceObjects ?? []) {
                await this.setObjectNotExistsAsync(_id, obj);
            }
        } catch (e) {
            this.log.warn(`Checking the objects of the instance failed: ${(e as Error).message}`);
        }
    }

    private classifierOptions(): ClassifierOptions {
        return {
            uiAdapters: parseList(this.config.uiAdapters),
            scriptAdapters: parseList(this.config.scriptAdapters),
            confirmWindowMs: clamp(this.config.confirmWindow, 1, 120, 10) * 1000,
            burstWindowMs: clamp(this.config.burstWindow, 0, 30, 2) * 1000,
            externalWindowMs: clamp(this.config.externalWindow, 0, 30, 3) * 1000,
        };
    }

    private retentionDays(): number {
        return clamp(this.config.retentionDays, 7, 365, 60);
    }

    private async systemLanguage(): Promise<string> {
        const config = await this.getForeignObjectAsync('system.config');
        return config?.common?.language || 'en';
    }

    /** Statistics are derived from the log, so they survive a restart */
    private async restoreToday(): Promise<void> {
        const today = dayKey(Date.now());
        this.stats.reset(today);
        for (const event of await this.log_!.readDay(today)) {
            this.stats.addEvent(event, undefined);
        }
    }

    private async ensureRecordingSince(): Promise<void> {
        const since = await this.getStateAsync('info.recordingSince');
        if (!since?.val) {
            await this.setStateAsync('info.recordingSince', Date.now(), true);
        }
    }

    /** Finds the relevant states and adjusts the subscriptions */
    private async rescan(): Promise<void> {
        try {
            // Without a type only states are returned: channels and devices (names) and rooms are read separately
            const objects: Record<string, ioBroker.Object> = {
                ...(await this.getForeignObjectsAsync('*', 'state')),
                ...(await this.getForeignObjectsAsync('*', 'channel')),
                ...(await this.getForeignObjectsAsync('*', 'device')),
                ...(await this.getForeignObjectsAsync('*', 'folder')),
                ...(await this.getForeignObjectsAsync('enum.rooms.*', 'enum')),
            };
            const options: RelevanceOptions = {
                // States of user interfaces and voice assistants are their own settings, not devices
                ignoreAdapters: [...parseList(this.config.ignoreAdapters), ...parseList(this.config.uiAdapters)],
                include: parseList(this.config.include),
                exclude: parseList(this.config.exclude),
                lang: this.lang,
                namespace: this.namespace,
            };
            const next = findRelevant(objects, options);
            this.contextSources = findContextSources(objects, {
                configured: listOf(this.config.contextValues),
                modes: listOf(this.config.modeValues),
                autoRooms: this.config.contextRooms !== false,
                ignoreAdapters: options.ignoreAdapters,
                exclude: options.exclude,
                lang: this.lang,
            });
            await this.setStateAsync(
                'info.contextSources',
                JSON.stringify(
                    this.contextSources.map(c => ({ id: c.id, kind: c.kind, name: c.name, room: c.room ?? null })),
                ),
                true,
            );

            const modes = new Map(this.contextSources.filter(c => c.onChange).map(c => [c.id, c]));
            const newModes = [...modes.keys()].filter(id => !this.modes.has(id));
            this.observed = next;
            this.modes = modes;
            const wanted = new Set([...next.keys(), ...modes.keys()]);
            const removed = [...this.subscribed].filter(id => !wanted.has(id));
            const added = [...wanted].filter(id => !this.subscribed.has(id));
            this.subscribed = wanted;
            if (removed.length) {
                await this.unsubscribeForeignStatesAsync(removed);
            }
            if (added.length) {
                await this.subscribeForeignStatesAsync(added);
            }
            // Current value of new presence/mode states, so the log knows the state from the start
            for (const id of newModes) {
                const state = await this.getForeignStateAsync(id);
                if (state && state.val !== null) {
                    this.context?.append({ t: Date.now(), k: modes.get(id)!.kind, id, v: state.val });
                }
            }

            const states = [...next.values()];
            const actions = states.filter(s => s.kind === 'action').length;
            await this.setStateAsync('info.observedActions', actions, true);
            await this.setStateAsync('info.observedTriggers', states.length - actions, true);
            await this.setStateAsync(
                'info.observedStates',
                JSON.stringify(
                    states.map(s => ({
                        id: s.id,
                        name: s.name,
                        room: s.room ?? null,
                        kind: s.kind,
                        category: s.category,
                    })),
                ),
                true,
            );
            if (added.length || removed.length) {
                this.log.info(
                    `Observing ${actions} actions and ${states.length - actions} triggers (+${added.length}/-${removed.length})`,
                );
            }
        } catch (e) {
            this.log.error(`Search for relevant states failed: ${(e as Error).message}`);
        }
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        const mode = this.modes.get(id);
        if (mode && state && state.val !== null && state.lc === state.ts) {
            this.context?.append({ t: state.ts, k: mode.kind, id, v: state.val });
        }
        const observed = this.observed.get(id);
        if (!state || !observed || !this.classifier || !this.log_) {
            return;
        }
        const result = this.classifier.classify(observed, state);
        if (result.type === 'confirmation') {
            this.stats.addConfirmation();
        } else if (result.type === 'event') {
            const today = dayKey(result.event.t);
            if (today > this.stats.today.date) {
                this.stats.reset(today);
            }
            this.log_.append(result.event);
            this.stats.addEvent(result.event, observed);
            this.log.debug(`${id}: ${result.event.o} (${result.event.s || 'no sender'})`);
        }
        this.statsDirty = true;
    }

    /** Periodic work: write the log, roll over the day, update states */
    private async tick(): Promise<void> {
        try {
            if (Date.now() - this.lastContextSample >= CONTEXT_INTERVAL_MS) {
                await this.sampleContext();
            }
            await this.log_?.flush();
            await this.context?.flush();
            const today = dayKey(Date.now());
            if (today !== this.stats.today.date) {
                this.stats.reset(today);
                this.statsDirty = true;
                await this.log_?.cleanup(this.retentionDays());
                await this.context?.cleanup(this.retentionDays());
            }
            await this.updateStatsStates();
        } catch (e) {
            this.log.warn(`Writing the event log failed: ${(e as Error).message}`);
        }
    }

    private async sampleContext(): Promise<void> {
        this.lastContextSample = Date.now();
        for (const source of this.contextSources) {
            if (source.onChange) {
                continue;
            }
            try {
                const state = await this.getForeignStateAsync(source.id);
                const value = typeof state?.val === 'number' ? state.val : Number(state?.val);
                if (state && state.val !== null && state.val !== '' && Number.isFinite(value)) {
                    this.context?.append({ t: this.lastContextSample, k: source.kind, id: source.id, v: value });
                }
            } catch (e) {
                this.log.debug(`Reading context value ${source.id} failed: ${(e as Error).message}`);
            }
        }
    }

    private async updateStatsStates(): Promise<void> {
        if (!this.statsDirty) {
            return;
        }
        this.statsDirty = false;
        const today = this.stats.today;
        const { ui, device, script, external, other } = today.actions;
        const since = (await this.getStateAsync('info.recordingSince'))?.val;
        if (typeof since === 'number') {
            await this.setStateAsync('info.recordingDays', Math.floor((Date.now() - since) / 86_400_000), true);
        }
        await this.setStateAsync('stats.today', JSON.stringify(today), true);
        await this.setStateAsync('stats.manualActions', ui + device, true);
        await this.setStateAsync('stats.automatedActions', script + external, true);
        await this.setStateAsync('stats.unknownActions', other, true);
        await this.setStateAsync('stats.manualShare', manualShare(today), true);
        await this.setStateAsync('stats.unknownSenders', Object.keys(today.unknownSenders).sort().join(', '), true);
        const recent = this.stats.recentActions;
        await this.setStateAsync('stats.recent', JSON.stringify(recent), true);
        await this.setStateAsync('stats.recentText', recent.slice(0, 10).map(describe).join('\n'), true);
    }

    private async onMessage(obj: ioBroker.Message): Promise<void> {
        if (!obj?.command || !obj.callback) {
            return;
        }
        if (obj.command === 'export') {
            try {
                const path = await this.writeExport();
                this.sendTo(obj.from, obj.command, { result: `Saved in the file storage: ${path}` }, obj.callback);
            } catch (e) {
                this.sendTo(obj.from, obj.command, { error: (e as Error).message }, obj.callback);
            }
        }
    }

    /** Anonymous export of all recorded days into the ioBroker file storage (Admin → Files) */
    private async writeExport(): Promise<string> {
        await this.log_!.flush();
        await this.context!.flush();
        const events = [];
        for (const day of await this.log_!.days()) {
            events.push(...(await this.log_!.readDay(day)));
        }
        const context: ContextSample[] = [];
        for (const day of await this.context!.days()) {
            context.push(...(await this.context!.readDay(day)));
        }
        const text = buildExport(this.observed.values(), events, context, await this.exportSecret(), {
            adapterVersion: this.version,
            created: new Date().toISOString(),
            settings: this.classifierOptions(),
        });
        const path = `export/cortex-export-${dayKey(Date.now())}.jsonl.gz`;
        await this.writeFileAsync(this.namespace, path, gzipSync(text));
        this.log.info(`Anonymous export with ${events.length} events saved as ${this.namespace}/${path}`);
        return `${this.namespace}/${path}`;
    }

    /** Random secret of this installation for anonymous IDs (stable across exports) */
    private async exportSecret(): Promise<string> {
        const existing = (await this.getStateAsync('info.exportSecret'))?.val;
        if (typeof existing === 'string' && existing) {
            return existing;
        }
        const secret = randomBytes(16).toString('hex');
        await this.setStateAsync('info.exportSecret', secret, true);
        return secret;
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            if (this.flushTimer) {
                this.clearInterval(this.flushTimer);
            }
            if (this.rescanTimer) {
                this.clearInterval(this.rescanTimer);
            }
            await this.log_?.flush();
            await this.context?.flush();
        } finally {
            callback();
        }
    }
}

/** Table from the settings; also accepts an object with numeric keys (merged configurations) */
function listOf<T>(value: T[] | Record<string, T> | undefined): T[] {
    if (Array.isArray(value)) {
        return value;
    }
    return value && typeof value === 'object' ? Object.values(value) : [];
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Cortex(options);
} else {
    (() => new Cortex())();
}

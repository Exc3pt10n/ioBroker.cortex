/**
 * Anonymous export of the recorded data – to check the classification with data from many installations.
 *
 * Contains: adapter instance, role and category of each state, time, value, origin and sending adapter, and the
 * sampled context values (outdoor temperature, brightness).
 * Does not contain: object IDs, names, rooms. IDs are replaced by a hash with a random secret of this
 * installation, so they cannot be recovered by trying out common IDs.
 */
import { createHash } from 'node:crypto';
import type { RecordedEvent } from './classify';
import type { ContextSample } from './eventlog';
import type { ObservedState } from './relevance';

export interface ExportedState {
    key: string;
    instance: string;
    role: string;
    kind: ObservedState['kind'];
    category: ObservedState['category'];
}

export type ExportedEvent = Omit<RecordedEvent, 'id'> & { key: string };

export function anonymousKey(id: string, secret: string): string {
    return createHash('sha256').update(`${secret}|${id}`).digest('hex').slice(0, 12);
}

/** Builds the export as JSON lines: a header with the states, then one line per event */
export function buildExport(
    observed: Iterable<ObservedState>,
    events: RecordedEvent[],
    context: ContextSample[],
    secret: string,
    meta: Record<string, unknown>,
): string {
    const states: ExportedState[] = [...observed].map(s => ({
        key: anonymousKey(s.id, secret),
        instance: s.instance,
        role: s.role,
        kind: s.kind,
        category: s.category,
    }));
    const lines = [JSON.stringify({ type: 'header', ...meta, states })];
    for (const event of events) {
        const { id, ...rest } = event;
        const exported: ExportedEvent = { key: anonymousKey(id, secret), ...rest };
        lines.push(JSON.stringify(exported));
    }
    for (const sample of context) {
        const { id, ...rest } = sample;
        lines.push(JSON.stringify({ type: 'context', key: anonymousKey(id, secret), ...rest }));
    }
    return `${lines.join('\n')}\n`;
}

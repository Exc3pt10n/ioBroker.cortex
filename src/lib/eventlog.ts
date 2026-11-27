/**
 * Logs: one JSONL file per local day in the instance data directory – events ("2026-11-27.jsonl") and
 * context values ("2026-11-27.context.jsonl").
 *
 * Plain files instead of a database: no native dependencies (installs everywhere, also on ARM),
 * readable with any text editor, and old days are removed by deleting a file.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { RecordedEvent } from './classify';
import { dayKey } from './stats';

/** Measured value at a point in time (outdoor temperature, brightness …) */
export interface ContextSample {
    t: number;
    /** Kind of value, e.g. "outdoor.temperature", "room.humidity" */
    k: string;
    /** State the value was read from */
    id: string;
    v: number;
}

export class JsonlLog<T extends { t: number }> {
    private buffer = new Map<string, string[]>();
    private readonly pattern: RegExp;
    private readonly ending: string;

    /** @param suffix part of the file name before ".jsonl" ("" for events, "context" for context values) */
    public constructor(
        private readonly dir: string,
        suffix = '',
    ) {
        this.ending = suffix ? `.${suffix}.jsonl` : '.jsonl';
        this.pattern = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})${this.ending.replace(/\./g, '\\.')}$`);
    }

    private file(day: string): string {
        return join(this.dir, `${day}${this.ending}`);
    }

    public append(event: T): void {
        const day = dayKey(event.t);
        const lines = this.buffer.get(day) ?? [];
        lines.push(JSON.stringify(event));
        this.buffer.set(day, lines);
    }

    /** Writes buffered events to disk */
    public async flush(): Promise<void> {
        if (!this.buffer.size) {
            return;
        }
        const pending = this.buffer;
        this.buffer = new Map();
        await fs.mkdir(this.dir, { recursive: true });
        for (const [day, lines] of pending) {
            await fs.appendFile(this.file(day), `${lines.join('\n')}\n`, 'utf8');
        }
    }

    /** Recorded days, oldest first */
    public async days(): Promise<string[]> {
        try {
            const files = await fs.readdir(this.dir);
            return files
                .map(f => this.pattern.exec(f)?.[1])
                .filter((d): d is string => !!d)
                .sort();
        } catch {
            return [];
        }
    }

    /** Events of one day (unreadable lines, e.g. after a power cut, are skipped) */
    public async readDay(day: string): Promise<T[]> {
        let text: string;
        try {
            text = await fs.readFile(this.file(day), 'utf8');
        } catch {
            return [];
        }
        const events: T[] = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) {
                continue;
            }
            try {
                events.push(JSON.parse(line) as T);
            } catch {
                // incomplete line
            }
        }
        return events;
    }

    /** Deletes days older than the retention period; returns the number of deleted days */
    public async cleanup(retentionDays: number, now = Date.now()): Promise<number> {
        const oldest = dayKey(now - retentionDays * 24 * 60 * 60 * 1000);
        let deleted = 0;
        for (const day of await this.days()) {
            if (day < oldest) {
                await fs.rm(this.file(day), { force: true });
                deleted++;
            }
        }
        return deleted;
    }
}

/** Log of recorded events */
export class EventLog extends JsonlLog<RecordedEvent> {}

/** Log of context values, sampled periodically */
export class ContextLog extends JsonlLog<ContextSample> {
    public constructor(dir: string) {
        super(dir, 'context');
    }
}

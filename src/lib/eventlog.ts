/**
 * Event log: one JSONL file per local day in the instance data directory.
 *
 * Plain files instead of a database: no native dependencies (installs everywhere, also on ARM),
 * readable with any text editor, and old days are removed by deleting a file.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { RecordedEvent } from './classify';
import { dayKey } from './stats';

const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class EventLog {
    private buffer = new Map<string, string[]>();

    public constructor(private readonly dir: string) {}

    public append(event: RecordedEvent): void {
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
            await fs.appendFile(join(this.dir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
        }
    }

    /** Recorded days, oldest first */
    public async days(): Promise<string[]> {
        try {
            const files = await fs.readdir(this.dir);
            return files
                .map(f => FILE_PATTERN.exec(f)?.[1])
                .filter((d): d is string => !!d)
                .sort();
        } catch {
            return [];
        }
    }

    /** Events of one day (unreadable lines, e.g. after a power cut, are skipped) */
    public async readDay(day: string): Promise<RecordedEvent[]> {
        let text: string;
        try {
            text = await fs.readFile(join(this.dir, `${day}.jsonl`), 'utf8');
        } catch {
            return [];
        }
        const events: RecordedEvent[] = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) {
                continue;
            }
            try {
                events.push(JSON.parse(line) as RecordedEvent);
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
                await fs.rm(join(this.dir, `${day}.jsonl`), { force: true });
                deleted++;
            }
        }
        return deleted;
    }
}

import { PLUGIN_CAPABILITY_NARRATION, type PluginManifest } from '@deadair/plugin-sdk';
import { z } from 'zod';

export const REQUEST_TIMEOUT_MS = 15_000;
export const BOOKS_KEY = 'books';

export const booksConfig = z.object({
    books: z.string().default('[]'),
});

export type BooksConfig = z.infer<typeof booksConfig>;

export interface ConfiguredBook {
    name: string;
    url: string;
}

const isFetchable = (url: string): boolean => {
    try {
        const { protocol } = new URL(url.trim());
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
};

/** Lenient reader: drops rows without a fetchable address (refused at save by the schema below). */
export function parseBookRows(raw: unknown, onDrop?: (row: unknown) => void): ConfiguredBook[] {
    if (typeof raw !== 'string' || raw.trim().length === 0) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const out: ConfiguredBook[] = [];
        // One address, one book: repeats would list — and read — the book twice.
        const seen = new Set<string>();
        for (const entry of parsed) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                onDrop?.(entry);
                continue;
            }
            const rec = entry as Record<string, unknown>;
            const url = typeof rec.url === 'string' ? rec.url.trim() : '';
            if (!isFetchable(url) || seen.has(url)) {
                onDrop?.(entry);
                continue;
            }
            seen.add(url);
            const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, 300) : '';
            out.push({ name, url });
        }
        return out;
    } catch {
        return [];
    }
}

function readsAsBookRows(value: string): boolean {
    if (value.trim().length === 0) return true;
    try {
        const parsed: unknown = JSON.parse(value);
        if (!Array.isArray(parsed)) return false;
        return parsed.every(row => {
            if (typeof row !== 'object' || row === null || Array.isArray(row)) return false;
            return isFetchable(String((row as Record<string, unknown>).url ?? ''));
        });
    } catch {
        return false;
    }
}

const booksRefine = z
    .string()
    .default('[]')
    .refine(v => readsAsBookRows(v), 'Each book needs an address starting with http:// or https://');

export const booksConfigSchema = z.object({
    books: booksRefine,
});

export const booksManifest: PluginManifest = {
    id: 'radio.vellichor.books',
    name: 'Vellichor books',
    version: '0.1.0',
    description: 'Reads EPUB books from your own addresses so the station can read a chapter aloud at a narration band.',
    capabilities: [PLUGIN_CAPABILITY_NARRATION],
    apiVersion: '^1.0.0',
    permissions: {
        // No hostname exists at authoring time: the host reads one address per row out of `url`, paced gently for public libraries and mirrors.
        network: [{ fromConfig: BOOKS_KEY, ratePerSecond: 2 }],
        // A whole book never fits one stored value, hence the slim manifest plus one key per chapter below.
        storage: true,
        oauth: false,
    },
    configFields: [
        {
            key: BOOKS_KEY,
            label: 'Books',
            type: 'list',
            required: true,
            placeholder: 'No books yet.',
            help: 'One row per book, with the address of its EPUB file: Project Gutenberg, Standard Ebooks, a Calibre-Web instance, or your own file server. Each book caches about one stored key per chapter against a 200-key station budget, so keep the shelf to a handful of books.',
            columns: [
                { key: 'name', label: 'Name', type: 'string', placeholder: 'Frankenstein' },
                { key: 'url', label: 'EPUB address', type: 'url', required: true, placeholder: 'https://example.com/frankenstein.epub' },
            ],
        },
    ],
    configSchema: booksConfigSchema,
};

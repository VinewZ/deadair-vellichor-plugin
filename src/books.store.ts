import type { EpubChapter, EpubIndex } from './books.epub.js';
import { isNamedAuthor, stripEditorial } from './books.epub.js';

/**
 * Persistent cache for parsed books. A whole book never fits one stored
 * value, so this keeps a slim manifest plus one key per chapter's text,
 * each safely under the host's per-value cap. Best-effort: persistence
 * failing only costs a re-fetch, never a listing.
 */

export const STORE_VERSION = 1;

/** Keep each stored value comfortably under the host's per-value cap. */
export const CHAPTER_VALUE_GUARD_BYTES = 48 * 1024;

export interface StoredChapter {
    title: string;
    href: string;
    wordCount: number;
    /** How many text keys hold this chapter's paragraphs. */
    chunks: number;
}

export interface StoredManifest {
    v: typeof STORE_VERSION;
    title: string;
    author?: string;
    language?: string;
    description?: string;
    fetchedAt: number;
    chapters: StoredChapter[];
}

export interface KeyValueStore {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list?(prefix?: string): Promise<string[]>;
}

export const legacyIndexKey = (id: string): string => `epub-index:${id}`;
export const manifestKey = (id: string): string => `epub-manifest:${id}`;
export const chapterKey = (id: string, ordinal: number, chunk: number, chunked: boolean): string =>
    chunked ? `epub-text:${id}:${ordinal}:${chunk}` : `epub-text:${id}:${ordinal}`;

function byteLength(text: string): number {
    return new TextEncoder().encode(text).length;
}

/** Split paragraphs into groups that each fit one stored value. Always makes progress: an oversized paragraph gets a group of its own. */
export function chunkParagraphs(paragraphs: string[], maxBytes: number = CHAPTER_VALUE_GUARD_BYTES): string[][] {
    const groups: string[][] = [];
    let current: string[] = [];
    let currentBytes = 2; // JSON array brackets
    for (const paragraph of paragraphs) {
        const size = byteLength(paragraph) + 3; // quotes + separator
        if (current.length > 0 && currentBytes + size > maxBytes) {
            groups.push(current);
            current = [];
            currentBytes = 2;
        }
        current.push(paragraph);
        currentBytes += size;
    }
    if (current.length > 0) groups.push(current);
    return groups;
}

export function toManifest(index: EpubIndex, fetchedAt: number): StoredManifest {
    return {
        v: STORE_VERSION,
        title: index.title,
        ...(isNamedAuthor(index.author) ? { author: index.author } : {}),
        ...(index.language ? { language: index.language } : {}),
        ...(index.description ? { description: index.description } : {}),
        fetchedAt,
        chapters: index.chapters.map(ch => ({
            title: ch.title,
            href: ch.href,
            wordCount: ch.wordCount,
            chunks: Math.max(1, chunkParagraphs(ch.paragraphs).length),
        })),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStoredManifest(value: unknown): value is StoredManifest {
    if (!isRecord(value) || value.v !== STORE_VERSION) return false;
    if (typeof value.title !== 'string' || value.title.length === 0) return false;
    if (value.author !== undefined && typeof value.author !== 'string') return false;
    if (value.language !== undefined && typeof value.language !== 'string') return false;
    if (value.description !== undefined && typeof value.description !== 'string') return false;
    if (typeof value.fetchedAt !== 'number') return false;
    if (!Array.isArray(value.chapters)) return false;
    return (value.chapters as unknown[]).every(
        ch =>
            isRecord(ch) &&
            typeof ch.title === 'string' &&
            typeof ch.href === 'string' &&
            typeof ch.wordCount === 'number' &&
            typeof ch.chunks === 'number' &&
            ch.chunks >= 1,
    );
}

/** The pre-fix shape: a whole EpubIndex under one key. Still readable, never written. */
function isLegacyIndex(value: unknown): value is EpubIndex {
    if (!isRecord(value) || typeof value.title !== 'string' || value.title.length === 0) return false;
    if (value.author !== undefined && typeof value.author !== 'string') return false;
    if (value.language !== undefined && typeof value.language !== 'string') return false;
    if (value.description !== undefined && typeof value.description !== 'string') return false;
    if (!Array.isArray(value.chapters)) return false;
    return (value.chapters as unknown[]).every(
        ch =>
            isRecord(ch) &&
            typeof ch.title === 'string' &&
            typeof ch.href === 'string' &&
            typeof ch.wordCount === 'number' &&
            Array.isArray(ch.paragraphs) &&
            (ch.paragraphs as unknown[]).every(p => typeof p === 'string'),
    );
}

async function safeSet(store: KeyValueStore, key: string, value: unknown, failed: string[]): Promise<void> {
    try {
        await store.set(key, value);
    } catch {
        failed.push(key);
    }
}

/** Persist an index in the slim scheme. Resolves with the keys that refused to store; never throws for storage reasons. */
export async function persistIndex(store: KeyValueStore, id: string, index: EpubIndex, fetchedAt: number): Promise<{ failed: string[] }> {
    const failed: string[] = [];
    const manifest = toManifest(index, fetchedAt);
    const chunkedFlags = index.chapters.map(ch => chunkParagraphs(ch.paragraphs).length > 1);
    const manifestId = manifestKey(id);
    await safeSet(store, manifestId, manifest, failed);
    const manifestStored = !failed.includes(manifestId);
    for (let ordinal = 0; ordinal < index.chapters.length; ordinal++) {
        const chapter = index.chapters[ordinal] as EpubChapter;
        // A chapter with no paragraphs still owns exactly one key holding [],
        // matching the chunks:1 the manifest records for it.
        const groups = chunkParagraphs(chapter.paragraphs);
        const list = groups.length === 0 ? [[] as string[]] : groups;
        const chunked = chunkedFlags[ordinal] === true;
        for (let chunk = 0; chunk < list.length; chunk++) {
            await safeSet(store, chapterKey(id, ordinal, chunk, chunked), list[chunk], failed);
        }
    }
    // Delete the pre-fix full-index key only once the slim manifest is
    // stored, so a failed manifest never costs the old fallback.
    if (manifestStored) {
        try {
            await store.delete(legacyIndexKey(id));
        } catch {
            // Intentionally ignored.
        }
    }
    return { failed };
}

async function readChapter(store: KeyValueStore, id: string, ordinal: number, entry: StoredChapter): Promise<string[] | undefined> {
    const chunked = entry.chunks > 1;
    const paragraphs: string[] = [];
    for (let chunk = 0; chunk < entry.chunks; chunk++) {
        let raw: unknown;
        try {
            raw = await store.get(chapterKey(id, ordinal, chunk, chunked));
        } catch {
            return undefined;
        }
        if (!Array.isArray(raw) || !(raw as unknown[]).every(p => typeof p === 'string')) return undefined;
        paragraphs.push(...(raw as string[]));
    }
    return paragraphs;
}

/** Reassemble an index from the slim scheme, migrating a legacy full-index value forward when found. Resolves `undefined` when anything is missing or misshapen. */
export interface LoadedIndex {
    index: EpubIndex;
    fetchedAt: number;
}

export async function loadIndex(store: KeyValueStore, id: string): Promise<LoadedIndex | undefined> {
    let manifest: unknown;
    try {
        manifest = await store.get(manifestKey(id));
    } catch {
        manifest = undefined;
    }
    if (isStoredManifest(manifest)) {
        const chapters: EpubChapter[] = [];
        for (let ordinal = 0; ordinal < manifest.chapters.length; ordinal++) {
            const entry = manifest.chapters[ordinal] as StoredChapter;
            const paragraphs = await readChapter(store, id, ordinal, entry);
            if (!paragraphs) return undefined;
            chapters.push({ title: entry.title, href: entry.href, paragraphs, wordCount: entry.wordCount });
        }
        return {
            index: {
                title: manifest.title,
                ...(isNamedAuthor(manifest.author) ? { author: manifest.author } : {}),
                ...(manifest.language ? { language: manifest.language } : {}),
                ...(manifest.description ? { description: manifest.description } : {}),
                chapters,
            },
            fetchedAt: manifest.fetchedAt,
        };
    }
    // One-shot migration: adopt a legacy full index, then re-store it slim.
    let legacy: unknown;
    try {
        legacy = await store.get(legacyIndexKey(id));
    } catch {
        return undefined;
    }
    if (!isLegacyIndex(legacy)) return undefined;
    // Deep copy: the host may hand back a shared in-memory reference, and
    // scrubbing must not be observable through the caller's handle.
    const adopted: EpubIndex = {
        ...legacy,
        chapters: legacy.chapters.map(ch => ({ ...ch, paragraphs: [...ch.paragraphs] })),
    };
    // Pre-fix caches predate author cleaning: strip and re-check as the
    // parser does, so '[Editor]' can never migrate into a spoken author.
    const migratedAuthor = adopted.author ? stripEditorial(adopted.author).slice(0, 200) : '';
    if (migratedAuthor && isNamedAuthor(migratedAuthor)) adopted.author = migratedAuthor;
    else delete adopted.author;
    const now = Date.now();
    const { failed } = await persistIndex(store, id, adopted, now);
    if (failed.length > 0) return { index: adopted, fetchedAt: now };
    return { index: adopted, fetchedAt: now };
}

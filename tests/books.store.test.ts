import type { PluginHost } from '@deadair/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { type EpubIndex, parseEpubBuffer, seriesIdFor } from '../src/books.epub.js';
import { VellichorBooksPlugin } from '../src/books.plugin.js';
import {
    CHAPTER_VALUE_GUARD_BYTES,
    chapterKey,
    chunkParagraphs,
    isStoredManifest,
    type KeyValueStore,
    legacyIndexKey,
    loadIndex,
    manifestKey,
    persistIndex,
    type StoredManifest,
} from '../src/books.store.js';
import { buildEpub, buildStandardEpub } from './epub.fixture.js';

const BOOK_URL = 'https://example.com/fixture.epub';

function memoryStore(initial = new Map<string, unknown>()): KeyValueStore & { data: Map<string, unknown> } {
    return {
        data: initial,
        async get(key: string) {
            return initial.get(key);
        },
        async set(key: string, value: unknown) {
            initial.set(key, value);
        },
        async delete(key: string) {
            initial.delete(key);
        },
        async list(prefix = '') {
            return [...initial.keys()].filter(k => k.startsWith(prefix));
        },
    };
}

interface FakeHost {
    host: PluginHost;
    warnings: Array<{ message: string; meta?: Record<string, unknown> }>;
    fetchCalls: string[];
}

function fakeHost(opts: {
    books: Array<{ name?: string; url: string }>;
    store: KeyValueStore;
    fetchImpl: (url: string) => Promise<Response>;
    remainingMs?: number;
    aborted?: boolean;
    skipped?: string[];
}): FakeHost {
    const warnings: FakeHost['warnings'] = [];
    const fetchCalls: string[] = [];
    const host = {
        config: {
            get: async () => ({ books: JSON.stringify(opts.books), skipped: JSON.stringify(opts.skipped ?? []) }),
        },
        logger: {
            debug() {},
            info() {},
            warn(message: string, meta?: Record<string, unknown>) {
                warnings.push({ message, meta });
            },
            error() {},
        },
        storage: opts.store,
        fetch: async (url: string) => {
            fetchCalls.push(url);
            return opts.fetchImpl(url);
        },
        remainingMs: () => opts.remainingMs ?? 60_000,
        signal: { aborted: opts.aborted ?? false } as AbortSignal,
    };
    return { host: host as unknown as PluginHost, warnings, fetchCalls };
}

async function standardIndex(): Promise<EpubIndex> {
    return parseEpubBuffer(await buildStandardEpub(), 'fixture.epub');
}

function okFetch(bytes: Uint8Array): (url: string) => Promise<Response> {
    return async () => new Response(bytes, { status: 200 });
}

describe('chunkParagraphs', () => {
    it('returns no groups for no paragraphs and never stalls on one huge paragraph', () => {
        expect(chunkParagraphs([])).toEqual([]);
        const huge = 'x'.repeat(CHAPTER_VALUE_GUARD_BYTES + 1_000);
        expect(chunkParagraphs([huge])).toEqual([[huge]]);
    });

    it('splits a long chapter into groups under the guard', () => {
        const paragraphs = Array.from({ length: 300 }, (_, i) => `Paragraph ${i} ${'x'.repeat(300)}`);
        const groups = chunkParagraphs(paragraphs);
        expect(groups.length).toBeGreaterThan(1);
        expect(groups.flat()).toEqual(paragraphs);
        for (const group of groups) {
            expect(Buffer.byteLength(JSON.stringify(group))).toBeLessThan(64 * 1024);
        }
    });
});

describe('persistIndex / loadIndex', () => {
    it('round-trips a book through values that all fit the host cap', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        const index = await standardIndex();
        const { failed } = await persistIndex(store, id, index, Date.now());
        expect(failed).toEqual([]);
        for (const key of store.data.keys()) {
            expect(Buffer.byteLength(JSON.stringify(store.data.get(key)) ?? '')).toBeLessThan(64 * 1024);
        }
        const loaded = await loadIndex(store, id);
        expect(loaded?.index).toEqual(index);
        expect(typeof loaded?.fetchedAt).toBe('number');
        expect(isStoredManifest(store.data.get(manifestKey(id)))).toBe(true);
    });

    it('reassembles a chapter split across several text keys', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        const index = await standardIndex();
        const long: EpubIndex = {
            ...index,
            chapters: [
                { title: 'Long', href: 'long.xhtml', paragraphs: Array.from({ length: 300 }, (_, i) => `P${i} ${'y'.repeat(300)}`), wordCount: 1200 },
            ],
        };
        const { failed } = await persistIndex(store, id, long, Date.now());
        expect(failed).toEqual([]);
        const manifest = store.data.get(manifestKey(id)) as StoredManifest;
        expect(manifest.chapters[0]?.chunks).toBeGreaterThan(1);
        expect(store.data.has(chapterKey(id, 0, 0, true))).toBe(true);
        expect(store.data.has(chapterKey(id, 0, 0, false))).toBe(false);
        expect((await loadIndex(store, id))?.index).toEqual(long);
    });

    it('migrates a legacy full-index value forward and deletes it', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        const index = await standardIndex();
        store.data.set(legacyIndexKey(id), index);
        const loaded = await loadIndex(store, id);
        expect(loaded?.index).toEqual(index);
        expect(store.data.has(legacyIndexKey(id))).toBe(false);
        expect(isStoredManifest(store.data.get(manifestKey(id)))).toBe(true);
    });

    it('scrubs a legacy Unknown author on migration', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        const index = { ...(await standardIndex()), author: 'Unknown' };
        store.data.set(legacyIndexKey(id), index);
        const loaded = await loadIndex(store, id);
        expect(loaded?.index.author).toBeUndefined();
        expect((store.data.get(manifestKey(id)) as StoredManifest).author).toBeUndefined();
    });

    it('cleans a legacy bracketed author on migration', async () => {
        const first = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        first.data.set(legacyIndexKey(id), { ...(await standardIndex()), author: 'Mary [Editor] Shelley' });
        expect((await loadIndex(first, id))?.index.author).toBe('Mary Shelley');

        const second = memoryStore();
        second.data.set(legacyIndexKey(id), { ...(await standardIndex()), author: '[Editor]' });
        expect((await loadIndex(second, id))?.index.author).toBeUndefined();
    });

    it('leaves the caller’s legacy object unmutated', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        const index = { ...(await standardIndex()), author: 'Unknown' };
        Object.freeze(index);
        store.data.set(legacyIndexKey(id), index);
        const loaded = await loadIndex(store, id);
        expect(loaded?.index.author).toBeUndefined();
        expect(index.author).toBe('Unknown');
    });

    it('returns a copy that never aliases the stored chapters', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        const index = await standardIndex();
        store.data.set(legacyIndexKey(id), index);
        const loaded = await loadIndex(store, id);
        expect(loaded?.index.chapters).not.toBe(index.chapters);
        expect(loaded?.index.chapters[0]?.paragraphs).not.toBe(index.chapters[0]?.paragraphs);
        expect(loaded?.index).toEqual({ ...index });
    });

    it('rejects a manifest with mistyped metadata', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        await persistIndex(store, id, await standardIndex(), Date.now());
        const manifest = store.data.get(manifestKey(id)) as StoredManifest;
        store.data.set(manifestKey(id), { ...manifest, language: 123 });
        expect(isStoredManifest(store.data.get(manifestKey(id)))).toBe(false);
        await expect(loadIndex(store, id)).resolves.toBeUndefined();
    });

    it('rejects a manifest with an empty title', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        await persistIndex(store, id, await standardIndex(), Date.now());
        const manifest = store.data.get(manifestKey(id)) as StoredManifest;
        store.data.set(manifestKey(id), { ...manifest, title: '' });
        expect(isStoredManifest(store.data.get(manifestKey(id)))).toBe(false);
        await expect(loadIndex(store, id)).resolves.toBeUndefined();
    });

    it('degrades a chapter with missing text instead of failing the book', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        const before = await standardIndex();
        await persistIndex(store, id, before, Date.now());
        store.data.delete(chapterKey(id, 1, 0, false));
        const loaded = await loadIndex(store, id);
        expect(loaded).toBeDefined();
        expect(loaded?.index.chapters).toHaveLength(before.chapters.length);
        expect(loaded?.index.chapters[1]?.paragraphs).toEqual([]);
        expect(loaded?.index.chapters[1]?.wordCount).toBe(before.chapters[1]?.wordCount);
        expect(loaded?.index.chapters[0]?.paragraphs).toEqual(before.chapters[0]?.paragraphs);
    });

    it('keeps the legacy fallback when the slim manifest refuses to store', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        const index = await standardIndex();
        store.data.set(legacyIndexKey(id), index);
        const refusing: KeyValueStore & { data: Map<string, unknown> } = {
            ...store,
            async set(key: string, value: unknown) {
                if (key === manifestKey(id)) throw new Error('413 value too large');
                store.data.set(key, value);
            },
        };
        const loaded = await loadIndex(refusing, id);
        expect(loaded?.index).toEqual(index);
        expect(store.data.has(legacyIndexKey(id))).toBe(true);
    });

    it('round-trips a chapter with no paragraphs through one empty key', async () => {
        const store = memoryStore();
        const id = await seriesIdFor(BOOK_URL);
        const index = await standardIndex();
        const hollow: EpubIndex = {
            ...index,
            chapters: [{ title: 'Hollow', href: 'hollow.xhtml', paragraphs: [], wordCount: 0 }],
        };
        const { failed } = await persistIndex(store, id, hollow, Date.now());
        expect(failed).toEqual([]);
        expect(store.data.get(chapterKey(id, 0, 0, false))).toEqual([]);
        expect((await loadIndex(store, id))?.index).toEqual(hollow);
    });
});

describe('VellichorBooksPlugin', () => {
    async function seriesIdOf(plugin: VellichorBooksPlugin): Promise<string> {
        const series = await plugin.listSeries();
        const id = series[0]?.id;
        if (!id) throw new Error('expected one series from the fixture book');
        return id;
    }

    async function started(opts: {
        books?: Array<{ name?: string; url: string }>;
        fetchImpl?: (url: string) => Promise<Response>;
        remainingMs?: number;
        aborted?: boolean;
        skipped?: string[];
        store?: KeyValueStore & { data: Map<string, unknown> };
    }) {
        const bytes = await buildStandardEpub();
        const store = opts.store ?? memoryStore();
        const { host, warnings, fetchCalls } = fakeHost({
            books: opts.books ?? [{ name: 'Fixture', url: BOOK_URL }],
            store,
            fetchImpl: opts.fetchImpl ?? okFetch(bytes),
            remainingMs: opts.remainingMs,
            aborted: opts.aborted,
            skipped: opts.skipped,
        });
        const plugin = new VellichorBooksPlugin();
        await plugin.init(host);
        return { plugin, store, warnings, fetchCalls };
    }

    it('lists one serial series and caps pieces at the limit', async () => {
        const { plugin } = await started({});
        const series = await plugin.listSeries();
        expect(series).toHaveLength(1);
        expect(series[0]).toMatchObject({ title: 'Fixture', order: 'serial' });
        const seriesId = series[0]?.id as string;

        const one = await plugin.listPieces({ seriesId, limit: 1 });
        expect(one).toHaveLength(1);
        const all = await plugin.listPieces({ seriesId, limit: 100 });
        expect(all).toHaveLength(3);
        expect(all.map(p => p.ordinal)).toEqual([0, 1, 2]);
        expect(all.map(p => p.id)).toEqual([`${seriesId}:0`, `${seriesId}:1`, `${seriesId}:2`]);
        for (const piece of all) {
            expect(piece.seriesId).toBe(seriesId);
            expect(piece.seriesTitle).toBe('Fixture');
            expect(typeof piece.wordCount).toBe('number');
        }
    });

    it('suggests every chapter for the skipped-sections boxes', async () => {
        const { plugin } = await started({});
        const seriesId = await seriesIdOf(plugin);
        const suggestions = await plugin.suggestConfigOptions();
        expect(suggestions.skipped).toHaveLength(3);
        expect(suggestions.skipped?.map(o => o.value)).toEqual([`${seriesId}:0`, `${seriesId}:1`, `${seriesId}:2`]);
        expect(suggestions.skipped?.[0]?.label).toContain('Fixture');
    });

    it('suggests from cache only: a cold book fetches nothing and lists nothing', async () => {
        const spy = vi.fn(async () => new Response(await buildStandardEpub(), { status: 200 }));
        // Fresh instance, empty storage: suggestions may not download.
        const { plugin } = await started({ fetchImpl: spy, remainingMs: 0, store: memoryStore() });
        expect(await plugin.suggestConfigOptions()).toEqual({ skipped: [] });
        expect(spy).not.toHaveBeenCalled();
    });

    it('suggests cached chapters with no budget and no fetch', async () => {
        const store = memoryStore();
        const primed = await started({ store });
        await primed.plugin.listSeries();
        const spy = vi.fn(async () => {
            throw new Error('must not be called');
        });
        const warm = await started({ store, fetchImpl: spy, remainingMs: 0 });
        expect((await warm.plugin.suggestConfigOptions()).skipped).toHaveLength(3);
        expect(spy).not.toHaveBeenCalled();
    });

    it('warms a cold book outside any call budget', async () => {
        const { plugin, fetchCalls } = await started({});
        expect(fetchCalls).toHaveLength(0);
        await plugin.warmUncachedBooks();
        expect(fetchCalls).toHaveLength(1);
        const series = await plugin.listSeries();
        expect(series[0]).toMatchObject({ title: 'Fixture', order: 'serial' });
    });

    it('leaves a fresh book alone when warming', async () => {
        const store = memoryStore();
        const primed = await started({ store });
        await primed.plugin.listSeries();
        expect(primed.fetchCalls).toHaveLength(1);
        const spy = vi.fn(async () => {
            throw new Error('must not be called');
        });
        const warm = await started({ store, fetchImpl: spy });
        await warm.plugin.warmUncachedBooks();
        expect(spy).not.toHaveBeenCalled();
    });

    it('warms past a failing book without blocking the others', async () => {
        const bytes = await buildStandardEpub();
        const deadUrl = 'https://example.com/dead.epub';
        const { plugin, warnings } = await started({
            books: [
                { name: 'Dead', url: deadUrl },
                { name: 'Fixture', url: BOOK_URL },
            ],
            fetchImpl: async (url: string) => {
                if (url === deadUrl) throw new Error('offline');
                return new Response(bytes, { status: 200 });
            },
        });
        await plugin.warmUncachedBooks();
        expect(warnings.some(w => w.message === 'book background warm failed, will retry on next load')).toBe(true);
        const series = await plugin.listSeries();
        expect(series.map(s => s.title)).toEqual(['Dead', 'Fixture']);
    });

    it('never lists or reads an unchecked section, keeping ordinals stable', async () => {
        const { plugin } = await started({});
        const seriesId = await seriesIdOf(plugin);
        const skipped = await started({ skipped: [`${seriesId}:1`, '  ', `${seriesId}:99`] });
        const pieces = await skipped.plugin.listPieces({ seriesId, limit: 10 });
        expect(pieces.map(p => p.ordinal)).toEqual([0, 2]);
        expect(pieces.map(p => p.id)).toEqual([`${seriesId}:0`, `${seriesId}:2`]);
        await expect(skipped.plugin.getText({ seriesId, pieceId: `${seriesId}:1` })).resolves.toBeUndefined();
        const kept = await skipped.plugin.getText({ seriesId, pieceId: `${seriesId}:0` });
        expect(kept?.parts.length).toBeGreaterThan(0);
        await expect(skipped.plugin.testConnection()).resolves.toEqual({
            ok: true,
            message: expect.stringContaining('Skipping 2 unchecked sections.'),
        });
    });
    it('serves chapter text as text-only parts and rejects foreign ids', async () => {
        const { plugin } = await started({});
        const seriesId = await seriesIdOf(plugin);
        const text = await plugin.getText({ seriesId: seriesId, pieceId: `${seriesId}:0` });
        expect(text?.parts).toEqual([{ text: 'The Beginning' }, { text: 'First paragraph here.' }, { text: 'Second.' }]);
        await expect(plugin.getText({ seriesId: seriesId, pieceId: 'other-series:0' })).resolves.toBeUndefined();
        await expect(plugin.getText({ seriesId: seriesId, pieceId: `${seriesId}:` })).resolves.toBeUndefined();
        await expect(plugin.getText({ seriesId: seriesId, pieceId: `${seriesId}: 0` })).resolves.toBeUndefined();
        await expect(plugin.getText({ seriesId: seriesId, pieceId: `${seriesId}:99` })).resolves.toBeUndefined();
        await expect(plugin.getText({ seriesId: seriesId, pieceId: 'nope' })).resolves.toBeUndefined();
        await expect(plugin.getText({ seriesId: 'missing', pieceId: 'missing:0' })).resolves.toBeUndefined();
        await expect(plugin.listPieces({ seriesId: 'missing', limit: 10 })).resolves.toEqual([]);
    });

    it('caches in memory: a second listing fetches nothing', async () => {
        const { plugin, fetchCalls } = await started({});
        const seriesId = await seriesIdOf(plugin);
        expect(fetchCalls).toHaveLength(1);
        await plugin.listPieces({ seriesId: seriesId, limit: 10 });
        await plugin.getText({ seriesId: seriesId, pieceId: `${seriesId}:0` });
        expect(fetchCalls).toHaveLength(1);
    });

    it('serves a fresh persistent cache on a new instance without fetching', async () => {
        const store = memoryStore();
        const first = await started({ store });
        const seriesId = await seriesIdOf(first.plugin);
        expect(first.fetchCalls).toHaveLength(1);

        const failing = async () => {
            throw new Error('offline');
        };
        const second = await started({ store, fetchImpl: failing });
        expect(await second.plugin.listPieces({ seriesId: seriesId, limit: 10 })).toHaveLength(3);
        expect(second.fetchCalls).toHaveLength(0);
    });

    it('falls back to stale cache when a refresh fails', async () => {
        const store = memoryStore();
        const first = await started({ store });
        const seriesId = await seriesIdOf(first.plugin);
        const manifest = store.data.get(manifestKey(seriesId)) as StoredManifest;
        store.data.set(manifestKey(seriesId), { ...manifest, fetchedAt: 0 });

        const failing = async () => {
            throw new Error('offline');
        };
        const second = await started({ store, fetchImpl: failing });
        expect(await second.plugin.listPieces({ seriesId, limit: 10 })).toHaveLength(3);
        expect(second.warnings.some(w => w.message === 'book refresh failed, serving cached text')).toBe(true);
    });

    it('skips a stale refresh when the call cannot afford it', async () => {
        const store = memoryStore();
        const first = await started({ store });
        const seriesId = await seriesIdOf(first.plugin);
        const manifest = store.data.get(manifestKey(seriesId)) as StoredManifest;
        store.data.set(manifestKey(seriesId), { ...manifest, fetchedAt: 0 });

        const spy = vi.fn(async () => {
            throw new Error('must not be called');
        });
        const second = await started({ store, fetchImpl: spy, remainingMs: 0 });
        expect(await second.plugin.listPieces({ seriesId, limit: 10 })).toHaveLength(3);
        expect(spy).not.toHaveBeenCalled();
    });

    it('checks every book and names failures', async () => {
        const bytes = await buildStandardEpub();
        const store = memoryStore();
        const secondUrl = 'https://example.com/second.epub';
        const { host, warnings } = fakeHost({
            books: [
                { name: 'First', url: BOOK_URL },
                { name: 'Second', url: secondUrl },
            ],
            store,
            fetchImpl: async (url: string) => {
                if (url === secondUrl) return new Response('nope', { status: 500 });
                return new Response(bytes, { status: 200 });
            },
        });
        const plugin = new VellichorBooksPlugin();
        await plugin.init(host);
        const result = await plugin.testConnection();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('Second');
        expect(warnings.some(w => w.message === 'book connection check failed')).toBe(true);

        const solo = await started({});
        await expect(solo.plugin.testConnection()).resolves.toEqual({ ok: true, message: 'Read Fixture: 3 chapters.' });
    });

    it('logs rows dropped as unfetchable or repeated', async () => {
        const { plugin, warnings } = await started({ books: [{ url: 'notaurl' }, { name: 'Fixture', url: BOOK_URL }] });
        expect(await plugin.listSeries()).toHaveLength(1);
        expect(warnings.some(w => w.message === 'book rows dropped (unfetchable or repeated address)')).toBe(true);
    });

    it('falls back to the filename, never the address, for a nameless unreadable book', async () => {
        const failing = async () => new Response('nope', { status: 500 });
        const { plugin } = await started({ books: [{ url: 'https://example.com/my_book.epub' }], fetchImpl: failing });
        const series = await plugin.listSeries();
        expect(series).toHaveLength(1);
        expect(series[0]?.title).toBe('my book');

        const bracketed = await started({ books: [{ url: 'https://example.com/my_[Illustrated]_book.epub' }], fetchImpl: failing });
        expect((await bracketed.plugin.listSeries())[0]?.title).toBe('my book');
    });

    it('answers from cache explicitly on a short budget, and says so', async () => {
        const store = memoryStore();
        const primed = await started({ store });
        await primed.plugin.listSeries();

        const cold = await started({ store: memoryStore(), remainingMs: 0 });
        await expect(cold.plugin.testConnection()).resolves.toEqual({
            ok: false,
            message: expect.stringContaining('not cached yet'),
        });

        const warm = await started({ store, remainingMs: 0 });
        const result = await warm.plugin.testConnection();
        expect(result.ok).toBe(true);
        expect(result.message).toContain('(cached)');
        expect(warm.fetchCalls).toHaveLength(0);
    });

    it('lists a skeleton without fetching when a cold book is over budget', async () => {
        const spy = vi.fn(async () => {
            throw new Error('must not be called');
        });
        const { plugin } = await started({
            books: [{ url: 'https://example.com/my_book.epub' }],
            fetchImpl: spy,
            remainingMs: 0,
        });
        const series = await plugin.listSeries();
        expect(series).toHaveLength(1);
        expect(series[0]?.title).toBe('my book');
        expect(spy).not.toHaveBeenCalled();
    });
    it('stops starting books once the host gives up on the call', async () => {
        const spy = vi.fn(async () => new Response(await buildStandardEpub(), { status: 200 }));
        const { plugin } = await started({
            books: [
                { name: 'First', url: BOOK_URL },
                { name: 'Second', url: 'https://example.com/second.epub' },
            ],
            fetchImpl: spy,
            aborted: true,
        });
        expect(await plugin.listSeries()).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
        await expect(plugin.testConnection()).resolves.toEqual({ ok: false, message: 'Timed out before reading any book.' });
    });

    it('leaves the author off a series the source leaves anonymous', async () => {
        const bytes = await buildEpub({
            title: 'Anon',
            author: '',
            chapters: [{ file: 'text/c.xhtml', id: 'c', body: '<p>Hi.</p>' }],
        });
        const store = memoryStore();
        const { host } = fakeHost({
            books: [{ name: '', url: 'https://example.com/anon.epub' }],
            store,
            fetchImpl: async () => new Response(bytes, { status: 200 }),
        });
        const plugin = new VellichorBooksPlugin();
        await plugin.init(host);
        const series = await plugin.listSeries();
        expect(series).toHaveLength(1);
        expect(series[0]?.title).toBe('Anon');
        expect('author' in (series[0] as unknown as Record<string, unknown>)).toBe(false);
    });

    it('cleans a bracketed operator name before it can be spoken', async () => {
        const { plugin } = await started({ books: [{ name: 'My [Illustrated] Book', url: BOOK_URL }] });
        const series = await plugin.listSeries();
        expect(series[0]?.title).toBe('My Book');
        const pieces = await plugin.listPieces({ seriesId: (series[0] as { id: string }).id, limit: 1 });
        expect(pieces[0]?.seriesTitle).toBe('My Book');
    });

    it('answers nothing once the host gives up on the call', async () => {
        const { plugin } = await started({ aborted: true });
        const series = await plugin.listSeries();
        expect(series).toEqual([]);
        expect(await plugin.listPieces({ seriesId: 'anything', limit: 10 })).toEqual([]);
        expect(await plugin.getText({ seriesId: 'anything', pieceId: 'anything:0' })).toBeUndefined();
    });
});

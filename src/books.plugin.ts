import {
    type ConfigFieldOption,
    type NarrationPiece,
    type NarrationPiecesQuery,
    type NarrationPluginInstance,
    type NarrationSeries,
    type NarrationText,
    type NarrationTextQuery,
    Plugin,
    type PluginConnectionResult,
    PluginError,
    type PluginHost,
    parseMultiSelect,
} from '@deadair/plugin-sdk';
import { cleanTitle, type EpubIndex, isNamedAuthor, parseEpubBuffer, seriesIdFor, titleFromFileName } from './books.epub.js';
import { BOOKS_KEY, booksConfigSchema, type ConfiguredBook, parseBookRows, REQUEST_TIMEOUT_MS, SKIPPED_KEY } from './books.manifest.js';
import { loadIndex, persistIndex } from './books.store.js';

interface CachedIndex {
    index: EpubIndex;
    readAt: number;
}

/** Memory serves the hot path; the persistent cache is revalidated daily. */
const MEMORY_TTL_MS = 60 * 60 * 1_000;
const STORE_STALE_MS = 24 * 60 * 60 * 1_000; /**
 * A stale book re-fetches only when the call can afford a ~3 MB download
 * plus parse. Short console calls serve stale text; the longer scheduler
 * calls that own the time do the refresh.
 */
const MIN_REFRESH_BUDGET_MS = 20_000;
/** Delay before a loaded instance warms uncached books outside any call budget. */
const WARM_DELAY_MS = 5_000;

/** A filename for metadata fallback only, never fetched or spoken as an address. */
export function fileNameFor(url: string): string {
    const path = url.split('#')[0]?.split('?')[0] ?? url;
    const last = path.split('/').filter(Boolean).pop() ?? '';
    try {
        return decodeURIComponent(last) || 'book.epub';
    } catch {
        return last || 'book.epub';
    }
}

/** What the station says when it names the series: the operator's label wins, cleaned like any spoken title. */
export function seriesDisplayTitle(book: ConfiguredBook, index: EpubIndex): string {
    return book.name ? cleanTitle(book.name, index.title) : index.title;
}

/** One failing book lists nothing; the others still list. */
export class VellichorBooksPlugin extends Plugin implements NarrationPluginInstance {
    /** Piece ids the operator unchecked: selected sections never air. */
    private skippedSet(): Set<string> {
        return new Set(this.skipped.map(s => s.trim()).filter(s => s.length > 0));
    }

    /**
     * Every chapter of every readable book, for the Skipped sections boxes.
     * Cache-only, never a download: the host gives this call seconds, not
     * the minutes a cold fetch can take. Press Test Connection first (it
     * fetches on a longer budget), then reopen the form to choose.
     * Unreadable or uncached books contribute nothing rather than failing
     * the whole form.
     */
    async suggestConfigOptions(): Promise<Record<string, ConfigFieldOption[]>> {
        const host = this.host;
        const options: ConfigFieldOption[] = [];
        for (const book of this.books) {
            if (this.cancelled(host)) break;
            let id: string;
            let index: EpubIndex;
            try {
                id = await seriesIdFor(book.url);
                index = await this.indexFor(host, book, false);
            } catch {
                continue;
            }
            const seriesTitle = seriesDisplayTitle(book, index);
            index.chapters.forEach((ch, ordinal) => {
                options.push({ value: `${id}:${ordinal}`, label: `${seriesTitle} — ${ordinal}: ${ch.title}` });
            });
        }
        return { [SKIPPED_KEY]: options };
    }
    private books: ConfiguredBook[] = [];
    private skipped: string[] = [];
    private readonly cache = new Map<string, CachedIndex>();

    protected async onLoad(): Promise<void> {
        const host = this.host;
        const raw = await host.config.get();
        // Save-strict, read-lenient: a pre-schema-change value still loads.
        const strict = booksConfigSchema.safeParse(raw);
        const booksValue = strict.success ? strict.data.books : (raw as { books?: unknown })?.books;
        const dropped: unknown[] = [];
        this.books = parseBookRows(typeof booksValue === 'string' ? booksValue : undefined, row => {
            dropped.push(row);
        });
        // Checked sections never air; anything unreadable selects nothing.
        const skippedValue = strict.success ? strict.data.skipped : (raw as { skipped?: unknown })?.skipped;
        this.skipped = parseMultiSelect(skippedValue);
        host.logger.info('vellichor books ready', { books: this.books.length, skipped: this.skipped.length });
        if (!strict.success) {
            host.logger.warn('book config failed validation, reading leniently', {
                issues: strict.error.issues.map(i => i.message).slice(0, 3),
            });
        }
        if (dropped.length > 0) {
            host.logger.warn('book rows dropped (unfetchable or repeated address)', {
                dropped: dropped.length,
                rows: dropped.slice(0, 5),
            });
        }
        // Console calls run on short budgets that never allow a download, so
        // a fresh book would stay cold forever: warm it once in the
        // background instead. Unref'd so tests and hosts never wait on it.
        try {
            const timer = setTimeout(() => {
                void this.warmUncachedBooks().catch(() => {});
            }, WARM_DELAY_MS);
            (timer as unknown as { unref?: () => void }).unref?.();
            this.registerTimer(timer);
        } catch {
            // No timers: the scheduler's long-budget calls still warm the cache.
        }
    }

    /**
     * Download and persist every book no cache covers yet. Best-effort and
     * call-budget free: one failing book logs and the rest still warm.
     * Public so hosts and tests can trigger a warm pass on demand.
     */
    async warmUncachedBooks(): Promise<void> {
        let host: PluginHost;
        try {
            host = this.host;
        } catch {
            return;
        }
        for (const book of this.books) {
            if (this.cancelled(host)) break;
            try {
                await this.indexFor(host, book, true);
            } catch (error) {
                host.logger.warn('book background warm failed, will retry on next load', {
                    url: book.url,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    async listSeries(): Promise<NarrationSeries[]> {
        const host = this.host;
        const out: NarrationSeries[] = [];
        for (const book of this.books) {
            if (this.cancelled(host)) break;
            let id: string | undefined;
            try {
                id = await seriesIdFor(book.url);
                // The console's call budget cannot survive a cold download:
                // list from cache (or skeleton) and let the scheduler refresh.
                const index = await this.indexFor(host, book, this.timeToRefresh(host));
                out.push({
                    id,
                    title: seriesDisplayTitle(book, index),
                    order: 'serial',
                    ...(isNamedAuthor(index.author) ? { author: index.author } : {}),
                    ...(index.description ? { description: index.description } : {}),
                    ...(index.language ? { language: index.language } : {}),
                });
            } catch (error) {
                // An unreadable series still lists (nameless: filename, never
                // the address) so one bad book costs nothing; its pieces answer [].
                host.logger.warn('book index failed, listing without metadata', {
                    url: book.url,
                    error: error instanceof Error ? error.message : String(error),
                });
                // Without an id the host drops the row anyway.
                if (!id) continue;
                const fileTitle = titleFromFileName(fileNameFor(book.url));
                out.push({ id, title: book.name ? cleanTitle(book.name, fileTitle) : fileTitle, order: 'serial' });
            }
        }
        return out;
    }

    async listPieces(query: NarrationPiecesQuery): Promise<NarrationPiece[]> {
        const host = this.host;
        if (this.cancelled(host)) return [];
        const book = await this.bookFor(query.seriesId);
        if (!book) return [];
        let index: EpubIndex;
        try {
            index = await this.indexFor(host, book);
        } catch {
            return [];
        }
        const seriesTitle = seriesDisplayTitle(book, index);
        // Unchecked sections keep their ordinals (stable piece ids), they
        // just never list: the serial skips them without renumbering.
        const skipped = this.skippedSet();
        return index.chapters
            .map(
                (ch, i) =>
                    ({
                        id: `${query.seriesId}:${i}`,
                        seriesId: query.seriesId,
                        seriesTitle,
                        title: ch.title,
                        ordinal: i,
                        wordCount: ch.wordCount,
                    }) satisfies NarrationPiece,
            )
            .filter(p => !skipped.has(p.id))
            .slice(0, Math.max(0, query.limit));
    }

    async getText(query: NarrationTextQuery): Promise<NarrationText | undefined> {
        const host = this.host;
        if (this.cancelled(host)) return undefined;
        const book = await this.bookFor(query.seriesId);
        if (!book) return undefined;
        // Piece ids are `${seriesId}:${ordinal}` minted by listPieces; a pair from another series must not read this book's ordinal.
        const separator = query.pieceId.lastIndexOf(':');
        if (separator === -1 || query.pieceId.slice(0, separator) !== query.seriesId) return undefined;
        // Digits only: Number('') and Number(' 0') both read as 0, which would
        // serve chapter 0 for a malformed id.
        const suffix = query.pieceId.slice(separator + 1);
        if (!/^\d+$/.test(suffix)) return undefined;
        // A directly addressed skipped section stays silent even if listed elsewhere.
        if (this.skippedSet().has(query.pieceId)) return undefined;
        const ordinal = Number(suffix);
        let index: EpubIndex;
        try {
            index = await this.indexFor(host, book);
        } catch {
            return undefined;
        }
        const ch = index.chapters[ordinal];
        if (!ch || ch.paragraphs.length === 0) return undefined;
        return { parts: ch.paragraphs.map(text => ({ text })) };
    }

    async testConnection(): Promise<PluginConnectionResult> {
        const host = this.host;
        if (this.books.length === 0) return { ok: true, message: 'No books configured yet.' };
        const read: string[] = [];
        const failures: string[] = [];
        for (const book of this.books) {
            if (this.cancelled(host)) break;
            try {
                // On a short budget an uncached book cannot download in time:
                // serve it from cache (or say so) instead of racing the timeout.
                if (!this.timeToRefresh(host)) {
                    const id = await seriesIdFor(book.url);
                    const cached = await loadIndex(host.storage, id);
                    if (cached) {
                        this.cache.set(id, { index: cached.index, readAt: Date.now() });
                        read.push(`${seriesDisplayTitle(book, cached.index)}: ${cached.index.chapters.length} chapters (cached)`);
                    } else {
                        failures.push(`${book.name || book.url} (not cached yet; try again in a minute)`);
                    }
                    continue;
                }
                const index = await this.indexFor(host, book);
                read.push(`${seriesDisplayTitle(book, index)}: ${index.chapters.length} chapters`);
            } catch (error) {
                host.logger.warn('book connection check failed', {
                    url: book.url,
                    error: error instanceof Error ? error.message : String(error),
                });
                failures.push(book.name || book.url);
            }
        }
        if (read.length === 0 && failures.length === 0) {
            return { ok: false, message: 'Timed out before reading any book.' };
        }
        if (failures.length > 0) return { ok: false, message: `Could not read ${failures.join(', ')}.` };
        const skipping = this.skippedSet().size;
        const tail = skipping > 0 ? ` Skipping ${skipping} unchecked section${skipping === 1 ? '' : 's'}.` : '';
        if (read.length === 1) return { ok: true, message: `Read ${read[0]}.${tail}` };
        return { ok: true, message: `Read ${read.join('; ')}.${tail}` };
    }

    private async bookFor(seriesId: string): Promise<ConfiguredBook | undefined> {
        for (const book of this.books) {
            let id: string;
            try {
                id = await seriesIdFor(book.url);
            } catch {
                continue;
            }
            if (id === seriesId) return book;
        }
        return undefined;
    }

    private async indexFor(host: PluginHost, book: ConfiguredBook, allowRefresh = true): Promise<EpubIndex> {
        const id = await seriesIdFor(book.url);
        const hit = this.cache.get(id);
        if (hit && Date.now() - hit.readAt < MEMORY_TTL_MS) return hit.index;

        const stored = await loadIndex(host.storage, id);
        if (stored) {
            this.cache.set(id, { index: stored.index, readAt: Date.now() });
            if (Date.now() - stored.fetchedAt < STORE_STALE_MS || !this.timeToRefresh(host) || !allowRefresh) {
                return stored.index;
            }
            // Stale but usable: refresh in place, serve the cache when the network says no.
            try {
                return await this.fetchAndPersist(host, book, id);
            } catch (error) {
                host.logger.warn('book refresh failed, serving cached text', {
                    url: book.url,
                    error: error instanceof Error ? error.message : String(error),
                });
                return stored.index;
            }
        }

        // No cache and no refresh budget: fail so the caller lists a
        // skeleton instead of racing the host's timeout with a download.
        if (!allowRefresh) throw new PluginError('Book not cached yet.').withCode('timeout');
        return this.fetchAndPersist(host, book, id);
    }

    private timeToRefresh(host: PluginHost): boolean {
        try {
            if (typeof host.remainingMs !== 'function') return true;
            return host.remainingMs() > MIN_REFRESH_BUDGET_MS;
        } catch {
            return true;
        }
    }

    private cancelled(host: PluginHost): boolean {
        try {
            return host.signal?.aborted === true;
        } catch {
            return false;
        }
    }

    private abortSignal(host: PluginHost): AbortSignal | undefined {
        try {
            const signal = host.signal;
            return signal instanceof AbortSignal ? signal : undefined;
        } catch {
            return undefined;
        }
    }

    private async fetchAndPersist(host: PluginHost, book: ConfiguredBook, id: string): Promise<EpubIndex> {
        const signal = this.abortSignal(host);
        const response = await host.fetch(book.url, {
            timeoutMs: REQUEST_TIMEOUT_MS,
            headers: { Accept: 'application/epub+zip' },
            ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new PluginError(`Book answered ${response.status}`).withCode('upstream').withUpstreamStatus(response.status);
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.length === 0) throw new PluginError('Book answered with an empty file.').withCode('upstream');
        const index = await parseEpubBuffer(buffer, fileNameFor(book.url), signal, skipped => {
            host.logger.info('book furniture skipped (never airs)', { url: book.url, skipped });
        });
        this.cache.set(id, { index, readAt: Date.now() });
        const { failed } = await persistIndex(host.storage, id, index, Date.now());
        if (failed.length > 0) {
            host.logger.warn('book cache incomplete, will re-fetch sooner', { url: book.url, failed: failed.length });
        }
        return index;
    }
}

export { BOOKS_KEY };

import {
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
} from '@deadair/plugin-sdk';
import { type EpubIndex, parseEpubBuffer, seriesIdFor } from './books.epub.js';
import { BOOKS_KEY, booksConfigSchema, type ConfiguredBook, parseBookRows, REQUEST_TIMEOUT_MS } from './books.manifest.js';

interface CachedIndex {
    index: EpubIndex;
    readAt: number;
}

/** Keep bad-row costs local: one failing book lists nothing, others still list. */
export class VellichorBooksPlugin extends Plugin implements NarrationPluginInstance {
    private books: ConfiguredBook[] = [];
    private readonly cache = new Map<string, CachedIndex>();

    protected async onLoad(): Promise<void> {
        const host = this.host;
        const parsed = booksConfigSchema.parse(await host.config.get());
        this.books = parseBookRows(parsed.books);
        host.logger.info('vellichor books ready', { books: this.books.length });
    }

    async listSeries(): Promise<NarrationSeries[]> {
        const host = this.host;
        const out: NarrationSeries[] = [];
        for (const book of this.books) {
            const id = await seriesIdFor(book.url);
            try {
                const index = await this.indexFor(host, book);
                out.push({
                    id,
                    title: book.name || index.title,
                    order: 'serial',
                    author: index.author,
                    ...(index.description ? { description: index.description } : {}),
                    ...(index.language ? { language: index.language } : {}),
                });
            } catch (error) {
                // A series that cannot be read still lists, so one bad book
                // does not cost the others. Pieces for it answer [].
                host.logger.warn('book index failed, listing without metadata', {
                    url: book.url,
                    error: error instanceof Error ? error.message : String(error),
                });
                out.push({ id, title: book.name || book.url, order: 'serial' });
            }
        }
        return out;
    }

    async listPieces(query: NarrationPiecesQuery): Promise<NarrationPiece[]> {
        const host = this.host;
        const book = await this.bookFor(query.seriesId);
        if (!book) return [];
        let index: EpubIndex;
        try {
            index = await this.indexFor(host, book);
        } catch {
            return [];
        }
        const seriesTitle = book.name || index.title;
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
            .slice(0, Math.max(0, query.limit));
    }

    async getText(query: NarrationTextQuery): Promise<NarrationText | undefined> {
        const host = this.host;
        const book = await this.bookFor(query.seriesId);
        if (!book) return undefined;
        let index: EpubIndex;
        try {
            index = await this.indexFor(host, book);
        } catch {
            return undefined;
        }
        const ordinal = Number(query.pieceId.split(':').pop());
        const ch = Number.isInteger(ordinal) ? index.chapters[ordinal] : undefined;
        if (!ch || ch.paragraphs.length === 0) return undefined;
        return { parts: ch.paragraphs.map(text => ({ text })) };
    }

    async testConnection(): Promise<PluginConnectionResult> {
        const host = this.host;
        if (this.books.length === 0) return { ok: true, message: 'No books configured yet.' };
        const book = this.books[0] as ConfiguredBook;
        try {
            const index = await this.indexFor(host, book);
            return { ok: true, message: `Read ${index.title}: ${index.chapters.length} chapters.` };
        } catch (error) {
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
    }

    private async bookFor(seriesId: string): Promise<ConfiguredBook | undefined> {
        for (const book of this.books) {
            if ((await seriesIdFor(book.url)) === seriesId) return book;
        }
        return undefined;
    }

    private async indexFor(host: PluginHost, book: ConfiguredBook): Promise<EpubIndex> {
        const id = await seriesIdFor(book.url);
        const hit = this.cache.get(id);
        if (hit) return hit.index;

        const stored = await host.storage.get(`epub-index:${id}`).catch(() => undefined);
        if (stored && typeof stored === 'object') {
            const index = stored as EpubIndex;
            if (Array.isArray(index.chapters)) {
                this.cache.set(id, { index, readAt: Date.now() });
                return index;
            }
        }

        const response = await host.fetch(book.url, { timeoutMs: REQUEST_TIMEOUT_MS, headers: { Accept: 'application/epub+zip' } });
        if (!response.ok) {
            await response.body?.cancel();
            throw new PluginError(`Book answered ${response.status}`).withCode('upstream').withUpstreamStatus(response.status);
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.length === 0) throw new PluginError('Book answered with an empty file.').withCode('upstream');
        const index = await parseEpubBuffer(buffer, book.url.split('/').pop() ?? 'book.epub');
        this.cache.set(id, { index, readAt: Date.now() });
        await host.storage.set(`epub-index:${id}`, index).catch(() => undefined);
        return index;
    }
}

export { BOOKS_KEY };

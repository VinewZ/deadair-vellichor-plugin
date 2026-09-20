import { describe, expect, it } from 'vitest';
import {
    cleanTitle,
    countWords,
    htmlToParagraphs,
    isNamedAuthor,
    parseEpubBuffer,
    seriesIdFor,
    stripEditorial,
    titleFromFileName,
} from '../src/books.epub.js';
import { booksConfigSchema, booksManifest, parseBookRows } from '../src/books.manifest.js';
import { fileNameFor } from '../src/books.plugin.js';
import { buildEpub, buildEpubNoText, buildNoNcxEpub, buildStandardEpub } from './epub.fixture.js';

describe('htmlToParagraphs', () => {
    it('splits blocks before stripping tags', () => {
        const parts = htmlToParagraphs('<html><body><p>First.</p><p>Second <b>bold</b>.</p></body></html>');
        expect(parts).toEqual(['First.', 'Second bold .']);
    });

    it('keeps <pre> as its own block and still splits <br/>', () => {
        const parts = htmlToParagraphs('<html><body><p>Before.</p><pre>Line one\nLine two</pre><p>After<br/>more.</p></body></html>');
        expect(parts).toEqual(['Before.', 'Line one Line two', 'After', 'more.']);
    });
});

describe('stripEditorial', () => {
    it('removes bracketed furniture (performance cues)', () => {
        expect(stripEditorial('Hello [Illustration: a boat] world')).toBe('Hello world');
        expect(stripEditorial('Text [Footnote 12] here')).toBe('Text here');
    });
});

describe('countWords', () => {
    it('counts whitespace runs', () => {
        expect(countWords('  hello   world\nnew line ')).toBe(4);
    });
});

describe('parseBookRows', () => {
    it('drops rows without a fetchable url', () => {
        expect(parseBookRows(JSON.stringify([{ name: 'x', url: 'notaurl' }, { url: 'https://example.com/a.epub' }]))).toEqual([
            { name: '', url: 'https://example.com/a.epub' },
        ]);
    });

    it('reports dropped rows through onDrop', () => {
        const dropped: unknown[] = [];
        const books = parseBookRows(JSON.stringify([{ url: 'notaurl' }, 'nope', { url: 'https://example.com/a.epub' }]), row => {
            dropped.push(row);
        });
        expect(books).toEqual([{ name: '', url: 'https://example.com/a.epub' }]);
        expect(dropped).toEqual([{ url: 'notaurl' }, 'nope']);
    });

    it('deduplicates repeated addresses, keeping the first row', () => {
        const dropped: unknown[] = [];
        const books = parseBookRows(
            JSON.stringify([
                { name: 'First', url: 'https://example.com/a.epub' },
                { name: 'Second', url: 'https://example.com/a.epub' },
                { name: 'Third', url: '  https://example.com/a.epub  ' },
            ]),
            row => {
                dropped.push(row);
            },
        );
        expect(books).toEqual([{ name: 'First', url: 'https://example.com/a.epub' }]);
        expect(dropped).toHaveLength(2);
    });

    it('refuses unfetchable rows at save time', () => {
        expect(() => booksConfigSchema.parse({ books: JSON.stringify([{ url: 'notaurl' }]) })).toThrow();
        expect(booksConfigSchema.parse({ books: JSON.stringify([{ url: 'https://example.com/a.epub' }]) })).toEqual({
            books: JSON.stringify([{ url: 'https://example.com/a.epub' }]),
            skipped: '[]',
        });
    });
});

describe('booksManifest', () => {
    it('keeps the narration capability, book list config, and a paced fromConfig entry', () => {
        expect(booksManifest.id).toBe('radio.vellichor.books');
        expect(booksManifest.capabilities).toContain('narration');
        const network = (booksManifest.permissions?.network ?? []) as unknown as Array<Record<string, unknown>>;
        const entry = network.find(e => e.fromConfig === 'books');
        expect(entry).toBeDefined();
        expect(entry?.ratePerSecond).toBe(2);
    });
});

describe('cleanTitle', () => {
    it('strips brackets but never returns empty', () => {
        expect(cleanTitle('Chapter [Four]', 'Fallback')).toBe('Chapter');
        expect(cleanTitle('[Illustration]', 'Fallback')).toBe('Fallback');
        expect(cleanTitle('  Plain  ')).toBe('Plain');
    });
});

describe('parseEpubBuffer', () => {
    it('reads spine order, NCX labels, and strips brackets from text and metadata', async () => {
        const index = await parseEpubBuffer(await buildStandardEpub(), 'fixture.epub');
        expect(index.title).toBe('Test Book');
        expect(index.author).toBe('Fixture Author');
        expect(index.description).toBe('A tale of woe.');
        expect(index.chapters.map(c => c.title)).toEqual(['Chapter One', 'Ch Two', 'Chapter']);
        expect(index.chapters[0]?.paragraphs).toEqual(['The Beginning', 'First paragraph here.', 'Second.']);
        expect(index.chapters[1]?.paragraphs).toEqual(['Unicode: Déjà vu ☃ and snow.']);
        for (const ch of index.chapters) {
            expect(ch.wordCount).toBeGreaterThan(0);
            expect(ch.href).toMatch(/^OEBPS\//);
        }
    });

    it('counts fallback titles from finished chapters, not spine slots', async () => {
        const index = await parseEpubBuffer(await buildNoNcxEpub(), 'fallback.epub');
        expect(index.chapters).toHaveLength(1);
        expect(index.chapters[0]?.title).toBe('Chapter 1');
    });

    it('parses deterministically: same bytes, same index', async () => {
        const bytes = await buildStandardEpub();
        const first = await parseEpubBuffer(bytes, 'a.epub');
        const second = await parseEpubBuffer(bytes, 'a.epub');
        expect(second).toEqual(first);
    });

    it('rejects missing container, empty spine, and textless books', async () => {
        const { default: JSZip } = await import('jszip');
        const empty = new JSZip();
        await expect(parseEpubBuffer(new Uint8Array(await empty.generateAsync({ type: 'uint8array' })), 'x.epub')).rejects.toThrow(/container\.xml/);
        const noText = await buildEpubNoText();
        await expect(parseEpubBuffer(noText, 'x.epub')).rejects.toThrow(/extract text/);
    });

    it('stops promptly when the call is already aborted', async () => {
        const bytes = await buildStandardEpub();
        const controller = new AbortController();
        controller.abort();
        await expect(parseEpubBuffer(bytes, 'x.epub', controller.signal)).rejects.toThrow(/aborted/);
    });

    it('skips non-XHTML spine items instead of reading them as text', async () => {
        const bytes = await buildEpub({
            title: 'Mixed',
            includeNcx: false,
            chapters: [
                { file: 'text/c.xhtml', id: 'c', mediaType: 'image/jpeg', body: '<p>Not a chapter.</p>' },
                { file: 'text/d.xhtml', id: 'd', body: '<p>Real.</p>' },
            ],
        });
        const index = await parseEpubBuffer(bytes, 'mixed.epub');
        expect(index.chapters).toHaveLength(1);
        expect(index.chapters[0]?.paragraphs).toEqual(['Real.']);
    });

    it('drops furniture: linear=no, guide cover/toc, nav properties, front/back matter', async () => {
        const bytes = await buildEpub({
            title: 'Furniture',
            includeNcx: false,
            chapters: [
                { file: 'text/notice.xhtml', id: 'notice', linearNo: true, body: '<p>Use of anyone anywhere.</p>' },
                { file: 'text/toc.xhtml', id: 'toc', guideType: 'toc', body: '<p>Contents.</p>' },
                { file: 'text/nav.xhtml', id: 'nav', properties: 'nav', body: '<p>Nav.</p>' },
                { file: 'text/licence.xhtml', id: 'licence', epubType: 'backmatter copyright-page', body: '<p>Licence.</p>' },
                { file: 'text/tocpage.xhtml', id: 'tocpage', bodyAttrs: 'epub:type="frontmatter"', body: '<p>Contents page.</p>' },
                {
                    file: 'text/letter1.xhtml',
                    id: 'letter1',
                    body: '<section epub:type="chapter"><h1>Letter 1</h1><p>Real.</p></section>',
                },
            ],
        });
        const skipped: string[][] = [];
        const index = await parseEpubBuffer(bytes, 'furniture.epub', undefined, hrefs => {
            skipped.push(hrefs);
        });
        expect(index.chapters).toHaveLength(1);
        expect(index.chapters[0]?.paragraphs).toEqual(['Letter 1', 'Real.']);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]).toHaveLength(5);
    });

    it('names a multi-section file after its first navPoint', async () => {
        const bytes = await buildEpub({
            title: 'Sections',
            chapters: [{ file: 'text/ch.xhtml', id: 'ch', body: '<p>Real.</p>' }],
            ncxExtra: [
                { label: 'Primary', src: 'text/ch.xhtml#s1' },
                { label: 'Trailing', src: 'text/ch.xhtml#s2' },
            ],
        });
        const index = await parseEpubBuffer(bytes, 'sections.epub');
        expect(index.chapters).toHaveLength(1);
        expect(index.chapters[0]?.title).toBe('Primary');
    });

    it('drops a page of links but keeps prose with a few inline links', async () => {
        const links = Array.from({ length: 10 }, (_, i) => `<a href="ch${i}.xhtml">Chapter ${i}</a>`).join(' ');
        const bytes = await buildEpub({
            title: 'Links',
            includeNcx: false,
            chapters: [
                { file: 'text/toc.xhtml', id: 'toc', body: `<p>${links}</p>` },
                { file: 'text/ch.xhtml', id: 'ch', body: '<p>Read <a href="note.xhtml">more here</a> and on.</p>' },
            ],
        });
        const skipped: string[][] = [];
        const index = await parseEpubBuffer(bytes, 'links.epub', undefined, hrefs => {
            skipped.push(hrefs);
        });
        expect(index.chapters).toHaveLength(1);
        expect(index.chapters[0]?.paragraphs).toEqual(['Read more here and on.']);
        expect(skipped[0]).toEqual(['OEBPS/text/toc.xhtml']);
    });
});

describe('seriesIdFor', () => {
    it('is stable and trims the url', async () => {
        const url = 'https://example.com/frankenstein.epub';
        expect(await seriesIdFor(url)).toBe(await seriesIdFor(url));
        expect(await seriesIdFor(`  ${url}  `)).toBe(await seriesIdFor(url));
        expect(await seriesIdFor(url)).toMatch(/^[0-9a-f]{16}$/);
        expect(await seriesIdFor('https://example.com/other.epub')).not.toBe(await seriesIdFor(url));
    });
});

describe('anonymous books', () => {
    it('omits the author instead of saying Unknown', async () => {
        const bytes = await buildEpub({
            title: 'Anon',
            author: '',
            chapters: [{ file: 'text/c.xhtml', id: 'c', body: '<p>Hi.</p>' }],
        });
        const index = await parseEpubBuffer(bytes, 'anon.epub');
        expect(index.author).toBeUndefined();
    });

    it('scrubs a literal Unknown creator at the source', async () => {
        expect(isNamedAuthor('Unknown')).toBe(false);
        expect(isNamedAuthor(' unknown ')).toBe(false);
        expect(isNamedAuthor('Mary Shelley')).toBe(true);
        const bytes = await buildEpub({
            title: 'Anon',
            author: 'Unknown',
            chapters: [{ file: 'text/c.xhtml', id: 'c', body: '<p>Hi.</p>' }],
        });
        const index = await parseEpubBuffer(bytes, 'anon.epub');
        expect(index.author).toBeUndefined();
    });

    it('cleans a bracketed creator like a title', async () => {
        const bytes = await buildEpub({
            title: ' brackets ',
            author: 'Mary [Editor] Shelley',
            chapters: [{ file: 'text/c.xhtml', id: 'c', body: '<p>Hi.</p>' }],
        });
        const index = await parseEpubBuffer(bytes, 'x.epub');
        expect(index.author).toBe('Mary Shelley');
    });

    it('drops a creator that is only brackets or Unknown', async () => {
        for (const author of ['[Editor]', '[Unknown]']) {
            const bytes = await buildEpub({
                title: 'Anon',
                author,
                chapters: [{ file: 'text/c.xhtml', id: 'c', body: '<p>Hi.</p>' }],
            });
            const index = await parseEpubBuffer(bytes, 'x.epub');
            expect(index.author).toBeUndefined();
        }
    });
});

describe('titleFromFileName', () => {
    it('strips tails and bounds the label', () => {
        expect(titleFromFileName('my_book.epub?download=1#ch1')).toBe('my book');
        expect(titleFromFileName('a'.repeat(300))).toHaveLength(200);
        expect(titleFromFileName('')).toBe('Untitled');
    });

    it('strips bracketed furniture and trailing-space extensions', () => {
        expect(titleFromFileName('my_[Illustrated]_book.epub')).toBe('my book');
        expect(titleFromFileName('book.epub ')).toBe('book');
        expect(titleFromFileName('https://example.com/a/b_c.epub')).toBe('b c');
    });
});

describe('fileNameFor', () => {
    it('drops queries, fragments, and trailing slashes', () => {
        expect(fileNameFor('https://example.com/books/frankenstein.epub?download=1#ch1')).toBe('frankenstein.epub');
        expect(fileNameFor('https://example.com/books/')).toBe('books');
        expect(fileNameFor('https://example.com/%E2%98%83.epub')).toBe('☃.epub');
        expect(fileNameFor('nota-url')).toBe('nota-url');
    });
});

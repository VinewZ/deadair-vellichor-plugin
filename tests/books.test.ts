import { describe, expect, it } from 'vitest';
import { countWords, htmlToParagraphs, stripEditorial } from '../src/books.epub.js';
import { parseBookRows } from '../src/books.manifest.js';

describe('htmlToParagraphs', () => {
    it('splits blocks before stripping tags', () => {
        const parts = htmlToParagraphs('<html><body><p>First.</p><p>Second <b>bold</b>.</p></body></html>');
        expect(parts).toEqual(['First.', 'Second bold .']);
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
});

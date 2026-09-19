import { plainText } from '@deadair/plugin-sdk';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

/**
 * EPUB parsing in Node, lifted from Vellichor (MIT) with attribution.
 * Vellichor parses in the browser with DOMParser; here fast-xml-parser
 * handles OPF/NCX XML and regex + SDK plainText handles chapter XHTML.
 */

export interface EpubChapter {
    title: string;
    href: string;
    paragraphs: string[];
    wordCount: number;
}

export interface EpubIndex {
    title: string;
    author: string;
    language?: string;
    description?: string;
    chapters: EpubChapter[];
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

export function countWords(text: string): number {
    const m = text.trim().match(/\S+/g);
    return m ? m.length : 0;
}

/** Editorial furniture is not the author's words, and [...] reads as a performance cue. */
export function stripEditorial(text: string): string {
    return text
        .replace(/\[[^\]\n]{0,200}\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function decodePath(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

function dirname(path: string): string {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i + 1);
}

function normalizeHref(base: string, href: string): string {
    const clean = href.split('#')[0] ?? '';
    if (!clean || clean.startsWith('http') || clean.startsWith('data:')) return href;
    if (clean.startsWith('/')) return clean.slice(1);
    const stack = (base + clean).split('/');
    const out: string[] = [];
    for (const part of stack) {
        if (part === '' || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
    }
    return out.join('/');
}

function asArray<T>(v: T | T[] | undefined): T[] {
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
}

function pickText(v: unknown): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null && '#text' in v) {
        const t = (v as Record<string, unknown>)['#text'];
        return typeof t === 'string' ? t : '';
    }
    return '';
}

/** First h1/h2/title in the chapter file, via regex (no DOM in Node). */
function htmlTitle(html: string, fallback: string): string {
    for (const tag of ['h1', 'h2', 'title']) {
        const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]{1,300}?)<\\/${tag}>`, 'i'));
        const t = m?.[1] ? plainText(m[1]) : undefined;
        if (t) return t.slice(0, 200);
    }
    return fallback;
}

/** Split XHTML into paragraphs first, then strip tags per paragraph (plainText collapses whitespace). */
export function htmlToParagraphs(html: string): string[] {
    const withoutHead = html.replace(/<head[\s\S]*?<\/head>/gi, ' ');
    const noScript = withoutHead.replace(/<(script|style|nav)[\s\S]*?<\/\1>/gi, ' ');
    const blocks = noScript.split(/<(?:p|h[1-6]|li|blockquote|div|section|article|br)[^>]*>/gi);
    const out: string[] = [];
    for (const block of blocks) {
        const ends = block.split(/<\/(?:p|h[1-6]|li|blockquote|div|section|article)>/gi);
        for (const chunk of ends) {
            const t = plainText(chunk);
            if (!t) continue;
            const clean = stripEditorial(t);
            if (clean.length > 0) out.push(clean);
        }
    }
    return out;
}

interface ManifestItem {
    href: string;
    mediaType: string;
    properties?: string;
}

export async function parseEpubBuffer(data: Uint8Array, fileName: string): Promise<EpubIndex> {
    const zip = await JSZip.loadAsync(data);
    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('Invalid EPUB: missing container.xml');
    const containerXml = await containerFile.async('string');
    const container = xmlParser.parse(containerXml) as Record<string, unknown>;
    const rootfiles = (container['container'] as Record<string, unknown>)?.['rootfiles'] as Record<string, unknown> | undefined;
    const rootfile = asArray(rootfiles?.['rootfile'] as unknown).map(r => (r as Record<string, unknown>)?.['@_full-path'])[0];
    if (typeof rootfile !== 'string' || !rootfile) throw new Error('Invalid EPUB: missing OPF path');

    const opfFile = zip.file(rootfile);
    if (!opfFile) throw new Error('Invalid EPUB: missing OPF file');
    const opfXml = await opfFile.async('string');
    const opf = (xmlParser.parse(opfXml) as Record<string, unknown>)?.['package'] as Record<string, unknown>;
    if (!opf) throw new Error('Invalid EPUB: bad OPF');
    const base = dirname(rootfile);

    const metadata = (opf['metadata'] as Record<string, unknown>) ?? {};
    const rawTitle = pickText(metadata['dc:title']).trim();
    const title =
        rawTitle ||
        fileName
            .replace(/\.epub$/i, '')
            .replace(/[_-]+/g, ' ')
            .trim() ||
        'Untitled';
    const creators = asArray(metadata['dc:creator'] as unknown)
        .map(pickText)
        .map(s => s.trim())
        .filter(Boolean);
    const author = creators[0] ?? 'Unknown';
    const language = pickText(metadata['dc:language']).trim().slice(0, 20) || undefined;
    const rawDesc = pickText(metadata['dc:description']).trim();
    const description = rawDesc ? plainText(rawDesc)?.slice(0, 500) : undefined;

    const manifestRaw = asArray((opf['manifest'] as Record<string, unknown> | undefined)?.['item'] as unknown) as Record<string, unknown>[];
    const manifest = new Map<string, ManifestItem>();
    for (const it of manifestRaw) {
        const id = it['@_id'];
        const href = it['@_href'];
        if (typeof id !== 'string' || typeof href !== 'string') continue;
        manifest.set(id, {
            href: normalizeHref(base, decodePath(href)),
            mediaType: typeof it['@_media-type'] === 'string' ? (it['@_media-type'] as string) : '',
            properties: typeof it['@_properties'] === 'string' ? (it['@_properties'] as string) : undefined,
        });
    }

    const spineRaw = asArray((opf['spine'] as Record<string, unknown> | undefined)?.['itemref'] as unknown) as Record<string, unknown>[];
    const spineIds = spineRaw.map(r => r['@_idref']).filter((v): v is string => typeof v === 'string');
    if (spineIds.length === 0) throw new Error('Invalid EPUB: empty spine');

    // TOC: prefer NCX, else spine order with HTML titles.
    const labelByHref = new Map<string, string>();
    const ncxItem = [...manifest.values()].find(i => i.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem) {
        const f = zip.file(ncxItem.href);
        if (f) {
            try {
                const ncx = xmlParser.parse(await f.async('string')) as Record<string, unknown>;
                const navMap = (ncx['ncx'] as Record<string, unknown>)?.['navMap'] as Record<string, unknown> | undefined;
                const walk = (nodes: unknown): void => {
                    for (const np of asArray(nodes as never)) {
                        const r = np as Record<string, unknown>;
                        const label = pickText((r['navLabel'] as Record<string, unknown>)?.['text']).trim();
                        const src = (r['content'] as Record<string, unknown>)?.['@_src'];
                        if (label && typeof src === 'string') {
                            labelByHref.set(String(src).split('#')[0] ?? '', label);
                        }
                        if (r['navPoint']) walk(r['navPoint']);
                    }
                };
                if (navMap?.['navPoint']) walk(navMap['navPoint']);
            } catch {
                // fall through to spine titles
            }
        }
    }

    const chapters: EpubChapter[] = [];
    for (let i = 0; i < spineIds.length; i++) {
        const id = spineIds[i] as string;
        const item = manifest.get(id);
        if (!item) continue;
        const entry = zip.file(item.href);
        if (!entry) continue;
        const html = await entry.async('string');
        const paragraphs = htmlToParagraphs(html);
        if (paragraphs.length === 0) continue;
        const key = item.href.split('#')[0] ?? item.href;
        chapters.push({
            title: labelByHref.get(key) ?? htmlTitle(html, `Chapter ${i + 1}`),
            href: item.href,
            paragraphs,
            wordCount: countWords(paragraphs.join('\n\n')),
        });
    }
    if (chapters.length === 0) throw new Error('Could not extract text from EPUB');

    return { title, author, language, description, chapters };
}

/** Stable series id: hash of URL so re-listing never renumbers. */
export async function seriesIdFor(url: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.trim()));
    return [...new Uint8Array(digest)]
        .slice(0, 8)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

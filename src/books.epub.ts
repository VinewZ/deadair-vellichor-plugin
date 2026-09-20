import { plainText } from '@deadair/plugin-sdk';
import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';

/** EPUB parsing in Node, lifted from Vellichor (MIT) with attribution: fast-xml-parser for OPF/NCX, regex + SDK plainText for chapter XHTML. */

export interface EpubChapter {
    title: string;
    href: string;
    paragraphs: string[];
    wordCount: number;
}

export interface EpubIndex {
    title: string;
    /** Absent when the source names nobody: the station must not say "Unknown" aloud. */
    author?: string;
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

/**
 * A readable label from a file address: no query, fragment, extension,
 * separator, or bracketed furniture, bounded like any spoken title.
 */
export function titleFromFileName(fileName: string): string {
    const withoutFragment = fileName.split('#')[0] ?? fileName;
    const withoutQuery = withoutFragment.split('?')[0] ?? withoutFragment;
    const base = withoutQuery.trim().split('/').filter(Boolean).pop() ?? withoutQuery.trim();
    const words =
        base
            .replace(/\.epub$/i, '')
            .replace(/[_-]+/g, ' ')
            .trim() || 'Untitled';
    return stripEditorial(words).slice(0, 200) || 'Untitled';
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

/** The host abandons the call anyway; this just stops burning its CPU first. */
function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error('Book parsing aborted.');
}

function pickText(v: unknown): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null && '#text' in v) {
        const t = (v as Record<string, unknown>)['#text'];
        return typeof t === 'string' ? t : '';
    }
    return '';
}

/** First h1/h2/title in the chapter file (regex; no DOM in Node). */
function htmlTitle(html: string, fallback: string): string {
    for (const tag of ['h1', 'h2', 'title']) {
        const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]{1,300}?)<\\/${tag}>`, 'i'));
        const t = m?.[1] ? plainText(m[1]) : undefined;
        if (t) return cleanTitle(t);
    }
    return fallback;
}

/** True for a name safe to say aloud: present and not a bare 'Unknown' left by old caches or publishers. */
export function isNamedAuthor(author: string | undefined): author is string {
    return !!author && author.trim().toLowerCase() !== 'unknown';
}

/** Strip bracketed furniture as in body text. Never returns empty: falls back to the caller's label. */
export function cleanTitle(title: string, fallback = 'Untitled'): string {
    const clean = stripEditorial(title).slice(0, 200);
    return clean || fallback.trim() || 'Untitled';
}

/** Split XHTML into paragraphs first, then strip tags per paragraph (plainText collapses whitespace). */
export function htmlToParagraphs(html: string): string[] {
    const withoutHead = html.replace(/<head[\s\S]*?<\/head>/gi, ' ');
    const noScript = withoutHead.replace(/<(script|style|nav)[\s\S]*?<\/\1>/gi, ' ');
    const blocks = noScript.split(/<(?:p|h[1-6]|li|blockquote|pre|div|section|article|br)(?:\s[^>]*)?\/?>/gi);
    const out: string[] = [];
    for (const block of blocks) {
        const ends = block.split(/<\/(?:p|h[1-6]|li|blockquote|pre|div|section|article)>/gi);
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

/** epub:type tokens anywhere in the document: the root declares it in EPUB 3, inner body/nav elements in EPUB 2-era files. */
function docEpubTypes(html: string): string[] {
    const out: string[] = [];
    for (const m of html.matchAll(/\sepub:type\s*=\s*["']([^"']*)["']/gi)) {
        const token = m[1];
        if (token) out.push(...token.toLowerCase().split(/\s+/).filter(Boolean));
    }
    return out;
}

/** True for matter no listener should ever hear: notices, licences, covers. */
export function isFurnitureType(types: string[]): boolean {
    return types.some(t => t === 'frontmatter' || t === 'backmatter' || t === 'colophon' || t === 'copyright-page');
}

/**
 * Words inside links: a contents page is nearly all link labels, a chapter
 * nearly none. The ratio tells them apart for any publisher.
 */
export function linkWordCount(html: string): number {
    let total = 0;
    for (const m of html.matchAll(/<a(?:\s[^>]*)?>((?:(?!<a[\s>])[\s\S])*?)<\/a\s*>/gi)) {
        const text = plainText(m[1] ?? '');
        if (text) total += countWords(text);
    }
    return total;
}

/** Above this share of link text a file is an index of links, not a chapter. */
export const LINK_DENSITY_GUARD = 0.5;

export async function parseEpubBuffer(
    data: Uint8Array,
    fileName: string,
    signal?: AbortSignal,
    reportSkipped?: (hrefs: string[]) => void,
): Promise<EpubIndex> {
    const zip = await JSZip.loadAsync(data);
    throwIfAborted(signal);
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
    const fileTitle = titleFromFileName(fileName);
    const title = rawTitle ? cleanTitle(rawTitle, fileTitle) : fileTitle;
    const creators = asArray(metadata['dc:creator'] as unknown)
        .map(pickText)
        .map(s => s.trim())
        .filter(isNamedAuthor);
    // Authors are said aloud: cleaned like titles, dropped when nothing speakable remains.
    const rawAuthor = creators[0];
    const strippedAuthor = rawAuthor ? stripEditorial(rawAuthor).slice(0, 200) : '';
    const author = strippedAuthor && isNamedAuthor(strippedAuthor) ? strippedAuthor : undefined;
    const language = pickText(metadata['dc:language']).trim().slice(0, 20) || undefined;
    const rawDesc = pickText(metadata['dc:description']).trim();
    const descText = rawDesc ? plainText(rawDesc) : undefined;
    const description = descText ? stripEditorial(descText).slice(0, 500) || undefined : undefined;

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
    const skipped: string[] = [];
    // Spine entries are chapters unless the publisher says otherwise:
    // linear="no" marks furniture (notices, tables of contents) the
    // serial must not open with or ever air.
    const spineIds = spineRaw
        .filter(r => {
            const linear = r['@_linear'];
            if (typeof linear === 'string' && linear.toLowerCase() === 'no') {
                const dropped = r['@_idref'];
                if (typeof dropped === 'string') {
                    const href = manifest.get(dropped)?.href;
                    if (href) skipped.push(href);
                }
                return false;
            }
            return true;
        })
        .map(r => r['@_idref'])
        .filter((v): v is string => typeof v === 'string');
    if (spineIds.length === 0) throw new Error('Invalid EPUB: empty spine');

    // EPUB 2 furniture pointers: the guide names cover and TOC files outright.
    const guideTypes = new Set(['cover', 'title-page', 'toc']);
    const guideHrefs = new Set<string>();
    const guideRaw = asArray((opf['guide'] as Record<string, unknown> | undefined)?.['reference'] as unknown) as Record<string, unknown>[];
    for (const ref of guideRaw) {
        const type = ref['@_type'];
        const href = ref['@_href'];
        if (typeof type !== 'string' || typeof href !== 'string') continue;
        if (guideTypes.has(type.toLowerCase())) {
            const key = normalizeHref(base, decodePath(href)).split('#')[0] ?? '';
            if (key) guideHrefs.add(key);
        }
    }
    // EPUB 3 navigation and cover-image documents are furniture by definition.
    const furnitureIds = new Set<string>();
    for (const [id, item] of manifest) {
        const tokens = (item.properties ?? '').toLowerCase().split(/\s+/);
        if (tokens.includes('nav') || tokens.includes('cover-image')) furnitureIds.add(id);
    }

    // TOC: prefer NCX, else spine order with HTML titles.
    const labelByHref = new Map<string, string>();
    const ncxItem = [...manifest.values()].find(i => i.mediaType === 'application/x-dtbncx+xml');
    if (ncxItem) {
        const f = zip.file(ncxItem.href);
        if (f) {
            try {
                const ncx = xmlParser.parse(await f.async('string')) as Record<string, unknown>;
                const navMap = (ncx['ncx'] as Record<string, unknown>)?.['navMap'] as Record<string, unknown> | undefined;
                // NCX sources resolve against the NCX file, manifest hrefs
                // against the OPF: normalize both or no label ever matches.
                const ncxBase = dirname(ncxItem.href);
                const walk = (nodes: unknown): void => {
                    for (const np of asArray(nodes as never)) {
                        const r = np as Record<string, unknown>;
                        const label = pickText((r['navLabel'] as Record<string, unknown>)?.['text']).trim();
                        const src = (r['content'] as Record<string, unknown>)?.['@_src'];
                        if (label && typeof src === 'string') {
                            const key = normalizeHref(ncxBase, decodePath(String(src))).split('#')[0] ?? '';
                            // First navPoint names the file: later fragments
                            // are trailing sections, never the chapter title.
                            if (key && !labelByHref.has(key)) labelByHref.set(key, cleanTitle(label, label));
                        }
                        if (r['navPoint']) walk(r['navPoint']);
                    }
                };
                if (navMap?.['navPoint']) walk(navMap['navPoint']);
            } catch {
                // Unparseable NCX: spine titles below still work.
            }
        }
    }

    const chapters: EpubChapter[] = [];
    for (let i = 0; i < spineIds.length; i++) {
        throwIfAborted(signal);
        const id = spineIds[i] as string;
        const item = manifest.get(id);
        if (!item) continue;
        // Only XHTML spine entries are chapters; anything else would parse as garbage text.
        if (item.mediaType && item.mediaType !== 'application/xhtml+xml' && item.mediaType !== 'text/html') continue;
        const key = item.href.split('#')[0] ?? item.href;
        if (furnitureIds.has(id) || guideHrefs.has(key)) {
            skipped.push(item.href);
            continue;
        }
        const entry = zip.file(item.href);
        if (!entry) continue;
        const html = await entry.async('string');
        // Furniture declares itself anywhere in the document: EPUB 3 on the
        // root, older files on inner body/nav elements.
        if (isFurnitureType(docEpubTypes(html))) {
            skipped.push(item.href);
            continue;
        }
        const paragraphs = htmlToParagraphs(html);
        if (paragraphs.length === 0) continue;
        // An index of links is furniture in any publisher's book: its words
        // are link labels, not text to speak.
        const words = countWords(paragraphs.join('\n\n'));
        if (words > 0 && linkWordCount(html) / words > LINK_DENSITY_GUARD) {
            skipped.push(item.href);
            continue;
        }
        // Fallbacks count finished chapters so skips leave no gaps and ordinals agree.
        const fallback = `Chapter ${chapters.length + 1}`;
        chapters.push({
            title: cleanTitle(labelByHref.get(key) ?? htmlTitle(html, fallback), fallback),
            href: item.href,
            paragraphs,
            wordCount: words,
        });
    }
    if (chapters.length === 0) throw new Error('Could not extract text from EPUB');
    if (skipped.length > 0) reportSkipped?.(skipped);

    return {
        title,
        ...(author ? { author } : {}),
        ...(language ? { language } : {}),
        ...(description ? { description } : {}),
        chapters,
    };
}

/** Stable series id: hash of URL so re-listing never renumbers. */
export async function seriesIdFor(url: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.trim()));
    return [...new Uint8Array(digest)]
        .slice(0, 8)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

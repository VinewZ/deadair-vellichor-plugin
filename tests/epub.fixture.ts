import JSZip from 'jszip';

export interface FixtureChapter {
    file: string;
    id: string;
    head?: string;
    body: string;
    ncxLabel?: string;
    mediaType?: string;
    /** Spine linear="no": furniture the serial must skip. */
    linearNo?: boolean;
    /** Guide reference type pointing at this file: 'cover', 'toc', ... */
    guideType?: string;
    /** OPF manifest properties, e.g. 'nav'. */
    properties?: string;
    /** epub:type on the document root, e.g. 'copyright-page'. */
    epubType?: string;
    /** Raw attributes on the <body> element, e.g. 'epub:type="frontmatter"'. */
    bodyAttrs?: string;
}

export interface FixtureOptions {
    title?: string;
    author?: string;
    description?: string;
    chapters: FixtureChapter[];
    includeNcx?: boolean;
    opfDir?: string;
    /** Extra NCX points (e.g. a second fragment in an existing file). */
    ncxExtra?: Array<{ label: string; src: string }>;
}

const containerXml = (opfPath: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles></container>`;

function opfXml(opt: FixtureOptions): string {
    const items = opt.chapters
        .map(
            c =>
                `<item id="${c.id}" href="${c.file}" media-type="${c.mediaType ?? 'application/xhtml+xml'}"${c.properties ? ` properties="${c.properties}"` : ''}/>`,
        )
        .join('');
    const ncx = opt.includeNcx === false ? '' : `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;
    const spine = opt.chapters.map(c => `<itemref idref="${c.id}"${c.linearNo ? ' linear="no"' : ''}/>`).join('');
    const guideRefs = opt.chapters
        .filter(c => c.guideType !== undefined)
        .map(c => `<reference type="${c.guideType}" title="Furniture" href="${c.file}"/>`)
        .join('');
    const guide = guideRefs ? `<guide>${guideRefs}</guide>` : '';
    return `<?xml version="1.0" encoding="UTF-8"?><package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${opt.title ?? 'Fixture Book'}</dc:title><dc:creator>${opt.author ?? 'Fixture Author'}</dc:creator><dc:language>en</dc:language>${opt.description ? `<dc:description>${opt.description}</dc:description>` : ''}</metadata><manifest>${items}${ncx}</manifest><spine>${spine}</spine>${guide}</package>`;
}

function ncxXml(opt: FixtureOptions): string {
    const points = opt.chapters
        .filter(c => c.ncxLabel !== undefined)
        .map((c, i) => `<navPoint id="np${i}"><navLabel><text>${c.ncxLabel}</text></navLabel><content src="${c.file}"/></navPoint>`)
        .join('');
    const extra = (opt.ncxExtra ?? [])
        .map((e, i) => `<navPoint id="npx${i}"><navLabel><text>${e.label}</text></navLabel><content src="${e.src}"/></navPoint>`)
        .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="uid"/></head><docTitle><text>Fixture</text></docTitle><navMap>${points}${extra}</navMap></ncx>`;
}

function chapterXml(c: FixtureChapter): string {
    const epubType = c.epubType ? ` epub:type="${c.epubType}"` : '';
    const bodyAttrs = c.bodyAttrs ? ` ${c.bodyAttrs}` : '';
    return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"${epubType} xmlns:epub="http://www.idpf.org/2007/ops"><head>${c.head ?? ''}</head><body${bodyAttrs}>${c.body}</body></html>`;
}

/** A minimal multi-chapter EPUB held entirely in memory. OPF+NCX live in OEBPS/, chapters beneath it. */
export async function buildEpub(opt: FixtureOptions): Promise<Uint8Array> {
    const dir = opt.opfDir ?? 'OEBPS';
    const zip = new JSZip();
    zip.file('META-INF/container.xml', containerXml(`${dir}/content.opf`));
    zip.file(`${dir}/content.opf`, opfXml(opt));
    if (opt.includeNcx !== false) zip.file(`${dir}/toc.ncx`, ncxXml(opt));
    for (const c of opt.chapters) zip.file(`${dir}/${c.file}`, chapterXml(c));
    return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

/** Three text chapters with NCX covering ch1+ch4, an empty ch3 skipped, brackets everywhere. */
export function buildStandardEpub(): Promise<Uint8Array> {
    return buildEpub({
        title: 'Test Book [Draft]',
        author: 'Fixture Author',
        description: 'A tale [Illustration: a boat] of woe.',
        chapters: [
            {
                file: 'text/ch1.xhtml',
                id: 'ch1',
                head: '<title>Ignored When NCX Wins</title>',
                body: '<h1>The Beginning</h1><p>First paragraph [Footnote 1] here.</p><p>Second.</p>',
                ncxLabel: 'Chapter One',
            },
            {
                file: 'text/ch2.xhtml',
                id: 'ch2',
                head: '<title>Ch Two</title>',
                body: '<p>Unicode: Déjà vu ☃ and snow.</p>',
            },
            {
                file: 'text/ch3.xhtml',
                id: 'ch3',
                head: '<title>Empty</title>',
                body: '<nav><a href="x">y</a></nav>',
            },
            {
                file: 'text/ch4.xhtml',
                id: 'ch4',
                body: '<h2>The End</h2><p>Done.</p>',
                ncxLabel: 'Chapter [Four]',
            },
        ],
    });
}

/** Every spine item textless: parsing must refuse the book. */
export function buildEpubNoText(): Promise<Uint8Array> {
    return buildEpub({
        title: 'No Text',
        includeNcx: false,
        chapters: [{ file: 'text/empty.xhtml', id: 'empty', head: '<title>Empty</title>', body: '<nav><a href="x">y</a></nav>' }],
    });
}
/** No NCX and a leading empty spine item: fallback titles must count finished chapters, not spine slots. */
export function buildNoNcxEpub(): Promise<Uint8Array> {
    return buildEpub({
        title: 'Fallbacks',
        includeNcx: false,
        chapters: [
            { file: 'text/empty.xhtml', id: 'empty', head: '<title>Empty</title>', body: '<nav><a href="x">y</a></nav>' },
            { file: 'text/real.xhtml', id: 'real', body: '<p>Hello.</p>' },
        ],
    });
}

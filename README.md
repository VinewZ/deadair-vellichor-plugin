# Vellichor Books

A narration plugin for the deadair station that reads EPUB books aloud, one chapter at a time. Each configured book appears to the station as a series, and each chapter as a piece of that series, so a narrator voice (for example Kokoro TTS) can speak a chapter at every narration band. EPUB-only, version 0.1.0.

The plugin downloads each book's EPUB file, extracts clean text per chapter (no markup, no bracketed furniture like footnotes or illustration notes, which would otherwise be spoken as performance cues), and caches it so books are not re-downloaded on every page load. Book titles, chapter titles, and author names are cleaned the same way before they can ever reach a presenter or a voice. Anonymous books simply list without an author instead of saying "Unknown" aloud.

## Install / add to the station

Recommended: download the ready-built `deadair-plugin-vellichor-books-<version>.tgz` from the [GitHub Releases page](https://github.com/VinewZ/deadair-vellichor-plugin/releases) and skip to step 3.

To build it yourself instead:

1. Build the plugin:
   ```sh
   bun install
   bun run build
   ```
2. Pack it into a tarball (produces `deadair-plugin-vellichor-books-0.1.0.tgz`):
   ```sh
   npm pack
   ```
3. In the station console, go to Plugins → Import and upload the tarball, then Enable the plugin. It appears as `radio.vellichor.books` ("Vellichor books").
4. Optionally verify the setup first with `bun run typecheck` and `bun run test`.

## Use

1. Open the plugin's configuration and add one row per book to the **Books** list: a **Name** (optional label, e.g. `Frankenstein`) and the **EPUB address** (required, `http://` or `https://`). Good sources are Project Gutenberg, Standard Ebooks, a Calibre-Web instance, or your own file server.
2. Press **Test Connection**: the plugin reads every configured book and reports something like `Read Frankenstein: 30 chapters.` If a book cannot be downloaded in the few seconds the probe allows, it tells you it is not cached yet — try again in a minute.
3. Set a narrator voice for the series (e.g. "Speak with" your Kokoro TTS plugin) and make sure a format clock has a narration band that includes books. At each band the station picks the next unread chapter and the voice reads it on air.
4. Keep the shelf to a handful of books: each book caches about one stored key per chapter against a 200-key station budget.

If a book's file is temporarily unreachable, the plugin keeps serving its cached text and lists the series without metadata rather than dropping your other books.

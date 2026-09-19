import { definePlugin } from '@deadair/plugin-sdk';
import { booksManifest } from './books.manifest.js';
import { VellichorBooksPlugin } from './books.plugin.js';

// What the station imports. `package.json`'s `deadair.plugin` points at the
// built copy of this file, and its default export is definePlugin(manifest,
// factory). The factory runs once per start; setup belongs in onLoad.
export default definePlugin(booksManifest, () => new VellichorBooksPlugin());

import { defineConfig } from 'tsup';

// One ES module the station imports. SDK + zod stay external (host links
// them). Everything else in devDependencies (jszip, fast-xml-parser) bundles
// in. Do not use `dependencies`: tsup treats those as external.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node24',
    sourcemap: true,
    clean: true,
});

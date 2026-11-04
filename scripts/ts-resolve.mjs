// Lets a check script `import` an app service directly.
//
// src/ uses extensionless relative imports ('./spKeys') because Metro and Vite
// both resolve them. Node's ESM loader does not, so a service that imports a
// sibling cannot be loaded by a check script the way scripts/check-sp-signing
// loads spSign.ts — that one works only because spSign happens to import no
// siblings at all.
//
// Registered with:
//   node --experimental-strip-types --import ./scripts/ts-resolve.mjs <script>
//
// It also maps the web app's '@/…' alias onto src/, which Vite resolves
// through its own config and Node knows nothing about. Without it a store that
// imports '@/services/backup' — the convention everywhere in src/stores — is
// unreachable from a check, and the alternative would be writing one file in
// the tree differently from its neighbours to suit the test harness.
//
// Resolution only; it adds no transform. --experimental-strip-types still does
// the TypeScript erasure, which is why app code must avoid syntax that erasure
// cannot handle (parameter properties, enums) if a check is to reach it.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';

      let srcRoot;
      export async function initialize(data) { srcRoot = data.srcRoot; }

      function withExtension(href) {
        if (/\\.[cm]?[jt]sx?$/.test(href)) return href;
        for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
          if (existsSync(fileURLToPath(href + ext))) return href + ext;
        }
        return null;
      }

      export async function resolve(specifier, context, next) {
        if (specifier.startsWith('@/')) {
          const href = new URL(specifier.slice(2), srcRoot).href;
          return next(withExtension(href) || href, context);
        }
        if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
          const url = new URL(specifier, context.parentURL);
          const resolved = withExtension(url.href);
          if (resolved) return next(specifier + resolved.slice(url.href.length), context);
        }
        return next(specifier, context);
      }
    `),
  pathToFileURL('./'),
  { data: { srcRoot: new URL('../src/', import.meta.url).href } },
);

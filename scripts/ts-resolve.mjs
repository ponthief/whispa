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
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
          const url = new URL(specifier, context.parentURL);
          for (const ext of ['.ts', '.tsx', '.js', '.mjs']) {
            if (existsSync(fileURLToPath(url.href + ext))) {
              return next(specifier + ext, context);
            }
          }
        }
        return next(specifier, context);
      }
    `),
  pathToFileURL('./'),
);

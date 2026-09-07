/* Validate tauri.conf.json against the schema that ships with the CLI.
 *
 * Worth having its own step: an invalid key here fails the build only
 * after Rust and the toolchain are set up, and the message points at the
 * whole offending object rather than the one bad field. This names it.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import Ajv from 'ajv';

const SCHEMA = 'node_modules/@tauri-apps/cli/config.schema.json';
const CONF = 'src-tauri/tauri.conf.json';
const CARGO = 'src-tauri/Cargo.toml';
const SRC = 'src-tauri/src';

let failed = false;

/* Every tauri-plugin-* dependency that the code actually calls into must
 * also be registered on the Builder. Miss one and the app compiles and
 * launches happily, then aborts the first time that plugin is touched —
 * which is how the dialog plugin shipped unregistered and killed the app
 * on the first "Open model" click.
 */
function checkPlugins() {
  if (!existsSync(CARGO) || !existsSync(SRC)) return;

  const cargo = readFileSync(CARGO, 'utf8');
  const deps = [...cargo.matchAll(/^tauri-plugin-([a-z0-9-]+)\s*=/gm)]
    .map((m) => m[1].replace(/-/g, '_'));
  if (!deps.length) return;

  const code = readdirSync(SRC)
    .filter((f) => f.endsWith('.rs'))
    .map((f) => readFileSync(`${SRC}/${f}`, 'utf8'))
    .join('\n');

  for (const name of deps) {
    const crate = `tauri_plugin_${name}`;
    const used = new RegExp(`\\b${crate}\\b`).test(code);
    const registered = new RegExp(`\\.plugin\\(\\s*${crate}`).test(code);
    if (used && !registered) {
      console.error(`  ${crate} is used but never registered on the Builder.`);
      console.error(`    add:  .plugin(${crate}::init())`);
      failed = true;
    }
  }
}

if (!existsSync(SCHEMA)) {
  console.error('Tauri CLI not installed — run: npm install');
  process.exit(1);
}

const schema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
const conf = JSON.parse(readFileSync(CONF, 'utf8'));

// Tauri's schema contains patterns that are invalid under the unicode
// flag Ajv compiles with by default, e.g. an escaped colon inside a
// character class. Retry without the flag rather than crash.
const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false,   // the schema uses Rust numeric formats Ajv does not know
  code: {
    regExp: (src, flags) => {
      try { return new RegExp(src, flags); }
      catch { return new RegExp(src, (flags || '').replace('u', '')); }
    }
  }
});
const validate = ajv.compile(schema);

if (validate(conf)) {
  console.log('tauri.conf.json is valid.');
} else {
  failed = true;
  console.error('tauri.conf.json failed validation:\n');
  reportSchemaErrors();
}

checkPlugins();
checkStrayManifest();

/* Cargo searches upward from src-tauri for a workspace root. A Cargo.toml
 * at the project root gets parsed as one and the build dies before it
 * compiles anything. src-tauri declares [workspace] to stop the search,
 * but a stray file is still a mistake worth naming.
 */
function checkStrayManifest() {
  if (!existsSync('Cargo.toml')) return;
  console.error('  Cargo.toml found at the project root.');
  console.error('    Rust lives in src-tauri/ — delete the root copy.');
  failed = true;
}

if (failed) process.exit(1);
console.log('Tauri plugins are all registered.');
process.exit(0);

function reportSchemaErrors() {
for (const e of validate.errors) {
  const where = e.instancePath || '(root)';
  console.error(`  ${where}  ${e.message}`);
  if (e.params?.additionalProperty) {
    console.error(`    unexpected key: "${e.params.additionalProperty}"`);
  }
  if (e.params?.allowedValues) {
    console.error(`    allowed: ${e.params.allowedValues.join(', ')}`);
  }
}
}

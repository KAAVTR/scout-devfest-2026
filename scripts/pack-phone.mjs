/**
 * Phone-only portable folder. Plain Node runs scout-phone.js. No npm install for the person opening the zip.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, 'release', 'scout-phone-v22');
const zipPath = join(root, 'release', 'scout-phone-release-v22.zip');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'phone-demo'), { recursive: true });

function bundle(entry, outfile) {
  const esbuild = join(root, 'node_modules', 'esbuild', 'bin', 'esbuild');
  const result = spawnSync(process.execPath, [
    esbuild, entry,
    '--bundle', '--platform=node', '--format=cjs',
    `--outfile=${outfile}`,
  ], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const source = readFileSync(outfile, 'utf8');
  const patched = source.replace(
    /var (import_meta\d*) = \{\};/g,
    'var $1 = { url: require("node:url").pathToFileURL(__filename).href };',
  );
  if (patched === source) {
    process.stderr.write(`portable bundle did not rewrite import.meta in ${outfile}\n`);
    process.exit(1);
  }
  writeFileSync(outfile, patched);
}

bundle('scripts/local-demo.ts', join(stage, 'scout-demo.js'));
bundle('scripts/scout-serve.ts', join(stage, 'scout-phone.js'));
for (const name of ['work.html', 'index.html', 'house-left-pass.jpg', 'house-right-inspect.jpg']) {
  cpSync(join(root, 'phone-demo', name), join(stage, 'phone-demo', name));
}
writeFileSync(join(stage, 'VERSION'), 'v22\n');
writeFileSync(join(stage, 'scout-phone.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nnode "%~dp0scout-phone.js" %*\r\n');

function filesIn(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesIn(full));
    else out.push(full);
  }
  return out;
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ~crc >>> 0;
}

function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = entry.data;
    const compressed = deflateRawSync(data);
    const use = compressed.length < data.length ? compressed : data;
    const method = use === compressed ? 8 : 0;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(use.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localHeader = Buffer.concat([local, name, use]);
    parts.push(localHeader);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(use.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([centralHeader, name]));
    offset += localHeader.length;
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDir, end]);
}

const entries = filesIn(stage).sort().map((full) => ({
  name: `scout-phone-v22/${relative(stage, full).split('\\').join('/')}`,
  data: readFileSync(full),
}));
const zip = zipStore(entries);
writeFileSync(zipPath, zip);
const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${sha}  scout-phone-release-v22.zip\n`);
process.stdout.write(`${sha}  ${zipPath}  ${zip.length}\n`);

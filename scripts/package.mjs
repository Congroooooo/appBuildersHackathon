// Builds an unpacked Windows distribution with the official @electron/packager.
import { packager } from '@electron/packager';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve('.'), stage = join(root, 'tmp', 'package');
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const folder of ['dist', 'electron', 'core', 'connectors', 'extension']) await cp(join(root, folder), join(stage, folder), { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: 'Continuum', version: pkg.version, main: pkg.main, type: 'module', description: pkg.description }));
const output = await packager({
  dir: stage, out: join(root, 'release'), name: 'Continuum', platform: 'win32', arch: 'x64', electronVersion: pkg.devDependencies.electron,
  // Adapter scripts are run by Claude Code / OpenCode with plain Node, so they live outside the asar archive.
  asar: { unpack: '{**/connectors/**,**/extension/**}' }, overwrite: true, prune: false, executableName: 'Continuum', appCopyright: 'Continuum hackathon team',
  win32metadata: { CompanyName: 'Continuum', FileDescription: 'Continuum: private, on-device AI memory for unfinished work', ProductName: 'Continuum' },
});
console.log(output.join('\n'));

// Fails the build if the packaged app contains anything private or unexpected.
import asar from '@electron/asar';
import fs from 'node:fs';
import path from 'node:path';

// accepts an unpacked app folder for any OS (Linux/Windows: resources/, macOS: X.app/Contents/Resources/)
const find = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.name === 'app.asar' && e.isFile()) return path.dirname(p);
    if (e.isDirectory() && !e.name.endsWith('.asar.unpacked')) {
      const found = find(p);
      if (found) return found;
    }
  }
  return null;
};
const resources = find(process.argv[2]);
if (!resources) throw new Error(`app.asar introuvable dans ${process.argv[2]}`);
const archive = path.join(resources, 'app.asar');
const files = asar.listPackage(archive).map((p) => p.replaceAll('\\', '/'));
const unpacked = path.join(resources, 'app.asar.unpacked');
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const all = [...files, ...walk(unpacked).map((f) => `/${path.relative(unpacked, f).replaceAll('\\', '/')}`)];
const forbidden = all.filter((f) => /^\/(data|test|test-results|dist|scripts)\//.test(f) || /(\.mcp\.json|ai\.json|youtube\.json|rclone\.conf|clipforge\.db)/.test(f));
const tops = [...new Set(files.map((f) => f.split('/')[1]))].sort();
console.log('top-level:', tops.join(', '));
if (forbidden.length) {
  console.error('INTERDIT dans le paquet :', forbidden.slice(0, 20));
  process.exit(1);
}
console.log(`OK : ${all.length} fichiers, rien de privé`);

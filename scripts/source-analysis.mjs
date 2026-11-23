import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { API } from 'typescript/unstable/sync';

// TypeScript 7 exposes its native compiler syntax trees through the sync API,
// not the removed 'typescript' JavaScript compiler facade.
export function listSourceFiles(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(absolute);
    }
  }
  visit(root);
  return files.sort();
}

export function withSourceTrees(sourceRoot, callback) {
  const root = path.resolve(sourceRoot);
  const files = listSourceFiles(root);
  if (files.length === 0) return callback([]);
  const api = new API({ cwd: root });
  let snapshot;
  try {
    snapshot = api.updateSnapshot({ openFiles: files });
    const trees = files.map((absolutePath) => {
      const project = snapshot.getDefaultProjectForFile(absolutePath);
      const sourceFile = project?.program.getSourceFile(absolutePath);
      if (!sourceFile) throw new Error(`TypeScript could not parse source: ${absolutePath}`);
      return {
        sourceFile,
        source: readFileSync(absolutePath, 'utf8'),
        absolutePath,
        relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
      };
    });
    return callback(trees);
  } finally {
    snapshot?.dispose();
    api.close();
  }
}

export function walkSource(node, visit) {
  visit(node);
  node.forEachChild((child) => walkSource(child, visit));
}

export function sourceLine(tree, node) {
  return tree.sourceFile.getLineAndCharacterOfPosition(node.getStart(tree.sourceFile)).line + 1;
}

export function logicalLines(value) {
  return value.split(/\r?\n/).filter((line) =>
    line.trim() !== '' && !/^\s*(?:\/\/|\/\*|\*)/.test(line)
  ).length;
}

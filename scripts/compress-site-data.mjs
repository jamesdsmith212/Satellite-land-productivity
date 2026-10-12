import { readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

const gzip = promisify(gzipCallback);
const dataRoot = path.resolve("dist/client/data");
const batchSize = 16;

async function collectJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(entryPath)));
    } else if (/\.(?:geo)?json$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

const files = await collectJsonFiles(dataRoot);
let originalBytes = 0;
let compressedBytes = 0;

for (let index = 0; index < files.length; index += batchSize) {
  await Promise.all(
    files.slice(index, index + batchSize).map(async (filePath) => {
      const input = await readFile(filePath);
      const output = await gzip(input, { level: 9 });
      await writeFile(`${filePath}.gz`, output);
      await unlink(filePath);
      originalBytes += input.byteLength;
      compressedBytes += output.byteLength;
    }),
  );
}

const rootSize = await stat(dataRoot);
if (!rootSize.isDirectory()) throw new Error(`${dataRoot} is not a directory`);

console.log(
  `Compressed ${files.length} hosted data files: ${Math.round(originalBytes / 1024 / 1024)} MiB → ${Math.round(compressedBytes / 1024 / 1024)} MiB`,
);

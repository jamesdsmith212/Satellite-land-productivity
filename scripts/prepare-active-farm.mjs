import {
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);
const configPath = process.env.FARM_CONFIG
  ? path.resolve(repositoryRoot, process.env.FARM_CONFIG)
  : path.join(repositoryRoot, "local-data/active-farm.json");

let workspace = path.join(repositoryRoot, "fixtures/demo-farm");
try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (!config.workspace) throw new Error(`Farm config has no workspace: ${configPath}`);
  workspace = path.resolve(repositoryRoot, config.workspace);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const requiredFiles = {
  profile: "profile.json",
  history: "source/history.json",
  importReport: "source/import-report.json",
  boundaries: "source/boundaries.geojson",
  weather: "derived/weather-summary.json",
  ndvi: "derived/ndvi-summary.json",
  performance: "derived/performance-summary.json",
};

for (const relativePath of Object.values(requiredFiles)) {
  await stat(path.join(workspace, relativePath));
}

const activeData = path.join(repositoryRoot, "data/active-farm");
const activePublic = path.join(repositoryRoot, "public/data/active-farm");
await rm(activeData, { recursive: true, force: true });
await rm(activePublic, { recursive: true, force: true });
await mkdir(activeData, { recursive: true });
await mkdir(activePublic, { recursive: true });

await Promise.all([
  cp(path.join(workspace, requiredFiles.profile), path.join(activeData, "profile.json")),
  cp(path.join(workspace, requiredFiles.history), path.join(activeData, "history.json")),
  cp(path.join(workspace, requiredFiles.importReport), path.join(activeData, "import-report.json")),
  cp(path.join(workspace, requiredFiles.weather), path.join(activeData, "weather-summary.json")),
  cp(path.join(workspace, requiredFiles.ndvi), path.join(activeData, "ndvi-summary.json")),
  cp(path.join(workspace, requiredFiles.performance), path.join(activeData, "performance-summary.json")),
  cp(path.join(workspace, requiredFiles.boundaries), path.join(activePublic, "boundaries.geojson")),
]);

async function ensurePublicLink(name) {
  const target = path.join(workspace, "public", name);
  await mkdir(target, { recursive: true });
  const link = path.join(repositoryRoot, "public/data", name);
  try {
    const details = await lstat(link);
    if (details.isSymbolicLink()) {
      const existingTarget = path.resolve(path.dirname(link), await readlink(link));
      if (existingTarget === target) return;
      await rm(link, { force: true });
    }
    if (details.isDirectory()) {
      throw new Error(
        `${link} is a real directory. Move it to ${target} before activating this farm.`,
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await rm(link, { force: true });
  await symlink(path.relative(path.dirname(link), target), link, "dir");
}

await Promise.all([
  ensurePublicLink("ndvi"),
  ensurePublicLink("performance"),
  ensurePublicLink("landsat"),
]);

const profile = JSON.parse(await readFile(path.join(workspace, "profile.json"), "utf8"));
console.log(`Active farm: ${profile.name} (${profile.id})`);
console.log(`Workspace: ${workspace}`);

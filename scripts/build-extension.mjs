import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extensionDir = path.join(repoRoot, "extension");
const distDir = path.join(repoRoot, "dist");

const targetArg = process.argv[2] || "all";
const targets = targetArg === "all" ? ["store", "dev"] : [targetArg];
const validTargets = new Set(["store", "dev"]);

for (const target of targets) {
  if (!validTargets.has(target)) {
    throw new Error(`Unknown build target: ${target}`);
  }
}

function toZipPath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function collectFiles(root, dir = root) {
  const rows = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rows.push(...await collectFiles(root, fullPath));
    } else if (entry.isFile()) {
      rows.push({
        fullPath,
        relativePath: toZipPath(path.relative(root, fullPath)),
      });
    }
  }
  return rows.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fixedDosTimeDate() {
  const year = 2026;
  const month = 1;
  const day = 1;
  const hour = 0;
  const minute = 0;
  const second = 0;
  return {
    time: (hour << 11) | (minute << 5) | Math.floor(second / 2),
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

async function createZip(sourceDir, zipPath) {
  const files = await collectFiles(sourceDir);
  const chunks = [];
  const centralChunks = [];
  let offset = 0;
  const { time, date } = fixedDosTimeDate();

  for (const file of files) {
    const raw = await fs.readFile(file.fullPath);
    const compressed = deflateRawSync(raw, { level: 9 });
    const name = Buffer.from(file.relativePath, "utf8");
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  await fs.writeFile(zipPath, Buffer.concat([...chunks, ...centralChunks, end]));
}

async function writeBuildConfig(outputDir, target) {
  const enableLocalBackend = target === "dev";
  const content = `(() => {
  globalThis.Echo360BuildConfig = {
    buildTarget: ${JSON.stringify(target)},
    enableLocalBackend: ${JSON.stringify(enableLocalBackend)},
  };
})();
`;
  await fs.writeFile(path.join(outputDir, "build_config.js"), content);
}

async function patchManifest(outputDir, target) {
  const manifestPath = path.join(outputDir, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  if (target === "store") {
    manifest.host_permissions = (manifest.host_permissions || []).filter((permission) =>
      !permission.startsWith("http://127.0.0.1") &&
      !permission.startsWith("http://localhost")
    );
  } else {
    manifest.name = `${manifest.name} (Dev)`;
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function patchStoreFiles(outputDir, target) {
  if (target !== "store") return;

  const optionsPath = path.join(outputDir, "options.html");
  const optionsHtml = await fs.readFile(optionsPath, "utf8");
  const strippedOptionsHtml = optionsHtml.replace(
    /\n\s*<!-- LOCAL_BACKEND_START -->[\s\S]*?<!-- LOCAL_BACKEND_END -->\n?/,
    "\n"
  );
  await fs.writeFile(optionsPath, strippedOptionsHtml);
}

async function buildTarget(target) {
  await fs.mkdir(distDir, { recursive: true });
  const outputDir = path.join(distDir, `extension-${target}`);
  const zipPath = path.join(distDir, `echo360-online-subtitle-translator-${target}.zip`);

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.rm(zipPath, { force: true });
  await copyDir(extensionDir, outputDir);
  await writeBuildConfig(outputDir, target);
  await patchManifest(outputDir, target);
  await patchStoreFiles(outputDir, target);
  await createZip(outputDir, zipPath);

  console.log(`Built ${target}:`);
  console.log(`  ${path.relative(repoRoot, outputDir)}`);
  console.log(`  ${path.relative(repoRoot, zipPath)}`);
}

for (const target of targets) {
  await buildTarget(target);
}

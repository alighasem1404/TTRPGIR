import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "dist");
const pdfRoot = resolve(process.argv[2] || join(root, "node_modules", "pdfjs-dist"));
const { name, version } = JSON.parse(await readFile(join(pdfRoot, "package.json"), "utf8"));
if (name !== "pdfjs-dist" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Expected an extracted pdfjs-dist npm package.");
}

const maker = await readFile(join(root, "bookmaker.html"), "utf8");
const pin = maker.match(/data-pdf-engine="https:\/\/cdn\.jsdelivr\.net\/npm\/pdfjs-dist@(\d+\.\d+\.\d+)\/"/);
if (!pin) throw new Error("Bookmaker is missing its pinned PDF.js version.");
const localTest = process.argv.includes("--local-test");
if (version !== pin[1] && !localTest) {
  throw new Error(`The release needs PDF.js ${pin[1]}. Found ${version}.`);
}
const files = [
  "index.html", "styles.css", "reader.js", "app.js", "image-viewer.js",
  "book-contents.js", "book-reprocessing.js", "book-restore.js", "book-archive.js", "book-editing.js", "image-recovery.js", "pdf-import.js", "book-format.schema.json",
  "Test text/Euphoria Demo.txt", "books/euphoria-demo/conversion.json",
  "books/euphoria-demo/book.json", "books/euphoria-demo/book-fa.json",
  "vendor/jszip-3.10.1/jszip.min.js", "vendor/jszip-3.10.1/LICENSE.markdown"
];

const buildPath = "legacy/build";
const modules = (await readdir(join(pdfRoot, buildPath))).filter((file) => /^pdf[\w.]*\.min\.mjs$/.test(file));
if (!["pdf.min.mjs", "pdf.worker.min.mjs"].every((file) => modules.includes(file))) {
  throw new Error("PDF.js is missing its browser module or worker.");
}

const previous = await lstat(dist).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error("dist must be a regular build directory.");
if (previous) await rm(dist, { recursive: true });
await mkdir(dist);

for (const file of files) {
  const target = join(dist, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, file), target);
}

const vendorPath = `vendor/pdfjs/${version}`;
const pdfVendor = join(dist, vendorPath);
await mkdir(join(pdfVendor, buildPath), { recursive: true });
for (const file of modules) await copyFile(join(pdfRoot, buildPath, file), join(pdfVendor, buildPath, file));
for (const directory of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
  await cp(join(pdfRoot, directory), join(pdfVendor, directory), { recursive: true });
}
await copyFile(join(pdfRoot, "LICENSE"), join(pdfVendor, "LICENSE"));
await writeFile(join(dist, "bookmaker.html"), maker.replace(pin[0], `data-pdf-engine="./${vendorPath}/"`));
await writeFile(join(dist, ".nojekyll"), "");
console.log(`Built dist with PDF.js ${version}${version === pin[1] ? "" : " (local test build)"}.`);

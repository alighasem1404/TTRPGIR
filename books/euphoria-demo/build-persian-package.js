const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..", "..");
const sourcePath = path.join(projectRoot, "Test text", "Euphoria Demo.txt");
const configPath = path.join(__dirname, "conversion.json");
const translationsPath = path.join(__dirname, "translations.fa.json");
const outputPath = path.join(__dirname, "book-fa.json");
const appSource = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
const context = {
  document: { addEventListener() {}, querySelector() { return null; } },
  console,
  setTimeout,
  clearTimeout,
  URL,
  Blob
};

vm.runInNewContext(`${appSource}\nglobalThis.bookMakerFunctions = { parseDocument, buildBookPackage };`, context);
const source = fs.readFileSync(sourcePath, "utf8");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const translations = JSON.parse(fs.readFileSync(translationsPath, "utf8"));
const sourceFingerprint = crypto.createHash("sha256").update(appSource).update(source).update(JSON.stringify(config)).digest("hex");
if (translations.sourceFingerprint !== sourceFingerprint) {
  throw new Error("The source or converter has changed since this translation was prepared; review the block mapping before rebuilding.");
}
const parsed = context.bookMakerFunctions.parseDocument(source, config);
const bookPackage = context.bookMakerFunctions.buildBookPackage(source, "Euphoria Demo.txt", parsed, config);
bookPackage.source.sourceHash = crypto.createHash("sha256").update(source).digest("hex");

bookPackage.book = {
  ...bookPackage.book,
  ...translations.book,
  id: "euphoria-demo-fa",
  language: "fa-IR",
  direction: "rtl",
  tags: [...new Set([...(bookPackage.book.tags || []), "persian"])]
};
bookPackage.theme.tokens["font.body"] = "Tahoma, Arial, sans-serif";

for (const [assetId, alt] of Object.entries(translations.assets || {})) {
  const asset = bookPackage.assets.find((candidate) => candidate.id === assetId);
  if (asset) asset.alt = alt;
}

for (const [entryId, localizedEntry] of Object.entries(translations.entries || {})) {
  const entry = bookPackage.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error(`Unknown translated entry: ${entryId}`);
  entry.title = localizedEntry.title;
  for (const [blockIndex, localizedFields] of Object.entries(localizedEntry.blocks || {})) {
    const block = entry.blocks[Number(blockIndex)];
    if (!block) throw new Error(`Missing ${entryId} block ${blockIndex}`);
    Object.assign(block, localizedFields);
  }
}

const missing = [];
for (const asset of bookPackage.assets) {
  if (!translations.assets?.[asset.id]) missing.push(`asset ${asset.id}`);
}
for (const entry of bookPackage.entries) {
  const localizedEntry = translations.entries?.[entry.id];
  if (!localizedEntry) {
    missing.push(`entry ${entry.id}`);
    continue;
  }
    if (!localizedEntry.title) missing.push(`title ${entry.id}`);
    entry.blocks.forEach((block, index) => {
    const fields = ["text", "title", "items", "columns", "rows"].filter((key) => key in block && !(key === "items" && block.items.every((item) => typeof item === "object")));
    for (const field of fields) {
      const localized = localizedEntry.blocks?.[index]?.[field];
      if (localized === undefined) missing.push(`${entry.id} block ${index} ${field}`);
    }
  });
}
if (missing.length) {
  console.error(`Persian translation is incomplete (${missing.length} fields remain).`);
  console.error(missing.slice(0, 30).join("\n"));
  process.exitCode = 1;
} else {
  fs.writeFileSync(outputPath, `${JSON.stringify(bookPackage, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(projectRoot, outputPath)} with ${bookPackage.entries.length} entries.`);
}

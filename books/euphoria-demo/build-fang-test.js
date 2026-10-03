const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..", "..");
const sourcePath = path.join(projectRoot, "Test text", "Euphoria Demo.txt");
const configPath = path.join(__dirname, "conversion.json");
const packagePath = path.join(__dirname, "book-fa.json");
const outputPath = path.join(__dirname, "book-fa-fang-test.json");
const appSource = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
const source = fs.readFileSync(sourcePath, "utf8");
const sourceHash = crypto.createHash("sha256").update(source).digest("hex");
const bookPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));

if (bookPackage.source?.sourceHash !== sourceHash) {
  throw new Error("The Persian package was not built from the current Euphoria Demo source.");
}

const context = {
  document: { addEventListener() {}, querySelector() { return null; } },
  console,
  setTimeout,
  clearTimeout,
  URL,
  Blob
};
vm.runInNewContext(`${appSource}\nglobalThis.bookMakerFunctions = { parseDocument, buildBookPackage };`, context);

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const maker = context.bookMakerFunctions;
const parsed = maker.parseDocument(source, config);
const sourcePackage = maker.buildBookPackage(source, "Euphoria Demo.txt", parsed, config);
const sourceEntry = sourcePackage.entries.find((entry) => entry.id === "the-fang-2");
const translatedEntry = bookPackage.entries.find((entry) => entry.id === "the-fang-2");

if (!sourceEntry || !translatedEntry || sourceEntry.blocks.length !== translatedEntry.blocks.length) {
  throw new Error("Could not safely pair the source and translated Fang entry blocks.");
}

const isPersianLetter = (character) => character !== undefined && /[\p{L}\p{M}\u200c]/u.test(character);
function transliterateNamedFang(text) {
  return text.replace(/نیش/gu, (match, offset, original) => {
    const before = [...original.slice(0, offset)].at(-1);
    const after = [...original.slice(offset + match.length)][0];
    return isPersianLetter(before) || isPersianLetter(after) ? match : "فنگ";
  });
}

function alignAndRevise(sourceValue, translatedValue) {
  if (typeof sourceValue === "string" && typeof translatedValue === "string") {
    let revised = translatedValue;
    if (/\bThe Fang(?:[’']s)?\b/i.test(sourceValue)) {
      revised = transliterateNamedFang(revised);
    }
    if (/\bSilver Fang\b/i.test(sourceValue)) {
      revised = revised.replace(/نیش سیمین/gu, "سیلور فنگ");
    }
    return revised;
  }
  if (Array.isArray(sourceValue) && Array.isArray(translatedValue)) {
    if (sourceValue.length !== translatedValue.length) throw new Error("Source and translated list structures differ.");
    return translatedValue.map((value, index) => alignAndRevise(sourceValue[index], value));
  }
  if (sourceValue && translatedValue && typeof sourceValue === "object" && typeof translatedValue === "object") {
    const revised = { ...translatedValue };
    for (const [key, sourceChild] of Object.entries(sourceValue)) {
      if (!(key in translatedValue)) continue;
      revised[key] = alignAndRevise(sourceChild, translatedValue[key]);
    }
    return revised;
  }
  return translatedValue;
}

translatedEntry.blocks = sourceEntry.blocks.map((block, index) => {
  if (block.type !== translatedEntry.blocks[index].type) {
    throw new Error(`Source and translated block ${index} have different types.`);
  }
  return alignAndRevise(block, translatedEntry.blocks[index]);
});
translatedEntry.title = "فنگ";
translatedEntry.order = 0;

const assetIds = new Set();
function collectAssetIds(value) {
  if (!value || typeof value !== "object") return;
  if (typeof value.assetId === "string") assetIds.add(value.assetId);
  if (Array.isArray(value.assetIds)) value.assetIds.forEach((id) => assetIds.add(id));
  if (Array.isArray(value)) value.forEach(collectAssetIds);
  else Object.values(value).forEach(collectAssetIds);
}
collectAssetIds(translatedEntry.blocks);
const assetsById = new Map(bookPackage.assets.map((asset) => [asset.id, asset]));
const missingAssets = [...assetIds].filter((id) => !assetsById.has(id));
if (missingAssets.length) throw new Error(`Missing entry assets: ${missingAssets.join(", ")}`);

const testPackage = {
  ...bookPackage,
  book: {
    ...bookPackage.book,
    id: "euphoria-demo-fang-fa-test",
    title: "دموی یوفوریا — فنگ (آزمون ترجمه)",
    description: "نمونهٔ آزمایشیِ ترجمهٔ فارسی و راست‌به‌چپ برای مدخل فنگ.",
    tags: [...new Set([...(bookPackage.book.tags || []), "translation-test"])]
  },
  assets: bookPackage.assets.filter((asset) => assetIds.has(asset.id)),
  entries: [translatedEntry]
};

if (testPackage.book.language !== "fa-IR" || testPackage.book.direction !== "rtl") {
  throw new Error("The test package must be marked as Persian and right-to-left.");
}

fs.writeFileSync(outputPath, `${JSON.stringify(testPackage, null, 2)}\n`, "utf8");
console.log(`Wrote ${path.relative(projectRoot, outputPath)}: 1 entry, ${translatedEntry.blocks.length} blocks, ${testPackage.assets.length} assets, fa-IR/rtl.`);

const SOURCE_PATH = encodeURI("Test text/Euphoria Demo.txt");
const CONFIG_PATH = "books/euphoria-demo/conversion.json";

const state = {
  source: "",
  config: {},
  bookPackage: null,
  entries: [],
  currentPage: 0,
  search: "",
  sourceTheme: null,
  paletteMode: "source"
};

const $ = (selector) => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", () => {
  $("#previousButton").addEventListener("click", () => goToPage(state.currentPage - 1));
  $("#nextButton").addEventListener("click", () => goToPage(state.currentPage + 1));
  $("#searchInput").addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderContents();
  });
  $("#mdInput").addEventListener("change", loadSelectedMarkdown);
  $("#jsonInput").addEventListener("change", loadSelectedJson);
  $("#exportButton").addEventListener("click", exportBookJson);
  $("#themePreset")?.addEventListener("change", applySelectedTheme);
  $("#paletteColorControls")?.addEventListener("input", handlePaletteInput);
  $("#paletteColorControls")?.addEventListener("change", handleInvalidPaletteValue);
  $("#sourceToggle").addEventListener("click", () => {
    const sourceSlice = $("#sourceSlice");
    sourceSlice.hidden = !sourceSlice.hidden;
    $("#sourceToggle").textContent = sourceSlice.hidden ? "Show JSON entry" : "Hide JSON entry";
  });
  loadSource();
});

async function loadSource() {
  try {
    const [sourceResponse, configResponse] = await Promise.all([fetch(SOURCE_PATH, { cache: "no-cache" }), fetch(CONFIG_PATH, { cache: "no-cache" })]);
    if (!sourceResponse.ok || !configResponse.ok) throw new Error("Could not load the demo source or its conversion profile.");
    loadDocument(await sourceResponse.text(), "Euphoria Demo.txt", await configResponse.json());
  } catch (error) {
    setStatus("Import a Markdown file to begin");
    showNotice("The demo source could not be loaded automatically. Choose the Markdown file with Import Markdown.");
  }
}

function loadSelectedMarkdown(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  const config = file.name.toLowerCase() === "euphoria demo.txt" ? state.config : standardConversionConfig();
  reader.addEventListener("load", () => loadDocument(String(reader.result), file.name, config));
  reader.readAsText(file);
}

function standardConversionConfig() {
  return {
    format: "ttrpg-book-conversion",
    version: 1,
    rules: {
      entryHeadingLevel: 2,
      pageBreaks: "ignore",
      images: { defaultPlacement: "inline", ignorePositioning: true, ignoredAlt: ["background", "menu", "nameBanner"], ignoredSourcePatterns: ["background", "transparent"] }
    },
    overrides: []
  };
}

function loadSelectedJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const bookPackage = JSON.parse(String(reader.result));
      validateBookPackage(bookPackage);
      state.sourceTheme = bookPackage.theme;
      state.paletteMode = "custom";
      loadPackage(bookPackage, file.name);
    } catch (error) {
      showNotice(`Could not load this book JSON: ${error.message}`);
    }
  });
  reader.readAsText(file);
}

function loadDocument(source, fileName, config = {}) {
  const parsed = parseDocument(source, config);
  state.sourceTheme = themeFromCss(parsed.css);
  state.paletteMode = "source";
  const bookPackage = buildBookPackage(source, fileName, parsed, config);
  loadPackage(bookPackage, fileName, source, config);
}

function loadPackage(bookPackage, fileName, source = "", config = {}) {
  state.bookPackage = bookPackage;
  state.entries = bookPackage.entries || [];
  state.source = source;
  state.config = config;
  if (!state.sourceTheme) state.sourceTheme = bookPackage.theme;
  state.currentPage = 0;
  applyPackageMeta(bookPackage);
  renderContents();
  renderPage();
  setStatus(`Loaded ${fileName}`);
  $("#exportButton").disabled = false;
}

function parseDocument(source, config = {}) {
  const metadataMatch = source.match(/```metadata\s*([\s\S]*?)```/i);
  const cssMatch = source.match(/```css\s*([\s\S]*?)```/i);
  const metadata = parseMetadata(metadataMatch?.[1] || "");
  const bodyStart = cssMatch ? cssMatch.index + cssMatch[0].length : (metadataMatch ? metadataMatch.index + metadataMatch[0].length : 0);
  const body = source.slice(bodyStart).trim();
  const pageBreaks = (body.match(/\\page\b/g) || []).length;
  const entries = buildEntries(body, config);
  const allBody = body.replace(/\\page\b/g, "\n");
  const imageMatches = [...allBody.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)];
  const keptImages = imageMatches.filter((match) => !shouldIgnoreImage(match[1], match[2], config)).length;
  return { metadata, css: cssMatch?.[1] || "", entries, pageBreaks, images: keptImages, tables: (allBody.match(/\{\{fancyTable\b/gi) || []).length, directives: (allBody.match(/\{\{[^\n}]*/g) || []).length };
}

function buildEntries(body, config = {}) {
  const withoutPageBreaks = body.replace(/\\page\b/g, "\n");
  const entryLevel = config.rules?.entryHeadingLevel || config.entryHeadingLevel || 2;
  const entryPrefix = "#".repeat(entryLevel);
  const headingMatches = [...withoutPageBreaks.matchAll(new RegExp(`^${entryPrefix}\\s+(.+)$`, "gm"))];
  if (!headingMatches.length) return [createEntry(withoutPageBreaks, 0, config)];
  const entries = [];
  const preamble = withoutPageBreaks.slice(0, headingMatches[0].index).trim();
  if (preamble) entries.push({ ...createEntry(preamble, 0, config), title: "Welcome" });
  headingMatches.forEach((match, index) => {
    const start = match.index;
    const end = headingMatches[index + 1]?.index ?? withoutPageBreaks.length;
    entries.push(createEntry(withoutPageBreaks.slice(start, end), entries.length, config));
  });
  return entries;
}

function createEntry(raw, index, config = {}) {
  const normalized = cleanSource(applyConversionRules(raw, config));
  const headings = [...normalized.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({ level: match[1].length, text: stripMarkup(match[2]) }));
  const firstHeading = headings.find((heading) => heading.level <= 3);
  const imageAlt = normalized.match(/!\[([^\]]+)\]/)?.[1];
  let title = firstHeading?.text || (index === 0 ? "Cover" : imageAlt || `Entry ${index + 1}`);
  if (index === 1 && !firstHeading) title = "Inside cover";
  return { raw, normalized, headings, title };
}

function buildBookPackage(source, fileName, parsed, config = {}) {
  const assets = new Map();
  const entries = parsed.entries.map((entry, index) => ({ id: `${slugify(entry.title) || "entry"}-${index + 1}`, title: entry.title, order: index, blocks: markdownToBlocks(entry.normalized, config, assets) }));
  const metadata = parsed.metadata;
  return {
    format: "ttrpg-book",
    schemaVersion: 1,
    book: { id: slugify(metadata.title) || "untitled-book", title: metadata.title, description: metadata.description || "Imported Homebrewery Markdown book.", version: "0.1.0", tags: ["homebrewery-import"] },
    source: { format: "homebrewery-markdown", fileName },
    conversion: { entryHeadingLevel: config.rules?.entryHeadingLevel || 2, pageBreaks: config.rules?.pageBreaks || "ignore", imagePolicy: { defaultPlacement: config.rules?.images?.defaultPlacement || "inline", ignoredRoles: ["background", "page-overlay", "menu", "decorative-banner"], ignorePositioning: config.rules?.images?.ignorePositioning !== false } },
    theme: themeFromCss(parsed.css),
    assets: [...assets.values()],
    entries
  };
}

function defaultTheme() {
  return {
    tokens: { "color.background": "#f5ead2", "color.backgroundLight": "#fbf4e5", "color.surface": "#efe0c0", "color.primary": "#6f2637", "color.primaryDark": "#4d1a25", "color.accent": "#b68a3d", "color.accentLight": "#d9b86c", "color.accentDark": "#7a5927", "color.secondary": "#5d466f", "color.text": "#4a3825", "color.textMuted": "#7a6143", "color.border": "#c8a463", "color.hover": "#f8efd8", "font.body": "Georgia, serif", "font.ui": "Inter, sans-serif" },
    decorations: { parchmentTexture: true, ornamentalFrames: true, ornamentalDividers: true, tableHeaderStyle: "wine", imageCaptionStyle: "italic-muted" }
  };
}

function themeFromCss(css) {
  const theme = defaultTheme();
  const variableMap = { bg: "color.background", "bg-light": "color.backgroundLight", card: "color.surface", gold: "color.accent", "gold-light": "color.accentLight", "gold-dark": "color.accentDark", wine: "color.primary", "wine-dark": "color.primaryDark", plum: "color.secondary", text: "color.text", "text-light": "color.textMuted", border: "color.border", hover: "color.hover" };
  [...css.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/gi)].forEach((match) => {
    const token = variableMap[match[1].toLowerCase()];
    if (token) theme.tokens[token] = match[2].trim();
  });
  return theme;
}

function markdownToBlocks(source, config, assets) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    if (line === "<!--COLUMN_BREAK-->") { blocks.push({ type: "divider", style: "column-break" }); index += 1; continue; }
    if (/^<div class=['"]video-section['"]>/i.test(line)) { blocks.push(parseVideoBlock(line)); index += 1; continue; }
    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)(?:\{([^}]*)\})?$/);
    if (image) {
      const [, alt, url] = image;
      const rule = findImageRule(alt, url, config);
      if (!shouldIgnoreImage(alt, url, config) && rule?.action !== "ignore") {
        const assetId = getAssetId(alt, url, assets);
        blocks.push({ type: "image", assetId, role: imageRole(alt), placement: rule?.location || "inline", className: rule?.className, width: rule?.width });
      }
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) { blocks.push({ type: "heading", level: heading[1].length, text: stripMarkup(heading[2]) }); index += 1; continue; }
    if (/^\|.*\|$/.test(line)) {
      const tableLines = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index].trim())) tableLines.push(lines[index++].trim());
      blocks.push(tableBlock(tableLines));
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index].trim())) items.push(lines[index++].trim().replace(/^[-*]\s+/, ""));
      blocks.push({ type: "list", items });
      continue;
    }
    if (/^---+$/.test(line)) { blocks.push({ type: "divider", style: "rule" }); index += 1; continue; }
    if (/^<[^>]+>/.test(line)) { index += 1; continue; }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isStructuralLine(lines[index].trim())) paragraph.push(lines[index++].trim());
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function getAssetId(alt, url, assets) {
  const baseId = slugify(alt) || `asset-${assets.size + 1}`;
  let id = baseId;
  let suffix = 2;
  while (assets.has(id) && assets.get(id).src !== url) id = `${baseId}-${suffix++}`;
  if (!assets.has(id)) assets.set(id, { id, src: url, alt: alt || id, role: imageRole(alt) });
  return id;
}

function imageRole(alt) {
  const label = alt.toLowerCase();
  if (label.includes("emblem")) return "emblem";
  if (label.includes("npc") || label.includes("owner") || label.includes("bartender")) return "portrait";
  if (label.includes("artifact")) return "artifact";
  if (label.includes("location") || label.includes("hub")) return "location";
  return "illustration";
}

function tableBlock(lines) {
  const rows = lines.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  return { type: "table", columns: rows[0] || [], rows: rows.slice(2).filter((row) => row.some(Boolean)) };
}

function parseVideoBlock(line) {
  const title = line.match(/<h2>(.*?)<\/h2>/i)?.[1] || "Video resources";
  const items = [...line.matchAll(/<a href=['"]([^'"]+)['"][^>]*>\s*<img src=['"]([^'"]+)['"]/gi)].map((match) => ({ url: match[1], thumbnail: match[2] }));
  return { type: "embed", kind: "video-grid", title, items };
}

function applyConversionRules(source, config) {
  const lines = source.split(/\r?\n/);
  const moved = [];
  const kept = lines.filter((line) => {
    const image = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)(?:\{[^}]*\})?$/);
    if (!image) return true;
    const rule = findImageRule(image[1], image[2], config);
    if (rule?.action === "ignore") return false;
    if (rule?.action === "move") { moved.push(line); return false; }
    return true;
  });
  if (!moved.length) return kept.join("\n");
  const location = findImageRule(extractImageAlt(moved[0]), "", config)?.location;
  if (["entry-top", "entry-top-right"].includes(location)) {
    const level = config.rules?.entryHeadingLevel || 2;
    const headingIndex = kept.findIndex((line) => new RegExp(`^${"#".repeat(level)}\\s+`).test(line.trim()));
    kept.splice(headingIndex < 0 ? 0 : headingIndex + 1, 0, "", ...moved, "");
  } else kept.push("", ...moved);
  return kept.join("\n");
}

function findImageRule(alt, url, config = {}) {
  const rules = config.overrides || config.images || [];
  return rules.find((rule) => {
    const match = rule.match || {};
    const altMatches = match.alt ? (Array.isArray(match.alt) ? match.alt : [match.alt]).some((value) => value.toLowerCase() === alt.trim().toLowerCase()) : true;
    const urlMatches = match.urlIncludes ? url.toLowerCase().includes(match.urlIncludes.toLowerCase()) : true;
    return altMatches && urlMatches;
  });
}

function extractImageAlt(line) { return line.match(/^!\[([^\]]*)\]/)?.[1] || ""; }

function cleanSource(source) {
  return source.replace(/^\s*\{\{[^\n]*\}\}\s*$/gm, "").replace(/^\s*\{\{[^\n]*$/gm, "").replace(/^\s*\}\}\s*$/gm, "").replace(/^\s*\{font-size:[^}]+\}\s*$/gm, "").replace(/\{\{width:\d+px\}\}/g, "").replace(/^\s*:{1,}\s*$/gm, "").replace(/^\s*\|+\s*$/gm, "").replace(/^\s*\\column\s*$/gm, "\n<!--COLUMN_BREAK-->\n").replace(/^\s*:{4,}\s*$/gm, "").trim();
}

function shouldIgnoreImage(alt, url, config = {}) {
  const label = alt.trim().toLowerCase();
  const source = url.toLowerCase();
  const configuredIgnore = findImageRule(alt, url, config)?.action === "ignore";
  const ignoredAlt = config.rules?.images?.ignoredAlt || [];
  const ignoredPatterns = config.rules?.images?.ignoredSourcePatterns || [];
  return configuredIgnore || ignoredAlt.some((value) => value.toLowerCase() === label) || ignoredPatterns.some((value) => source.includes(value.toLowerCase())) || ["background", "menu", "namebanner"].includes(label) || /(?:background|transparent)\.(?:webp|png|jpe?g)(?:\?|$)/i.test(source);
}

function renderPackageBlock(block, assets, entryIndex, blockIndex) {
  if (block.type === "heading") { const level = Math.min(Math.max(block.level, 2), 5); const id = level === 3 ? ` id="entry-${entryIndex}-section-${blockIndex}"` : ""; return `<h${level}${id}>${inlineMarkdown(block.text)}</h${level}>`; }
  if (block.type === "paragraph") return `<p${block.style ? ` class="${escapeAttribute(block.style)}"` : ""}>${inlineMarkdown(block.text)}</p>`;
  if (block.type === "list") return `<ul>${block.items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`;
  if (block.type === "table") return `<table><thead><tr>${block.columns.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  if (block.type === "divider") return `<div class="column-marker" aria-hidden="true"></div>`;
  if (block.type === "image") {
    const asset = assets.find((candidate) => candidate.id === block.assetId);
    if (!asset) return "";
    const semanticClass = block.role === "emblem" ? " entry-emblem" : "";
    const placementClass = block.placement === "entry-top-right" ? " entry-emblem--top-right" : "";
    const customClass = block.className ? ` ${block.className.replace(/[^a-z0-9_-]/gi, "")}` : "";
    const className = `${semanticClass}${placementClass}${customClass}`;
    const width = block.width ? ` style="width:${escapeAttribute(block.width)}"` : "";
    return `<figure class="page-art page-art--flow${className}"${width}><span class="image-frame"><img src="${escapeAttribute(asset.src)}" alt="${escapeAttribute(asset.alt)}" aria-haspopup="dialog" aria-label="View larger image: ${escapeAttribute(asset.alt)}" data-image-viewer tabindex="0" loading="lazy"></span><figcaption>${inlineMarkdown(asset.alt)}</figcaption></figure>`;
  }
  if (block.type === "embed" && block.kind === "video-grid") return `<section><h3>${inlineMarkdown(block.title)}</h3><div class="video-grid">${block.items.map((item, index) => `<a class="video-card" href="${escapeAttribute(item.url)}" target="_blank" rel="noreferrer"><span class="image-frame image-frame--wide"><img src="${escapeAttribute(item.thumbnail)}" alt="${escapeAttribute(block.title)} video ${index + 1}" aria-haspopup="dialog" aria-label="View larger image: ${escapeAttribute(block.title)} video ${index + 1}" data-image-viewer tabindex="0" loading="lazy"></span><span class="video-card-caption">Watch ${escapeHtml(block.title)} video ${index + 1} ↗</span></a>`).join("")}</div></section>`;
  return "";
}

function renderContents() {
  const contents = $("#contents");
  const filtered = state.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) => !state.search || `${entry.title} ${JSON.stringify(entry.blocks)}`.toLowerCase().includes(state.search));
  contents.innerHTML = filtered.map(({ entry, index }) => {
    const active = index === state.currentPage;
    const subsections = active ? entry.blocks.map((block, blockIndex) => ({ block, blockIndex })).filter(({ block }) => block.type === "heading" && Number(block.level) === 3) : [];
    const subitems = subsections.length ? `<div class="contents-subtree" role="group" aria-label="${escapeAttribute(entry.title)} sections">${subsections.map(({ block, blockIndex }) => `<a class="contents-subitem" data-section="entry-${index}-section-${blockIndex}" href="#entry-${index}-section-${blockIndex}"><span class="page-no">H3</span><span class="page-title">${inlineMarkdown(block.text)}</span></a>`).join("")}</div>` : "";
    return `<div class="contents-entry"><button type="button" class="${active ? "active" : ""}"${active ? ' aria-current="page"' : ""} data-page="${index}"><span class="page-no">H2</span><span class="page-title">${escapeHtml(entry.title)}</span></button>${subitems}</div>`;
  }).join("") || '<p class="empty-search">No matching entries.</p>';
  contents.querySelectorAll("button[data-page]").forEach((button) => button.addEventListener("click", () => goToPage(Number(button.dataset.page))));
  contents.querySelectorAll("a[data-section]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    document.getElementById(link.dataset.section)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("#contentsCount").textContent = `${filtered.length}/${state.entries.length}`;
}

function renderPage() {
  const entry = state.entries[state.currentPage];
  if (!entry || !state.bookPackage) return;
  const html = entry.blocks.map((block, blockIndex) => renderPackageBlock(block, state.bookPackage.assets, state.currentPage, blockIndex)).join("\n");
  $("#pageViewport").innerHTML = `<article class="book-page"><div class="page-inner"><div class="page-content">${html}</div></div><span class="page-number">${String(state.currentPage + 1).padStart(2, "0")}</span></article>`;
  $("#currentPage").textContent = state.currentPage + 1;
  $("#totalPages").textContent = state.entries.length;
  $("#currentLabel").textContent = entry.title;
  $("#previousButton").disabled = state.currentPage === 0;
  $("#nextButton").disabled = state.currentPage === state.entries.length - 1;
  $("#sourceSlice").textContent = JSON.stringify(entry, null, 2);
  renderContents();
}

function goToPage(index) {
  if (index < 0 || index >= state.entries.length) return;
  state.currentPage = index;
  renderPage();
  $(".reader-stage").scrollTo({ top: 0, behavior: "smooth" });
}

function applyPackageMeta(bookPackage) {
  const blockCount = bookPackage.entries.reduce((sum, entry) => sum + entry.blocks.length, 0);
  $("#bookTitle").textContent = bookPackage.book.title;
  $("#bookDescription").textContent = bookPackage.book.description || "Imported TTRPG book package.";
  $("#themeLabel").textContent = `JSON v${bookPackage.schemaVersion}`;
  $("#pageCount").textContent = `${bookPackage.entries.length} entries`;
  $("#totalPages").textContent = bookPackage.entries.length;
  $("#statPages").textContent = bookPackage.entries.length;
  $("#statImages").textContent = bookPackage.assets.filter((asset) => !asset.ignored).length;
  $("#statTables").textContent = bookPackage.entries.reduce((sum, entry) => sum + entry.blocks.filter((block) => block.type === "table").length, 0);
  $("#statDirectives").textContent = blockCount;
  applyTheme(bookPackage.theme);
  renderThemeControls(bookPackage.theme, state.sourceTheme || bookPackage.theme);
  document.title = `${bookPackage.book.title} · Content Reader`;
}

const THEME_PRESETS = {
  classic: () => defaultTheme(),
  midnight: () => ({ ...defaultTheme(), tokens: { ...defaultTheme().tokens, "color.background": "#21191d", "color.backgroundLight": "#302027", "color.surface": "#3b252d", "color.primary": "#d9b86c", "color.primaryDark": "#f4dfb6", "color.accent": "#b68a3d", "color.text": "#f6e8d2", "color.textMuted": "#cfb7a1", "color.border": "#7d5360" } }),
  ember: () => ({ ...defaultTheme(), tokens: { ...defaultTheme().tokens, "color.background": "#f1dfc4", "color.backgroundLight": "#fff5e4", "color.surface": "#ead0a7", "color.primary": "#9b3f24", "color.primaryDark": "#652516", "color.accent": "#c16a2d", "color.accentLight": "#e2a65d", "color.text": "#4b2b20", "color.textMuted": "#86614d", "color.border": "#c78e54" } })
};

const PALETTE_FIELDS = [
  ["color.background", "Page"],
  ["color.backgroundLight", "Light page"],
  ["color.surface", "Surface"],
  ["color.primary", "Primary"],
  ["color.primaryDark", "Dark primary"],
  ["color.accent", "Accent"],
  ["color.accentLight", "Light accent"],
  ["color.accentDark", "Dark accent"],
  ["color.secondary", "Secondary"],
  ["color.text", "Text"],
  ["color.textMuted", "Muted text"],
  ["color.border", "Border"],
  ["color.hover", "Hover"]
];

function cloneTheme(theme) { return JSON.parse(JSON.stringify(theme || defaultTheme())); }

function applySelectedTheme() {
  if (!state.bookPackage) return;
  const selected = $("#themePreset")?.value || "source";
  state.paletteMode = selected;
  if (selected === "source") state.bookPackage.theme = cloneTheme(state.sourceTheme || defaultTheme());
  else if (THEME_PRESETS[selected]) state.bookPackage.theme = THEME_PRESETS[selected]();
  applyTheme(state.bookPackage.theme);
  renderThemeControls(state.bookPackage.theme, state.sourceTheme || defaultTheme());
  renderPage();
  const label = selected === "source" ? "source CSS" : selected === "custom" ? "custom" : selected;
  showNotice(`Applied ${label} palette. Export JSON to save it.`);
}

function renderThemeControls(theme, sourceTheme) {
  const preset = $("#themePreset");
  if (!preset) return;
  preset.value = state.paletteMode;
  const sourceTokens = sourceTheme?.tokens || {};
  const activeTokens = theme?.tokens || {};
  const swatches = ["color.background", "color.primary", "color.accent", "color.text"];
  renderThemeSwatches(activeTokens, swatches);
  $("#cssTokenCount").textContent = `${Object.keys(sourceTokens).filter((token) => token.startsWith("color.")).length} CSS colors`;
  $("#themeNote").textContent = state.paletteMode === "source"
    ? "Image frames follow Accent. Use the controls below to customize this source palette."
    : state.paletteMode === "custom"
      ? "Image frames follow Accent. Pick a color or enter a CSS color value; changes save in the book JSON."
      : "Using a Maker preset. Image frames follow its Accent color; adjust any color below.";
  $("#paletteColorControls").innerHTML = PALETTE_FIELDS.map(([token, label]) => {
    const value = String(activeTokens[token] || defaultTheme().tokens[token] || "#000000");
    const pickerValue = colorInputHex(value, defaultTheme().tokens[token] || "#000000");
    return `<label class="palette-color-field"><span>${label}</span><span class="palette-color-inputs"><input type="color" data-palette-picker="${token}" value="${escapeAttribute(pickerValue)}" aria-label="Choose ${label} color"><input type="text" data-palette-value="${token}" value="${escapeAttribute(value)}" spellcheck="false" aria-label="${label} color value"></span></label>`;
  }).join("");
}

function renderThemeSwatches(tokens, swatches = ["color.background", "color.primary", "color.accent", "color.text"]) {
  $("#themeSwatches").innerHTML = swatches.map((token) => `<span class="theme-swatch" title="${escapeAttribute(token)}" style="background:${escapeAttribute(tokens[token] || "transparent")}"></span>`).join("");
}

function colorInputHex(value, fallback) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return /^#[\da-f]{6}$/i.test(value) ? value : fallback;
  context.fillStyle = fallback;
  context.fillStyle = String(value);
  const normalized = context.fillStyle;
  if (/^#[\da-f]{6}$/i.test(normalized)) return normalized;
  const rgb = normalized.match(/^rgba?\((\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/i);
  return rgb ? `#${rgb.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}` : fallback;
}

function handlePaletteInput(event) {
  if (!state.bookPackage) return;
  const picker = event.target.closest("input[data-palette-picker]");
  const text = event.target.closest("input[data-palette-value]");
  const control = picker || text;
  if (!control) return;
  const token = picker ? picker.dataset.palettePicker : text.dataset.paletteValue;
  const value = control.value.trim();
  if (!isValidCssColor(value)) return;
  const colorPicker = $(`[data-palette-picker="${token}"]`);
  const colorText = $(`[data-palette-value="${token}"]`);
  if (picker) colorText.value = value;
  else colorPicker.value = colorInputHex(value, defaultTheme().tokens[token] || "#000000");
  state.paletteMode = "custom";
  $("#themePreset").value = "custom";
  state.bookPackage.theme.tokens[token] = value;
  applyTheme(state.bookPackage.theme);
  renderThemeSwatches(state.bookPackage.theme.tokens);
  $("#themeNote").textContent = "Image frames follow Accent. Pick a color or enter a CSS color value; changes save in the book JSON.";
  renderPage();
}

function handleInvalidPaletteValue(event) {
  const text = event.target.closest("input[data-palette-value]");
  if (!text || isValidCssColor(text.value.trim()) || !state.bookPackage) return;
  renderThemeControls(state.bookPackage.theme, state.sourceTheme || defaultTheme());
}

function isValidCssColor(value) {
  return Boolean(value) && (window.CSS?.supports?.("color", value) || /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value));
}

function applyTheme(theme = {}) {
  const root = document.documentElement;
  const aliases = { "color.background": "--parchment", "color.backgroundLight": "--parchment-light", "color.surface": "--card", "color.primary": "--wine", "color.primaryDark": "--wine-dark", "color.accent": "--gold", "color.accentLight": "--gold-light", "color.accentDark": "--gold-dark", "color.secondary": "--plum", "color.text": "--ink", "color.textMuted": "--ink-soft", "color.border": "--border", "color.hover": "--hover", "font.body": "--book-body-font", "font.ui": "--book-ui-font" };
  Object.entries(theme.tokens || {}).forEach(([token, value]) => { if (aliases[token]) root.style.setProperty(aliases[token], value); });
}

function exportBookJson() {
  if (!state.bookPackage) return;
  const blob = new Blob([JSON.stringify(state.bookPackage, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.bookPackage.book.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotice(`Exported ${link.download}`);
}

function validateBookPackage(bookPackage) {
  if (!bookPackage || bookPackage.format !== "ttrpg-book") throw new Error("The file is not a ttrpg-book package.");
  if (!Number.isInteger(bookPackage.schemaVersion)) throw new Error("The package is missing schemaVersion.");
  if (!bookPackage.book?.title || !Array.isArray(bookPackage.entries) || !Array.isArray(bookPackage.assets)) throw new Error("The package is missing book, entries, or assets.");
}

function parseMetadata(block) {
  const get = (key) => block.match(new RegExp(`^${key}:\\s*(.*)$`, "mi"))?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "";
  return { title: get("title") || "Untitled book", description: get("description"), theme: get("theme") || "Homebrewery" };
}

function isStructuralLine(line) { return /^(#{1,6})\s+/.test(line) || /^!\[/.test(line) || /^\|.*\|$/.test(line) || /^[-*]\s+/.test(line) || line === "<!--COLUMN_BREAK-->" || /^<div\b/i.test(line) || /^---+$/.test(line); }
function setStatus(message) { $("#sourceStatus").innerHTML = `<i></i> ${escapeHtml(message)}`; }
function showNotice(message) { const notice = $("#notice"); notice.textContent = message; notice.hidden = false; setTimeout(() => { notice.hidden = true; }, 8000); }
function stripMarkup(value) { return value.replace(/[*_`]/g, "").replace(/\{\{[^}]+\}\}/g, "").trim(); }
function slugify(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function inlineMarkdown(value) { let html = escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>"); html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>"); return html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1 ↗</a>'); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char])); }
function escapeAttribute(value) { return escapeHtml(value); }

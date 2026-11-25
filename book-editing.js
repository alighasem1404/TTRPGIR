(() => {
  const dialog = $("#bookEditing");
  const form = $("#bookEditingForm");
  const fields = $("#bookEditingFields");
  const message = $("#bookEditingStatus");
  const toggle = $("#toggleBookEditing");
  const editLabels = new Map([["paragraph", "Edit text"], ["heading", "Edit heading"], ["image", "Edit image"],
    ["table", "Edit table"], ["list", "Edit bullet list"], ["link", "Edit link"]]);
  let action;
  let order;
  let hiddenSections;
  let active = false;
  let releaseImagePreview;
  let draggedOrder;
  const replacementHistory = [];

  window.bookEditing = { reset, wrapBlock, exportPackage, clearReplacementHistory, get active() { return active; } };
  reset();
  toggle.addEventListener("click", () => {
    active = !active;
    toggle.setAttribute("aria-pressed", String(active));
    toggle.textContent = active ? "Done editing" : "Edit preview";
    renderPage();
  });
  $("#pageViewport").addEventListener("click", (event) => {
    const button = event.target.closest("[data-book-edit], [data-book-add]");
    if (button) {
      const { bookEdit, bookAdd } = button.dataset;
      const index = Number(bookEdit ?? bookAdd);
      const type = bookEdit === undefined ? null : currentEntry().blocks[index]?.type;
      if (type === "image") editImage(index);
      else if (type === "table" || type === "list") editStructuredBlock(type, index);
      else editText(index, bookEdit === undefined);
      return;
    }
    if (!active || event.target.closest("a, button, input")) return;
    const card = event.target.closest("[data-edit-block]");
    if (card) {
      event.stopPropagation();
      card.querySelector("[data-book-edit]")?.click();
    }
  });
  $("#organizeBook").addEventListener("click", organizeBook);
  $("#editSectionRules").addEventListener("click", editSectionRules);
  $("#reviewSourceItems").addEventListener("click", reviewSourceItems);
  $("#replaceBookText").addEventListener("click", findAndReplace);
  $("#undoBookReplacement").addEventListener("click", undoReplacement);
  $("#setImageCaptions").addEventListener("click", setImageCaptions);
  $("#exportEdition").addEventListener("change", updateExportLabel);
  dialog.addEventListener("close", () => { if (!dialog.open) releaseImagePreview?.(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const current = action;
    const button = event.submitter || form.querySelector('button[type="submit"]');
    if (!current || !button || button.disabled) return;
    button.disabled = true;
    message.textContent = "";
    try {
      await current(button.value, () => action === current && dialog.open);
    } catch (error) {
      if (action === current && dialog.open) message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  function reset() {
    action = null;
    if (dialog.open) dialog.close();
    active = false;
    toggle.setAttribute("aria-pressed", "false");
    toggle.textContent = "Edit preview";
    order = [];
    hiddenSections = new Set();
    clearReplacementHistory();
    $("#exportEdition").value = "full";
  }

  function currentEntry() { return state.entries[state.currentPage]; }

  function setImageCaptions() {
    if (!state.bookPackage) return;
    open("Image captions", `
      <label>Caption source <select name="captionSource"><option value="heading">H2 of each entry</option><option value="mapping">Import URL and caption lists</option></select></label>
      <div id="captionMapping" class="book-edit-grid" hidden>
        <label>Image URLs — one per line<textarea name="captionUrls" rows="8" dir="auto" spellcheck="false"></textarea></label>
        <label>Corresponding captions — one per line<textarea name="captionValues" rows="8" dir="auto"></textarea></label>
      </div>
      <p>Applies across the book. URL line 1 pairs with caption line 1, URL line 2 with caption line 2, and so on.</p>
      <p id="captionSummary" role="status"></p>
      <ul id="captionExamples" class="book-source-list" aria-label="Caption preview"></ul>
      <div class="book-edit-actions"><button type="submit" value="save" disabled>Apply captions</button></div>`, () => {
      const changes = captionChanges();
      if (!changes.updates.size) throw new Error("No matching images to update.");
      const entries = state.entries.map((entry) => ({ ...entry, blocks: entry.blocks.map((block) => {
        const change = changes.updates.get(block);
        if (!change) return block;
        const recovery = state.previewImages.get(block);
        if (recovery) {
          const key = block[imageSlotContext].key;
          state.recoveredImages.set(key, { ...recovery, caption: change.caption });
        }
        return { ...block, caption: change.caption, alt: change.alt };
      }) }));
      save(entries, `Updated ${changes.updates.size} image captions.`);
    });
    const source = form.elements.captionSource;
    const preview = () => {
      $("#captionMapping").hidden = source.value !== "mapping";
      const list = $("#captionExamples");
      list.replaceChildren();
      const button = form.querySelector('button[value="save"]');
      button.disabled = true;
      try {
        const { updates, unmatched } = captionChanges();
        $("#captionSummary").textContent = `${updates.size} images to update.${unmatched.length ? ` ${unmatched.length} URLs have no matching image.` : ""}`;
        for (const { title, caption } of [...updates.values()].slice(0, 30)) {
          const item = document.createElement("li");
          item.textContent = `${title} · ${caption || "(empty caption)"}`;
          list.append(item);
        }
        button.disabled = !updates.size;
      } catch (error) {
        $("#captionSummary").textContent = error.message;
      }
    };
    source.addEventListener("change", preview);
    for (const control of [form.elements.captionUrls, form.elements.captionValues]) control.addEventListener("input", preview);
    preview();
  }

  function captionChanges() {
    const mapping = new Map();
    const matched = new Set();
    const updates = new Map();
    const source = form.elements.captionSource.value;
    if (source === "mapping") {
      const urls = form.elements.captionUrls.value.trim().split(/\r?\n/).map((value) => value.trim());
      const captions = form.elements.captionValues.value.replace(/\r\n/g, "\n").split("\n");
      while (captions.length > urls.length && captions.at(-1) === "") captions.pop();
      if (!urls[0] || urls.some((url) => !url)) throw new Error("Enter one image URL per line, with no empty URL rows.");
      if (urls.length !== captions.length) throw new Error(`The lists need the same number of lines. There are ${urls.length} URLs and ${captions.length} captions.`);
      urls.forEach((url, index) => {
        const caption = captions[index].trim();
        if (mapping.has(url) && mapping.get(url) !== caption) throw new Error(`The URL on line ${index + 1} has two different captions.`);
        mapping.set(url, caption);
      });
    }
    const assets = new Map(state.bookPackage.assets.map((asset) => [asset.id, asset]));
    for (const entry of state.entries) {
      let h2 = entry.title;
      for (const block of entry.blocks) {
        if (!block.statBlock && block.type === "heading" && block.level === 2) h2 = block.text;
        if (block.type !== "image" || block[sourceHidden]) continue;
        const asset = assets.get(block.assetId);
        const urls = [...new Set([asset?.src, block[markdownImage]?.url, block[imageSlotContext]?.url].filter(Boolean))];
        const keys = urls.filter((url) => mapping.has(url));
        if (source === "mapping" && !keys.length) continue;
        const captions = new Set(keys.map((url) => mapping.get(url)));
        if (captions.size > 1) throw new Error(`Conflicting captions match an image in ${entry.title}.`);
        for (const key of keys) matched.add(key);
        const recovery = state.previewImages.get(block);
        updates.set(block, { title: entry.title, caption: source === "heading" ? h2 : mapping.get(keys[0]),
          alt: block.alt ?? recovery?.caption ?? asset?.alt ?? "" });
      }
    }
    return { updates, unmatched: [...mapping.keys()].filter((url) => !matched.has(url)) };
  }

  function open(title, html, apply) {
    releaseImagePreview?.();
    releaseImagePreview = null;
    $("#bookEditingTitle").textContent = title;
    fields.innerHTML = html;
    message.textContent = "";
    action = apply;
    if (!dialog.open) dialog.showModal();
  }

  function save(entries, notice, keepReplacementHistory = false) {
    dialog.close();
    applyEditedEntries(entries, { keepHeadingHistory: false, keepReplacementHistory });
    showNotice(notice);
  }

  function clearReplacementHistory() {
    replacementHistory.length = 0;
    $("#undoBookReplacement").disabled = true;
  }

  function undoReplacement() {
    const previous = replacementHistory.pop();
    if (!previous) return;
    order = previous.order;
    hiddenSections = previous.hiddenSections;
    for (const [key, caption] of previous.captions) {
      const image = state.recoveredImages.get(key);
      if (image) state.recoveredImages.set(key, { ...image, caption });
    }
    state.currentPage = previous.currentPage;
    save(previous.entries, "Replacement undone.", true);
    $("#undoBookReplacement").disabled = !replacementHistory.length;
  }

  function wrapBlock(block, index, content) {
    const label = block.type === "list" && block.ordered ? "Edit numbered list" : editLabels.get(block.type);
    const control = label ? `<button type="button" data-book-edit="${index}">${label}</button>` : "";
    return `<div class="book-edit-block"${label ? ` data-edit-block="${index}"` : ""}>${content}<div class="book-block-actions">${control}<button type="button" data-book-add="${index + 1}">Add below</button></div></div>`;
  }

  function withBlocks(entry, blocks) {
    return state.entries.map((candidate) => candidate === entry ? { ...entry, blocks } : candidate);
  }

  function displayOptions(options, selected) {
    return options.map(([value, label]) => `<option value="${escapeAttribute(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
  }

  function findAndReplace() {
    const entry = currentEntry();
    if (!entry) return;
    open("Find and replace", `
      <label>Find <input name="query" type="text" required autocomplete="off" dir="auto"></label>
      <label>Replace with <input name="replacement" type="text" autocomplete="off" dir="auto"></label>
      <label>Search in <select name="replaceScope">${displayOptions([["entry", `Current entry — ${entry.title}`], ["book", "Entire book"]], "entry")}</select></label>
      <label class="book-edit-check"><input name="matchCase" type="checkbox"> Match case</label>
      <p>Replaces literal text in headings, paragraphs, link labels, lists, tables, image captions, and alt text. Link destinations are edited separately. Leave the replacement empty to delete matching text.</p>
      <p id="replaceSummary" role="status">Enter text to find.</p>
      <ul id="replaceExamples" class="book-source-list" aria-label="Replacement preview"></ul>
      <div class="book-edit-actions"><button type="submit" value="save" disabled>Replace all matches</button></div>`, () => {
      const result = replacementPreview(entry);
      if (!result.count) throw new Error("No matching text to replace.");
      if (result.emptyTitle) throw new Error("A heading, entry title, or link label would become empty. Enter replacement text.");
      replacementHistory.push({ entries: state.entries, currentPage: state.currentPage,
        order: [...order], hiddenSections: new Set(hiddenSections),
        captions: new Map(result.recoveries.map(({ key }) => [key, state.recoveredImages.get(key).caption])) });
      for (const { key, caption } of result.recoveries) {
        state.recoveredImages.set(key, { ...state.recoveredImages.get(key), caption });
      }
      for (const [before, after] of result.sectionRenames) {
        if (hiddenSections.has(before)) hiddenSections.add(after);
        const index = order.indexOf(before);
        if (index !== -1 && !order.includes(after)) order.splice(index + 1, 0, after);
      }
      save(result.entries, `Replaced ${result.count} matches in ${result.entryCount} ${result.entryCount === 1 ? "entry" : "entries"}.`, true);
      $("#undoBookReplacement").disabled = false;
    });
    function preview() {
      const result = replacementPreview(entry);
      $("#replaceSummary").textContent = !form.elements.query.value ? "Enter text to find."
        : result.emptyTitle ? "A heading, entry title, or link label would become empty. Enter replacement text."
          : `${result.count} matches in ${result.entryCount} ${result.entryCount === 1 ? "entry" : "entries"}.`;
      const list = $("#replaceExamples");
      list.replaceChildren(...result.examples.map(({ entry, before, after }) => {
        const item = document.createElement("li");
        const title = document.createElement("strong");
        title.textContent = entry;
        const oldValue = document.createElement("div");
        oldValue.textContent = `Before · ${before.slice(0, 240)}`;
        const newValue = document.createElement("div");
        newValue.textContent = `After · ${after.slice(0, 240)}`;
        item.append(title, oldValue, newValue);
        return item;
      }));
      form.querySelector('button[value="save"]').disabled = !result.count || result.emptyTitle;
    }
    for (const input of [form.elements.query, form.elements.replacement, form.elements.replaceScope, form.elements.matchCase]) {
      input.addEventListener("input", preview);
      input.addEventListener("change", preview);
    }
    form.elements.query.focus();
  }

  function replacementPreview(selectedEntry) {
    const { query, replacement, replaceScope, matchCase } = form.elements;
    if (!query.value) return { count: 0, entryCount: 0, examples: [] };
    const expression = new RegExp(query.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase.checked ? "g" : "gi");
    const examples = [];
    const recoveries = [];
    const sectionRenames = [];
    let count = 0;
    let entryCount = 0;
    let emptyTitle = false;
    const replace = (text) => text.replace(expression, () => {
      count += 1;
      return replacement.value;
    });
    const assets = new Map(state.bookPackage.assets.map((asset) => [asset.id, asset]));
    const entries = state.entries.map((entry) => {
      if (replaceScope.value === "entry" && entry !== selectedEntry) return entry;
      const previousCount = count;
      const change = (text) => {
        const after = replace(text);
        if (after !== text && examples.length < 30) examples.push({ entry: entry.title, before: text, after });
        return after;
      };
      const blocks = entry.blocks.map((block) => {
        if (block[sourceHidden]) return block;
        if (block.type === "heading" || block.type === "paragraph" || block.type === "link") {
          const text = change(block.text);
          if (["heading", "link"].includes(block.type) && !normalizeBreaks(text).trim()) emptyTitle = true;
          if (!block.statBlock && block.type === "heading" && block.level === 3 && text !== block.text) sectionRenames.push([sectionName(block.text), sectionName(text)]);
          return text === block.text ? block : { ...block, text };
        }
        if (block.type === "list") return { ...block, items: block.items.map(change) };
        if (block.type === "table") return { ...block, columns: block.columns.map(change), rows: block.rows.map((row) => row.map(change)) };
        if (block.type === "image") {
          const asset = assets.get(block.assetId);
          const recovery = state.previewImages.get(block);
          const beforeCaption = recovery?.caption ?? block.caption ?? asset?.alt ?? "";
          const beforeAlt = block.alt ?? recovery?.caption ?? asset?.alt ?? "";
          const caption = change(beforeCaption);
          const alt = change(beforeAlt);
          if (caption === beforeCaption && alt === beforeAlt) return block;
          if (recovery) recoveries.push({ key: block[imageSlotContext].key, caption });
          return { ...block, caption, alt };
        }
        if (block.type === "embed" && typeof block.title === "string") return { ...block, title: change(block.title) };
        return block;
      });
      const leadIndex = entryHeadingIndex(entry.blocks, entryHeadingLevel(state.config));
      const lead = entry.blocks[leadIndex];
      const syncedTitle = lead?.type === "heading" && lead.level === entryHeadingLevel(state.config) && entry.title === lead.text;
      const title = syncedTitle ? blocks[leadIndex].text : change(entry.title);
      if (!title.trim()) emptyTitle = true;
      if (count > previousCount) entryCount += 1;
      return { ...entry, title, blocks };
    });
    return { entries, count, entryCount, examples, recoveries, emptyTitle, sectionRenames };
  }

  function editScope(entry, index) {
    const selected = entry.blocks[index];
    if (!selected) return new Map();
    const matches = new Map([["single", { label: "This item only", targets: [{ entry, index, block: selected }] }]]);
    const assets = new Map(state.bookPackage.assets.map((asset) => [asset.id, asset]));
    const imageLabel = (block) => sectionName(block[markdownImage]?.alt ?? (block.alt || assets.get(block.assetId)?.alt || ""));
    const imageUrl = (block) => assets.get(block.assetId)?.src;
    const label = selected.type === "image" ? imageLabel(selected) : "";
    const url = selected.type === "image" ? imageUrl(selected) : "";
    const section = selected.type === "paragraph" ? paragraphPosition(entry, index) : null;
    const candidates = state.entries.flatMap((item) => item.blocks.flatMap((block, index) =>
      block.type === selected.type && !block[sourceHidden] && (selected.type !== "heading" || Boolean(block.statBlock) === Boolean(selected.statBlock)) ? [{ entry: item, index, block }] : []));
    function add(value, label, test) {
      const targets = candidates.filter(test);
      if (targets.length > 1) matches.set(value, { label, targets });
    }
    if (selected.type === "image") {
      if (label) add("image-label", `Same image label: ${selected[markdownImage]?.alt ?? (selected.alt || assets.get(selected.assetId)?.alt)}`,
        ({ block }) => imageLabel(block) === label);
      if (url && url !== "about:blank") add("image-url", "Same image URL", ({ block }) => imageUrl(block) === url);
    } else if (selected.type === "heading") {
      add("heading", `Same H${selected.level} title`, ({ block }) =>
        block.level === selected.level && sectionName(block.text) === sectionName(selected.text));
    } else if (selected.type === "paragraph") {
      add("text", "Identical text", ({ block }) => block.text === selected.text);
      if (section) {
        const atPosition = new Set(state.entries.flatMap(({ blocks }) => splitSections(blocks)
          .filter(({ title }) => title && sectionName(title) === section.key)
          .map(({ blocks }) => blocks.filter((block) => block.type === "paragraph" && !block.statBlock && !block[sourceHidden])[section.number - 1])));
        add("section-position", `Paragraph ${section.number} under ${section.title}`, ({ block }) => atPosition.has(block));
      }
      add("paragraph-style", "Same paragraph format across the book", ({ block }) => (block.style || "") === (selected.style || ""));
    } else if (selected.type === "table" || selected.type === "list") {
      const signature = (block) => JSON.stringify(block.type === "table" ? [block.columns, block.rows] : [Boolean(block.ordered), block.start ?? 1, block.items]);
      const original = signature(selected);
      add("identical", selected.type === "table" ? "Identical table" : "Identical list", ({ block }) => signature(block) === original);
    }
    return matches;
  }

  function paragraphPosition(entry, index) {
    if (entry.blocks[index]?.statBlock) return null;
    let number = 0;
    for (let previous = index; previous >= 0; previous -= 1) {
      const block = entry.blocks[previous];
      if (block.statBlock) continue;
      if (block.type === "heading" && block.level <= 3) {
        if (block.level === 3) return { title: block.text, key: sectionName(block.text), number };
        return null;
      }
      if (block.type === "paragraph" && !block[sourceHidden]) number += 1;
    }
    return null;
  }

  function scopeField(scopes, paragraph = false) {
    if (scopes.size < 2) return "";
    const options = [...scopes].map(([value, { label, targets }]) => [value, `${label} (${targets.length})`]);
    return `<fieldset class="book-edit-scope"><legend>Apply to</legend>
      <select name="scope" aria-label="Edit scope">${displayOptions(options, "single")}</select>
      <div data-scope-details hidden>
        <p data-scope-count role="status"></p>
        ${paragraph ? '<label class="book-edit-check"><input name="replaceText" type="checkbox"> Use the text above for every match</label>' : ""}
      </div></fieldset>`;
  }

  function wireScope(scopes, noun) {
    const selector = form.elements.scope;
    if (!selector) return;
    selector.addEventListener("change", () => {
      const { targets } = scopes.get(selector.value);
      const count = targets.length;
      const entries = new Set(targets.map(({ entry }) => entry.id)).size;
      fields.querySelector("[data-scope-details]").hidden = count < 2;
      fields.querySelector("[data-scope-count]").textContent = `${count} ${noun}s in ${entries} ${entries === 1 ? "entry" : "entries"}.`;
      const remove = fields.querySelector('button[value="remove"]');
      if (remove) remove.textContent = count > 1 ? `Remove ${count} matching ${noun}s` : `Remove ${noun}`;
      const selection = fields.querySelector('button[value="selection"]');
      if (selection) selection.disabled = !["single", "text"].includes(selector.value);
    });
  }

  function editText(index, add) {
    const entry = currentEntry();
    const block = add ? null : entry.blocks[index];
    const format = block?.type === "heading" ? `h${block.level}` : block?.type === "link" ? "link" : block?.style || "paragraph";
    const statBlock = add ? entry.blocks[index - 1]?.statBlock : block?.statBlock;
    const isSection = !statBlock && block?.type === "heading" && block.level === 3;
    const formats = [["paragraph", "Paragraph"], ["book-quote", "Quote"], ["book-callout", "Callout"],
      ...[1, 2, 3, 4, 5, 6].map((level) => [`h${level}`, `Heading H${level}`])];
    if (add || block?.type === "paragraph" || block?.type === "link") formats.push(["link", "Link"]);
    if (!formats.some(([value]) => value === format)) formats.push([format, "Current style"]);
    if (add) formats.push(["image", "Image"], ["table", "Table"], ["list", "Bullet list"]);
    const otherEntries = state.entries.filter((item) => item !== entry).map(({ id, title }) => [id, title]);
    const scopes = add ? new Map() : editScope(entry, index);
    open(add ? "Add a block" : "Edit preview block", `
      <label>Format <select name="format">${displayOptions(formats, format)}</select></label>
      <label id="editTextField">Text <textarea name="text" rows="6" dir="auto" required>${escapeHtml(block?.text || "")}</textarea></label>
      <label id="editLinkUrlField"${format === "link" ? "" : " hidden"}>Destination URL <input name="url" type="url" dir="ltr" placeholder="https://example.com" value="${escapeAttribute(block?.url || "")}"${format === "link" ? " required" : " disabled"}></label>
      ${isSection ? `<label>Player edition <select name="visibility">${displayOptions([["default", "Follow section rule"], ["include", "Include this section"], ["exclude", "Hide this section"]], block[sectionVisibility] || "default")}</select></label>
        ${otherEntries.length ? `<label>Move section to <select name="destination">${displayOptions([["", "Keep in this entry"], ...otherEntries], "")}</select></label>` : ""}` : ""}
      ${scopeField(scopes, block?.type === "paragraph")}
      <div class="book-edit-actions">
        <button type="submit" value="save">${add ? "Add block" : "Save edits"}</button>
        ${block?.type === "paragraph" ? '<button type="submit" value="selection">Format selected text</button>' : ""}
        ${!add ? '<button type="submit" value="remove" formnovalidate>Remove block</button>' : ""}
      </div>`, (command) => {
      const selected = form.elements.format.value;
      const scope = form.elements.scope?.value || "single";
      if (scope !== "single") {
        if (selected === "link") throw new Error("Choose This item only when creating a link.");
        editMatchingText(scopes.get(scope).targets, block, command);
        return;
      }
      if (selected === "image") { editImage(index, true); return; }
      if (selected === "table" || selected === "list") { editStructuredBlock(selected, index, true); return; }
      const textField = form.elements.text;
      const value = textField.value;
      if (command !== "remove" && !value.trim()) throw new Error("Enter some text.");
      let replacement = [];
      if (command !== "remove" && selected === "link") {
        const text = normalizeBreaks(value.trim());
        const url = safeBookLinkUrl(form.elements.url.value);
        if (!text.trim()) throw new Error("Enter the link's display text.");
        if (!url) throw new Error("Enter a valid absolute HTTP or HTTPS URL.");
        replacement = [{ type: "link", text, url }];
      } else if (command === "selection") {
        const { selectionStart: start, selectionEnd: end } = textField;
        if (!value.slice(start, end).trim()) throw new Error("Select the words to format in the text field.");
        replacement = [value.slice(0, start), value.slice(start, end), value.slice(end)]
          .flatMap((part, partIndex) => part.trim() ? [formatTextBlock(part, partIndex === 1 ? selected : format)] : []);
      } else if (command !== "remove") {
        replacement = /^h[1-6]$/.test(selected) ? [formatTextBlock(value, selected)]
          : value.split(/\n\s*\n/).filter((text) => text.trim()).map((text) => formatTextBlock(text, selected));
      }
      if (statBlock) for (const part of replacement) part.statBlock = statBlock;
      const visibility = form.elements.visibility?.value;
      if (visibility && replacement[0]?.level === 3) replacement[0][sectionVisibility] = visibility;
      if (block?.[sourceHeadingKey] && replacement[0]?.type === "heading") replacement[0][sourceHeadingKey] = block[sourceHeadingKey];
      if (block?.[sourceArtifact] && replacement.length) replacement[0][sourceArtifact] = block[sourceArtifact];
      const destination = form.elements.destination?.value;
      if (command === "save" && destination) {
        if (replacement[0]?.level !== 3) throw new Error("Keep H3 to move the whole section.");
        const end = sectionEnd(entry.blocks, index);
        const moving = [...replacement, ...entry.blocks.slice(index + 1, end)];
        save(state.entries.map((item) => item === entry
          ? { ...item, blocks: [...item.blocks.slice(0, index), ...item.blocks.slice(end)] }
          : item.id === destination ? { ...item, blocks: [...item.blocks, ...moving] } : item), "Section moved.");
        return;
      }
      const blocks = [...entry.blocks];
      blocks.splice(index, add ? 0 : 1, ...replacement);
      let entries = withBlocks(entry, blocks);
      const entryLevel = entryHeadingLevel(state.config);
      if (!statBlock && command === "save" && block?.type === "heading" && replacement[0]?.type === "heading" &&
        (block.level === entryLevel || replacement[0].level === entryLevel)) {
        const edit = { title: replacement[0].text, level: replacement[0].level };
        entries = regroupEditedHeadings(new Map([[block, edit]]));
      } else {
        const newEntryHeading = replacement.find((part) => !part.statBlock && part.type === "heading" && part.level === entryLevel);
        if (newEntryHeading) {
          newEntryHeading.level = entryLevel === 1 ? 2 : 1;
          entries = regroupEditedHeadings(new Map([[newEntryHeading, { title: newEntryHeading.text, level: entryLevel }]]), entries);
        }
      }
      save(entries, "Preview updated.");
    });
    wireScope(scopes, "block");
    const selector = form.elements.format;
    selector.addEventListener("change", () => {
      const hasText = !["image", "table", "list"].includes(selector.value);
      const isLink = selector.value === "link";
      $("#editTextField").hidden = !hasText;
      form.elements.text.required = hasText;
      $("#editLinkUrlField").hidden = !isLink;
      form.elements.url.disabled = !isLink;
      form.elements.url.required = isLink;
      const scope = form.elements.scope;
      if (scope) {
        if (isLink) {
          scope.value = "single";
          scope.dispatchEvent(new Event("change"));
        }
        scope.closest("fieldset").hidden = isLink;
      }
      const selection = form.querySelector('button[value="selection"]');
      if (selection) selection.disabled = isLink || (scope && !["single", "text"].includes(scope.value));
    });
  }

  function editStructuredBlock(type, index, add = false) {
    const entry = currentEntry();
    const block = add ? null : entry.blocks[index];
    const noun = type === "table" ? "table" : "list";
    const scopes = add ? new Map() : editScope(entry, index);
    let readBlock;
    open(`${add ? "Add" : "Edit"} ${noun}`, `
      <div id="structuredBlockFields"></div>
      ${scopeField(scopes)}
      <div class="book-edit-actions">
        <button type="submit" value="save">${add ? `Add ${noun}` : "Save edits"}</button>
        ${add ? "" : `<button type="submit" value="remove" formnovalidate>Remove ${noun}</button>`}
      </div>`, (command) => {
      const edited = command === "remove" ? null : readBlock();
      if (add) {
        if (entry.blocks[index - 1]?.statBlock) edited.statBlock = entry.blocks[index - 1].statBlock;
        const blocks = [...entry.blocks];
        blocks.splice(index, 0, edited);
        save(withBlocks(entry, blocks), `Added ${noun}.`);
        return;
      }
      const { targets } = scopes.get(form.elements.scope?.value || "single");
      const matched = new Set(targets.map(({ block }) => block));
      const entries = state.entries.map((item) => ({ ...item, blocks: item.blocks.flatMap((original) => {
        if (!matched.has(original)) return [original];
        return edited ? [{ ...original, ...structuredClone(edited) }] : [];
      }) }));
      const count = matched.size;
      save(entries, `${command === "remove" ? "Removed" : "Updated"} ${count} ${noun}${count === 1 ? "" : "s"}.`);
    });
    const container = $("#structuredBlockFields");
    readBlock = type === "table" ? tableEditor(container, block) : listEditor(container, block);
    wireScope(scopes, noun);
  }

  function editorButton(text, label, run) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    if (label) button.setAttribute("aria-label", label);
    button.addEventListener("click", run);
    return button;
  }

  function editorField(value, label, onInput, multiline = false) {
    const input = document.createElement(multiline ? "textarea" : "input");
    input.setAttribute("aria-label", label);
    input.dir = "auto";
    input.value = value;
    if (multiline) input.rows = 2;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function listEditor(container, block) {
    const items = block?.items.length ? [...block.items] : [""];
    let ordered = Boolean(block?.ordered);
    const listContainer = document.createElement("div");
    let list;
    const style = document.createElement("label");
    style.textContent = "List style";
    const select = document.createElement("select");
    select.name = "listStyle";
    select.innerHTML = displayOptions([["bullet", "Bullet points"], ["numbered", "Numbered"]], ordered ? "numbered" : "bullet");
    style.append(select);
    const startLabel = document.createElement("label");
    startLabel.textContent = "Start at";
    const start = document.createElement("input");
    start.type = "number";
    start.min = "0";
    start.step = "1";
    start.name = "listStart";
    start.value = block?.start ?? 1;
    startLabel.append(start);
    function updateStyle() {
      ordered = select.value === "numbered";
      startLabel.hidden = !ordered;
      start.disabled = !ordered;
      start.required = ordered;
      addItem.textContent = ordered ? "Add item" : "Add bullet";
      render();
    }
    select.addEventListener("change", updateStyle);
    start.addEventListener("input", () => { if (Number.isSafeInteger(start.valueAsNumber)) list.start = start.valueAsNumber; });
    const addItem = editorButton(block?.ordered ? "Add item" : "Add bullet", null, () => {
      items.push("");
      render();
      list.lastElementChild.querySelector("textarea").focus();
    });
    function render() {
      list = document.createElement(ordered ? "ol" : "ul");
      list.className = "book-bullet-editor";
      if (ordered) list.start = start.valueAsNumber;
      const label = ordered ? "Item" : "Bullet";
      list.append(...items.map((value, index) => {
        const row = document.createElement("li");
        const input = editorField(value, `${label} ${index + 1}`, (value) => { items[index] = value; }, true);
        const remove = editorButton("Remove", `Remove ${label.toLowerCase()} ${index + 1}`, () => {
          items.splice(index, 1);
          render();
          (list.children[Math.min(index, items.length - 1)]?.querySelector("textarea") || addItem).focus();
        });
        row.append(input, remove);
        return row;
      }));
      listContainer.replaceChildren(list);
    }
    container.append(style, startLabel, listContainer, addItem);
    updateStyle();
    return () => {
      const formatted = items.filter((item) => item.trim());
      if (!formatted.length) throw new Error("Enter at least one item, or remove the list.");
      if (ordered && (!Number.isSafeInteger(start.valueAsNumber) || start.valueAsNumber < 0)) throw new Error("Enter a whole starting number of zero or more.");
      return { type: "list", items: formatted, ...(ordered ? { ordered: true, start: start.valueAsNumber }
        : block?.ordered ? { ordered: false, start: undefined } : {}) };
    };
  }

  function tableEditor(container, block) {
    const width = block ? block.rows.reduce((width, row) => Math.max(width, row.length), Math.max(1, block.columns.length)) : 2;
    const fill = (cells) => Array.from({ length: width }, (_, index) => cells[index] ?? "");
    const columns = fill(block?.columns || []);
    const rows = block ? block.rows.map(fill) : [fill([])];
    const viewport = document.createElement("div");
    viewport.className = "book-table-editor";
    const table = document.createElement("table");
    table.setAttribute("aria-label", "Table cells");
    const headers = table.createTHead();
    const body = table.createTBody();
    viewport.append(table);
    const controls = document.createElement("div");
    controls.className = "book-edit-actions";
    const addRow = editorButton("Add row", null, () => {
      rows.push(columns.map(() => ""));
      render();
      body.lastElementChild.querySelector("input").focus();
    });
    const addColumn = editorButton("Add column", null, () => {
      columns.push("");
      for (const row of rows) row.push("");
      render();
      headers.rows[0].cells[columns.length - 1].querySelector("input").focus();
    });
    controls.append(addRow, addColumn);
    function render() {
      headers.replaceChildren();
      const header = headers.insertRow();
      for (const [index, value] of columns.entries()) {
        const cell = document.createElement("th");
        cell.scope = "col";
        const input = editorField(value, `Column ${index + 1} heading`, (value) => { columns[index] = value; });
        const remove = editorButton("Remove", `Remove column ${index + 1}`, () => {
          columns.splice(index, 1);
          for (const row of rows) row.splice(index, 1);
          render();
          headers.rows[0].cells[Math.min(index, columns.length - 1)].querySelector("input").focus();
        });
        remove.disabled = columns.length === 1;
        cell.append(input, remove);
        header.append(cell);
      }
      header.insertCell();
      body.replaceChildren();
      for (const [rowIndex, values] of rows.entries()) {
        const row = body.insertRow();
        for (const [index, value] of values.entries()) {
          row.insertCell().append(editorField(value, `Row ${rowIndex + 1}, column ${index + 1}`, (value) => { values[index] = value; }));
        }
        row.insertCell().append(editorButton("Remove", `Remove row ${rowIndex + 1}`, () => {
          rows.splice(rowIndex, 1);
          render();
          (body.rows[Math.min(rowIndex, rows.length - 1)]?.querySelector("input") || addRow).focus();
        }));
      }
    }
    container.append(viewport, controls);
    render();
    return () => ({ type: "table", columns, rows });
  }

  function editMatchingText(targets, selected, command) {
    const controls = form.elements;
    const replacements = new Map();
    const headingChanges = new Map();
    const destination = command === "save" && controls.destination?.value;
    const visibility = controls.visibility?.value;
    const updateVisibility = visibility && visibility !== (selected[sectionVisibility] || "default");
    const format = controls.format.value;
    const changeFormat = format !== blockFormat(selected);
    const replaceText = selected.type === "heading" || controls.replaceText?.checked;
    const input = controls.text;
    const text = input.value;
    const entryLevel = entryHeadingLevel(state.config);
    if (command !== "remove" && replaceText && !text.trim()) throw new Error("Enter some text.");
    if (command === "selection" && !text.slice(input.selectionStart, input.selectionEnd).trim()) throw new Error("Select the words to format in the text field.");
    if (command === "selection" && !replaceText && text !== selected.text) throw new Error("Use the original wording for selection formatting or choose to replace the text in every match.");
    if (command === "save" && selected.type === "paragraph" && !changeFormat && !replaceText) throw new Error("Choose a different format or select the option to replace the text in every match.");
    if (destination && format !== "h3") throw new Error("Keep H3 to move whole sections.");

    function formatBlock(original, value, type) {
      const updated = formatTextBlock(value, type);
      if (original.statBlock) updated.statBlock = original.statBlock;
      if (updated.type === "heading") updated[sourceHeadingKey] = original[sourceHeadingKey];
      if (updated.level === 3) updated[sectionVisibility] = updateVisibility ? visibility : original[sectionVisibility];
      return updated;
    }

    for (const { block } of targets) {
      if (command === "remove") {
        replacements.set(block, []);
        continue;
      }
      const targetFormat = changeFormat ? format : blockFormat(block);
      const words = replaceText ? text : block.text;
      const parts = command === "selection"
        ? [text.slice(0, input.selectionStart), text.slice(input.selectionStart, input.selectionEnd), text.slice(input.selectionEnd)]
          .flatMap((part, index) => part.trim() ? [formatBlock(block, part, index === 1 ? format : blockFormat(block))] : [])
        : /^h[1-6]$/.test(targetFormat) ? [formatBlock(block, words, targetFormat)]
          : words.split(/\n\s*\n/).filter((part) => part.trim()).map((part) => formatBlock(block, part, targetFormat));
      if (parts.length && block[sourceArtifact]) parts[0][sourceArtifact] = block[sourceArtifact];
      for (const [index, part] of parts.entries()) {
        if (part.statBlock || part.type !== "heading" || part.level !== entryLevel && (index !== 0 || block.level !== entryLevel)) continue;
        const before = block.type === "heading" && index === 0 ? block : { ...part, level: entryLevel === 1 ? 2 : 1 };
        headingChanges.set(before, { title: part.text, level: part.level, block: part });
        parts[index] = before;
      }
      replacements.set(block, parts);
    }

    const moved = [];
    if (destination) for (const { entry, index, block } of targets) {
      if (entry.id === destination) continue;
      const children = entry.blocks.slice(index + 1, sectionEnd(entry.blocks, index));
      moved.push(...replacements.get(block), ...children);
      for (const item of [block, ...children]) replacements.set(item, []);
    }
    let entries = state.entries.map((entry) => ({ ...entry, blocks: [
      ...entry.blocks.flatMap((block) => replacements.get(block) || [block]), ...(entry.id === destination ? moved : [])
    ] }));
    if (headingChanges.size) entries = regroupEditedHeadings(headingChanges, entries);
    save(entries, `${command === "remove" ? "Removed" : "Updated"} ${targets.length} matching blocks.`);
  }

  function blockFormat(block) {
    return block.type === "heading" ? `h${block.level}` : block.style || "paragraph";
  }

  function formatTextBlock(text, format) {
    const trimmed = normalizeBreaks(text.trim());
    return /^h[1-6]$/.test(format)
      ? { type: "heading", level: Number(format[1]), text: trimmed }
      : { type: "paragraph", text: trimmed, ...(format !== "paragraph" && { style: format }) };
  }

  function editImage(index, add = false) {
    const entry = currentEntry();
    const block = add ? null : entry.blocks[index];
    const asset = state.bookPackage.assets.find(({ id }) => id === block?.assetId);
    const recovered = block && state.previewImages.get(block);
    const defaultAlt = recovered?.caption ?? asset?.alt ?? "";
    const imageSource = recovered?.url || state.bundledImages.get(asset?.src)?.url || asset?.src || "";
    const editableUrl = recovered ? "" : asset?.src || "";
    const width = /^\d+(?:\.\d+)?%$/.test(block?.width || "") ? block.width.slice(0, -1) : "";
    const scopes = add ? new Map() : editScope(entry, index);
    const initialCaption = recovered?.caption ?? block?.caption ?? defaultAlt;
    const initialAlt = block?.alt ?? defaultAlt;
    open(add ? "Add an image" : "Edit image", `
      <div class="book-edit-grid">
        <label>Image URL <input name="url" value="${escapeAttribute(editableUrl)}" placeholder="https://…" spellcheck="false"></label>
        <label>Upload replacement <input name="upload" type="file" accept="image/*"></label>
        <label>WebP filename <input name="fileName" value="${escapeAttribute(recovered?.fileName || "")}" placeholder="Enter a name to bundle the image"></label>
        <label>Width (%) <input name="width" type="number" min="1" max="100" step="any" value="${width}"></label>
        <label>Caption <input name="caption" dir="auto" value="${escapeAttribute(initialCaption)}"></label>
        <label>Alt text <input name="alt" dir="auto" value="${escapeAttribute(initialAlt)}"></label>
        <label>Position <select name="position">${displayOptions([["same", "Keep position"], ["above", "Move up one block"], ["below", "Move down one block"], ["top", "Start of entry"], ["bottom", "End of entry"]], "same")}</select></label>
      </div>
      <details><summary>Crop image</summary><label class="book-edit-check"><input type="checkbox" name="crop"> Apply crop on save</label>
        <p>Drag over the image or enter percentages measured from its top-left corner.</p>
        <div id="editCropStage" class="book-crop-stage" hidden><img id="editCropImage" alt="Image to crop" draggable="false"><div id="editCropOutline" hidden></div></div>
        <div class="book-edit-grid">${[["x", "Left", 0], ["y", "Top", 0], ["w", "Width", 100], ["h", "Height", 100]].map(([name, label, value]) => `<label>${label} (%) <input name="${name}" type="number" min="0" max="100" step="any" value="${value}"></label>`).join("")}</div>
      </details>
      ${scopeField(scopes)}
      <div class="book-edit-actions"><button type="submit" value="save">${add ? "Add image" : "Save image"}</button>${add ? "" : '<button type="submit" value="remove" formnovalidate>Remove image</button>'}</div>`, async (command, isCurrent) => {
      const scope = form.elements.scope?.value || "single";
      const blocks = [...entry.blocks];
      if (command === "remove") {
        const targets = new Set(scopes.get(scope).targets.map(({ block }) => block));
        for (const image of targets) {
          const key = image[imageSlotContext]?.key;
          const recovered = state.recoveredImages.get(key);
          if (recovered) URL.revokeObjectURL(recovered.url);
          state.recoveredImages.delete(key);
        }
        save(state.entries.map((entry) => ({ ...entry, blocks: entry.blocks.filter((block) => !targets.has(block)) })),
          targets.size > 1 ? `Removed ${targets.size} matching images.` : "Image removed.");
        return;
      }
      const input = form.elements;
      const url = input.url.value.trim();
      const file = input.upload.files[0];
      const crop = input.crop.checked ? [input.x, input.y, input.w, input.h].map((field) => field.valueAsNumber) : null;
      if (crop && (crop.some((number) => !Number.isFinite(number)) || crop[2] <= 0 || crop[3] <= 0 || crop[0] + crop[2] > 100.000001 || crop[1] + crop[3] > 100.000001)) {
        throw new Error("The crop must stay inside the image and have a positive width and height.");
      }
      if (url && url !== editableUrl && !validImageUrl(url)) throw new Error("Enter a web or relative image URL.");
      if (!url && !file && !recovered) throw new Error("Enter an image URL or choose a file.");
      const alt = input.alt.value.trim();
      const caption = input.caption.value.trim();
      const role = block?.role || imageRole(alt);
      const newWidth = input.width.value ? `${input.width.value}%` : width ? undefined : block?.width;
      const position = input.position.value;
      const enteredName = input.fileName.value.trim();
      if (scope !== "single") {
        await editMatchingImages(scopes.get(scope).targets, {
          url: url !== editableUrl ? url : undefined, file, crop, position,
          width: input.width.value !== width ? newWidth : undefined, clearWidth: !input.width.value && Boolean(width),
          caption: caption !== initialCaption.trim() ? caption : undefined,
          alt: alt !== initialAlt.trim() ? alt : undefined,
          fileName: enteredName && enteredName !== recovered?.fileName ? enteredName : undefined
        }, isCurrent);
        return;
      }
      const requestedName = enteredName || file?.name || recovered?.fileName || alt || "image";
      const bundleLink = url && enteredName && enteredName !== recovered?.fileName;
      const blob = file || crop || bundleLink ? await makeImageWebp(file || (url && url !== editableUrl ? url : imageSource || url), crop)
        : !url && recovered ? recovered.blob : null;
      if (!isCurrent()) return;
      const image = { ...block, type: "image", role, placement: position === "same" ? block?.placement || "inline" : "inline", width: newWidth, caption, alt };
      if (add && entry.blocks[index - 1]?.statBlock) image.statBlock = entry.blocks[index - 1].statBlock;
      if (position !== "same") delete image.className;
      if (add || url && url !== editableUrl) image.assetId = ensureAsset(url || "about:blank", alt, role);
      const oldKey = block?.[imageSlotContext]?.key;
      const context = image[imageSlotContext] ||= { key: `edited-image-${++editedImageId}`, page: null, before: "", after: "", caption: "" };
      if (blob) {
        const fileName = webpName(requestedName, oldKey);
        if (recovered) URL.revokeObjectURL(recovered.url);
        state.recoveredImages.set(context.key, { ...recovered, blob, fileName, caption, url: URL.createObjectURL(blob) });
      } else if (recovered) {
        URL.revokeObjectURL(recovered.url);
        state.recoveredImages.delete(context.key);
      }
      if (!add) blocks.splice(index, 1);
      const first = entryHeadingIndex(blocks, entryHeadingLevel(state.config)) + 1;
      const positions = { same: index, above: Math.max(first, index - 1), below: index + 1, top: first, bottom: blocks.length };
      let destination = positions[position];
      if (image.statBlock) {
        const start = blocks.findIndex((item) => item.statBlock === image.statBlock);
        const end = blocks.findLastIndex((item) => item.statBlock === image.statBlock);
        destination = start < 0 ? index : Math.max(start, Math.min(end + 1, destination));
      } else if (blocks[destination - 1]?.statBlock && blocks[destination - 1].statBlock === blocks[destination]?.statBlock) {
        const group = blocks[destination].statBlock;
        destination = position === "above" || position === "top" ? blocks.findIndex((item) => item.statBlock === group) : blocks.findLastIndex((item) => item.statBlock === group) + 1;
      }
      blocks.splice(destination, 0, image);
      save(withBlocks(entry, blocks), "Image updated.");
    });
    wireScope(scopes, "image");
    wireCropPreview(imageSource, editableUrl);
  }

  async function editMatchingImages(targets, changes, isCurrent) {
    const assets = new Map(state.bookPackage.assets.map((asset) => [asset.id, asset]));
    const pending = [];
    const conversions = new Map();
    if (changes.url === "" && !changes.file) throw new Error("Choose an image file or enter a replacement URL.");
    for (const { block } of targets) {
      const recovery = state.previewImages.get(block);
      const original = assets.get(block.assetId);
      const source = changes.file || changes.url || recovery?.blob || state.bundledImages.get(original?.src)?.blob || original?.src;
      let blob = changes.url ? null : recovery?.blob;
      if (changes.file || changes.crop || changes.fileName && !blob) {
        try {
          if (!conversions.has(source)) conversions.set(source, await makeImageWebp(source, changes.crop));
          blob = conversions.get(source);
        } catch (error) {
          throw new Error(`Could not edit every match. ${error.message}`);
        }
        if (!isCurrent()) return;
      }
      pending.push({ block, original, recovery, blob });
    }
    if (!isCurrent()) return;

    const updates = new Map();
    for (const { block, original, recovery, blob } of pending) {
      const image = { ...block };
      const alt = changes.alt ?? block.alt ?? original?.alt ?? "";
      const caption = changes.caption ?? recovery?.caption ?? block.caption ?? original?.alt ?? "";
      if (changes.alt !== undefined) image.alt = alt;
      if (changes.caption !== undefined || changes.url && recovery) image.caption = caption;
      if (changes.clearWidth || changes.width !== undefined) image.width = changes.width;
      if (changes.position !== "same") {
        image.placement = "inline";
        delete image.className;
      }
      if (changes.url) image.assetId = ensureAsset(changes.url, alt, block.role);
      const context = image[imageSlotContext] ||= { key: `edited-image-${++editedImageId}`, page: null, before: "", after: "", caption: "" };
      if (blob) {
        const suggested = changes.fileName || recovery?.fileName || changes.file?.name || alt || "image";
        const fileName = webpName(suggested, context.key);
        const url = blob === recovery?.blob ? recovery.url : URL.createObjectURL(blob);
        if (recovery && url !== recovery.url) URL.revokeObjectURL(recovery.url);
        state.recoveredImages.set(context.key, { ...recovery, blob, fileName, caption, url });
      } else if (recovery) {
        URL.revokeObjectURL(recovery.url);
        state.recoveredImages.delete(context.key);
      }
      updates.set(block, image);
    }
    const moved = new Set(updates.values());
    const entries = state.entries.map((entry) => {
      const blocks = entry.blocks.map((block) => updates.get(block) || block);
      return { ...entry, blocks: positionImages(blocks, moved, changes.position) };
    });
    save(entries, `Updated ${targets.length} matching images.`);
  }

  function positionImages(blocks, moved, position, withinStat = false) {
    if (position === "same") return blocks;
    if (!withinStat && blocks.some((block) => block.statBlock)) {
      // Treat each stat panel as one unit when moving normal images, and keep
      // matching images inside their own panel when moving stat artwork.
      const units = [];
      for (let index = 0; index < blocks.length;) {
        const group = blocks[index].statBlock;
        if (!group) { units.push({ blocks: [blocks[index]], movable: moved.has(blocks[index]) }); index += 1; continue; }
        const start = index;
        while (index < blocks.length && blocks[index].statBlock === group) index += 1;
        units.push({ blocks: positionImages(blocks.slice(start, index), moved, position, true), movable: false });
      }
      const first = units.findIndex((unit) => entryHeadingIndex(unit.blocks, entryHeadingLevel(state.config)) >= 0) + 1;
      if (position === "top" || position === "bottom") {
        const moving = units.filter((unit) => unit.movable);
        const remaining = units.filter((unit) => !unit.movable);
        const top = remaining.findIndex((unit) => entryHeadingIndex(unit.blocks, entryHeadingLevel(state.config)) >= 0) + 1;
        remaining.splice(position === "top" ? top : remaining.length, 0, ...moving);
        return remaining.flatMap((unit) => unit.blocks);
      }
      const step = position === "above" ? -1 : 1;
      for (let index = step < 0 ? first + 1 : units.length - 2; index >= first && index < units.length; index -= step) {
        const next = index + step;
        if (next < first || next >= units.length || !units[index].movable || units[next].movable) continue;
        [units[index], units[next]] = [units[next], units[index]];
      }
      return units.flatMap((unit) => unit.blocks);
    }
    const first = withinStat ? 0 : entryHeadingIndex(blocks, entryHeadingLevel(state.config)) + 1;
    if (position === "top" || position === "bottom") {
      const images = blocks.filter((block) => moved.has(block));
      const remaining = blocks.filter((block) => !moved.has(block));
      remaining.splice(position === "top" ? (withinStat ? 0 : entryHeadingIndex(remaining, entryHeadingLevel(state.config)) + 1) : remaining.length, 0, ...images);
      return remaining;
    }
    const step = position === "above" ? -1 : 1;
    let index = step < 0 ? first + 1 : blocks.length - 2;
    for (; index >= first && index < blocks.length; index -= step) {
      const next = index + step;
      if (next < first || next >= blocks.length || !moved.has(blocks[index]) || moved.has(blocks[next])) continue;
      [blocks[index], blocks[next]] = [blocks[next], blocks[index]];
    }
    return blocks;
  }

  function wireCropPreview(source, originalUrl) {
    const controls = form.elements;
    const stage = $("#editCropStage");
    const image = $("#editCropImage");
    const outline = $("#editCropOutline");
    const bounds = [controls.x, controls.y, controls.w, controls.h];
    let temporary;
    let start;
    releaseImagePreview = () => {
      if (temporary) URL.revokeObjectURL(temporary);
      temporary = null;
    };
    function showImage() {
      releaseImagePreview();
      const file = controls.upload.files[0];
      if (file) temporary = URL.createObjectURL(file);
      const url = controls.url.value.trim();
      const preview = temporary || (url === originalUrl || !url ? source : validImageUrl(url) ? url : "");
      stage.hidden = !preview;
      if (preview) image.src = preview;
      else image.removeAttribute("src");
    }
    function showOutline() {
      outline.hidden = !controls.crop.checked;
      for (const [index, property] of ["left", "top", "width", "height"].entries()) {
        outline.style[property] = `${bounds[index].valueAsNumber || 0}%`;
      }
    }
    function point(event) {
      const rect = image.getBoundingClientRect();
      const percent = (value, size) => Math.min(100, Math.max(0, 100 * value / size));
      return [percent(event.clientX - rect.left, rect.width), percent(event.clientY - rect.top, rect.height)];
    }
    controls.upload.addEventListener("change", showImage);
    controls.url.addEventListener("change", showImage);
    controls.crop.addEventListener("change", showOutline);
    for (const field of bounds) field.addEventListener("input", showOutline);
    image.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0 || !image.naturalWidth) return;
      start = point(event);
      image.setPointerCapture(event.pointerId);
    });
    image.addEventListener("pointermove", (event) => {
      if (!start || !image.hasPointerCapture(event.pointerId)) return;
      const [x, y] = point(event);
      const round = (number) => Math.round(number * 100) / 100;
      const left = round(Math.min(x, start[0]));
      const top = round(Math.min(y, start[1]));
      const width = round(Math.max(x, start[0]) - left);
      const height = round(Math.max(y, start[1]) - top);
      if (!width || !height) return;
      [left, top, width, height].forEach((value, index) => { bounds[index].value = value; });
      controls.crop.checked = true;
      showOutline();
    });
    image.addEventListener("lostpointercapture", () => { start = null; });
    showImage();
  }

  function validImageUrl(value) {
    try { return ["http:", "https:", "file:"].includes(new URL(value, document.baseURI).protocol); }
    catch { return false; }
  }

  async function makeImageWebp(source, crop) {
    let image;
    let temporary;
    try {
      if (source instanceof Blob) {
        temporary = URL.createObjectURL(source);
        source = temporary;
      }
      image = new Image();
      if (!temporary && /^https?:/.test(new URL(source, document.baseURI).protocol)) image.crossOrigin = "anonymous";
      image.src = source;
      await image.decode();
      const [x, y, w, h] = crop || [0, 0, 100, 100];
      const [left, top, width, height] = [x * image.naturalWidth / 100, y * image.naturalHeight / 100,
        w * image.naturalWidth / 100, h * image.naturalHeight / 100];
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width));
      canvas.height = Math.max(1, Math.round(height));
      canvas.getContext("2d").drawImage(image, left, top, width, height, 0, 0, canvas.width, canvas.height);
      return window.bookArchive.encodeWebp(canvas);
    } catch {
      throw new Error("Could not read this image for cropping or export. Upload the image file if the host blocks access.");
    } finally {
      if (temporary) URL.revokeObjectURL(temporary);
    }
  }

  function ensureAsset(src, alt, role) {
    const assets = new Map(state.bookPackage.assets.map((asset) => [asset.id, asset]));
    const id = getAssetId(alt, src, assets);
    if (assets.size > state.bookPackage.assets.length) state.bookPackage.assets.push({ ...assets.get(id), role });
    return id;
  }

  function webpName(value, except) {
    const { uniqueWebpName, reservedImagePaths } = window.bookArchive;
    const used = new Set([...reservedImagePaths(state.bookPackage.assets)].map((path) => path.slice("images/".length)));
    for (const [key, image] of state.recoveredImages) if (key !== except) used.add(image.fileName.toLowerCase());
    return uniqueWebpName(value, used) || uniqueWebpName("image", used);
  }

  function sectionEnd(blocks, index) {
    let end = index + 1;
    while (end < blocks.length && !(!blocks[end].statBlock && blocks[end].type === "heading" && blocks[end].level <= 3)) end += 1;
    return end;
  }

  function splitSections(blocks) {
    const parts = [];
    for (let index = 0; index < blocks.length;) {
      const block = blocks[index];
      const section = !block.statBlock && block.type === "heading" && block.level === 3;
      const end = section ? sectionEnd(blocks, index) : index + 1;
      parts.push({ title: section ? block.text : "", blocks: blocks.slice(index, end) });
      index = end;
    }
    return parts;
  }

  function orderSections(parts, ordered) {
    let cursor = 0;
    return parts.flatMap((part) => part.title ? ordered[cursor++].blocks : part.blocks);
  }

  function organizeBook() {
    if (!currentEntry()) return;
    const entry = currentEntry();
    const entries = [...state.entries];
    let draftBlocks = [...entry.blocks];
    let scope = "entries";
    open("Organize book", `
      <label>Organize <select name="scope"><option value="entries">Book entries</option><option value="sections">Sections in ${escapeHtml(entry.title)}</option><option value="headings">Headings and content in this entry</option></select></label>
      <p>Remove deletes the heading and all its content when you apply changes. Close to discard pending changes.</p>
      <p id="headingOrderHint" hidden>Move a heading with its content and subheadings using the arrows or drag it beside another heading in the same group.</p>
      <button id="sortBookEntries" type="button">Sort alphabetically</button>
      <ol id="bookOrderRows" class="book-order-list" aria-label="Order"></ol>
      <div class="book-edit-actions"><button type="submit" value="save">Apply changes</button></div>`, () => {
      save(entries.map((item) => item === entry ? { ...item, blocks: draftBlocks } : item), "Book organization updated.");
    });
    const render = () => {
      $("#headingOrderHint").hidden = scope !== "headings";
      const list = $("#bookOrderRows");
      if (scope === "headings") {
        const root = headingGroups(draftBlocks);
        const sync = () => { draftBlocks = flattenHeadingGroup(root); };
        const renderGroups = (list, parent) => renderOrder(list, parent.children, ({ heading }) => heading.text, (row, group) => {
          const level = document.createElement("small");
          level.textContent = `H${group.heading.level} `;
          row.firstElementChild.prepend(level);
          row.append(editorButton("Remove", `Remove ${group.heading.text} and content`, () => {
            parent.children.splice(parent.children.indexOf(group), 1);
            sync();
            render();
          }));
          if (group.children.length) {
            const children = document.createElement("ol");
            children.className = "book-order-list book-heading-children";
            children.setAttribute("aria-label", `${group.heading.text} subheadings`);
            row.append(children);
            renderGroups(children, group);
          }
        }, sync);
        renderGroups(list, root);
        return;
      }
      const parts = splitSections(draftBlocks);
      const items = scope === "entries" ? entries : parts.filter((part) => part.title);
      renderOrder(list, items, ({ title }) => title, (row, item) => {
        row.append(editorButton("Remove", `Remove ${item.title} and content`, () => {
          if (scope === "entries") entries.splice(entries.indexOf(item), 1);
          else draftBlocks = draftBlocks.filter((block) => !item.blocks.includes(block));
          render();
        }));
      }, (ordered) => {
        if (scope === "sections") draftBlocks = orderSections(parts, ordered);
      });
    };
    form.elements.scope.addEventListener("change", () => {
      scope = form.elements.scope.value;
      $("#sortBookEntries").hidden = scope !== "entries";
      render();
    });
    $("#sortBookEntries").addEventListener("click", () => {
      entries.sort((first, second) => first.title.localeCompare(second.title, undefined, { sensitivity: "base", numeric: true }));
      render();
    });
    render();
  }

  function headingGroups(blocks) {
    const root = { blocks: [], children: [] };
    const stack = [root];
    const lead = Math.max(0, entryHeadingIndex(blocks, entryHeadingLevel(state.config)));
    for (const [index, block] of blocks.entries()) {
      if (block.statBlock || block.type !== "heading" || index <= lead) {
        stack.at(-1).blocks.push(block);
        continue;
      }
      while (stack.length > 1 && stack.at(-1).heading.level >= block.level) stack.pop();
      const group = { heading: block, blocks: [block], children: [] };
      stack.at(-1).children.push(group);
      stack.push(group);
    }
    return root;
  }

  function flattenHeadingGroup(group) {
    return [...group.blocks, ...group.children.flatMap(flattenHeadingGroup)];
  }

  function renderOrder(list, items, title, extra = () => {}, onOrder) {
    const render = () => renderOrder(list, items, title, extra, onOrder);
    function move(from, to) {
      if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
      items.splice(to, 0, items.splice(from, 1)[0]);
      onOrder?.(items);
      render();
    }
    list.replaceChildren(...items.map((item, index) => {
      const row = document.createElement("li");
      row.draggable = true;
      row.innerHTML = `<span>${escapeHtml(title(item))}</span><button type="button" aria-label="Move ${escapeAttribute(title(item))} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" aria-label="Move ${escapeAttribute(title(item))} down" ${index === items.length - 1 ? "disabled" : ""}>↓</button>`;
      const [, up, down] = row.children;
      for (const [button, offset] of [[up, -1], [down, 1]]) button.addEventListener("click", () => {
        move(index, index + offset);
        const controls = list.children[index + offset].querySelectorAll("button:not(:disabled)");
        controls[0]?.focus();
      });
      row.addEventListener("dragstart", (event) => {
        event.stopPropagation();
        draggedOrder = { list, index };
        event.dataTransfer.setData("application/x-book-order", String(index));
      });
      row.addEventListener("dragend", (event) => {
        event.stopPropagation();
        draggedOrder = null;
      });
      row.addEventListener("dragover", (event) => {
        event.stopPropagation();
        if (draggedOrder?.list === list) event.preventDefault();
      });
      row.addEventListener("drop", (event) => {
        event.stopPropagation();
        if (draggedOrder?.list !== list) return;
        event.preventDefault();
        move(draggedOrder.index, index);
        draggedOrder = null;
      });
      extra(row, item);
      return row;
    }));
    if (!items.length) {
      const empty = document.createElement("li");
      empty.textContent = "No items in this view.";
      list.append(empty);
    }
  }

  function sectionName(title) { return title.trim().normalize("NFKC").toLowerCase(); }

  function editSectionRules() {
    if (!state.bookPackage) return;
    const names = new Map();
    for (const entry of state.entries) for (const { title } of splitSections(entry.blocks)) {
      if (!title) continue;
      const key = sectionName(title);
      if (!names.has(key)) names.set(key, { key, title, count: 0, hidden: hiddenSections.has(key) });
      names.get(key).count += 1;
    }
    const rows = [...new Set([...order, ...names.keys()])].filter((key) => names.has(key)).map((key) => names.get(key));
    open("Section rules", `<p>Order recurring H3 sections and choose which ones to hide in the player edition. Individual sections can override this in the preview editor.</p>
      <ol id="sectionRuleRows" class="book-order-list" aria-label="Section rules"></ol>
      <div class="book-edit-actions"><button type="submit" value="save">Apply rules</button></div>`, () => {
      order = rows.map(({ key }) => key);
      hiddenSections = new Set(rows.filter(({ hidden }) => hidden).map(({ key }) => key));
      const positions = new Map(order.map((key, index) => [key, index]));
      save(state.entries.map((entry) => {
        const parts = splitSections(entry.blocks);
        const sections = parts.filter((part) => part.title).sort((a, b) => positions.get(sectionName(a.title)) - positions.get(sectionName(b.title)));
        return { ...entry, blocks: orderSections(parts, sections) };
      }), "Section rules applied.");
    });
    renderOrder($("#sectionRuleRows"), rows, ({ title, count }) => `${title} (${count})`, (row, item) => {
      const label = document.createElement("label");
      label.className = "book-edit-check";
      label.innerHTML = `<input type="checkbox" ${item.hidden ? "checked" : ""}> Hide from players`;
      label.querySelector("input").addEventListener("change", ({ target }) => { item.hidden = target.checked; });
      row.append(label);
    });
  }

  function reviewSourceItems() {
    if (!state.bookPackage) return;
    const groups = new Map();
    function collect(kind, label, item) {
      const key = `${kind}:${sectionName(label)}`;
      if (!groups.has(key)) groups.set(key, { kind, label, items: [] });
      groups.get(key).items.push(item);
    }
    const locations = new Map();
    const headings = new Map();
    for (const entry of state.entries) {
      for (const block of entry.blocks) {
        if (block[sourceArtifact]) locations.set(block[sourceArtifact], { entry, block });
        if (block[sourceHeadingKey]) headings.set(block[sourceHeadingKey], entry);
        const image = block[markdownImage];
        if (image && !block[sourceArtifact]) collect("image", image.alt || image.url, { entry, block });
      }
    }
    for (const entry of state.entries) {
      for (const artifact of entry[sourceArtifact] || []) {
        const location = locations.get(artifact) || { entry: headings.get(artifact.anchor) || entry };
        collect(artifact.image ? "image" : "directive", artifact.label, { ...location, artifact });
      }
    }
    const list = [...groups.values()];
    open("Homebrewery items", `<p>Set a rule for artwork with the same label or for a recurring source directive.</p>
      ${list.length ? `<ul class="book-source-list">${list.map(({ kind, label, items }, index) => `<li><label><span>${escapeHtml(label)} <small>${kind === "image" ? "Image" : "Directive"} · ${items.length} · ${items.filter(({ block }) => block && !block[sourceHidden]).length} shown</small></span>
        <select name="source-${index}">${displayOptions([["", "Leave as is"], ["hide", "Hide"], ...(kind === "image" ? [["keep", "Keep as inline artwork"]] : [["callout", "Convert to callout"], ["divider", "Convert to separator"]])], "")}</select></label></li>`).join("")}</ul>` : "<p>No Homebrewery items were found.</p>"}
      ${list.length ? '<div class="book-edit-actions"><button type="submit" value="save">Apply source rules</button></div>' : ""}`, () => {
      const choices = list.flatMap(({ items }, index) => {
        const choice = form.elements[`source-${index}`].value;
        return choice ? items.map((item) => ({ ...item, choice })) : [];
      });
      const entries = state.entries.map((entry) => {
        const blocks = [...entry.blocks];
        for (const { artifact, block, choice } of choices.filter((choice) => choice.entry === entry)) {
          if (choice === "hide" && !block) continue;
          if (choice === "hide" || choice === "keep" && block) {
            const updated = { ...block, [sourceHidden]: choice === "hide" };
            if (choice === "keep") {
              updated.placement = "inline";
              delete updated.className;
              delete updated.width;
            }
            blocks[blocks.indexOf(block)] = updated;
            continue;
          }
          const source = artifact.image;
          const role = source?.fullPage ? "full-page" : source && imageRole(source.alt);
          const converted = source ? { type: "image", role, placement: "inline", [markdownImage]: source,
            assetId: ensureAsset(source.url, source.alt, role) }
            : choice === "divider" ? { type: "divider", style: "rule" }
              : { type: "paragraph", style: "book-callout", text: artifact.text || artifact.label };
          converted[sourceArtifact] = artifact;
          const group = block?.statBlock || blocks.find((item) => artifact.anchor && item[sourceHeadingKey] === artifact.anchor)?.statBlock;
          if (group) converted.statBlock = group;
          const at = block ? blocks.indexOf(block) : sourceInsertIndex(blocks, artifact);
          blocks.splice(at, block ? 1 : 0, converted);
        }
        return { ...entry, blocks };
      });
      if (choices.length) save(entries, "Homebrewery rules applied.");
      else dialog.close();
    });
  }

  function sourceInsertIndex(blocks, artifact) {
    let start = artifact.anchor ? blocks.findIndex((block) => block[sourceHeadingKey] === artifact.anchor) : -1;
    if (start < 0 && artifact.heading) start = blocks.findIndex((block) => block.type === "heading" && block.text === artifact.heading);
    const next = blocks.findIndex((block, index) => index > start && block.type === "heading");
    return next === -1 ? blocks.length : next;
  }

  function exportPackage() {
    const book = state.bookPackage;
    if (!book) return null;
    const player = $("#exportEdition").value === "player";
    if (!player && !state.visualEdits) return book;
    const referenced = new Set();
    const entries = book.entries.map((entry) => {
      const parts = player ? splitSections(entry.blocks).filter(({ title, blocks: [heading] }) =>
        !title || heading[sectionVisibility] === "include" ||
        (heading[sectionVisibility] !== "exclude" && !hiddenSections.has(sectionName(title)))) : [{ blocks: entry.blocks }];
      const blocks = parts.flatMap(({ blocks }) => blocks.filter((block) => !block[sourceHidden]));
      for (const block of blocks) if (block.type === "image") referenced.add(block.assetId);
      return { ...entry, blocks };
    });
    return { ...book, entries, assets: book.assets.filter(({ id }) => referenced.has(id)) };
  }
})();

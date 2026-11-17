(() => {
  const dialog = $("#bookEditing");
  const form = $("#bookEditingForm");
  const fields = $("#bookEditingFields");
  const message = $("#bookEditingStatus");
  const toggle = $("#toggleBookEditing");
  let action;
  let order;
  let hiddenSections;
  let active = false;
  let releaseImagePreview;

  window.bookEditing = { reset, wrapBlock, exportPackage, get active() { return active; } };
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
      if (bookEdit !== undefined && currentEntry().blocks[index]?.type === "image") editImage(index);
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
    $("#exportEdition").value = "full";
  }

  function currentEntry() { return state.entries[state.currentPage]; }

  function open(title, html, apply) {
    releaseImagePreview?.();
    releaseImagePreview = null;
    $("#bookEditingTitle").textContent = title;
    fields.innerHTML = html;
    message.textContent = "";
    action = apply;
    if (!dialog.open) dialog.showModal();
  }

  function save(entries, notice) {
    dialog.close();
    applyEditedEntries(entries, { keepHeadingHistory: false });
    showNotice(notice);
  }

  function wrapBlock(block, index, content) {
    const editable = ["paragraph", "heading", "image"].includes(block.type);
    const label = block.type === "image" ? "Edit image" : block.type === "heading" ? "Edit heading" : "Edit text";
    const control = editable ? `<button type="button" data-book-edit="${index}">${label}</button>` : "";
    return `<div class="book-edit-block"${editable ? ` data-edit-block="${index}"` : ""}>${content}<div class="book-block-actions">${control}<button type="button" data-book-add="${index + 1}">Add below</button></div></div>`;
  }

  function withBlocks(entry, blocks) {
    return state.entries.map((candidate) => candidate === entry ? { ...entry, blocks } : candidate);
  }

  function displayOptions(options, selected) {
    return options.map(([value, label]) => `<option value="${escapeAttribute(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
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
      block.type === selected.type && !block[sourceHidden] ? [{ entry: item, index, block }] : []));
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
          .map(({ blocks }) => blocks.filter((block) => block.type === "paragraph" && !block[sourceHidden])[section.number - 1])));
        add("section-position", `Paragraph ${section.number} under ${section.title}`, ({ block }) => atPosition.has(block));
      }
      add("paragraph-style", "Same paragraph format across the book", ({ block }) => (block.style || "") === (selected.style || ""));
    }
    return matches;
  }

  function paragraphPosition(entry, index) {
    let number = 0;
    for (let previous = index; previous >= 0; previous -= 1) {
      const block = entry.blocks[previous];
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
    const format = block?.type === "heading" ? `h${block.level}` : block?.style || "paragraph";
    const isSection = block?.type === "heading" && block.level === 3;
    const formats = [["paragraph", "Paragraph"], ["book-quote", "Quote"], ["book-callout", "Callout"],
      ...[1, 2, 3, 4, 5, 6].map((level) => [`h${level}`, `Heading H${level}`])];
    if (!formats.some(([value]) => value === format)) formats.push([format, "Current style"]);
    if (add) formats.push(["image", "Image"]);
    const otherEntries = state.entries.filter((item) => item !== entry).map(({ id, title }) => [id, title]);
    const scopes = add ? new Map() : editScope(entry, index);
    open(add ? "Add a block" : "Edit preview block", `
      <label>Format <select name="format">${displayOptions(formats, format)}</select></label>
      <label id="editTextField">Text <textarea name="text" rows="6" dir="auto" required>${escapeHtml(block?.text || "")}</textarea></label>
      ${isSection ? `<label>Player edition <select name="visibility">${displayOptions([["default", "Follow section rule"], ["include", "Include this section"], ["exclude", "Hide this section"]], block[sectionVisibility] || "default")}</select></label>
        ${otherEntries.length ? `<label>Move section to <select name="destination">${displayOptions([["", "Keep in this entry"], ...otherEntries], "")}</select></label>` : ""}` : ""}
      ${scopeField(scopes, block?.type === "paragraph")}
      <div class="book-edit-actions">
        <button type="submit" value="save">${add ? "Add block" : "Save edits"}</button>
        ${block?.type === "paragraph" ? '<button type="submit" value="selection">Format selected text</button>' : ""}
        ${!add ? '<button type="submit" value="remove" formnovalidate>Remove block</button>' : ""}
      </div>`, (command) => {
      const scope = form.elements.scope?.value || "single";
      if (scope !== "single") {
        editMatchingText(scopes.get(scope).targets, block, command);
        return;
      }
      const selected = form.elements.format.value;
      if (selected === "image") { editImage(index, true); return; }
      const textField = form.elements.text;
      const value = textField.value;
      if (command !== "remove" && !value.trim()) throw new Error("Enter some text.");
      let replacement = [];
      if (command === "selection") {
        const { selectionStart: start, selectionEnd: end } = textField;
        if (!value.slice(start, end).trim()) throw new Error("Select the words to format in the text field.");
        replacement = [value.slice(0, start), value.slice(start, end), value.slice(end)]
          .flatMap((part, partIndex) => part.trim() ? [formatTextBlock(part, partIndex === 1 ? selected : format)] : []);
      } else if (command !== "remove") {
        replacement = /^h[1-6]$/.test(selected) ? [formatTextBlock(value, selected)]
          : value.split(/\n\s*\n/).filter((text) => text.trim()).map((text) => formatTextBlock(text, selected));
      }
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
      if (command === "save" && block?.type === "heading" && replacement[0]?.type === "heading" &&
        (block.level === entryLevel || replacement[0].level === entryLevel)) {
        const edit = { title: replacement[0].text, level: replacement[0].level };
        entries = regroupEditedHeadings(new Map([[block, edit]]));
      } else {
        const newEntryHeading = replacement.find((part) => part.type === "heading" && part.level === entryLevel);
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
      const image = selector.value === "image";
      $("#editTextField").hidden = image;
      form.elements.text.required = !image;
    });
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
        if (part.type !== "heading" || part.level !== entryLevel && (index !== 0 || block.level !== entryLevel)) continue;
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
    const trimmed = text.trim();
    return /^h[1-6]$/.test(format)
      ? { type: "heading", level: Number(format[1]), text: trimmed.replace(/\s*\n\s*/g, " ") }
      : { type: "paragraph", text: trimmed, ...(format !== "paragraph" && { style: format }) };
  }

  function editImage(index, add = false) {
    const entry = currentEntry();
    const block = add ? null : entry.blocks[index];
    const asset = state.bookPackage.assets.find(({ id }) => id === block?.assetId);
    const recovered = block && state.previewImages.get(block);
    const defaultAlt = recovered?.caption ?? asset?.alt ?? "";
    const imageSource = recovered?.url || asset?.src || "";
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
      const first = blocks[0]?.type === "heading" && blocks[0].level === entryHeadingLevel(state.config) ? 1 : 0;
      const positions = { same: index, above: Math.max(first, index - 1), below: index + 1, top: first, bottom: blocks.length };
      blocks.splice(positions[position], 0, image);
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
      const source = changes.file || changes.url || recovery?.blob || original?.src;
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

  function positionImages(blocks, moved, position) {
    if (position === "same") return blocks;
    const first = blocks[0]?.type === "heading" && blocks[0].level === entryHeadingLevel(state.config) ? 1 : 0;
    if (position === "top" || position === "bottom") {
      const images = blocks.filter((block) => moved.has(block));
      const remaining = blocks.filter((block) => !moved.has(block));
      remaining.splice(position === "top" ? first : remaining.length, 0, ...images);
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
    while (end < blocks.length && !(blocks[end].type === "heading" && blocks[end].level <= 3)) end += 1;
    return end;
  }

  function splitSections(blocks) {
    const parts = [];
    for (let index = 0; index < blocks.length;) {
      const block = blocks[index];
      const section = block.type === "heading" && block.level === 3;
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
    const parts = splitSections(entry.blocks);
    const sections = parts.filter((part) => part.title);
    let scope = "entries";
    open("Organize book", `
      <label>Reorder <select name="scope"><option value="entries">Book entries</option><option value="sections">Sections in ${escapeHtml(entry.title)}</option></select></label>
      <button id="sortBookEntries" type="button">Sort alphabetically</button>
      <ol id="bookOrderRows" class="book-order-list" aria-label="Order"></ol>
      <div class="book-edit-actions"><button type="submit" value="save">Apply order</button></div>`, () => {
      const blocks = orderSections(parts, sections);
      save(entries.map((item) => item === entry ? { ...item, blocks } : item), "Book order updated.");
    });
    const render = () => renderOrder($("#bookOrderRows"), scope === "entries" ? entries : sections, ({ title }) => title);
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

  function renderOrder(list, items, title, extra = () => {}) {
    const render = () => renderOrder(list, items, title, extra);
    function move(from, to) {
      if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return;
      items.splice(to, 0, items.splice(from, 1)[0]);
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
      row.addEventListener("dragstart", (event) => event.dataTransfer.setData("application/x-book-order", String(index)));
      row.addEventListener("dragover", (event) => {
        if (event.dataTransfer.types.includes("application/x-book-order")) event.preventDefault();
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        const from = event.dataTransfer.getData("application/x-book-order");
        if (from) move(Number(from), index);
      });
      extra(row, item);
      return row;
    }));
    if (!items.length) {
      const empty = document.createElement("li");
      empty.textContent = "No H3 sections in this view.";
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
          const converted = source ? { type: "image", role: imageRole(source.alt), placement: "inline", [markdownImage]: source,
            assetId: ensureAsset(source.url, source.alt, imageRole(source.alt)) }
            : choice === "divider" ? { type: "divider", style: "rule" }
              : { type: "paragraph", style: "book-callout", text: artifact.text || artifact.label };
          converted[sourceArtifact] = artifact;
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

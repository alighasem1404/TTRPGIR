// Restore only the grouping metadata from the reference Markdown. The text,
// tables, and images of the open (possibly edited) book remain authoritative.
function statRestoreKey(block, assets) {
  if (!block) return "";
  if (block.type === "link" || block.type === "paragraph" && parseStandaloneBookLink(block.text)) return restoreAnchorKey(block);
  if (block.type === "heading") return `heading:${restoreTextKey(block.text)}`;
  if (block.type === "paragraph") return `p:${restoreTextKey(block.text).replace(/:+/g, " ").replace(/\s+/g, " ").trim()}`;
  if (block.type === "image") return `image:${restoreUrlKey(block[markdownImage]?.url || block[imageSlotContext]?.url || assets.get(block.assetId)?.src)}`;
  if (block.type === "divider") return `divider:${block.style || ""}`;
  return restoreAnchorKey(block);
}

// Reproduce the former heading-based entry IDs, not the former content. This
// lets us recognize a renamed monster entry without replacing its edited text.
function legacyStatEntrySpecs(markdown, config) {
  const body = prepareSourcePages(markdown.slice(markdownHeader(markdown).end).trim());
  const wrappers = findStatBlockRanges(body);
  const level = entryHeadingLevel(config);
  let partStart;
  const matches = [];
  for (const heading of findMarkdownHeadings(body)) {
    if (heading.level === level) {
      matches.push({ heading, start: partStart ?? heading.index });
      partStart = undefined;
    } else if (heading.level === 1 && level > 1) partStart ??= heading.index;
  }
  const specs = [];
  if (matches.length && body.slice(0, matches[0].start).trim()) specs.push({ id: "welcome-1", title: "Welcome" });
  for (const { heading } of matches) {
    const title = stripMarkup(heading.title);
    specs.push({ id: `${slugify(title) || "entry"}-${specs.length + 1}`, title, stat: Boolean(heading.statBlock),
      wrapper: wrappers.findIndex((range) => heading.index >= range.start && heading.index < range.end) });
  }
  return specs;
}

function referenceStatGroups(reference, level) {
  const groups = [];
  for (const [entryIndex, entry] of reference.entries.entries()) {
    for (let start = 0; start < entry.blocks.length;) {
      const id = entry.blocks[start].statBlock;
      if (!id) { start += 1; continue; }
      let end = start + 1;
      while (end < entry.blocks.length && entry.blocks[end].statBlock === id) end += 1;
      const blocks = entry.blocks.slice(start, end);
      const heading = blocks.find((block) => block.type === "heading" && block.level === level) || blocks.find((block) => block.type === "heading");
      groups.push({ id, entry, entryIndex, start, end, blocks, heading, name: heading?.text || `Stat block ${groups.length + 1}` });
      start = end;
    }
  }
  return groups;
}

function scanRestoreStatBlocks(book, markdown, fileName, config = {}, reference) {
  const profile = restoreConversionConfig(config);
  const level = entryHeadingLevel(profile);
  reference ||= buildBookPackage(markdown, fileName, parseDocument(markdown, profile), profile);
  const sourceGroups = referenceStatGroups(reference, level);
  const sourceAssets = new Map(reference.assets.map((asset) => [asset.id, asset]));
  const assets = new Map(book.assets.map((asset) => [asset.id, asset]));
  const specs = legacyStatEntrySpecs(markdown, profile);
  const specById = new Map(specs.map((spec, index) => [spec.id, { ...spec, index }]));
  const specByName = new Map();
  const seenWrappers = new Set();
  for (const [index, spec] of specs.entries()) {
    if (!spec.stat || seenWrappers.has(spec.wrapper)) continue;
    seenWrappers.add(spec.wrapper);
    const key = restoreTextKey(spec.title);
    if (!specByName.has(key)) specByName.set(key, []);
    specByName.get(key).push({ ...spec, index });
  }
  const occurrences = new Map();
  const titleCounts = new Map();
  const firstCounts = new Map();
  for (const group of sourceGroups) {
    const key = restoreTextKey(group.name);
    titleCounts.set(key, (titleCounts.get(key) || 0) + 1);
    const first = statRestoreKey(group.blocks[0], sourceAssets);
    if (first) firstCounts.set(first, (firstCounts.get(first) || 0) + 1);
  }
  const existingGroups = new Set(book.entries.flatMap((entry) => entry.blocks.map((block) => block.statBlock).filter(Boolean)));
  const candidates = [];
  let presentCount = 0;
  for (const group of sourceGroups) {
    const key = restoreTextKey(group.name);
    const occurrence = occurrences.get(key) || 0;
    occurrences.set(key, occurrence + 1);
    const legacy = specByName.get(key)?.[occurrence];
    if (existingGroups.has(group.id)) { presentCount += 1; continue; }
    const named = book.entries.flatMap((entry, entryIndex) => entry.blocks.flatMap((block, position) =>
      block.type === "heading" && restoreTextKey(block.text) === key ? [{ entryIndex, position, block }] : []));
    if (titleCounts.get(key) === 1 && named.length === 1 && named[0].block.statBlock) { presentCount += 1; continue; }
    const legacyIndex = legacy ? book.entries.findIndex((entry) => entry.id === legacy.id) : -1;
    let entryIndex;
    let start;
    let exactLegacy = false;
    if (legacyIndex >= 0) {
      entryIndex = legacyIndex;
      const entry = book.entries[entryIndex];
      const match = named.filter((item) => item.entryIndex === entryIndex && !item.block.statBlock);
      start = match.length === 1 ? match[0].position : entry.blocks.findIndex((block) => !block.statBlock && block.type === "heading" && block.level === level);
      if (start < 0) start = undefined;
      if (start !== undefined && entry.blocks[start].statBlock) { presentCount += 1; continue; }
      exactLegacy = start !== undefined;
    } else if (titleCounts.get(key) === 1 && named.length === 1 && !named[0].block.statBlock) {
      entryIndex = named[0].entryIndex;
      start = named[0].position;
    }
    if (start === undefined) {
      const first = statRestoreKey(group.blocks[0], sourceAssets);
      if (first && !first.startsWith("divider:") && firstCounts.get(first) === 1) {
        const matches = book.entries.flatMap((entry, index) => entry.blocks.flatMap((block, position) =>
          statRestoreKey(block, assets) === first ? [{ entryIndex: index, position, block }] : []));
        if (matches.length === 1) {
          if (matches[0].block.statBlock) { presentCount += 1; continue; }
          entryIndex = matches[0].entryIndex;
          start = matches[0].position;
        }
      }
    }

    let end;
    let endEntryIndex = entryIndex;
    let confidence = false;
    let reason = "No reliable match. Choose an existing entry and the exact stat-block range.";
    let canMerge = false;
    let mergeRecommended = false;
    let legacyLead = -1;
    if (entryIndex !== undefined && start !== undefined) {
      const entry = book.entries[entryIndex];
      const keys = entry.blocks.map((block) => statRestoreKey(block, assets));
      const firstKey = statRestoreKey(group.blocks[0], sourceAssets);
      // If the source has text before its name, include it only when we can
      // identify that earlier boundary. Otherwise leave the range for review.
      let startConfirmed = group.blocks[0] === group.heading;
      if (!startConfirmed && firstKey) {
        const before = keys.slice(0, start + 1).map((value, index) => value === firstKey ? index : -1).filter((index) => index >= 0);
        if (before.length === 1) { start = before[0]; startConfirmed = true; }
      }
      // Older importers could split one wrapper at multiple internal H2s.
      // Follow only an intact, consecutive chain of its original entry IDs.
      let brokenLegacyChain = false;
      if (exactLegacy && legacy.wrapper >= 0) {
        const chain = specs.slice(legacy.index + 1).filter((spec) => spec.wrapper === legacy.wrapper);
        if (chain.length) {
          if (chain.every((spec, offset) => book.entries[entryIndex + offset + 1]?.id === spec.id)) endEntryIndex = entryIndex + chain.length;
          else brokenLegacyChain = true;
        }
      }
      const closingEntry = book.entries[endEntryIndex];
      const closingKeys = endEntryIndex === entryIndex ? keys : closingEntry.blocks.map((block) => statRestoreKey(block, assets));
      const closingStart = endEntryIndex === entryIndex ? start : Math.max(0, entryHeadingIndex(closingEntry.blocks, level));
      const findAfter = (expected) => {
        const target = statRestoreKey(expected, sourceAssets);
        if (!target) return undefined;
        const matches = closingKeys.map((value, index) => index >= closingStart && value === target ? index : -1).filter((index) => index >= 0);
        return matches.length === 1 ? matches[0] : undefined;
      };
      const last = findAfter(group.blocks.at(-1));
      const after = group.entry.blocks[group.end];
      const next = findAfter(after);
      const nextEntryBoundary = !after || after.type === "heading" && (after.level === level || after.level === 1);
      if (last !== undefined && (next === undefined || last < next)) {
        end = last + 1;
        confidence = startConfirmed;
        reason = "Matched the first and last source blocks.";
      } else if (next !== undefined && next > closingStart) {
        end = next;
        confidence = startConfirmed;
        reason = "Matched the next content outside the original wrapper.";
      } else if (exactLegacy && nextEntryBoundary && !closingEntry.blocks.slice(closingStart + 1).some((block) => block.type === "heading" && block.level === level)) {
        end = closingEntry.blocks.length;
        confidence = startConfirmed;
        reason = "Matched a legacy monster entry whose source wrapper ends at the entry boundary.";
      } else {
        reason = "Matched the monster heading, but its closing boundary is uncertain. Choose the last included block.";
      }
      if (brokenLegacyChain && last === undefined) {
        end = undefined;
        confidence = false;
        reason = "The source wrapper's legacy entries are no longer consecutive. Choose the full edited range manually.";
      }
      const proposed = { entryIndex, start, endEntryIndex, end };
      if (end !== undefined && statRestoreSegments(book, proposed).some(({ entryIndex: at, start: from, end: to }) => book.entries[at].blocks.slice(from, to).some((block) => block.statBlock))) {
        end = undefined;
        confidence = false;
        reason = "Existing stat grouping overlaps this range. Review the boundaries before applying.";
      }
      // A legacy entry started by the monster heading can be folded into its
      // predecessor without moving any content out of the book's current order.
      const lead = entryHeadingIndex(entry.blocks, level);
      legacyLead = lead;
      canMerge = entryIndex > 0 && (exactLegacy || restoreTextKey(entry.title) === key) && lead >= start && (endEntryIndex > entryIndex || end === undefined || lead < end);
      if (canMerge && exactLegacy && confidence) {
        const previous = book.entries[entryIndex - 1];
        const expectedPrevious = legacy.index > 0 ? specs[legacy.index - 1] : null;
        const previousSpec = specById.get(previous.id);
        const sameTitle = restoreTextKey(entry.title) === restoreTextKey(entry.blocks[lead]?.text);
        mergeRecommended = sameTitle && Boolean(expectedPrevious && (previous.id === expectedPrevious.id || previousSpec?.index === legacy.index - 1));
      }
    }
    candidates.push({ ...group, legacy, entryIndex, start, endEntryIndex, end, confidence, reason, canMerge, mergeRecommended, legacyLead });
  }
  return { candidates, sourceCount: sourceGroups.length, presentCount };
}

function statSelectionRange(row) {
  if (row.entrySelect.value === "" || row.startSelect.value === "" || row.endEntrySelect.value === "" || row.endSelect.value === "") return null;
  return { candidate: row.candidate, entryIndex: Number(row.entrySelect.value), start: Number(row.startSelect.value), endEntryIndex: Number(row.endEntrySelect.value), end: Number(row.endSelect.value), merge: row.merge.checked };
}

function statRestoreSegments(book, choice) {
  const endEntryIndex = choice.endEntryIndex ?? choice.entryIndex;
  const segments = [];
  for (let index = choice.entryIndex; index <= endEntryIndex; index += 1) {
    segments.push({ entryIndex: index, start: index === choice.entryIndex ? choice.start : 0,
      end: index === endEntryIndex ? choice.end : book.entries[index]?.blocks.length });
  }
  return segments;
}

function statRestoreMergeIndexes(choices) {
  const indexes = new Set();
  for (const choice of choices.filter(Boolean)) {
    if (choice.merge) indexes.add(choice.entryIndex);
    for (let index = choice.entryIndex + 1; index <= (choice.endEntryIndex ?? choice.entryIndex); index += 1) indexes.add(index);
  }
  return indexes;
}

function validStatRestoreRanges(book, choices) {
  const occupied = new Map();
  for (const choice of choices) {
    if (!choice) return false;
    const { entryIndex, start, end } = choice;
    const endEntryIndex = choice.endEntryIndex ?? entryIndex;
    if (!Number.isInteger(entryIndex) || !Number.isInteger(endEntryIndex) || entryIndex < 0 || endEntryIndex < entryIndex || endEntryIndex >= book.entries.length) return false;
    for (const { entryIndex: index, start: from, end: to } of statRestoreSegments(book, choice)) {
      const entry = book.entries[index];
      if (!entry || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > entry.blocks.length ||
          (index === entryIndex || index === endEntryIndex) && to === from) return false;
      if (entry.blocks.slice(from, to).some((block) => block.statBlock)) return false;
      const intervals = occupied.get(index) || [];
      if (intervals.some((range) => from < range.end && to > range.start)) return false;
      intervals.push({ start: from, end: to });
      occupied.set(index, intervals);
    }
    if (choice.merge && (!choice.candidate.canMerge || entryIndex !== choice.candidate.entryIndex || entryIndex === 0 ||
        choice.candidate.legacyLead < start || endEntryIndex === entryIndex && choice.candidate.legacyLead >= end)) return false;
  }
  return true;
}

function makeStatRestoreRow(candidate, book) {
  const item = document.createElement("li");
  item.className = "restore-stat-row";
  item.innerHTML = `<label class="restore-choice"><input type="checkbox" data-stat-restore-select> <strong>${escapeHtml(candidate.name)}</strong></label>
    <p class="heading-hint">Original entry: ${escapeHtml(candidate.entry.title)} · ${candidate.blocks.length} source content blocks</p>
    <p class="restore-match-note${candidate.confidence ? "" : " restore-needs-review"}">${escapeHtml(candidate.reason)}</p>
    <label>First included entry<select data-stat-restore-entry></select></label>
    <label>First included block<select data-stat-restore-start></select></label>
    <label>Last included entry<select data-stat-restore-end-entry></select></label>
    <label>Last included block<select data-stat-restore-end></select></label>
    <label class="restore-merge-choice" hidden><input type="checkbox" data-stat-restore-merge> <span data-stat-restore-merge-label></span></label>
    <p data-stat-restore-range class="heading-hint"></p>`;
  const checkbox = item.querySelector("[data-stat-restore-select]");
  const entrySelect = item.querySelector("[data-stat-restore-entry]");
  const startSelect = item.querySelector("[data-stat-restore-start]");
  const endEntrySelect = item.querySelector("[data-stat-restore-end-entry]");
  const endSelect = item.querySelector("[data-stat-restore-end]");
  const merge = item.querySelector("[data-stat-restore-merge]");
  const row = { candidate, checkbox, entrySelect, startSelect, endEntrySelect, endSelect, merge, item };
  entrySelect.append(new Option("Choose an entry", ""), ...book.entries.map((entry, index) => new Option(`${index + 1}. ${entry.title}`, String(index))));
  entrySelect.value = candidate.entryIndex === undefined ? "" : String(candidate.entryIndex);
  function labelBlock(block, position) { return `${position + 1}. ${restoreBlockLabel(block, book).replace(/\s+/g, " ").slice(0, 100)}`; }
  function fillEndBlocks(end) {
    endSelect.replaceChildren(new Option("Choose last block", ""));
    const entry = endEntrySelect.value === "" ? null : book.entries[Number(endEntrySelect.value)];
    endSelect.disabled = !entry;
    if (entry) for (const [position, block] of entry.blocks.entries()) endSelect.add(new Option(labelBlock(block, position), String(position + 1)));
    endSelect.value = end === undefined ? "" : String(end);
  }
  function fill(start, end, recommended, endEntryIndex) {
    startSelect.replaceChildren(new Option("Choose first block", ""));
    const index = entrySelect.value === "" ? -1 : Number(entrySelect.value);
    const entry = book.entries[index];
    startSelect.disabled = endEntrySelect.disabled = !entry;
    if (entry) for (const [position, block] of entry.blocks.entries()) startSelect.add(new Option(labelBlock(block, position), String(position)));
    startSelect.value = start === undefined ? "" : String(start);
    endEntrySelect.replaceChildren(new Option("Choose last entry", ""));
    if (entry) book.entries.slice(index).forEach((item, offset) => endEntrySelect.add(new Option(`${index + offset + 1}. ${item.title}`, String(index + offset))));
    endEntrySelect.value = entry ? String(endEntryIndex ?? index) : "";
    fillEndBlocks(end);
    const canMerge = candidate.canMerge && index === candidate.entryIndex;
    merge.closest("label").hidden = !canMerge;
    merge.checked = Boolean(canMerge && recommended);
    if (canMerge) item.querySelector("[data-stat-restore-merge-label]").textContent = `Merge legacy entry into preceding entry “${book.entries[index - 1].title}” (keep every block; remove only the old entry boundary).`;
    showRange();
  }
  function showRange() {
    const choice = statSelectionRange(row);
    const valid = choice && validStatRestoreRanges(book, [choice]);
    const count = valid ? statRestoreSegments(book, choice).reduce((sum, segment) => sum + segment.end - segment.start, 0) : 0;
    const boundaries = valid ? statRestoreMergeIndexes([choice]).size : 0;
    item.querySelector("[data-stat-restore-range]").textContent = valid
      ? `${count} existing blocks will be grouped.${boundaries ? ` ${boundaries} entry boundary(s) will be merged.` : ""} Their contents will not be replaced.`
      : "Choose a non-overlapping range of existing ungrouped blocks.";
  }
  fill(candidate.start, candidate.end, candidate.mergeRecommended, candidate.endEntryIndex);
  entrySelect.addEventListener("change", () => { fill(undefined, undefined, false); updateStatRestoreSelection(); });
  endEntrySelect.addEventListener("change", () => { fillEndBlocks(undefined); showRange(); updateStatRestoreSelection(); });
  for (const control of [checkbox, startSelect, endSelect, merge]) control.addEventListener("change", () => { showRange(); updateStatRestoreSelection(); });
  restoreDraft.statRows.push(row);
  return item;
}

function renderStatRestoreReview(result, book) {
  $("#restoreStatSummary").textContent = `${result.sourceCount} source stat block(s); ${result.presentCount} already grouped; ${result.candidates.length} to review.`;
  $("#restoreStatRows").replaceChildren(...result.candidates.map((candidate) => makeStatRestoreRow(candidate, book)));
  if (!result.candidates.length) {
    const item = document.createElement("li");
    item.className = "heading-hint";
    item.textContent = result.sourceCount ? "All source stat blocks are already grouped." : "No monster wrappers were found in this source.";
    $("#restoreStatRows").append(item);
  }
  updateStatRestoreSelection();
}

function updateStatRestoreSelection() {
  const rows = restoreDraft?.statRows || [];
  const selected = rows.filter((row) => row.checkbox.checked);
  const choices = selected.map(statSelectionRange);
  const valid = selected.length > 0 && validStatRestoreRanges(restoreDraft.book, choices);
  const mergeCount = statRestoreMergeIndexes(choices).size;
  const entryCount = restoreDraft?.book.entries.length || 0;
  $("#restoreStatSelection").textContent = `${selected.length} selected; ${mergeCount} legacy entry boundary(s) to merge${mergeCount ? `; entries ${entryCount} → ${entryCount - mergeCount}` : ""}${selected.length && !valid ? "; review invalid or overlapping ranges" : ""}.`;
  $("#applyStatRestore").disabled = !valid;
  $("#restoreStatClearSelection").disabled = !selected.length;
  $("#restoreStatSelectSuggested").disabled = !rows.some((row) => !row.checkbox.checked && row.candidate.confidence && validStatRestoreRanges(restoreDraft.book, [statSelectionRange(row)]));
}

function selectSuggestedStatRestores() {
  for (const row of restoreDraft?.statRows || []) {
    if (!row.candidate.confidence || !validStatRestoreRanges(restoreDraft.book, [statSelectionRange(row)])) continue;
    const existing = restoreDraft.statRows.filter((item) => item.checkbox.checked && item !== row).map(statSelectionRange);
    if (validStatRestoreRanges(restoreDraft.book, [...existing, statSelectionRange(row)])) row.checkbox.checked = true;
  }
  updateStatRestoreSelection();
}

function clearStatRestoreSelection() {
  for (const row of restoreDraft?.statRows || []) row.checkbox.checked = false;
  updateStatRestoreSelection();
}

function buildStatRestoredBook(book, choices) {
  if (!validStatRestoreRanges(book, choices)) throw new Error("Choose valid, non-overlapping stat-block ranges.");
  const tags = new Map();
  const mergeIndexes = statRestoreMergeIndexes(choices);
  const used = new Set(book.entries.flatMap((entry) => entry.blocks.map((block) => block.statBlock).filter(Boolean)));
  for (const choice of choices) {
    const { candidate } = choice;
    let id = candidate.id;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${candidate.id}-${suffix}`;
    used.add(id);
    for (const { entryIndex, start, end } of statRestoreSegments(book, choice)) {
      if (!tags.has(entryIndex)) tags.set(entryIndex, new Map());
      for (let position = start; position < end; position += 1) tags.get(entryIndex).set(position, id);
    }
  }
  const entries = [];
  const mergedEntries = new Map();
  for (const [index, original] of book.entries.entries()) {
    const positions = tags.get(index);
    const blocks = original.blocks.map((block, position) => positions?.has(position) ? { ...block, statBlock: positions.get(position) } : block);
    const entry = { ...original, blocks };
    if (mergeIndexes.has(index) && entries.length) {
      const previous = entries.at(-1);
      previous.blocks = [...previous.blocks, ...entry.blocks];
      if (entry[sourceArtifact]?.length) previous[sourceArtifact] = [...(previous[sourceArtifact] || []), ...entry[sourceArtifact]];
      mergedEntries.set(entry.id, previous.id);
    } else entries.push(entry);
  }
  return { book: { ...book, schemaVersion: Math.max(book.schemaVersion, 2), entries }, mergedEntries };
}

function applyStatRestore() {
  const draft = restoreDraft;
  const selected = draft?.statRows.filter((row) => row.checkbox.checked).map(statSelectionRange) || [];
  if (!draft || !selected.length || !validStatRestoreRanges(draft.book, selected)) return;
  if (restoreDraftChanged(draft)) {
    $("#restoreStatus").textContent = "The book changed during review. Scan the original Markdown again.";
    $("#restoreReview").hidden = true;
    restoreDraft = null;
    return;
  }
  try {
    const result = buildStatRestoredBook(draft.book, selected);
    validateBookPackage(result.book);
    const currentId = state.entries[state.currentPage]?.id;
    state.bookPackage = result.book;
    applyEditedEntries(result.book.entries, { keepHeadingHistory: false, preserveExistingData: true, currentEntryId: result.mergedEntries.get(currentId) || currentId });
    $("#bookRestore").close();
    showNotice(`Restored ${selected.length} stat block group(s); merged ${result.mergedEntries.size} legacy entry boundary(s). Existing content was kept. Export to save.`);
  } catch (error) {
    $("#restoreStatus").textContent = `Could not recover stat blocks. ${error.message}`;
  }
}

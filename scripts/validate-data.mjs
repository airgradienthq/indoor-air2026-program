import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDataDir = path.join(rootDir, "public", "data");
const dataDir = path.join(rootDir, "data");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function minutes(time) {
  const match = String(time ?? "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function failIf(condition, errors, message) {
  if (condition) errors.push(message);
}

const [events, presenters, searchDocs, sources, corrections] = await Promise.all([
  readJson(path.join(publicDataDir, "events.json")),
  readJson(path.join(publicDataDir, "presenters.json")),
  readJson(path.join(publicDataDir, "search-index.json")),
  readJson(path.join(publicDataDir, "sources.json")),
  readJson(path.join(dataDir, "corrections.json"))
]);

const errors = [];
const warnings = [];
const eventIds = new Set(events.map((event) => event.id));
const presenterIds = new Set(presenters.map((presenter) => presenter.id));
const eventById = new Map(events.map((event) => [event.id, event]));

failIf(!Array.isArray(events) || events.length === 0, errors, "events.json must contain events.");
failIf(!Array.isArray(presenters), errors, "presenters.json must contain an array.");
failIf(!Array.isArray(searchDocs) || searchDocs.length === 0, errors, "search-index.json must contain search documents.");

for (const event of events) {
  failIf(!event.id, errors, "Event missing id.");
  failIf(!event.title, errors, `Event ${event.id} missing title.`);
  failIf(!event.type, errors, `Event ${event.id} missing type.`);
  failIf(!event.sourceFile, errors, `Event ${event.id} missing sourceFile.`);
  failIf(!event.sourcePage, errors, `Event ${event.id} missing sourcePage.`);
  failIf(!event.sourceSnippet, errors, `Event ${event.id} missing sourceSnippet.`);

  const hasAnyTime = event.date || event.startTime || event.endTime;
  if (hasAnyTime) {
    failIf(event.timezone !== "Asia/Singapore", errors, `Event ${event.id} has wrong timezone.`);
    failIf(!/^\d{4}-\d{2}-\d{2}$/.test(event.date ?? ""), errors, `Event ${event.id} has invalid date.`);
    failIf(!/^\d{2}:\d{2}$/.test(event.startTime ?? ""), errors, `Event ${event.id} has invalid startTime.`);
    failIf(!/^\d{2}:\d{2}$/.test(event.endTime ?? ""), errors, `Event ${event.id} has invalid endTime.`);
    failIf(minutes(event.endTime) <= minutes(event.startTime), errors, `Event ${event.id} ends before it starts.`);
  }

  if (event.parentId) {
    failIf(!eventIds.has(event.parentId), errors, `Event ${event.id} references missing parentId ${event.parentId}.`);
    const parent = eventById.get(event.parentId);
    if (["talk", "poster"].includes(event.type) && parent?.type === "session") {
      failIf(event.date !== parent.date, errors, `${event.type} ${event.id} date differs from parent session ${event.parentId}.`);
      failIf(
        event.startTime !== parent.startTime || event.endTime !== parent.endTime,
        errors,
        `${event.type} ${event.id} time differs from parent session ${event.parentId}.`
      );
    }
  }
  for (const presenterId of event.presenterIds ?? []) {
    failIf(!presenterIds.has(presenterId), errors, `Event ${event.id} references missing presenter ${presenterId}.`);
  }
  for (const childId of event.childItemIds ?? []) {
    failIf(!eventIds.has(childId), errors, `Session ${event.id} references missing child item ${childId}.`);
  }

  if (["talk", "poster"].includes(event.type) && !event.paperId) {
    errors.push(`Paper item ${event.id} missing paperId.`);
  }
  if (event.type === "poster" && !event.posterPanel) {
    warnings.push(`Poster ${event.id} has no poster panel assignment.`);
  }
}

for (const presenter of presenters) {
  failIf(!presenter.id, errors, "Presenter missing id.");
  failIf(!presenter.displayName, errors, `Presenter ${presenter.id} missing displayName.`);
  for (const itemId of presenter.itemIds ?? []) {
    failIf(!eventIds.has(itemId), errors, `Presenter ${presenter.id} references missing item ${itemId}.`);
  }
}

for (const doc of searchDocs) {
  failIf(!doc.id, errors, "Search document missing id.");
  failIf(!doc.title, errors, `Search document ${doc.id} missing title.`);
  if (doc.itemId) failIf(!eventIds.has(doc.itemId), errors, `Search document ${doc.id} references missing item ${doc.itemId}.`);
  if (doc.presenterId) {
    failIf(!presenterIds.has(doc.presenterId), errors, `Search document ${doc.id} references missing presenter ${doc.presenterId}.`);
  }
}

const appliedCorrectionKeys = new Set(
  (sources.appliedCorrections ?? []).map((correction) => `${correction.kind}:${correction.from}`)
);
for (const [kind, map] of Object.entries(corrections)) {
  if (!map || typeof map !== "object") continue;
  for (const key of Object.keys(map)) {
    failIf(
      !appliedCorrectionKeys.has(`${kind}:${key}`) && kind !== "itemOverrides",
      errors,
      `Correction ${kind}.${key} did not match extracted data.`
    );
  }
}

const miniSearch = new MiniSearch({
  fields: ["title", "body", "keywords"],
  storeFields: ["title", "type", "itemId", "presenterId"]
});
miniSearch.addAll(searchDocs);
const sampleTalk = events.find((event) => event.type === "talk" && event.presentingAuthor);
const samplePoster = events.find((event) => event.type === "poster" && event.paperId);
const samplePresenter = presenters.find((presenter) => presenter.itemIds.length);
for (const term of [sampleTalk?.presentingAuthor, samplePoster?.paperId, samplePresenter?.displayName].filter(Boolean)) {
  const results = miniSearch.search(term, { prefix: true, fuzzy: 0.2 });
  failIf(results.length === 0, errors, `Known search term returned no results: ${term}`);
}

const report = [
  "# Validation Result",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  `- Errors: ${errors.length}`,
  `- Warnings: ${warnings.length}`,
  `- Events: ${events.length}`,
  `- Presenters: ${presenters.length}`,
  `- Search documents: ${searchDocs.length}`,
  "",
  "## Errors",
  "",
  ...(errors.length ? errors.map((error) => `- ${error}`) : ["No validation errors."]),
  "",
  "## Warnings",
  "",
  ...(warnings.length ? warnings.slice(0, 300).map((warning) => `- ${warning}`) : ["No validation warnings."])
];

await fs.writeFile(path.join(dataDir, "validation-result.md"), `${report.join("\n")}\n`);
await fs.writeFile(
  path.join(publicDataDir, "validation-report.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), errors, warnings }, null, 2)}\n`
);

if (errors.length) {
  console.error(`Validation failed with ${errors.length} error(s). See data/validation-result.md.`);
  process.exit(1);
}

console.log(`Validation passed with ${warnings.length} warning(s).`);

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const pdfDir = path.join(rootDir, "downloaded-pdfs");
const publicDataDir = path.join(rootDir, "public", "data");
const dataDir = path.join(rootDir, "data");
const timezone = "Asia/Singapore";

const sourceFiles = {
  programme: "Programme as at 12 June 2026_2008hrs.pdf",
  details: "Session details as at 12 June 2026_2008hrs.pdf",
  posters: "Poster Location - Panel Assignment - 12 June 2026.pdf",
  wayfinding: "Poster Location - Wayfinding - 12 June 2026.pdf"
};

const corrections = JSON.parse(
  await fs.readFile(path.join(dataDir, "corrections.json"), "utf8")
);
const appliedCorrections = [];

function clean(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(value) {
  const ascii = clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || "item";
}

function applyCorrection(kind, value) {
  const source = clean(value);
  const mapped = corrections[kind]?.[source];
  if (!mapped) return source;
  appliedCorrections.push({ kind, from: source, to: mapped });
  return mapped;
}

function lineText(line) {
  return clean(line.items.map((item) => item.str).join(" "));
}

function lineRange(line, minX, maxX) {
  return clean(
    line.items
      .filter((item) => item.x >= minX && item.x < maxX)
      .map((item) => item.str)
      .join(" ")
  );
}

function makeLines(items) {
  const lines = [];
  for (const item of items) {
    const str = clean(item.str);
    if (!str) continue;
    const y = Math.round(item.transform[5]);
    const x = Math.round(item.transform[4]);
    const width = Math.round(item.width ?? 0);
    let line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
    if (!line) {
      line = { y, items: [] };
      lines.push(line);
    }
    line.items.push({ str, x, y, width });
  }
  return lines
    .map((line) => ({
      y: line.y,
      items: line.items.sort((a, b) => a.x - b.x)
    }))
    .sort((a, b) => b.y - a.y)
    .map((line) => ({ ...line, text: lineText(line) }));
}

async function extractPdf(fileName) {
  const filePath = path.join(pdfDir, fileName);
  const data = new Uint8Array(await fs.readFile(filePath));
  const document = await pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true
  }).promise;

  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const items = content.items
      .filter((item) => clean(item.str))
      .map((item) => ({
        str: clean(item.str),
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5]),
        width: Math.round(item.width ?? 0),
        transform: item.transform
      }));
    const lines = makeLines(content.items);
    pages.push({
      pageNumber,
      items,
      lines,
      text: lines.map((line) => line.text).join("\n")
    });
  }

  return { fileName, pageCount: document.numPages, pages };
}

const sessionCodePattern = /^[A-Z][A-Z0-9]*-\d+(?:-\d{2})?$/;
const orderPattern = /^(?:Oral|Poster)-?X?\d{2}$/;
const paperIdPattern = /^\d{5}$/;

function firstInRange(line, minX, maxX, pattern) {
  return line.items.find((item) => item.x >= minX && item.x < maxX && pattern.test(item.str));
}

function isDetailRecordStart(line) {
  return Boolean(
    firstInRange(line, 20, 85, sessionCodePattern) &&
      firstInRange(line, 80, 135, orderPattern) &&
      firstInRange(line, 130, 180, paperIdPattern)
  );
}

function parseAuthorNames(authorText, presentingAuthor) {
  const names = clean(authorText)
    .split(";")
    .map((name) =>
      clean(name)
        .replace(/\([^)]*\d[^)]*\)/g, "")
        .replace(/[.;,]+$/g, "")
    )
    .filter((name) => name.length > 1);

  const presenter = clean(presentingAuthor).replace(/[.;,]+$/g, "");
  if (presenter && !names.some((name) => name.toLowerCase() === presenter.toLowerCase())) {
    names.push(presenter);
  }

  return [...new Set(names.map((name) => applyCorrection("presenterNames", name)))];
}

function parseSessionDetails(pdf) {
  const records = [];
  const warnings = [];

  for (const page of pdf.pages) {
    const starts = page.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => isDetailRecordStart(line));

    for (let startIndex = 0; startIndex < starts.length; startIndex += 1) {
      const current = starts[startIndex];
      const next = starts[startIndex + 1];
      const recordLines = page.lines.slice(current.index, next ? next.index : page.lines.length);
      const firstLine = current.line;
      const sessionCode = firstInRange(firstLine, 20, 85, sessionCodePattern)?.str;
      const order = firstInRange(firstLine, 80, 135, orderPattern)?.str;
      const paperId = firstInRange(firstLine, 130, 180, paperIdPattern)?.str;
      const authorText = clean(recordLines.map((line) => lineRange(line, 180, 350)).join(" "));
      const title = clean(recordLines.map((line) => lineRange(line, 350, 630)).join(" "));
      const presentingAuthor = clean(recordLines.map((line) => lineRange(line, 630, 760)).join(" "));
      const sourceSnippet = recordLines.map((line) => line.text).join("\n");

      if (!sessionCode || !order || !paperId) continue;
      if (!title) warnings.push(`Missing title for paper ${paperId} on page ${page.pageNumber}`);

      records.push({
        id: `paper-${paperId}`,
        type: order.startsWith("Poster") ? "poster" : "talk",
        title: title || `${order} ${paperId}`,
        description: authorText,
        sessionCode,
        order,
        paperId,
        presentingAuthor: applyCorrection("presenterNames", presentingAuthor),
        authorNames: parseAuthorNames(authorText, presentingAuthor),
        sourceFile: pdf.fileName,
        sourcePage: page.pageNumber,
        sourceSnippet,
        warnings: title ? [] : ["Missing title"]
      });
    }
  }

  const seen = new Set();
  return {
    records: records.filter((record) => {
      if (seen.has(record.id)) {
        warnings.push(`Duplicate paper ID skipped: ${record.paperId}`);
        return false;
      }
      seen.add(record.id);
      return true;
    }),
    warnings
  };
}

function parseDate(text) {
  const match = text.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\d{1,2}\s+June\s+2026/i);
  if (!match) return undefined;
  const day = Number(match[0].match(/\d{1,2}/)?.[0]);
  return `2026-06-${String(day).padStart(2, "0")}`;
}

function parseClock(token) {
  const match = clean(token).match(/^(\d{1,2})[.:](\d{2})\s*(am|pm)$/i);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3].toLowerCase();
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseTimeRange(text) {
  const normalized = clean(text).replace(/\s+/g, " ");
  const match = normalized.match(/(\d{1,2}[.:]\d{2}\s*(?:am|pm))\s*-\s*(\d{1,2}[.:]\d{2}\s*(?:am|pm))/i);
  if (!match) return undefined;
  return { startTime: parseClock(match[1]), endTime: parseClock(match[2]) };
}

function buildTimeLabels(page) {
  const candidates = page.items
    .filter((item) => item.x < 70 && /\d{1,2}[.:]\d{2}/.test(item.str))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const used = new Set();
  const labels = [];

  for (const item of candidates) {
    const key = `${item.x}-${item.y}-${item.str}`;
    if (used.has(key)) continue;
    let text = item.str;
    let yBottom = item.y;

    if (/-\s*$/.test(item.str)) {
      const next = candidates.find(
        (candidate) =>
          candidate !== item &&
          !used.has(`${candidate.x}-${candidate.y}-${candidate.str}`) &&
          candidate.y < item.y &&
          item.y - candidate.y <= 12 &&
          /^\d{1,2}[.:]\d{2}\s*(?:am|pm)$/i.test(candidate.str)
      );
      if (next) {
        text = `${item.str} ${next.str}`;
        yBottom = next.y;
        used.add(`${next.x}-${next.y}-${next.str}`);
      }
    }

    const parsed = parseTimeRange(text);
    if (!parsed?.startTime || !parsed?.endTime) continue;
    used.add(key);
    labels.push({
      text: clean(text),
      startTime: parsed.startTime,
      endTime: parsed.endTime,
      yTop: item.y,
      yBottom
    });
  }

  return labels.sort((a, b) => b.yTop - a.yTop);
}

function nearestRoom(roomHeaders, x) {
  if (!roomHeaders.length) return undefined;
  const room = roomHeaders.reduce((best, current) =>
    Math.abs(current.x - x) < Math.abs(best.x - x) ? current : best
  );
  return applyCorrection("roomNames", room.label);
}

function nearestLowerTime(timeLabels, y) {
  return timeLabels.find((label) => label.yTop < y - 2);
}

function parseProgramme(pdf) {
  const sessionSlots = [];
  const paperSchedule = new Map();
  const specialEvents = [];
  const warnings = [];

  for (const page of pdf.pages) {
    const date = parseDate(page.text);
    if (!date) {
      warnings.push(`No date found on programme page ${page.pageNumber}`);
      continue;
    }

    const roomHeaders = page.items
      .filter((item) => item.y > 750 && item.x > 70 && /^(Room|SMU Halls)/i.test(item.str))
      .map((item) => ({ label: item.str, x: item.x }));
    const timeLabels = buildTimeLabels(page);
    const codeRows = [];

    for (const line of page.lines) {
      const codeItems = line.items.filter(
        (item) => item.x > 70 && sessionCodePattern.test(item.str) && !/^Poster/i.test(item.str)
      );
      if (codeItems.length < 2) continue;
      const time = nearestLowerTime(timeLabels, line.y);
      if (!time) continue;
      codeRows.push({ line, codeItems, time });

      const sortedCodes = codeItems.sort((a, b) => a.x - b.x);
      for (let index = 0; index < sortedCodes.length; index += 1) {
        const codeItem = sortedCodes[index];
        const previous = sortedCodes[index - 1];
        const next = sortedCodes[index + 1];
        const left = previous ? (previous.x + codeItem.x) / 2 : 60;
        const right = next ? (codeItem.x + next.x) / 2 : 1160;
        const room = nearestRoom(roomHeaders, codeItem.x) ?? "Room TBC";
        const paperIds = [
          ...new Set(
            page.items
              .filter(
                (item) =>
                  item.y < line.y - 2 &&
                  item.y > time.yTop + 2 &&
                  item.x >= left &&
                  item.x < right &&
                  paperIdPattern.test(item.str)
              )
              .map((item) => item.str)
          )
        ];
        const sourceSnippet = page.lines
          .filter((candidate) => candidate.y <= line.y + 2 && candidate.y >= time.yTop - 2)
          .slice(0, 18)
          .map((candidate) => candidate.text)
          .join("\n");
        const sessionId = `session-${slug(codeItem.str)}-${date}-${time.startTime.replace(":", "")}-${slug(room)}`;

        sessionSlots.push({
          id: sessionId,
          sessionCode: codeItem.str,
          date,
          startTime: time.startTime,
          endTime: time.endTime,
          timezone,
          room,
          paperIds,
          sourceFile: pdf.fileName,
          sourcePage: page.pageNumber,
          sourceSnippet,
          warnings: paperIds.length ? [] : ["No paper IDs detected in timetable column"]
        });

        for (const paperId of paperIds) {
          if (!paperSchedule.has(paperId)) {
            paperSchedule.set(paperId, {
              sessionId,
              sessionCode: codeItem.str,
              date,
              startTime: time.startTime,
              endTime: time.endTime,
              timezone,
              room,
              sourceFile: pdf.fileName,
              sourcePage: page.pageNumber,
              sourceSnippet
            });
          }
        }
      }
    }

    for (const label of timeLabels) {
      const hasAssociatedCodeRow = codeRows.some((row) => row.time === label);
      if (hasAssociatedCodeRow) continue;
      const nearbyLines = page.lines
        .filter((line) => line.y <= label.yTop + 14 && line.y >= label.yBottom - 6)
        .filter(
          (line) =>
            !line.items.some(
              (item) =>
                sessionCodePattern.test(item.str) ||
                orderPattern.test(item.str) ||
                paperIdPattern.test(item.str) ||
                /^Poster-?$/i.test(item.str) ||
                /^X\d{2}$/i.test(item.str)
            )
        );
      const title = clean(
        nearbyLines
          .flatMap((line) => line.items)
          .filter(
            (item) =>
              item.x > 70 &&
              !/^(Room|SMU Halls|Date\/ Time|INFORMATION)/i.test(item.str) &&
              !sessionCodePattern.test(item.str) &&
              !orderPattern.test(item.str) &&
              !paperIdPattern.test(item.str)
          )
          .map((item) => item.str)
          .join(" ")
      );
      if (!/[a-z]/i.test(title)) continue;
      const lowerTitle = title.toLowerCase();
      const type = lowerTitle.includes("keynote")
        ? "keynote"
        : lowerTitle.includes("coffee") ||
            lowerTitle.includes("break") ||
            lowerTitle.includes("lunch") ||
            lowerTitle.includes("reception")
          ? "break"
          : lowerTitle.includes("poster viewing")
            ? "poster-session"
            : "other";
      specialEvents.push({
        id: `special-${date}-${label.startTime.replace(":", "")}-${slug(title).slice(0, 40)}`,
        type,
        title,
        date,
        startTime: label.startTime,
        endTime: label.endTime,
        timezone,
        room: title.match(/@\s*(.+)$/)?.[1],
        sourceFile: pdf.fileName,
        sourcePage: page.pageNumber,
        sourceSnippet: nearbyLines.map((line) => line.text).join("\n"),
        warnings: []
      });
    }
  }

  return { sessionSlots, paperSchedule, specialEvents, warnings };
}

function parsePosterAssignments(pdf) {
  const assignments = new Map();
  const warnings = [];

  for (const page of pdf.pages) {
    const date = parseDate(page.text);
    const roomHeaders = page.items
      .filter((item) => item.y > 800 && item.x > 70 && /^(Room|SMU Halls)/i.test(item.str))
      .map((item) => ({ label: item.str, x: item.x }));
    const timeLabels = buildTimeLabels(page);
    const panelItems = page.items.filter((item) => /^P[X]?\d-[A-Z0-9]+-\d-\d{2}\s*-?\s*\d{5}$/i.test(item.str));

    for (const panelItem of panelItems) {
      const time = nearestLowerTime(timeLabels, panelItem.y);
      const paperIdItem = page.items.find(
        (item) =>
          paperIdPattern.test(item.str) &&
          Math.abs(item.y - panelItem.y) <= 8 &&
          item.x >= panelItem.x &&
          item.x <= panelItem.x + 90
      );
      const paperId = paperIdItem?.str ?? panelItem.str.match(/(\d{5})$/)?.[1];
      if (!paperId) {
        warnings.push(`Poster assignment without paper ID near page ${page.pageNumber}: ${panelItem.str}`);
        continue;
      }
      const posterGroup = page.items.find(
        (item) =>
          /^Poster-?X?\d+/i.test(item.str) &&
          Math.abs(item.y - panelItem.y) <= 8 &&
          item.x >= panelItem.x - 10 &&
          item.x <= panelItem.x + 20
      )?.str;
      const nextPanelX = page.items
        .filter((item) => item.y === panelItem.y && item.x > panelItem.x && /^P[X]?\d-/i.test(item.str))
        .map((item) => item.x)
        .sort((a, b) => a - b)[0];
      const presenter = clean(
        page.items
          .filter(
            (item) =>
              paperIdItem &&
              item.y === paperIdItem.y &&
              item.x > paperIdItem.x &&
              item.x < (nextPanelX ?? panelItem.x + 110) &&
              !paperIdPattern.test(item.str)
          )
          .map((item) => item.str)
          .join(" ")
      );
      const panel = applyCorrection("posterPanels", panelItem.str);
      const sourceLines = page.lines.filter(
        (line) => Math.abs(line.y - panelItem.y) <= 8 && line.items.some((item) => Math.abs(item.x - panelItem.x) < 80)
      );
      assignments.set(paperId, {
        posterGroup,
        panel,
        assignmentName: presenter,
        date,
        startTime: time?.startTime,
        endTime: time?.endTime,
        timezone,
        room: nearestRoom(roomHeaders, panelItem.x),
        sourceFile: pdf.fileName,
        sourcePage: page.pageNumber,
        sourceSnippet: sourceLines.map((line) => line.text).join("\n")
      });
    }
  }

  return { assignments, warnings };
}

function compareDateTime(a, b) {
  return `${a.date ?? "9999-99-99"} ${a.startTime ?? "99:99"}`.localeCompare(
    `${b.date ?? "9999-99-99"} ${b.startTime ?? "99:99"}`
  );
}

function makePresenterId(name) {
  return `presenter-${slug(name)}`;
}

function buildSearchDocuments(events, presenters) {
  const documents = [];
  for (const item of events) {
    documents.push({
      id: `search-${item.id}`,
      itemId: item.id,
      type: item.type === "talk" ? "talk" : item.type === "poster" ? "poster" : item.type,
      title: item.title,
      body: clean(
        [
          item.description,
          item.paperId,
          item.sessionCode,
          item.order,
          item.room,
          item.location,
          item.posterPanel,
          item.posterGroup,
          item.track,
          item.authorNames?.join(" "),
          item.presentingAuthor
        ]
          .filter(Boolean)
          .join(" ")
      ),
      keywords: [
        item.type,
        item.paperId,
        item.sessionCode,
        item.order,
        item.room,
        item.location,
        item.posterPanel
      ].filter(Boolean)
    });
  }

  for (const presenter of presenters) {
    documents.push({
      id: `search-${presenter.id}`,
      presenterId: presenter.id,
      type: "presenter",
      title: presenter.displayName,
      body: clean(
        presenter.itemIds
          .map((itemId) => events.find((event) => event.id === itemId)?.title)
          .filter(Boolean)
          .join(" ")
      ),
      keywords: ["presenter"]
    });
  }

  const locations = new Map();
  for (const item of events) {
    for (const label of [item.room, item.location, item.posterPanel].filter(Boolean)) {
      const id = `location-${slug(label)}`;
      if (!locations.has(id)) {
        locations.set(id, { id, label, itemIds: [] });
      }
      locations.get(id).itemIds.push(item.id);
    }
  }
  for (const location of locations.values()) {
    documents.push({
      id: `search-${location.id}`,
      type: "location",
      title: location.label,
      body: location.itemIds
        .map((itemId) => events.find((event) => event.id === itemId)?.title)
        .filter(Boolean)
        .join(" "),
      keywords: ["location"]
    });
  }

  return documents;
}

function buildValidationReport(events, sources) {
  const warningItems = events.filter((event) => event.warnings?.length);
  const lines = [
    "# Data Validation Review",
    "",
    `Generated: ${sources.generatedAt}`,
    `Timezone: ${sources.timezone}`,
    "",
    "## Counts",
    "",
    `- Events: ${events.length}`,
    `- Sessions: ${events.filter((event) => event.type === "session").length}`,
    `- Talks: ${events.filter((event) => event.type === "talk").length}`,
    `- Posters: ${events.filter((event) => event.type === "poster").length}`,
    `- Special events: ${events.filter((event) => !["session", "talk", "poster"].includes(event.type)).length}`,
    `- Warnings: ${warningItems.length}`,
    "",
    "## Warning Items",
    ""
  ];

  if (!warningItems.length) {
    lines.push("No parser warnings.");
  } else {
    for (const item of warningItems.slice(0, 200)) {
      lines.push(`### ${item.title}`);
      lines.push("");
      lines.push(`- ID: ${item.id}`);
      lines.push(`- Source: ${item.sourceFile}, page ${item.sourcePage}`);
      lines.push(`- Warnings: ${item.warnings.join("; ")}`);
      lines.push("");
      lines.push("```text");
      lines.push(String(item.sourceSnippet ?? "").slice(0, 1200));
      lines.push("```");
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

await fs.mkdir(publicDataDir, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });

const [programmePdf, detailsPdf, postersPdf, wayfindingPdf] = await Promise.all([
  extractPdf(sourceFiles.programme),
  extractPdf(sourceFiles.details),
  extractPdf(sourceFiles.posters),
  extractPdf(sourceFiles.wayfinding)
]);

const details = parseSessionDetails(detailsPdf);
const programme = parseProgramme(programmePdf);
const posterAssignments = parsePosterAssignments(postersPdf);

const eventMap = new Map();
const presenterMap = new Map();

for (const slot of programme.sessionSlots) {
  eventMap.set(slot.id, {
    id: slot.id,
    type: "session",
    title: `Session ${slot.sessionCode}`,
    description: `${slot.paperIds.length} listed paper${slot.paperIds.length === 1 ? "" : "s"} in this timetable block.`,
    date: slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    timezone,
    room: slot.room,
    track: slot.sessionCode.split("-")[0],
    sessionCode: slot.sessionCode,
    childItemIds: [],
    sourceFile: slot.sourceFile,
    sourcePage: slot.sourcePage,
    sourceSnippet: slot.sourceSnippet,
    warnings: slot.warnings
  });
}

for (const record of details.records) {
  const assignment = posterAssignments.assignments.get(record.paperId);
  const programmeSchedule = programme.paperSchedule.get(record.paperId);
  const assignmentSchedule =
    record.type === "poster" && assignment?.date && assignment?.startTime && assignment?.endTime
      ? {
          date: assignment.date,
          startTime: assignment.startTime,
          endTime: assignment.endTime,
          timezone,
          room: assignment.room,
          sourceFile: assignment.sourceFile,
          sourcePage: assignment.sourcePage,
          sourceSnippet: assignment.sourceSnippet
        }
      : undefined;
  const schedule = programmeSchedule ?? assignmentSchedule;
  const override = corrections.itemOverrides?.[record.paperId] ?? {};
  const warnings = [...record.warnings];
  if (!schedule) warnings.push("No exact timetable match found for this paper ID");

  const item = {
    ...record,
    title: override.title ?? record.title,
    description: override.description ?? record.description,
    date: override.date ?? schedule?.date,
    startTime: override.startTime ?? schedule?.startTime,
    endTime: override.endTime ?? schedule?.endTime,
    timezone,
    room: override.room ?? schedule?.room,
    location: override.location ?? assignment?.room ?? schedule?.room,
    parentId: programmeSchedule?.sessionId,
    track: record.sessionCode.split("-")[0],
    posterPanel: override.posterPanel ?? assignment?.panel,
    posterGroup: assignment?.posterGroup,
    posterAssignmentName: assignment?.assignmentName,
    assignmentSourceFile: assignment?.sourceFile,
    assignmentSourcePage: assignment?.sourcePage,
    assignmentSourceSnippet: assignment?.sourceSnippet,
    warnings
  };

  eventMap.set(item.id, item);
  if (item.parentId && eventMap.has(item.parentId)) {
    eventMap.get(item.parentId).childItemIds.push(item.id);
  }
}

for (const specialEvent of programme.specialEvents) {
  eventMap.set(specialEvent.id, specialEvent);
}

const events = [...eventMap.values()].sort(compareDateTime);

for (const item of events) {
  if (!["talk", "poster"].includes(item.type)) continue;
  const names = item.authorNames?.length ? item.authorNames : [item.presentingAuthor].filter(Boolean);
  item.presenterIds = [];
  for (const name of names) {
    const canonical = applyCorrection("presenterNames", name);
    const id = makePresenterId(canonical);
    if (!presenterMap.has(id)) {
      presenterMap.set(id, {
        id,
        displayName: canonical,
        normalizedName: slug(canonical),
        affiliations: [],
        itemIds: []
      });
    }
    presenterMap.get(id).itemIds.push(item.id);
    item.presenterIds.push(id);
  }
}

const presenters = [...presenterMap.values()].sort((a, b) =>
  a.displayName.localeCompare(b.displayName)
);
for (const presenter of presenters) {
  presenter.itemIds = [...new Set(presenter.itemIds)];
}

const searchDocuments = buildSearchDocuments(events, presenters);
const allWarnings = [
  ...details.warnings,
  ...programme.warnings,
  ...posterAssignments.warnings,
  ...events.flatMap((event) => event.warnings?.map((warning) => `${event.id}: ${warning}`) ?? [])
];

const sources = {
  generatedAt: new Date().toISOString(),
  timezone,
  sourceFiles: [
    { role: "programme", fileName: programmePdf.fileName, pages: programmePdf.pageCount },
    { role: "details", fileName: detailsPdf.fileName, pages: detailsPdf.pageCount },
    { role: "posterAssignments", fileName: postersPdf.fileName, pages: postersPdf.pageCount },
    { role: "wayfinding", fileName: wayfindingPdf.fileName, pages: wayfindingPdf.pageCount }
  ],
  counts: {
    events: events.length,
    sessions: events.filter((event) => event.type === "session").length,
    talks: events.filter((event) => event.type === "talk").length,
    posters: events.filter((event) => event.type === "poster").length,
    presenters: presenters.length,
    searchDocuments: searchDocuments.length,
    scheduledItems: events.filter((event) => event.date && event.startTime && event.endTime).length,
    warnings: allWarnings.length
  },
  warnings: allWarnings,
  appliedCorrections
};

await fs.writeFile(path.join(publicDataDir, "events.json"), `${JSON.stringify(events, null, 2)}\n`);
await fs.writeFile(path.join(publicDataDir, "presenters.json"), `${JSON.stringify(presenters, null, 2)}\n`);
await fs.writeFile(path.join(publicDataDir, "search-index.json"), `${JSON.stringify(searchDocuments, null, 2)}\n`);
await fs.writeFile(path.join(publicDataDir, "sources.json"), `${JSON.stringify(sources, null, 2)}\n`);
await fs.writeFile(path.join(dataDir, "validation-report.md"), buildValidationReport(events, sources));

console.log(
  `Generated ${events.length} events, ${presenters.length} presenters, ${searchDocuments.length} search docs.`
);
console.log(`${allWarnings.length} parser warnings written to data/validation-report.md.`);

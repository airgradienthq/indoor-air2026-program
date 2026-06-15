import MiniSearch from "minisearch";
import { createIcons, icons } from "lucide";
import "./styles.css";

type EventType = "session" | "talk" | "poster" | "break" | "keynote" | "poster-session" | "other";

type ProgramItem = {
  id: string;
  type: EventType;
  title: string;
  description?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  timezone?: string;
  room?: string;
  location?: string;
  track?: string;
  sessionCode?: string;
  order?: string;
  paperId?: string;
  presentingAuthor?: string;
  authorNames?: string[];
  presenterIds?: string[];
  parentId?: string;
  childItemIds?: string[];
  posterPanel?: string;
  posterGroup?: string;
  sourceFile?: string;
  sourcePage?: number;
  sourceSnippet?: string;
  warnings?: string[];
};

type Presenter = {
  id: string;
  displayName: string;
  normalizedName: string;
  itemIds: string[];
};

type SearchDocument = {
  id: string;
  itemId?: string;
  presenterId?: string;
  type: string;
  title: string;
  body: string;
  keywords: string[];
};

type Sources = {
  generatedAt: string;
  timezone: string;
  counts: Record<string, number>;
  warnings: string[];
};

type ValidationReport = {
  generatedAt: string;
  errors: string[];
  warnings: string[];
};

type View = "home" | "schedule" | "posters" | "presenters" | "favorites";
type SearchType = "all" | "session" | "talk" | "poster" | "presenter" | "keynote" | "break";

type AppState = {
  view: View;
  query: string;
  searchType: SearchType;
  selectedItemId?: string;
  selectedPresenterId?: string;
  day: string;
  scheduleType: string;
  upcomingFilter: string;
};

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app root.");
const app: HTMLDivElement = root;

let events: ProgramItem[] = [];
let presenters: Presenter[] = [];
let searchDocs: SearchDocument[] = [];
let sources: Sources;
let validation: ValidationReport;
let searchIndex: MiniSearch<SearchDocument>;
let state: AppState = {
  view: "home",
  query: "",
  searchType: "all",
  day: "all",
  scheduleType: "timeline",
  upcomingFilter: "all"
};
let favorites = new Set<string>(readFavorites());

const eventsById = new Map<string, ProgramItem>();
const presentersById = new Map<string, Presenter>();
const searchFilterOptions: Array<[SearchType, string]> = [
  ["all", "All"],
  ["session", "Sessions"],
  ["talk", "Talks"],
  ["poster", "Posters"],
  ["presenter", "Presenters"],
  ["keynote", "Keynotes"],
  ["break", "Breaks"]
];
const searchResultNouns: Record<SearchType, string> = {
  all: "result",
  session: "session",
  talk: "talk",
  poster: "poster",
  presenter: "presenter",
  keynote: "keynote",
  break: "break"
};

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function readFavorites(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("ia2026:favorites") ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem("ia2026:favorites", JSON.stringify([...favorites]));
}

function getNow(): Date {
  const override = new URLSearchParams(window.location.search).get("now");
  if (override) return new Date(override);
  return new Date();
}

function dateTime(item: ProgramItem, field: "startTime" | "endTime"): Date | undefined {
  const time = item[field];
  if (!item.date || !time) return undefined;
  return new Date(`${item.date}T${time}:00+08:00`);
}

function isScheduled(item: ProgramItem): boolean {
  return Boolean(item.date && item.startTime && item.endTime);
}

function isTimelineDefault(item: ProgramItem): boolean {
  return ["session", "break", "keynote", "poster-session", "other"].includes(item.type);
}

function isActiveNow(item: ProgramItem, now = getNow()): boolean {
  const start = dateTime(item, "startTime");
  const end = dateTime(item, "endTime");
  return Boolean(start && end && start <= now && now < end);
}

function isUpcoming(item: ProgramItem, now = getNow()): boolean {
  const start = dateTime(item, "startTime");
  return Boolean(start && start > now);
}

function itemSort(a: ProgramItem, b: ProgramItem): number {
  return `${a.date ?? "9999-99-99"} ${a.startTime ?? "99:99"} ${a.room ?? ""} ${a.title}`.localeCompare(
    `${b.date ?? "9999-99-99"} ${b.startTime ?? "99:99"} ${b.room ?? ""} ${b.title}`
  );
}

function formatDate(date?: string): string {
  if (!date) return "Unscheduled";
  return new Intl.DateTimeFormat("en-SG", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "Asia/Singapore"
  }).format(new Date(`${date}T00:00:00+08:00`));
}

function formatTime(time?: string): string {
  if (!time) return "";
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(Date.UTC(2026, 0, 1, hour - 8, minute));
  return new Intl.DateTimeFormat("en-SG", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Singapore"
  }).format(date);
}

function formatRange(item: ProgramItem): string {
  if (!item.date || !item.startTime || !item.endTime) return "Unscheduled";
  return `${formatDate(item.date)} · ${formatTime(item.startTime)}-${formatTime(item.endTime)}`;
}

function formatNowLabel(): string {
  return new Intl.DateTimeFormat("en-SG", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Singapore"
  }).format(getNow());
}

function typeLabel(type: string): string {
  if (type === "poster-session") return "poster viewing";
  return type.replace("-", " ");
}

function dateOptions(): string[] {
  return [...new Set(events.filter(isScheduled).map((item) => item.date as string))].sort();
}

function itemMeta(item: ProgramItem): string {
  const pieces = [
    item.paperId,
    item.sessionCode,
    item.order,
    item.posterPanel,
    item.room || item.location
  ].filter(Boolean);
  return pieces.join(" · ");
}

function presenterNames(item: ProgramItem): string[] {
  return (item.presenterIds ?? [])
    .map((id) => presentersById.get(id)?.displayName)
    .filter((name): name is string => Boolean(name));
}

function icon(name: string): string {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function typeBadge(item: ProgramItem): string {
  return `<span class="type-badge ${escapeHtml(item.type)}">${escapeHtml(typeLabel(item.type))}</span>`;
}

function favoriteButton(itemId: string): string {
  const active = favorites.has(itemId);
  return `<button class="icon-button ${active ? "active" : ""}" data-favorite="${escapeHtml(itemId)}" aria-label="${active ? "Remove favorite" : "Add favorite"}">${icon("star")}</button>`;
}

function renderItemCard(item: ProgramItem, compact = false): string {
  const presentersText = presenterNames(item).slice(0, 4).join(", ");
  const description = compact ? "" : item.description || presentersText;
  const warning = item.warnings?.length ? `<span class="meta warning">${icon("triangle-alert")} ${item.warnings.length}</span>` : "";
  return `
    <article class="card item-card clickable" data-open="${escapeHtml(item.id)}" tabindex="0">
      <div class="item-top">
        <div>
          <h3 class="item-title">${escapeHtml(item.title)}</h3>
        </div>
        <div class="meta-row">
          ${typeBadge(item)}
          ${favoriteButton(item.id)}
        </div>
      </div>
      ${description ? `<p class="item-description">${escapeHtml(description)}</p>` : ""}
      <div class="meta-row">
        <span class="meta">${icon("clock")} <strong>${escapeHtml(formatRange(item))}</strong></span>
        ${item.room || item.location ? `<span class="meta">${icon("map-pin")} ${escapeHtml(item.room || item.location)}</span>` : ""}
        ${itemMeta(item) ? `<span class="meta">${escapeHtml(itemMeta(item))}</span>` : ""}
        ${warning}
      </div>
    </article>
  `;
}

function renderPresenterCard(presenter: Presenter): string {
  const linkedItems = presenter.itemIds
    .map((id) => eventsById.get(id))
    .filter((item): item is ProgramItem => Boolean(item))
    .sort(itemSort);
  return `
    <article class="card item-card clickable" data-presenter="${escapeHtml(presenter.id)}" tabindex="0">
      <div class="item-top">
        <h3 class="item-title">${escapeHtml(presenter.displayName)}</h3>
        <span class="type-badge">${linkedItems.length} item${linkedItems.length === 1 ? "" : "s"}</span>
      </div>
      <p class="item-description">${escapeHtml(linkedItems.slice(0, 3).map((item) => item.title).join(" · "))}</p>
      <div class="meta-row">
        ${linkedItems.slice(0, 3).map((item) => `<span class="meta">${escapeHtml(typeLabel(item.type))}</span>`).join("")}
      </div>
    </article>
  `;
}

function renderTabs(): string {
  const tabs: Array<[View, string, string]> = [
    ["home", "Now", "clock"],
    ["schedule", "Schedule", "calendar-days"],
    ["posters", "Posters", "layout-grid"],
    ["presenters", "People", "users-round"],
    ["favorites", "Saved", "star"]
  ];
  return `
    <nav class="tabs" aria-label="Primary">
      ${tabs
        .map(
          ([view, label, iconName]) =>
            `<button class="tab ${state.view === view ? "active" : ""}" data-view="${view}">${icon(iconName)}<span>${label}</span></button>`
        )
        .join("")}
    </nav>
  `;
}

type SearchEntry = {
  key: string;
  kind: SearchType;
  html: string;
};

function searchDocumentKind(doc: SearchDocument): SearchType | undefined {
  if (doc.presenterId) return "presenter";
  if (doc.itemId) {
    const item = eventsById.get(doc.itemId);
    if (!item) return undefined;
    if (["session", "talk", "poster", "keynote", "break"].includes(item.type)) {
      return item.type as SearchType;
    }
    return undefined;
  }
  return undefined;
}

function getSearchEntries(query: string): SearchEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const results = searchIndex.search(trimmed, {
    prefix: true,
    fuzzy: trimmed.length > 4 ? 0.2 : false,
    combineWith: "AND"
  });
  const seen = new Set<string>();
  const entries: SearchEntry[] = [];

  for (const result of results) {
    const doc = searchDocs.find((searchDoc) => searchDoc.id === result.id);
    if (!doc) continue;

    const key = doc.itemId ?? doc.presenterId ?? doc.id;
    if (seen.has(key)) continue;

    const kind = searchDocumentKind(doc);
    if (!kind) continue;

    if (doc.itemId) {
      const item = eventsById.get(doc.itemId);
      if (!item) continue;
      seen.add(key);
      entries.push({ key, kind, html: renderItemCard(item, false) });
    } else if (doc.presenterId) {
      const presenter = presentersById.get(doc.presenterId);
      if (!presenter) continue;
      seen.add(key);
      entries.push({ key, kind, html: renderPresenterCard(presenter) });
    }
  }

  return entries;
}

function getSearchCounts(entries: SearchEntry[]): Record<SearchType, number> {
  return searchFilterOptions.reduce(
    (counts, [type]) => {
      counts[type] = type === "all" ? entries.length : entries.filter((entry) => entry.kind === type).length;
      return counts;
    },
    {} as Record<SearchType, number>
  );
}

function renderSearchFilterBar(): string {
  const query = state.query.trim();
  if (!query) return "";

  const counts = getSearchCounts(getSearchEntries(query));
  return `
    <div class="search-filter-row" aria-label="Search result filters">
      ${searchFilterOptions
        .map(
          ([type, label]) => `
            <button class="search-filter-chip ${state.searchType === type ? "active" : ""}" data-search-type="${type}" ${counts[type] === 0 ? "disabled" : ""}>
              <span>${escapeHtml(label)}</span>
              <strong>${counts[type]}</strong>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderHome(): string {
  const now = getNow();
  const active = events
    .filter((item) => isScheduled(item) && isActiveNow(item, now) && isTimelineDefault(item))
    .sort(itemSort);
  const upcomingBase = events.filter((item) => isScheduled(item) && isUpcoming(item, now));
  const upcoming =
    state.upcomingFilter === "all"
      ? upcomingBase.filter(isTimelineDefault)
      : upcomingBase.filter((item) => item.type === state.upcomingFilter);
  const upcomingItems = upcoming.sort(itemSort).slice(0, 12);

  return `
    <section class="section">
      <div class="stats">
        <div class="stat"><strong>${sources.counts.events}</strong><span>program records</span></div>
        <div class="stat"><strong>${sources.counts.presenters}</strong><span>presenters/authors</span></div>
        <div class="stat"><strong>${sources.counts.posters}</strong><span>posters</span></div>
        <div class="stat"><strong>${validation.errors.length}</strong><span>validation errors</span></div>
      </div>
    </section>

    <section class="section" data-section="going-now">
      <div class="section-header">
        <div>
          <h2>Going on now</h2>
          <p>${escapeHtml(formatNowLabel())}</p>
        </div>
      </div>
      <div class="grid two">
        ${active.length ? active.map((item) => renderItemCard(item, true)).join("") : `<div class="empty">Nothing scheduled right now in the current conference time.</div>`}
      </div>
    </section>

    <section class="section" data-section="upcoming">
      <div class="section-header">
        <div>
          <h2>Upcoming</h2>
          <p>Next scheduled items</p>
        </div>
      </div>
      <div class="filter-row" role="list">
        ${[
          ["all", "All"],
          ["session", "Sessions"],
          ["poster", "Posters"],
          ["keynote", "Keynotes"],
          ["break", "Breaks"]
        ]
          .map(
            ([value, label]) =>
              `<button class="chip ${state.upcomingFilter === value ? "active" : ""}" data-upcoming-filter="${value}">${escapeHtml(label)}</button>`
          )
          .join("")}
      </div>
      <div class="grid two" style="margin-top: 10px">
        ${upcomingItems.length ? upcomingItems.map((item) => renderItemCard(item, true)).join("") : `<div class="empty">No upcoming items for this filter.</div>`}
      </div>
    </section>
  `;
}

function filterByScheduleType(item: ProgramItem): boolean {
  if (state.scheduleType === "timeline") return isTimelineDefault(item);
  if (state.scheduleType === "all") return true;
  return item.type === state.scheduleType;
}

function renderGroupedItems(items: ProgramItem[]): string {
  if (!items.length) return `<div class="empty">No matching items.</div>`;
  const groups = new Map<string, ProgramItem[]>();
  for (const item of items) {
    const key = item.startTime ? `${item.date}-${item.startTime}` : "unscheduled";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(item);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const sample = group[0];
      const label = key === "unscheduled" ? "Unscheduled" : `${formatDate(sample.date)} · ${formatTime(sample.startTime)}`;
      return `
        <div class="time-group">
          <div class="time-label">${escapeHtml(label)}</div>
          <div class="grid two">${group.sort(itemSort).map((item) => renderItemCard(item, true)).join("")}</div>
        </div>
      `;
    })
    .join("");
}

function renderSchedule(): string {
  const days = dateOptions();
  const filtered = events
    .filter(isScheduled)
    .filter((item) => state.day === "all" || item.date === state.day)
    .filter(filterByScheduleType)
    .sort(itemSort);

  return `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Schedule</h2>
          <p>${filtered.length} visible items</p>
        </div>
      </div>
      <div class="controls">
        <select class="select" data-day-select aria-label="Day">
          <option value="all" ${state.day === "all" ? "selected" : ""}>All days</option>
          ${days.map((day) => `<option value="${day}" ${state.day === day ? "selected" : ""}>${escapeHtml(formatDate(day))}</option>`).join("")}
        </select>
        <select class="select" data-schedule-type aria-label="Schedule type">
          ${[
            ["timeline", "Timeline"],
            ["all", "All records"],
            ["session", "Sessions"],
            ["talk", "Talks"],
            ["poster", "Posters"],
            ["keynote", "Keynotes"],
            ["break", "Breaks"]
          ]
            .map(([value, label]) => `<option value="${value}" ${state.scheduleType === value ? "selected" : ""}>${label}</option>`)
            .join("")}
        </select>
      </div>
      ${renderGroupedItems(filtered)}
    </section>
  `;
}

function renderPosters(): string {
  const posters = events
    .filter((item) => item.type === "poster")
    .filter((item) => state.day === "all" || item.date === state.day)
    .sort(itemSort);
  const days = dateOptions();
  return `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Posters</h2>
          <p>${posters.length} posters</p>
        </div>
      </div>
      <div class="controls">
        <select class="select" data-day-select aria-label="Poster day">
          <option value="all" ${state.day === "all" ? "selected" : ""}>All days</option>
          ${days.map((day) => `<option value="${day}" ${state.day === day ? "selected" : ""}>${escapeHtml(formatDate(day))}</option>`).join("")}
        </select>
      </div>
      <div class="grid two">
        ${posters.map((item) => renderItemCard(item, true)).join("")}
      </div>
    </section>
  `;
}

function renderPresenters(): string {
  const visible = presenters.slice(0, 250);
  return `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Presenters</h2>
          <p>Showing first ${visible.length} of ${presenters.length}; use search for a specific name</p>
        </div>
      </div>
      <div class="grid two">
        ${visible.map(renderPresenterCard).join("")}
      </div>
    </section>
  `;
}

function renderFavorites(): string {
  const savedItems = [...favorites]
    .map((id) => eventsById.get(id))
    .filter((item): item is ProgramItem => Boolean(item))
    .sort(itemSort);
  return `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Favorites</h2>
          <p>${savedItems.length} saved item${savedItems.length === 1 ? "" : "s"}</p>
        </div>
      </div>
      <div class="grid two">
        ${savedItems.length ? savedItems.map((item) => renderItemCard(item, false)).join("") : `<div class="empty">No favorites saved yet.</div>`}
      </div>
    </section>
  `;
}

function renderSearchResults(): string {
  const query = state.query.trim();
  if (!query) return "";
  const entries = getSearchEntries(query);
  const filteredEntries =
    state.searchType === "all" ? entries : entries.filter((entry) => entry.kind === state.searchType);
  const cards = filteredEntries.slice(0, 80).map((entry) => entry.html);
  const filterLabel = searchFilterOptions.find(([type]) => type === state.searchType)?.[1] ?? "Results";
  const resultNoun = searchResultNouns[state.searchType];
  const resultSummary =
    state.searchType === "all"
      ? `${filteredEntries.length} result${filteredEntries.length === 1 ? "" : "s"}`
      : `${filteredEntries.length} ${resultNoun} result${filteredEntries.length === 1 ? "" : "s"} of ${entries.length}`;

  return `
    <section class="section">
      <div class="section-header">
        <div>
          <h2>Search results</h2>
          <p>${resultSummary} for "${escapeHtml(query)}"</p>
        </div>
      </div>
      <div class="grid two">
        ${cards.length ? cards.join("") : `<div class="empty">No ${state.searchType === "all" ? "" : `${escapeHtml(filterLabel.toLowerCase())} `}matches. Try another filter, paper ID, presenter surname, room, panel code, or topic.</div>`}
      </div>
    </section>
  `;
}

function renderCurrentView(): string {
  if (state.query.trim()) return renderSearchResults();
  switch (state.view) {
    case "schedule":
      return renderSchedule();
    case "posters":
      return renderPosters();
    case "presenters":
      return renderPresenters();
    case "favorites":
      return renderFavorites();
    case "home":
    default:
      return renderHome();
  }
}

function renderPresenterDetail(presenter: Presenter): string {
  const items = presenter.itemIds
    .map((id) => eventsById.get(id))
    .filter((item): item is ProgramItem => Boolean(item))
    .sort(itemSort);
  return `
    <aside class="card detail-card">
      <div class="detail-actions">
        <button class="button" data-close-detail>${icon("x")} Close</button>
      </div>
      <h2>${escapeHtml(presenter.displayName)}</h2>
      <div class="meta-row">
        <span class="meta">${icon("user-round")} ${items.length} item${items.length === 1 ? "" : "s"}</span>
      </div>
      <div class="detail-section">
        <h3>Program items</h3>
        <div class="grid">${items.map((item) => renderItemCard(item, true)).join("")}</div>
      </div>
    </aside>
  `;
}

function renderDetail(): string {
  if (state.selectedPresenterId) {
    const presenter = presentersById.get(state.selectedPresenterId);
    return presenter ? renderPresenterDetail(presenter) : "";
  }
  if (!state.selectedItemId) return `<div class="empty">Select a session, poster, presenter, or search result.</div>`;
  const item = eventsById.get(state.selectedItemId);
  if (!item) return `<div class="empty">Selected item not found.</div>`;
  const presentersList = presenterNames(item);
  const children = (item.childItemIds ?? [])
    .map((id) => eventsById.get(id))
    .filter((child): child is ProgramItem => Boolean(child))
    .sort(itemSort);
  const parent = item.parentId ? eventsById.get(item.parentId) : undefined;
  return `
    <aside class="card detail-card">
      <div class="detail-actions">
        ${favoriteButton(item.id)}
        <button class="button" data-close-detail>${icon("x")} Close</button>
      </div>
      <h2>${escapeHtml(item.title)}</h2>
      <div class="meta-row">
        ${typeBadge(item)}
        <span class="meta">${icon("clock")} ${escapeHtml(formatRange(item))}</span>
        ${item.room || item.location ? `<span class="meta">${icon("map-pin")} ${escapeHtml(item.room || item.location)}</span>` : ""}
        ${item.paperId ? `<span class="meta">Paper ${escapeHtml(item.paperId)}</span>` : ""}
        ${item.posterPanel ? `<span class="meta">Panel ${escapeHtml(item.posterPanel)}</span>` : ""}
      </div>
      ${item.description ? `<div class="detail-section"><h3>Text</h3><p class="item-description" style="-webkit-line-clamp: unset">${escapeHtml(item.description)}</p></div>` : ""}
      ${
        presentersList.length
          ? `<div class="detail-section"><h3>People</h3><div class="meta-row">${presentersList
              .map(
                (name) =>
                  `<button class="chip" data-presenter="${escapeHtml(makePresenterId(name))}">${icon("user-round")} ${escapeHtml(name)}</button>`
              )
              .join("")}</div></div>`
          : ""
      }
      ${
        parent
          ? `<div class="detail-section"><h3>Parent session</h3>${renderItemCard(parent, true)}</div>`
          : ""
      }
      ${
        children.length
          ? `<div class="detail-section"><h3>Items in this session</h3><div class="grid">${children.map((child) => renderItemCard(child, true)).join("")}</div></div>`
          : ""
      }
      ${
        item.warnings?.length
          ? `<div class="detail-section"><h3>Parser warnings</h3><ul>${item.warnings.map((warning) => `<li class="warning">${escapeHtml(warning)}</li>`).join("")}</ul></div>`
          : ""
      }
      <div class="detail-section">
        <h3>Source evidence</h3>
        <p class="meta-row"><span class="meta">${escapeHtml(item.sourceFile ?? "")}${item.sourcePage ? ` · page ${item.sourcePage}` : ""}</span></p>
        <code class="source">${escapeHtml(item.sourceSnippet ?? "")}</code>
      </div>
    </aside>
  `;
}

function render() {
  app.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand-row">
            <div class="brand">
              <h1>Indoor Air 2026 Program</h1>
              <p>Singapore time · ${escapeHtml(sources.counts.scheduledItems)} timed records · ${escapeHtml(new Date(sources.generatedAt).toLocaleString())}</p>
            </div>
            <div class="source-pill">${icon("file-check-2")} ${escapeHtml(validation.errors.length)} validation errors</div>
          </div>
          <p class="site-disclaimer">
            ${icon("info")}
            <span>This is an unofficial site to help conference participants find sessions, talks, and posters they are interested in. It was developed by <a href="https://www.airgradient.com/" target="_blank" rel="noreferrer">AirGradient</a>, which also has a booth at the conference. The data was extracted from the conference PDF documents. If you find any problems, please email <a href="mailto:indoor-air-2026@airgradient.com">indoor-air-2026@airgradient.com</a>.</span>
          </p>
          <div class="search-row">
            <div class="search-box">
              ${icon("search")}
              <input class="search-input" data-search aria-label="Search program" placeholder="Search sessions, posters, presenters, rooms, paper IDs..." value="${escapeHtml(state.query)}" />
              ${state.query ? `<button class="clear-search" data-clear-search aria-label="Clear search">${icon("x")}</button>` : ""}
            </div>
            ${renderTabs()}
          </div>
          ${renderSearchFilterBar()}
        </div>
      </header>
      <main class="main">
        <div class="layout">
          <div class="content">${renderCurrentView()}</div>
          <div class="detail-panel">${renderDetail()}</div>
        </div>
      </main>
      <div class="mobile-detail ${state.selectedItemId || state.selectedPresenterId ? "" : "hidden"}">${renderDetail()}</div>
    </div>
  `;
  createIcons({ icons });
}

function makePresenterId(name: string): string {
  return `presenter-${name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
}

function openItem(id: string) {
  state = { ...state, selectedItemId: id, selectedPresenterId: undefined };
  render();
}

function openPresenter(id: string) {
  state = { ...state, selectedPresenterId: id, selectedItemId: undefined };
  render();
}

function toggleFavorite(id: string) {
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  saveFavorites();
  render();
}

document.addEventListener("input", (event) => {
  const target = event.target as HTMLElement;
  if (target.matches("[data-search]")) {
    state = { ...state, query: (target as HTMLInputElement).value };
    render();
    const input = document.querySelector<HTMLInputElement>("[data-search]");
    input?.focus();
    input?.setSelectionRange(state.query.length, state.query.length);
  }
});

document.addEventListener("change", (event) => {
  const target = event.target as HTMLElement;
  if (target.matches("[data-day-select]")) {
    state = { ...state, day: (target as HTMLSelectElement).value };
    render();
  }
  if (target.matches("[data-schedule-type]")) {
    state = { ...state, scheduleType: (target as HTMLSelectElement).value };
    render();
  }
});

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const favorite = target.closest<HTMLElement>("[data-favorite]");
  if (favorite) {
    event.stopPropagation();
    toggleFavorite(favorite.dataset.favorite ?? "");
    return;
  }
  const open = target.closest<HTMLElement>("[data-open]");
  if (open) {
    openItem(open.dataset.open ?? "");
    return;
  }
  const presenter = target.closest<HTMLElement>("[data-presenter]");
  if (presenter) {
    openPresenter(presenter.dataset.presenter ?? "");
    return;
  }
  const view = target.closest<HTMLElement>("[data-view]");
  if (view) {
    state = { ...state, view: view.dataset.view as View, query: "", searchType: "all" };
    render();
    return;
  }
  const clear = target.closest("[data-clear-search]");
  if (clear) {
    state = { ...state, query: "", searchType: "all" };
    render();
    return;
  }
  const searchType = target.closest<HTMLElement>("[data-search-type]");
  if (searchType) {
    state = { ...state, searchType: searchType.dataset.searchType as SearchType };
    render();
    return;
  }
  const close = target.closest("[data-close-detail]");
  if (close) {
    state = { ...state, selectedItemId: undefined, selectedPresenterId: undefined };
    render();
    return;
  }
  const upcomingFilter = target.closest<HTMLElement>("[data-upcoming-filter]");
  if (upcomingFilter) {
    state = { ...state, upcomingFilter: upcomingFilter.dataset.upcomingFilter ?? "all" };
    render();
  }
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if ((event.key === "Enter" || event.key === " ") && target.matches("[data-open]")) {
    event.preventDefault();
    openItem(target.dataset.open ?? "");
  }
  if ((event.key === "Enter" || event.key === " ") && target.matches("[data-presenter]")) {
    event.preventDefault();
    openPresenter(target.dataset.presenter ?? "");
  }
  if (event.key === "Escape") {
    state = { ...state, selectedItemId: undefined, selectedPresenterId: undefined };
    render();
  }
});

function dataUrl(filename: string) {
  return `${import.meta.env.BASE_URL}data/${filename}`;
}

async function init() {
  const [eventData, presenterData, searchData, sourceData, validationData] = await Promise.all([
    fetch(dataUrl("events.json")).then((response) => response.json()),
    fetch(dataUrl("presenters.json")).then((response) => response.json()),
    fetch(dataUrl("search-index.json")).then((response) => response.json()),
    fetch(dataUrl("sources.json")).then((response) => response.json()),
    fetch(dataUrl("validation-report.json")).then((response) => response.json())
  ]);

  events = eventData;
  presenters = presenterData;
  searchDocs = searchData;
  sources = sourceData;
  validation = validationData;

  for (const item of events) eventsById.set(item.id, item);
  for (const presenter of presenters) presentersById.set(presenter.id, presenter);

  searchIndex = new MiniSearch<SearchDocument>({
    fields: ["title", "body", "keywords"],
    storeFields: ["title", "type", "itemId", "presenterId"]
  });
  searchIndex.addAll(searchDocs);

  const firstDay = dateOptions()[0];
  if (firstDay) state.day = firstDay;
  render();
}

init().catch((error) => {
  app.innerHTML = `<div class="main"><div class="empty">Failed to load program data: ${escapeHtml(error instanceof Error ? error.message : String(error))}</div></div>`;
});

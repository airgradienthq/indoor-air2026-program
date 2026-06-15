# Conference Program Website Specification

## Purpose

Build a small static website that makes the Indoor Air 2026 conference program easier to search and browse while attending the event.

The site should prioritize fast answers on a phone:

- What sessions, talks, and posters match a topic, presenter, or room?
- What is going on now?
- What is coming up next?
- Where is a poster or session located?

## Source Documents

Use the PDFs currently present in `downloaded-pdfs/` as the source of truth:

- `Programme as at 12 June 2026_2008hrs.pdf`
- `Session details as at 12 June 2026_2008hrs.pdf`
- `Poster Location - Panel Assignment - 12 June 2026.pdf`
- `Poster Location - Wayfinding - 12 June 2026.pdf`

PDFs that were deleted from `downloaded-pdfs/` should be ignored.

## Core Requirements

### 1. Full Text Search

The site must provide one search box that searches across:

- Session title
- Session description or abstract text
- Talk title
- Poster title
- Presenter, speaker, chair, and author names
- Room, location, track, session type, poster panel, and poster code

Search results should be grouped by result type:

- Sessions
- Talks or papers
- Posters
- Presenters
- Locations

Each result should show enough context to decide whether to open it:

- Title
- Date and time
- Room or poster location
- Matching presenter names
- Snippet of matching text where possible
- Source type, such as session, talk, poster, or presenter

Search should tolerate partial matches, casing differences, punctuation differences, and small typos. A lightweight frontend search library such as `MiniSearch` or `Fuse.js` is acceptable.

### 2. Going On Now

The home screen must show a `Going on now` section.

This section should:

- Use `Asia/Singapore` as the conference timezone, stored as a site configuration value.
- Compare the current browser time against normalized session start and end times.
- Show active sessions, talks, breaks, keynotes, poster sessions, and other scheduled items.
- Include room, time range, title, and a compact action to open details.
- Sort by start time, then room.
- Show a clear empty state when nothing is currently active.
- Exclude posters or poster assignments that do not have a specific start and end time.

If an item has no end time, the data build step should infer one where possible from the next item in the same room or from the parent session.

### 3. Upcoming

The home screen must show an `Upcoming` section.

This section should:

- Show the next scheduled items after the current time.
- Default to the next 2 to 4 hours or the next 10 items, whichever is more useful.
- Group by time block when many items start together.
- Include room, time, title, and session type.
- Allow quick filtering to `All`, `Sessions`, `Posters`, `Keynotes`, and `Breaks` if the data supports those types.
- Exclude posters or poster assignments that do not have a specific start and end time.

### 4. Session And Poster Detail Views

Each session detail page or panel should show:

- Session title
- Date
- Start and end time
- Room
- Track or theme when available
- Session type
- Chairs or moderators when available
- Talks, speakers, and abstracts when available
- Related posters or linked poster sessions when available

Each poster detail page or panel should show:

- Poster code or panel number
- Poster title
- Authors or presenters
- Poster session date and time when available
- Poster location or panel assignment
- Searchable abstract or topic text when available
- Wayfinding reference when available

Presenter names should be clickable when the data can identify them reliably. A presenter detail view should list every session, talk, and poster associated with that person.

### 5. Favorites

The first version should support saving favorites locally in the browser.

Favorites should:

- Use `localStorage`.
- Work without user accounts.
- Apply to sessions, talks, and posters.
- Be visible from item detail views and search results.
- Provide a simple `Favorites` view or filter.
- Stay local to the current browser and device.

## Recommended Architecture

Avoid a complex backend. Use a static frontend with prebuilt data files.

### Static Site

Recommended stack:

- Vite
- TypeScript
- Plain React, Vue, Svelte, or simple vanilla TypeScript
- Static JSON files in `public/data/`
- Client-side search index loaded from static JSON

The site can be hosted on GitHub Pages, Netlify, Vercel, Cloudflare Pages, or opened locally during the conference if built as static files.

### Build-Time Data Pipeline

Create a local build step that converts the source PDFs into normalized JSON.

Proposed generated files:

- `public/data/events.json`: all sessions, talks, posters, breaks, and scheduled items
- `public/data/presenters.json`: normalized presenter records
- `public/data/search-index.json`: prebuilt search documents
- `public/data/sources.json`: source filenames, generated timestamp, and parser warnings
- `data/corrections.json`: manual mappings for room names, poster panels, presenter names, and parser fixes

The frontend should never need to parse PDFs directly.

### Data Extraction Validation

The build step should prove that extracted records correspond to the source PDFs as much as possible.

Each extracted record should keep source provenance:

- `sourceFile`
- `sourcePage`
- Raw extracted text snippet used to create the record
- Parser confidence or warning flags when a field was inferred or corrected

Automated validation should include:

- Schema checks: every generated JSON file must match the expected shape, with required fields by item type.
- Source text checks: session titles, poster codes, poster titles, presenter names, room names, and time strings should be found on the recorded source page whenever possible.
- Date and time checks: all scheduled items must use `Asia/Singapore`, have valid dates and times, and have `endTime` after `startTime`.
- Parent-child checks: talks linked to a session must fall inside the parent session time window when talk times are available.
- Link checks: every `presenterId`, `parentId`, and related item reference must resolve to an existing record.
- Correction checks: every manual correction in `data/corrections.json` should match at least one extracted value, so stale corrections are caught.
- Search checks: a small set of known search terms should return expected sessions, posters, or presenters.

The build step should also generate a human-review report, for example `public/data/validation-report.html` or `data/validation-report.md`, that shows:

- Extracted item
- Source PDF filename and page
- Source text snippet
- Applied corrections
- Parser warnings
- Missing or inferred fields

Manual review should focus on:

- All keynote, plenary, and high-priority schedule items
- All items currently shown in `Going on now` or `Upcoming`
- A random sample of sessions, talks, posters, and presenters
- Every item with parser warnings or manual corrections

The site should not silently publish if validation finds missing required fields, broken links, invalid times, or extracted records with no source evidence.

### Browser QA Automation

After the static site exists, use Chrome DevTools automation to test the built website in a real browser.

Automated browser checks should include:

- Load the local production build.
- Capture desktop and mobile screenshots of the home screen, search results, session detail, poster detail, presenter detail, and favorites view.
- Verify the page renders without console errors.
- Verify required data files load successfully from `public/data/`.
- Search known terms and assert expected sessions, posters, or presenters appear.
- Test `Going on now` and `Upcoming` by overriding browser time or injecting a controlled test clock.
- Test favorites by adding and removing a session, talk, and poster, then confirming `localStorage` persists the selection after reload.
- Check that result cards show title, time, room or poster location, and source type.
- Check mobile layout for text overflow, overlapping controls, and unreachable tap targets.

Screenshot output should be saved under a local QA folder, for example `qa/screenshots/`, so visual changes can be reviewed quickly.

### No Backend By Default

The first version should not require:

- A database
- Server-side search
- User accounts
- Admin screens
- Authentication
- Live synchronization

If the PDFs change, regenerate the static JSON and redeploy.

## Confirmed Decisions

1. The conference timezone is `Asia/Singapore`.
2. The site should only use information present in the remaining source PDFs.
3. The first version should support browser-local favorites.
4. `Going on now` and `Upcoming` should exclude posters that do not have a specific time.
5. The data build step should support a manual correction file for normalizing room names, poster panel locations, presenter names, and parser fixes.

## Data Model Draft

```ts
type ProgramItem = {
  id: string;
  type: "session" | "talk" | "poster" | "break" | "keynote" | "other";
  title: string;
  description?: string;
  date?: string; // YYYY-MM-DD
  startTime?: string; // HH:mm, conference local time
  endTime?: string; // HH:mm, conference local time
  timezone: string;
  room?: string;
  location?: string;
  track?: string;
  sessionType?: string;
  parentId?: string;
  presenterIds?: string[];
  posterCode?: string;
  panel?: string;
  sourceFile: string;
  sourcePage?: number;
};

type Presenter = {
  id: string;
  displayName: string;
  normalizedName: string;
  affiliations?: string[];
  itemIds: string[];
};

type SearchDocument = {
  id: string;
  itemId?: string;
  presenterId?: string;
  type: "session" | "talk" | "poster" | "presenter" | "location";
  title: string;
  body: string;
  keywords: string[];
};
```

## Key Screens

### Home

- Search box at the top.
- `Going on now` section.
- `Upcoming` section.
- Shortcut filters for today, posters, keynotes, rooms, and presenters.

### Search Results

- Sticky search input.
- Type filters.
- Results grouped by type or sorted by relevance.
- Compact result cards optimized for phone use.

### Schedule

- Day selector.
- Timeline grouped by time.
- Room/location labels.
- Filters for session type and track.

### Posters

- Searchable poster list.
- Filter by poster session, panel, location, or topic when available.
- Link to wayfinding information.

### Presenter

- Presenter name.
- All related sessions, talks, and posters.
- Times and locations for each item.

## UX Priorities

- Fast on mobile conference Wi-Fi.
- Works after initial load even with poor connectivity.
- Minimal navigation depth.
- Search results should be useful within one keystroke or two.
- Times and rooms must be visible without opening every result.
- Use readable density: compact, but not cramped.
- Avoid decorative landing-page treatment; the first screen should be the usable program browser.

## Open Questions

No open product questions yet.

## First Milestone

Build a static prototype that:

- Extracts or manually normalizes data from the four remaining PDFs.
- Generates `events.json`, `presenters.json`, and `search-index.json`.
- Implements full text search across sessions, posters, presenters, rooms, and text.
- Shows `Going on now` and `Upcoming` based on conference-local time.
- Supports browser-local favorites.
- Applies a manual correction file for room, location, poster panel, presenter, and parser cleanup.
- Provides basic detail views for sessions, posters, and presenters.

## Later Enhancements

- Add-to-calendar links.
- Offline service worker.
- Room map or poster wayfinding images.
- QR code for sharing the site.
- Export personal schedule.

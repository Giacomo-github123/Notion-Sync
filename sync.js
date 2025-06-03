// sync.js
import { Client } from "@notionhq/client";
import { google } from "googleapis";

// ─── 1) Notion client ──────────────────────────────────────────────────────────
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// ─── 2) Google OAuth2 client ───────────────────────────────────────────────────
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// ─── 3) Fetch existing UIDs from Notion ─────────────────────────────────────────
async function fetchExistingUIDs() {
  const uids = new Set();
  let cursor;

  do {
    const resp = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      page_size: 100,
      start_cursor: cursor,
      properties: ["UID"],
    });

    resp.results.forEach((page) => {
      const uidProp = page.properties.UID;
      if (uidProp?.type === "rich_text" && uidProp.rich_text.length > 0) {
        uids.add(uidProp.rich_text[0].plain_text);
      }
    });

    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  return uids;
}

// ─── 4) Upsert one event into Notion ───────────────────────────────────────────
async function upsertEventToNotion(evt) {
  const existing = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    page_size: 1,
    filter: { property: "UID", rich_text: { equals: evt.uid } },
  });

  const props = {
    Name: { title: [{ text: { content: evt.summary || "(no title)" } }] },
    Start: { date: { start: evt.startDate, end: evt.endDate || null } },
    Source: { select: { name: evt.source } },
    UID:   { rich_text: [{ text: { content: evt.uid } }] },
  };
  if (evt.link) props.Link = { url: evt.link };

  if (existing.results.length) {
    await notion.pages.update({ page_id: existing.results[0].id, properties: props });
  } else {
    await notion.pages.create({ parent: { database_id: NOTION_DATABASE_ID }, properties: props });
  }
}

// ─── 5) Main sync ──────────────────────────────────────────────────────────────
(async () => {
  try {
    await fetchExistingUIDs(); // ensure DB accessible (optional)

    // Define time window: now → one year ahead
    const nowIso = new Date().toISOString();
    const oneYearAheadIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    // Get every calendar you can see
    const listRes = await calendar.calendarList.list();
    const allCalendarIds = listRes.data.items.map((c) => c.id);

    // Loop calendars
    for (const calId of allCalendarIds) {
      const { data } = await calendar.events.list({
        calendarId: calId,
        timeMin: nowIso,
        timeMax: oneYearAheadIso,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500,
      });

      for (const ev of data.items || []) {
        await upsertEventToNotion({
          uid:        ev.id,
          summary:    ev.summary,
          startDate:  ev.start?.dateTime || ev.start?.date,
          endDate:    ev.end?.dateTime   || ev.end?.date ||
                      new Date(new Date(ev.start.dateTime || ev.start.date).getTime() + 3600000).toISOString(),
          source:     "Google",
          link:       ev.htmlLink,
        });
      }
    }

    console.log("✅ Sync complete");
  } catch (err) {
    console.error("❌ Sync error:", err);
    process.exit(1);
  }
})();

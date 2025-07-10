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
      // only need UID for dedupe
      properties: ["UID"],
    });

    resp.results.forEach(page => {
      const prop = page.properties.UID;
      if (prop.type === "rich_text" && prop.rich_text.length) {
        uids.add(prop.rich_text[0].plain_text);
      }
    });

    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  return uids;
}

// ─── 4) Upsert one event into Notion ───────────────────────────────────────────
async function upsertEventToNotion(evt) {
  // look for an existing page with this UID
  const existing = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    page_size: 1,
    filter: {
      property: "UID",
      rich_text: { equals: evt.uid }
    }
  });

  // map to your new properties
  const props = {
    Name: {
      title: [{ text: { content: evt.summary || "(no title)" } }]
    },
    "Date/Time": {
      date: {
        start: evt.startDate,
        end: evt.endDate
      }
    },
    Calendar: {
      select: { name: evt.calendarName }
    },
    UID: {
      rich_text: [{ text: { content: evt.uid } }]
    },
    "Event Location": {
      rich_text: [{ text: { content: evt.location || "" } }]
    },
    Notes: {
      rich_text: [{ text: { content: evt.description || "" } }]
    }
    // Rollup, Domain, Linked Tasks are left untouched
  };

  if (existing.results.length) {
    // update
    await notion.pages.update({
      page_id: existing.results[0].id,
      properties: props
    });
  } else {
    // create
    await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: props
    });
  }
}

// ─── 5) Main sync ──────────────────────────────────────────────────────────────
(async () => {
  try {
    await fetchExistingUIDs(); // sanity check

    const nowIso = new Date().toISOString();
    const oneYearAheadIso = new Date(Date.now() + 365*24*60*60*1000).toISOString();

    // get all calendars you have access to
    const listRes = await calendar.calendarList.list();
    const calendars = listRes.data.items || [];

    for (const cal of calendars) {
      const calId   = cal.id;
      const calName = cal.summary;

      const { data } = await calendar.events.list({
        calendarId:    calId,
        timeMin:       nowIso,
        timeMax:       oneYearAheadIso,
        singleEvents:  true,
        orderBy:       "startTime",
        maxResults:    2500
      });

      for (const ev of data.items || []) {
        await upsertEventToNotion({
          uid:          ev.id,
          summary:      ev.summary,
          startDate:    ev.start?.dateTime || ev.start?.date,
          endDate:      ev.end?.dateTime   || ev.end?.date ||
                        new Date(
                          new Date(ev.start?.dateTime || ev.start?.date)
                            .getTime() + 60*60*1000
                        ).toISOString(),
          calendarName: calName,
          location:     ev.location,
          description:  ev.description
        });
      }
    }

    console.log("✅ Sync complete");
  } catch (err) {
    console.error("❌ Sync error:", err);
    process.exit(1);
  }
})();

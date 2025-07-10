// sync.js
import { Client } from "@notionhq/client";
import { google } from "googleapis";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

async function findExistingEvent(summary, start) {
  const response = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    filter: {
      and: [
        { property: "Name", title: { equals: summary || "(no title)" } },
        { property: "Date/Time", date: { equals: start } },
      ],
    },
    page_size: 1,
  });
  return response.results[0] || null;
}

async function upsertEventToNotion(evt) {
  const existing = await findExistingEvent(evt.summary, evt.startDate);

  const props = {
    Name: { title: [{ text: { content: evt.summary || "(no title)" } }] },
    "Date/Time": { date: { start: evt.startDate, end: evt.endDate || null } },
    Calendar: { rich_text: [{ text: { content: evt.calendarId } }] },
  };

  if (evt.description) {
    props.Notes = { rich_text: [{ text: { content: evt.description } }] };
  }

  if (evt.location) {
    props["Event Location"] = { rich_text: [{ text: { content: evt.location } }] };
  }

  if (existing) {
    await notion.pages.update({ page_id: existing.id, properties: props });
  } else {
    await notion.pages.create({ parent: { database_id: NOTION_DATABASE_ID }, properties: props });
  }
}

(async () => {
  try {
    const nowIso = new Date().toISOString();
    const oneYearAheadIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    const listRes = await calendar.calendarList.list();
    const allCalendarIds = listRes.data.items.map((c) => c.id);

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
          summary:     ev.summary,
          startDate:   ev.start?.dateTime || ev.start?.date,
          endDate:     ev.end?.dateTime   || ev.end?.date || null,
          calendarId:  calId,
          description: ev.description || "",
          location:    ev.location || "",
        });
      }
    }

    console.log("✅ Sync complete");
  } catch (err) {
    console.error("❌ Sync error:", err);
    process.exit(1);
  }
})();

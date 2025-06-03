// sync.js
import { Client } from "@notionhq/client";
// import ical from "node-ical";           // ⬅️ iCloud parser (disabled)
import { google } from "googleapis";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// const ICLOUD_ICS_URLS = JSON.parse(process.env.ICLOUD_ICS_URLS || "[]"); // ⬅️ disabled

async function fetchExistingUIDs() {
  const set = new Set();
  let cursor;
  do {
    const resp = await notion.databases.query({
      database_id: NOTION_DATABASE_ID,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const page of resp.results) {
      const uidProp = page.properties.UID;
      if (uidProp.rich_text.length) {
        set.add(uidProp.rich_text[0].plain_text);
      }
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return set;
}

async function upsertEventToNotion(evt) {
  const query = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    page_size: 1,
    filter: {
      property: "UID",
      rich_text: { equals: evt.uid },
    },
  });

  const props = {
    Name: {
      title: [
        {
          text: { content: evt.summary || "(no title)" },
        },
      ],
    },
    Start: {
      date: { start: evt.startDate, end: evt.endDate || null },
    },
    Source: {
      select: { name: evt.source },
    },
    UID: {
      rich_text: [
        {
          text: { content: evt.uid },
        },
      ],
    },
  };
  if (evt.link) {
    props.Link = { url: evt.link };
  }

  if (query.results.length) {
    await notion.pages.update({
      page_id: query.results[0].id,
      properties: props,
    });
  } else {
    await notion.pages.create({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: props,
    });
  }
}

(async () => {
  try {
    const existingUIDs = await fetchExistingUIDs();

    // A) Sync Google events (updated in last 15 minutes)
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const listRes = await calendar.calendarList.list();
    const allCalendarIds = listRes.data.items.map((c) => c.id);

    for (const calId of allCalendarIds) {
      const { data } = await calendar.events.list({
        calendarId: calId,
        updatedMin: fifteenMinAgo,
        singleEvents: true,
        orderBy: "updated",
        maxResults: 100,
      });
      for (const ev of data.items || []) {
        const uid = ev.id;
        const startDate = ev.start.dateTime || ev.start.date;
        const endDate =
          ev.end?.dateTime ||
          ev.end?.date ||
          new Date(new Date(startDate).getTime() + 3600000).toISOString();
        await upsertEventToNotion({
          uid,
          summary: ev.summary,
          startDate,
          endDate,
          source: "Google",
          link: ev.htmlLink,
        });
        existingUIDs.add(uid);
      }
    }

    // B) Sync iCloud/Outlook events via ICS (disabled)
    /*
    for (const icsUrl of ICLOUD_ICS_URLS) {
      const icalData = await ical.fromURL(icsUrl);
      for (const ev of Object.values(icalData)) {
        if (ev.type === "VEVENT" && ev.start) {
          const uid = ev.uid;
          const startDate = ev.start.toISOString();
          const endDate = ev.end
            ? ev.end.toISOString()
            : new Date(ev.start.getTime() + 3600000).toISOString();
          await upsertEventToNotion({
            uid,
            summary: ev.summary || "(no title)",
            startDate,
            endDate,
            source: "iCloud",
          });
          existingUIDs.add(uid);
        }
      }
    }
    */

    console.log("✅ Sync complete");
  } catch (err) {
    console.error("❌ Sync error:", err);
    process.exit(1);
  }
})();

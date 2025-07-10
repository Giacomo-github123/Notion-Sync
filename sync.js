// sync.js
import { Client } from "@notionhq/client";
import { google } from "googleapis";

// 1) Notion client
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// 2) Google OAuth2 client
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET
);
oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

// 3) Fetch existing UIDs
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

// 4) Upsert one event
async function upsertEventToNotion(evt) {
  const existing = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    page_size: 1,
    filter: { property: "UID", rich_text: { equals: evt.uid } },
  });

  const props = {
    Name: {
      title: [{ text: { content: evt.summary || "(no title)" } }]
    },
    "Date/Time": {
      date: { start: evt.startDate, end: evt.endDate }
    },
    Calendar: {
      // ← now rich_text instead of select
      rich_text: [{ text: { content: evt.calendarName } }]
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
    // Rollup, Domain, Linked Tasks remain untouched
  };

  if (existing.results.length) {
    await notion.pages.update({
      page_id: existing.results[0].id,
      properties: props
    });
  } else {
    awai

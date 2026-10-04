# Source Spread

Static site for Source Spread. The page layout remains in `index.html`; published articles are generated from the Notion source database into `posts.json` and static `/posts/{slug}/` pages.

## Notion database

The Source Spread database has been created in the connected Notion workspace. Its database URL is <https://app.notion.com/p/e7896766856a4e06b57cd259c694c161> and its data source ID is `7790a424-902d-44f2-ade0-560b2e51056c`. Its properties are:

| Property | Type | Required |
| --- | --- | --- |
| Title | Title | Yes |
| From | Rich text | Yes |
| Source | Rich text | Yes |
| Date | Date — original/source date shown on the site | Yes |
| Sort Date | Date — controls newest-first order; initially matches Date | Yes |
| Category | Select (`Design`, `Fashion`, `Tech`, `Sports`, `Culture`) | Yes |
| Thumbnail | URL or Files & media | No |
| Source URL | URL | Yes |
| Published | Checkbox | Yes |
| Slug | Rich text | No; generated from Title when empty |

Write article content in the page body. Paragraphs start flush left without indentation and get about one line of space between them; line breaks inside a paragraph stay visible. The site keeps inline bold/italic/underline/strikethrough/code, text colors, links, headings, quotes, bulleted and numbered lists, checklists, callouts, bookmarks, equations, dividers, and images. Empty paragraphs remain as extra spacing. Only rows with `Published` checked are exported. An unpublished `[TEST] Sample article` is in the database as a field and body example; replace it with an actual article before publishing. Share the data source with the Notion integration used for the API token.

### Article layout

- The site does not add gray `01`, `02` section numbers. All regular text, headings, and paragraphs go in the second column.
- Use a Notion **Divider** only when you want extra blank space between paragraphs. It never adds a number or other marker.
- For interview dialogue, put each turn in its own paragraph as `Name: dialogue`, for example `GQ: What inspired the first designs?` followed by `James Jebbia: The people around the store inspired us.` The site places the speaker name in the first column and the dialogue in the second column on the same line. The colon is an input marker and is not shown on the site; the speaker name is black.
- Text without a `Name:` prefix appears only in the second column. With or without Dividers, content starts with the first body block; it is not moved into a separate lead area.
- Use **Heading 1**, **Heading 2**, and **Heading 3** for headings. They do not create section numbers.
- `Date` is the original/source date displayed on the site. `Sort Date` determines newest-first order on both the Notion database view and the homepage. For existing articles, both dates were initially set to the existing `Date`; set `Sort Date` to the day you want a new or updated article to move to the top.

## Manual sync

Create an internal Notion integration with read access to this data source, then add its token as the repository Actions secret `NOTION_TOKEN`. The data source ID is already configured in the sync script; it can be overridden with the `NOTION_DATA_SOURCE_ID` environment variable if the database is moved. Then open **Actions → Sync Notion → Run workflow** and choose the branch to update. The workflow commits changed content to that branch; when run on the production branch, the connected Vercel project deploys the update.

The site reads `posts.json`. A sync also creates static pages for each published post so link preview crawlers receive that article's title, description, canonical URL, and thumbnail without running JavaScript. Uploaded Notion images are copied into `assets/notion/` so expiring Notion file URLs are not used by the public site. Each downloaded image must be at most 15 MB.

## Near-real-time sync

The manual GitHub Actions button remains available. To also sync automatically after Notion edits, deploy the merged project on Vercel, then configure:

1. Create a fine-grained GitHub token for `chaigun-jung-me/spread-project` with **Actions: write** permission. Add it to Vercel Production environment variables as `GITHUB_DISPATCH_TOKEN`.
2. In Vercel Production, set `NOTION_WEBHOOK_VERIFICATION_TOKEN` after creating the Notion webhook as described below. The function logs the initial one-time verification token so it can be copied from Vercel function logs. Store it in Vercel, redeploy, then paste that same value into Notion's verification dialog.
3. In the Notion integration's **Webhooks** settings, create a subscription pointing to `https://source-spread.kr/api/notion-webhook`. Subscribe to `page.created`, `page.content_updated`, `page.properties_updated`, `page.deleted`, `page.undeleted`, `page.moved`, and `data_source.content_updated`. The integration should only be shared with the Source Spread database so unrelated pages do not trigger builds.
4. Verify the webhook in Notion. Edits then dispatch the existing sync workflow on `main`; its generated commit triggers the connected Vercel deployment. The endpoint verifies Notion's HMAC signature before dispatching.

Notion groups frequent page edits and typically delivers the event within about a minute, with documented delivery taking up to five minutes. GitHub Actions and Vercel deployment add time after that, so this is near-real-time rather than instantaneous. The manual sync action remains a fallback.

## Local preview

Serve this directory with any static file server. After editing Notion content, run `node scripts/sync-notion.mjs` with the two environment variables set to regenerate the public data and pages.

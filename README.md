# Source Spread

Static site for Source Spread. The page layout remains in `index.html`; published articles are generated from the Notion source database into `posts.json` and static `/posts/{slug}/` pages.

## Notion database

The Source Spread database has been created in the connected Notion workspace. Its database URL is <https://app.notion.com/p/e7896766856a4e06b57cd259c694c161> and its data source ID is `7790a424-902d-44f2-ade0-560b2e51056c`. Its properties are:

| Property | Type | Required |
| --- | --- | --- |
| Title | Title | Yes |
| From | Rich text | Yes |
| Source | Rich text | Yes |
| Date | Date | Yes |
| Category | Select (`Design`, `Fashion`, `Tech`, `People`, `Culture`) | Yes |
| Thumbnail | URL or Files & media | No |
| Source URL | URL | Yes |
| Published | Checkbox | Yes |
| Slug | Rich text | No; generated from Title when empty |

Write article content in the page body. Paragraphs, headings, quotes, lists, code, and images are included. Only rows with `Published` checked are exported. An unpublished `[TEST] Sample article` is in the database as a field and body example; replace it with an actual article before publishing. Share the data source with the Notion integration used for the API token.

## Manual sync

Create an internal Notion integration with read access to this data source, then add its token as the repository Actions secret `NOTION_TOKEN`. The data source ID is already configured in the sync script; it can be overridden with the `NOTION_DATA_SOURCE_ID` environment variable if the database is moved. Then open **Actions → Sync Notion → Run workflow** and choose the branch to update. The workflow commits changed content to that branch; when run on the production branch, the connected Vercel project deploys the update.

The site reads `posts.json`. A sync also creates static pages for each published post so link preview crawlers receive that article's title, description, canonical URL, and thumbnail without running JavaScript. Uploaded Notion images are copied into `assets/notion/` so expiring Notion file URLs are not used by the public site. Each downloaded image must be at most 15 MB.

## Local preview

Serve this directory with any static file server. After editing Notion content, run `node scripts/sync-notion.mjs` with the two environment variables set to regenerate the public data and pages.

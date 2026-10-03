import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.NOTION_TOKEN;
const dataSourceId = process.env.NOTION_DATA_SOURCE_ID || '7790a424-902d-44f2-ade0-560b2e51056c';
const apiVersion = '2026-03-11';
const categories = new Set(['Design', 'Fashion', 'Tech', 'People', 'Culture']);
const assetsDirectory = path.join(root, 'assets', 'notion');
await rm(assetsDirectory, { recursive: true, force: true });
await mkdir(assetsDirectory, { recursive: true });

if (!token || !dataSourceId) {
  throw new Error('Set the NOTION_TOKEN GitHub Actions secret.');
}

async function notion(endpoint, options = {}) {
  const response = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': apiVersion,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Notion ${response.status}: ${data.message || endpoint}`);
  return data;
}

const asText = value => Array.isArray(value) ? value.map(item => item.plain_text || item.text?.content || '').join('') : '';
const slugify = value => value.toLocaleLowerCase().normalize('NFKC').trim()
  .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
  .replace(/^-+|-+$/g, '');
const plain = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const summary = post => (post.body.find(block => block.text)?.text || `${post.from}에서 소개한 ${post.category} 콘텐츠를 번역하고 큐레이션합니다.`).replace(/\s+/g, ' ').slice(0, 160);

function imageExtension(url, contentType = '') {
  const type = contentType.split(';')[0].trim().toLowerCase();
  const known = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/svg+xml': '.svg' };
  if (known[type]) return known[type];
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg'].includes(ext) ? ext : '.jpg';
}

async function localImage(url, pageId, key) {
  if (!url) return '';
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download image (${response.status}): ${parsed.hostname}`);
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().startsWith('image/')) throw new Error(`Expected an image but received ${type || 'unknown content'}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 15 * 1024 * 1024) throw new Error(`Image exceeds 15 MB: ${parsed.hostname}`);
  const relative = path.posix.join('assets', 'notion', pageId.replaceAll('-', ''), `${key}${imageExtension(url, type)}`);
  const destination = path.join(root, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return `/${relative}`;
}

function property(page, name) { return page.properties?.[name]; }
function valueText(page, name) {
  const p = property(page, name);
  return p?.type === 'title' ? asText(p.title) : asText(p?.rich_text);
}
function valueSelect(page, name) { return property(page, name)?.select?.name || ''; }
function valueUrl(page, name) {
  const p = property(page, name);
  if (p?.type === 'url') return p.url || '';
  if (p?.type === 'files') {
    const file = p.files?.[0];
    return file?.external?.url || file?.file?.url || '';
  }
  return '';
}
function valueDate(page, name) { return property(page, name)?.date?.start?.slice(0, 10) || ''; }
function isPublished(page) { return property(page, 'Published')?.checkbox === true; }

async function fetchBlocks(pageId) {
  let cursor;
  const blocks = [];
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (cursor) query.set('start_cursor', cursor);
    const result = await notion(`blocks/${pageId}/children?${query}`);
    blocks.push(...result.results);
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  return blocks;
}

async function convertBlock(block, pageId, imageCount) {
  const type = block.type;
  const data = block[type] || {};
  if (type === 'divider') return { type };
  if (type === 'image') {
    const file = data.external?.url || data.file?.url;
    const url = await localImage(file, pageId, `body-${imageCount}`);
    if (!url) return null;
    return { type, url, caption: asText(data.caption) };
  }
  const supported = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'quote', 'bulleted_list_item', 'numbered_list_item', 'code']);
  if (!supported.has(type)) return null;
  const text = asText(data.rich_text);
  if (!text.trim()) return null;
  return { type, text, number: data.number || '' };
}

const queryResults = [];
let cursor;
do {
  const body = { page_size: 100, sorts: [{ property: 'Date', direction: 'descending' }] };
  if (cursor) body.start_cursor = cursor;
  const result = await notion(`data_sources/${dataSourceId}/query`, { method: 'POST', body: JSON.stringify(body) });
  queryResults.push(...result.results);
  cursor = result.has_more ? result.next_cursor : null;
} while (cursor);

const published = queryResults.filter(isPublished);
const slugs = new Set();
const posts = [];
for (const page of published) {
  const title = valueText(page, 'Title');
  const category = valueSelect(page, 'Category');
  const sourceUrl = valueUrl(page, 'Source URL');
  const from = valueText(page, 'From');
  const source = valueText(page, 'Source');
  const date = valueDate(page, 'Date');
  if (!title || !from || !source || !date || !categories.has(category) || !sourceUrl) {
    throw new Error(`Published page ${page.id} must have Title, From, Source, Date, a supported Category, and Source URL.`);
  }
  let parsedSource;
  try { parsedSource = new URL(sourceUrl); } catch { throw new Error(`Source URL is invalid on “${title}”.`); }
  if (!['http:', 'https:'].includes(parsedSource.protocol)) throw new Error(`Source URL must use HTTP or HTTPS on “${title}”.`);
  const slug = slugify(valueText(page, 'Slug') || title) || page.id.replaceAll('-', '');
  if (slugs.has(slug)) throw new Error(`Duplicate slug: ${slug}`);
  slugs.add(slug);
  const rawThumb = valueUrl(page, 'Thumbnail');
  const thumbnail = rawThumb ? await localImage(rawThumb, page.id, 'thumbnail') : '';
  const rawBlocks = await fetchBlocks(page.id);
  const body = [];
  let imageCount = 0;
  for (const block of rawBlocks) {
    if (block.type === 'image') imageCount += 1;
    const converted = await convertBlock(block, page.id, imageCount);
    if (converted) body.push(converted);
  }
  posts.push({
    slug, title, category, date,
    from, source,
    url: sourceUrl, thumbnail, body, lang: 'ko', createdTime: page.created_time || '',
  });
}
posts.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdTime || '').localeCompare(a.createdTime || '') || a.title.localeCompare(b.title, 'ko'));
await writeFile(path.join(root, 'posts.json'), `${JSON.stringify(posts, null, 2)}\n`);

// Each detail URL has its own HTML shell so link previews receive metadata without running JS.
const template = await readFile(path.join(root, 'index.html'), 'utf8');
const generatedPosts = path.join(root, 'posts');
for (const entry of await readdir(generatedPosts).catch(() => [])) {
  if (entry !== 'README.md') await rm(path.join(generatedPosts, entry), { recursive: true, force: true });
}
for (const post of posts) {
  const canonical = `https://source-spread.kr/posts/${encodeURIComponent(post.slug)}`;
  const title = `${post.title} — source spread`;
  const description = summary(post);
  let html = template
    .replace('<title>source spread</title>', `<title>${plain(title)}</title>`)
    .replace('content="해외 패션, 테크, 디자인, 문화 콘텐츠를 번역하고 큐레이션합니다."', `content="${plain(description)}"`)
    .replace('property="og:type" content="website"', 'property="og:type" content="article"')
    .replace('property="og:title" content="source spread"', `property="og:title" content="${plain(title)}"`)
    .replace(/property="og:description" content="[^"]*"/, `property="og:description" content="${plain(description)}"`)
    .replace('href="https://source-spread.kr/">', `href="${canonical}">`);
  if (post.thumbnail) html = html.replace('</head>', `<meta property="og:image" content="https://source-spread.kr${post.thumbnail}">\n</head>`);
  const directory = path.join(generatedPosts, post.slug);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'index.html'), html);
}

console.log(`Synced ${posts.length} published post(s) from Notion.`);

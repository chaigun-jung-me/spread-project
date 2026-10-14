import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = process.env.NOTION_TOKEN;
const dataSourceId = process.env.NOTION_DATA_SOURCE_ID || '7790a424-902d-44f2-ade0-560b2e51056c';
const apiVersion = '2026-03-11';
const categories = new Set(['Design', 'Fashion', 'Tech', 'Sports', 'Culture', 'Music']);
const assetsDirectory = path.join(root, 'assets', 'notion');
await mkdir(assetsDirectory, { recursive: true });

if (!token || !dataSourceId) {
  throw new Error('Set the NOTION_TOKEN GitHub Actions secret.');
}

async function notion(endpoint, options = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`https://api.notion.com/v1/${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': apiVersion,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    // Rate limits and transient Notion outages are retried instead of failing the whole sync.
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      const wait = Number(response.headers.get('retry-after')) || attempt * 2;
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      continue;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(`Notion ${response.status}: ${data.message || endpoint}`);
    return data;
  }
}

const asText = value => Array.isArray(value) ? value.map(item => item.plain_text || item.text?.content || '').join('') : '';
const serializeRichText = value => Array.isArray(value) ? value.map(item => ({
  text: item.plain_text || item.text?.content || '',
  href: item.href || item.text?.link?.url || '',
  annotations: {
    bold: item.annotations?.bold === true,
    italic: item.annotations?.italic === true,
    strikethrough: item.annotations?.strikethrough === true,
    underline: item.annotations?.underline === true,
    code: item.annotations?.code === true,
    color: item.annotations?.color || 'default',
  },
})) : [];
const slugify = value => value.toLocaleLowerCase().normalize('NFKC').trim()
  .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
  .replace(/^-+|-+$/g, '');
const plain = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function autoDescription(post) {
  const sentences = [];
  const paragraphs = post.body
    .filter(block => block.type === 'paragraph' && block.text)
    .map(block => block.text.replace(/\s+/g, ' ').trim())
    .filter(text => text && !/^[^\s:\n][^:\n]{0,39}:[ \t]*\S/u.test(text));
  for (const paragraph of paragraphs) {
    const parts = paragraph.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/gu) || [];
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence) sentences.push(sentence);
      if (sentences.length === 2) break;
    }
    if (sentences.length === 2) break;
  }
  const fallback = `${post.from}에서 소개한 ${post.category} 분야의 글입니다.`;
  if (!sentences.length) {
    const title = post.title.replace(/[.!?]+$/u, '').trim();
    sentences.push(`${title}의 핵심 내용을 다룹니다.`, fallback);
  }
  if (sentences.length === 1) sentences.push(fallback);
  return sentences.slice(0, 2).join(' ');
}
const summary = post => (post.description || autoDescription(post)).replace(/\s+/g, ' ').trim();

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
    return { type, url, caption: asText(data.caption), caption_rich_text: serializeRichText(data.caption) };
  }
  const supported = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'quote', 'bulleted_list_item', 'numbered_list_item', 'code', 'to_do', 'callout', 'bookmark', 'video', 'embed', 'equation']);
  if (!supported.has(type)) return null;
  const source = ['bookmark', 'video'].includes(type) ? data.caption : ['equation', 'embed'].includes(type) ? [] : data.rich_text;
  const richText = serializeRichText(source);
  const text = type === 'equation' ? data.expression || '' : type === 'embed' ? data.url || '' : asText(source);
  if (!text.trim() && !['paragraph', 'callout', 'bookmark', 'video', 'embed'].includes(type)) return null;
  const result = { type, text, rich_text: richText };
  if (type === 'to_do') result.checked = data.checked === true;
  if (type === 'callout') result.icon = data.icon?.emoji || '';
  if (type === 'bookmark') result.url = data.url || '';
  if (type === 'video') {
    result.url = data.external?.url || data.file?.url || '';
    result.caption = asText(data.caption);
  }
  if (type === 'embed') result.url = data.url || '';
  return result;
}

const queryResults = [];
let cursor;
do {
  const body = { page_size: 100, sorts: [{ property: 'Sort Date', direction: 'descending' }] };
  if (cursor) body.start_cursor = cursor;
  const result = await notion(`data_sources/${dataSourceId}/query`, { method: 'POST', body: JSON.stringify(body) });
  queryResults.push(...result.results);
  cursor = result.has_more ? result.next_cursor : null;
} while (cursor);

const published = queryResults.filter(isPublished);
const previousPosts = JSON.parse(await readFile(path.join(root, 'posts.json'), 'utf8').catch(() => '[]'));
const slugs = new Set();
const posts = [];
const skipped = [];
for (const page of published) {
  try {
    posts.push(await buildPost(page));
  } catch (error) {
    // One incomplete or broken page must not block every other article.
    // If it was already live, keep its last good version instead of removing it from the site.
    const title = valueText(page, 'Title') || page.id;
    const previous = previousPosts.find(post => post.notionId === page.id)
      || previousPosts.find(post => !post.notionId && post.slug === slugify(valueText(page, 'Slug').trim() || valueText(page, 'Title')));
    const kept = previous && !slugs.has(previous.slug);
    if (kept) {
      slugs.add(previous.slug);
      posts.push({ ...previous, notionId: page.id });
    }
    skipped.push({ title, reason: error.message, kept });
  }
}

async function buildPost(page) {
  const title = valueText(page, 'Title');
  const category = valueSelect(page, 'Category');
  const sourceUrl = valueUrl(page, 'Source URL');
  const from = valueText(page, 'From');
  const source = valueText(page, 'Source');
  const date = valueDate(page, 'Date');
  const sortDate = valueDate(page, 'Sort Date');
  const missing = [];
  if (!title) missing.push('Title');
  if (!from) missing.push('From');
  if (!source) missing.push('Source');
  if (!date) missing.push('Date');
  if (!sortDate) missing.push('Sort Date');
  if (!categories.has(category)) missing.push(`Category${category ? ` (${category} is unsupported)` : ''}`);
  if (!sourceUrl) missing.push('Source URL');
  if (missing.length) throw new Error(`Published page “${title || page.id}” is missing required fields: ${missing.join(', ')}.`);
  let parsedSource;
  try { parsedSource = new URL(sourceUrl); } catch { throw new Error(`Source URL is invalid on “${title}”.`); }
  if (!['http:', 'https:'].includes(parsedSource.protocol)) throw new Error(`Source URL must use HTTP or HTTPS on “${title}”.`);
  const existingSlug = valueText(page, 'Slug').trim();
  const slug = slugify(existingSlug || title) || page.id.replaceAll('-', '');
  if (slugs.has(slug)) throw new Error(`Duplicate slug: ${slug}`);
  const rawBlocks = await fetchBlocks(page.id);
  const body = [];
  let imageCount = 0;
  for (const block of rawBlocks) {
    if (block.type === 'image') imageCount += 1;
    const converted = await convertBlock(block, page.id, imageCount);
    if (converted) body.push(converted);
  }
  const post = {
    notionId: page.id, slug, title, category, date, sortDate,
    from, source,
    url: sourceUrl, body, lang: 'ko', createdTime: page.created_time || '',
    description: valueText(page, 'Description').trim(),
  };
  if (!post.description) post.description = autoDescription(post);
  if (!body.length) throw new Error(`Published page “${title}” is missing its article body.`);

  const generatedProperties = {};
  if (!valueText(page, 'Description').trim()) {
    generatedProperties.Description = { rich_text: [{ text: { content: post.description } }] };
  }
  if (!existingSlug) {
    generatedProperties.Slug = { rich_text: [{ text: { content: slug } }] };
  }
  if (Object.keys(generatedProperties).length) {
    try {
      await notion(`pages/${page.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: generatedProperties }),
      });
    } catch (error) {
      // The generated values are already in the post, so publishing does not depend on the write-back.
      console.log(`::warning::Could not save generated Description/Slug back to Notion for “${title}”: ${error.message}`);
    }
  }
  slugs.add(slug);
  return post;
}

// Remove downloaded images that no published post references any more.
const referencedImages = new Set(posts.flatMap(post => post.body.filter(block => block.type === 'image').map(block => block.url.replace(/^\//, ''))));
for (const entry of await readdir(assetsDirectory, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const relative = path.posix.join('assets', 'notion', path.relative(assetsDirectory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  if (!referencedImages.has(relative)) await rm(path.join(root, relative), { force: true });
}
for (const entry of await readdir(assetsDirectory, { withFileTypes: true })) {
  if (entry.isDirectory() && !(await readdir(path.join(assetsDirectory, entry.name))).length) {
    await rm(path.join(assetsDirectory, entry.name), { recursive: true });
  }
}

posts.sort((a, b) => (b.sortDate || b.date || '').localeCompare(a.sortDate || a.date || '') || (b.createdTime || '').localeCompare(a.createdTime || '') || a.title.localeCompare(b.title, 'ko'));
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
  const directory = path.join(generatedPosts, post.slug);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'index.html'), html);
}

console.log(`Synced ${posts.length} published post(s) from Notion.`);

if (skipped.length) {
  const lines = skipped.map(({ title, reason, kept }) => `- **${title}** — ${reason} (${kept ? 'kept the previously published version' : 'not published'})`);
  for (const line of lines) console.log(`::warning::Skipped ${line.slice(2)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `### Skipped Notion pages\n\nFix these in Notion; every other article was synced.\n\n${lines.join('\n')}\n`, { flag: 'a' });
  }
}

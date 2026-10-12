import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { chromium } from 'playwright';
import { parseDialogue, youtubeEmbedUrl } from './article-format.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const categories = new Set(['Design', 'Fashion', 'Tech', 'Sports', 'Culture']);
const supportedBlocks = new Set([
  'paragraph', 'heading_1', 'heading_2', 'heading_3', 'quote', 'bulleted_list_item',
  'numbered_list_item', 'code', 'to_do', 'callout', 'bookmark', 'video', 'embed',
  'equation', 'divider', 'image',
]);
const posts = JSON.parse(await readFile(path.join(root, 'posts.json'), 'utf8'));
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const fixture = {
  slug: '__qa-fixture__', title: 'QA fixture article', category: 'Culture',
  date: '2000-01-01', sortDate: '1900-01-01', from: 'QA', source: 'QA fixture',
  url: 'https://example.com/source', description: 'QA fixture description. Used only in automated checks.', lang: 'en',
  body: [
    { type: 'paragraph', text: 'GQ: A question for the interviewee.', rich_text: [{ text: 'GQ: A question for the interviewee.', annotations: {} }] },
    { type: 'divider', text: '', rich_text: [] },
    { type: 'paragraph', text: 'James Jebbia: A longer speaker name should not move this dialogue.', rich_text: [{ text: 'James Jebbia: A longer speaker name should not move this dialogue.', annotations: {} }] },
    { type: 'video', url: 'https://www.youtube.com/watch?v=8N3PmjcvYtY&t=1m2s', caption: 'QA video', text: '', rich_text: [] },
  ],
};
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed += 1;
  process.stdout.write(`✓ ${name}\n`);
};
const mustMatch = (pattern, message) => assert.ok(pattern.test(html), message);
const isDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

await check('Notion dialogue markers: names and numeric labels lose the colon', () => {
  assert.deepEqual(parseDialogue('GQ:  What inspired the first designs?'), {
    speaker: 'GQ', text: 'What inspired the first designs?', bodyStart: 5,
  });
  assert.deepEqual(parseDialogue('00: Opening line.'), {
    speaker: '00', text: 'Opening line.', bodyStart: 4,
  });
  assert.equal(parseDialogue('A regular paragraph.'), null);
});

await check('YouTube links convert safely and retain supported start times', () => {
  assert.equal(youtubeEmbedUrl('https://www.youtube.com/watch?v=8N3PmjcvYtY&t=1m2s'), 'https://www.youtube-nocookie.com/embed/8N3PmjcvYtY?start=62');
  assert.equal(youtubeEmbedUrl('https://youtu.be/8N3PmjcvYtY?t=90'), 'https://www.youtube-nocookie.com/embed/8N3PmjcvYtY?start=90');
  assert.equal(youtubeEmbedUrl('https://www.youtube.com/shorts/8N3PmjcvYtY'), 'https://www.youtube-nocookie.com/embed/8N3PmjcvYtY');
  assert.equal(youtubeEmbedUrl('https://youtube.com.evil.test/watch?v=8N3PmjcvYtY'), '');
  assert.equal(youtubeEmbedUrl('javascript:alert(1)'), '');
});

await check('Homepage JavaScript parses and the required visual rules are present', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes));
  assert.ok(scripts.length, 'index.html has an inline application script');
  for (const [, , source] of scripts) {
    const withoutImports = source.replace(/^\s*import\s+[^;]+;\s*/gm, '');
    new Script(withoutImports, { filename: 'index.html inline script' });
  }
  mustMatch(/\.list td\.title\s*>\s*\.mobile-date\s*\{[^}]*display:\s*block/s, 'mobile date must remain visible');
  mustMatch(/\.list th\.date,[\s\S]*?\.list td\.date\s*\{\s*display:\s*none/s, 'mobile Date column must be hidden');
  mustMatch(/@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)\s*\{[^}]*title-roll/s, 'title animation must be limited to real hover devices');
  mustMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.article-content\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;\s*\}[\s\S]*?\.article-content\s*>\s*\.dialogue\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'mobile dialogues must use a single column without a fixed speaker rail');
  mustMatch(/\.article \.notion-video\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s, 'video must preserve its aspect ratio');
  mustMatch(/\.article \.dialogue-speaker\s*\{[^}]*text-align:\s*right/s, 'desktop dialogue speaker must be right aligned');
  mustMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.article \.dialogue-speaker\s*\{[^}]*font-weight:\s*700/s, 'mobile dialogue speaker must be bold');
  mustMatch(/\.article \.dialogue-text\s*\{[^}]*text-indent:\s*0/s, 'dialogue text must not be indented');
  mustMatch(/<link rel="apple-touch-icon"/, 'iPhone home screen icon must be configured');
  mustMatch(/<link rel="manifest"/, 'web app manifest must be configured');
});

await check('Every published post has valid required fields, blocks, and a generated article page', async () => {
  assert.ok(Array.isArray(posts) && posts.length > 0, 'posts.json contains published posts');
  const slugs = new Set();
  for (const post of posts) {
    for (const field of ['title', 'from', 'source', 'url', 'slug', 'description']) {
      assert.equal(typeof post[field], 'string');
      assert.ok(post[field].trim(), `${post.slug || post.title} is missing ${field}`);
    }
    assert.ok(categories.has(post.category), `${post.slug} has unsupported Category`);
    assert.ok(isDate(post.date), `${post.slug} has invalid Date`);
    assert.ok(isDate(post.sortDate), `${post.slug} has invalid Sort Date`);
    assert.match(post.slug, /^[\p{Letter}\p{Number}]+(?:-[\p{Letter}\p{Number}]+)*$/u);
    assert.ok(!slugs.has(post.slug), `duplicate slug ${post.slug}`);
    slugs.add(post.slug);
    assert.ok(['http:', 'https:'].includes(new URL(post.url).protocol), `${post.slug} Source URL must be HTTP(S)`);
    assert.ok(Array.isArray(post.body), `${post.slug} body must be a block array`);
    assert.ok(!Object.hasOwn(post, 'thumbnail'), `${post.slug} must not use the retired Thumbnail field`);
    assert.ok(post.body.length > 0, `${post.slug} article body must not be empty`);
    for (const block of post.body) {
      assert.ok(supportedBlocks.has(block.type), `${post.slug} has unsupported block ${block.type}`);
      if (block.type === 'video' || block.type === 'embed') {
        assert.ok(/^https?:\/\//i.test(block.url || ''), `${post.slug} has a video/embed block without a URL`);
      }
    }
    const pagePath = path.join(root, 'posts', post.slug, 'index.html');
    const page = await readFile(pagePath, 'utf8');
    assert.ok(page.includes(`https://source-spread.kr/posts/${encodeURIComponent(post.slug)}`), `${post.slug} is missing canonical metadata`);
    assert.match(page, /property="og:type" content="article"/);
    assert.match(page, /property="og:description" content="[^"]+"/);
  }
});

if (process.argv.includes('--static-only')) {
  process.stdout.write(`\nStatic QA passed: ${passed} checks; ${posts.length} published posts inspected.\n`);
  process.exit(0);
}

// Serve the static project with the same clean URL behavior used by the site.
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname.startsWith('/category/')) pathname = '/';
    let filePath = path.resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) throw new Error('invalid path');
    try {
      if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, 'index.html');
    } catch {
      if (!path.extname(filePath)) filePath = path.join(filePath, 'index.html');
    }
    if (pathname === '/posts.json') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify([...posts, fixture]));
      return;
    }
    let content;
    try {
      content = await readFile(filePath);
    } catch {
      if (/^\/posts\/[^/]+\/?$/.test(pathname)) {
        filePath = path.join(root, 'index.html');
        content = await readFile(filePath);
      }
      else throw new Error('not found');
    }
    const extension = path.extname(filePath);
    const mime = ({ '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json' })[extension] || 'application/octet-stream';
    response.writeHead(200, { 'content-type': mime });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const pageErrors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', error => pageErrors.push(error.message));

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('.list tbody tr[data-slug]').first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts?.ready);
  const desktop = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    rightEdge: Math.max(...[...document.querySelectorAll('body *')].map(element => element.getBoundingClientRect().right)),
    dateDisplay: getComputedStyle(document.querySelector('.list td.date')).display,
    mobileDateDisplay: getComputedStyle(document.querySelector('.mobile-date')).display,
    titleWhiteSpace: getComputedStyle(document.querySelector('.list td.title > .t')).whiteSpace,
    hasOverflowTitle: !!document.querySelector('.list td.title.flow'),
    fineHover: matchMedia('(hover: hover) and (pointer: fine)').matches,
    sourceWhiteSpace: getComputedStyle(document.querySelector('.list td.src a')).whiteSpace,
  }));
  assert.ok(desktop.scrollWidth <= desktop.width, 'desktop should not scroll horizontally');
  assert.ok(desktop.rightEdge <= desktop.width + 1, 'desktop content extends beyond the viewport');
  assert.notEqual(desktop.dateDisplay, 'none');
  assert.equal(desktop.mobileDateDisplay, 'none');
  assert.equal(desktop.titleWhiteSpace, 'nowrap');
  assert.ok(desktop.fineHover, 'desktop should expose hover and fine pointer');
  assert.equal(desktop.sourceWhiteSpace, 'nowrap');
  assert.ok(desktop.hasOverflowTitle, 'homepage should contain at least one long title to verify the hover effect');
  const longTitle = page.locator('.list td.title.flow').first();
  await longTitle.hover();
  const animationName = await longTitle.locator('.t').evaluate(element => getComputedStyle(element).animationName);
  assert.equal(animationName, 'title-roll');
  passed += 1;
  process.stdout.write('✓ Desktop hover animates an overflowing title\n');

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobileContext.newPage();
  mobilePage.on('pageerror', error => pageErrors.push(error.message));
  await mobilePage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await mobilePage.locator('.list tbody tr[data-slug]').first().waitFor({ state: 'visible' });
  for (const width of [320, 375, 390, 430]) {
    await mobilePage.setViewportSize({ width, height: 844 });
    const mobile = await mobilePage.evaluate(() => {
      const title = document.querySelector('.list td.title > .t');
      const date = document.querySelector('.mobile-date');
      const category = document.querySelector('.list td.cat');
      return {
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        rightEdge: Math.max(...[...document.querySelectorAll('body *')].map(element => element.getBoundingClientRect().right)),
        dateVisible: !!date && getComputedStyle(date).display !== 'none' && !!date.textContent.trim(),
        dateHeaderHidden: getComputedStyle(document.querySelector('.list th.date')).display === 'none',
        titleOneLine: getComputedStyle(title).whiteSpace === 'nowrap',
        categoryVisible: !!category && getComputedStyle(category).display !== 'none',
        pointerMode: matchMedia('(hover: hover) and (pointer: fine)').matches,
      };
    });
    assert.ok(mobile.scrollWidth <= width, `${width}px mobile layout overflows horizontally`);
    assert.ok(mobile.rightEdge <= width + 1, `${width}px mobile content extends beyond the viewport`);
    assert.ok(mobile.dateVisible, `${width}px mobile layout hides the article date`);
    assert.ok(mobile.dateHeaderHidden, `${width}px mobile layout shows a redundant Date heading`);
    assert.ok(mobile.titleOneLine, `${width}px mobile title wraps`);
    assert.ok(mobile.categoryVisible, `${width}px mobile category is hidden`);
    assert.equal(mobile.pointerMode, false, `${width}px touch viewport incorrectly enables desktop hover`);
  }
  passed += 1;
  process.stdout.write('✓ Mobile list at 320/375/390/430px: date, title, category, no overflow, touch mode\n');

  const sportsLink = mobilePage.locator('nav a[href="/category/sports"]');
  assert.equal(await sportsLink.count(), 1, 'Sports category route exists');
  await sportsLink.click();
  await mobilePage.locator('.list tbody tr[data-slug]').first().waitFor({ state: 'visible' });
  assert.ok((await mobilePage.locator('.list tbody tr[data-slug] .cat').allTextContents()).every(text => text === 'Sports'));
  assert.equal(new URL(mobilePage.url()).hash, '', 'category navigation should not use a hash route');
  passed += 1;
  process.stdout.write('✓ Category navigation uses a clean path and filters its posts\n');

  await mobilePage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const firstRow = mobilePage.locator('.list tbody tr[data-slug]').first();
  const firstSlug = await firstRow.getAttribute('data-slug');
  await firstRow.click();
  await mobilePage.waitForURL(`**/posts/${encodeURIComponent(firstSlug)}`);
  assert.equal(new URL(mobilePage.url()).hash, '', 'article navigation should not use a hash route');
  passed += 1;
  process.stdout.write('✓ Touching a mobile row opens its clean article route\n');

  await mobilePage.goto(`${baseUrl}/posts/${encodeURIComponent(fixture.slug)}`, { waitUntil: 'domcontentloaded' });
  await mobilePage.locator('.dialogue-text').first().waitFor({ state: 'visible' });
  const dialogueLayout = await mobilePage.locator('.dialogue').evaluateAll(elements => elements.map(element => {
    const speaker = element.querySelector('.dialogue-speaker');
    const text = element.querySelector('.dialogue-text');
    return {
      speaker: speaker.textContent.trim(),
      speakerTop: speaker.getBoundingClientRect().top,
      textTop: text.getBoundingClientRect().top,
      speakerWeight: getComputedStyle(speaker).fontWeight,
      textLeft: Math.round(text.getBoundingClientRect().left),
      contentLeft: Math.round(document.querySelector('.article-content').getBoundingClientRect().left),
      columns: getComputedStyle(element).gridTemplateColumns,
    };
  }));
  assert.ok(dialogueLayout.length > 1);
  assert.ok(dialogueLayout.every(row => row.speakerTop < row.textTop), 'mobile speaker must appear above its dialogue');
  assert.ok(dialogueLayout.every(row => Number(row.speakerWeight) >= 700), 'mobile speaker must be bold');
  assert.ok(dialogueLayout.every(row => row.textLeft === row.contentLeft), 'mobile dialogue must use the full content column');
  assert.ok(dialogueLayout.every(row => !row.speaker.endsWith(':')), 'speaker command colon leaked into article text');
  passed += 1;
  process.stdout.write('✓ Mobile dialogue names share one column and the command colon is hidden\n');

  await mobilePage.goto(`${baseUrl}/posts/${encodeURIComponent(fixture.slug)}`, { waitUntil: 'domcontentloaded' });
  await mobilePage.locator('.notion-divider').first().waitFor({ state: 'visible' });
  assert.equal(await mobilePage.locator('.section-number').count(), 0, 'Divider generated a section number');
  passed += 1;
  process.stdout.write('✓ Divider creates spacing without section numbering\n');

  await mobilePage.goto(`${baseUrl}/posts/${encodeURIComponent(fixture.slug)}`, { waitUntil: 'domcontentloaded' });
  const iframe = mobilePage.locator('.notion-video iframe').first();
  await iframe.waitFor({ state: 'visible' });
  const video = await iframe.evaluate(element => ({
    src: element.src,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    viewport: innerWidth,
  }));
  assert.ok(video.src.startsWith('https://www.youtube-nocookie.com/embed/'));
  assert.ok(Math.abs(video.width / video.height - 16 / 9) < 0.03, 'video player is not 16:9');
  assert.ok(video.width <= video.viewport, 'video player exceeds mobile width');
  passed += 1;
  process.stdout.write('✓ Notion YouTube block renders as a responsive 16:9 player\n');
  await mobileContext.close();

  assert.deepEqual(pageErrors, [], `browser JavaScript errors: ${pageErrors.join('; ')}`);
  passed += 1;
  process.stdout.write('✓ Browser reports no JavaScript errors\n');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

process.stdout.write(`\nSite QA passed: ${passed} checks; ${posts.length} published posts inspected.\n`);

const { createHmac, timingSafeEqual } = require('node:crypto');

const acceptedEvents = new Set([
  'page.created',
  'page.content_updated',
  'page.properties_updated',
  'page.deleted',
  'page.undeleted',
  'page.moved',
  'data_source.content_updated',
]);

async function rawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function validSignature(body, signature, verificationToken) {
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', verificationToken).update(body).digest('hex')}`);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

module.exports = async function notionWebhook(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return send(res, 405, { error: 'Method not allowed' });
  }

  let body;
  let event;
  try {
    body = await rawBody(req);
    event = JSON.parse(body.toString('utf8'));
  } catch (error) {
    return send(res, error.message === 'Request body too large' ? 413 : 400, { error: 'Invalid request body' });
  }

  // Notion sends this one-time challenge when a webhook subscription is created.
  // The value is needed both to verify the subscription in Notion and to validate
  // subsequent event signatures, so it is exposed in the Vercel function logs.
  if (typeof event.verification_token === 'string') {
    console.info('Notion webhook verification token:', event.verification_token);
    return send(res, 200, { received: true });
  }

  const verificationToken = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
  if (!verificationToken || !validSignature(body, req.headers['x-notion-signature'], verificationToken)) {
    return send(res, 401, { error: 'Invalid webhook signature' });
  }

  if (!acceptedEvents.has(event.type)) return send(res, 200, { ignored: true });

  const dispatchToken = process.env.GITHUB_DISPATCH_TOKEN;
  if (!dispatchToken) return send(res, 500, { error: 'GitHub dispatch is not configured' });

  const [owner, repository] = (process.env.GITHUB_REPOSITORY || 'chaigun-jung-me/spread-project').split('/');
  const ref = process.env.GITHUB_SYNC_REF || 'main';
  if (!owner || !repository) return send(res, 500, { error: 'GITHUB_REPOSITORY must use owner/repo format' });

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repository}/actions/workflows/sync-notion.yml/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${dispatchToken}`,
        'X-GitHub-Api-Version': '2026-03-10',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      console.error('GitHub workflow dispatch failed:', response.status, details);
      return send(res, 502, { error: 'Could not start the Notion sync workflow' });
    }
    return send(res, 202, { accepted: true });
  } catch (error) {
    console.error('GitHub workflow dispatch failed:', error.message);
    return send(res, 502, { error: 'Could not start the Notion sync workflow' });
  }
};

module.exports.config = { api: { bodyParser: false } };

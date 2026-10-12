/** Return the speaker and dialogue when a paragraph uses the `Speaker: words` rule. */
export function parseDialogue(value) {
  const text = String(value ?? '');
  const match = text.match(/^([^\s:\n][^:\n]{0,39}):[ \t]*(\S[\s\S]*)$/u);
  if (!match) return null;
  const colonIndex = text.indexOf(':');
  const bodyStart = colonIndex + 1 + (text.slice(colonIndex + 1).match(/^[ \t]*/) || [''])[0].length;
  return {
    speaker: text.slice(0, colonIndex).trim(),
    text: match[2].trim(),
    bodyStart,
  };
}

/** Turn supported YouTube watch/share URLs into privacy-enhanced embed URLs. */
export function youtubeEmbedUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      id = url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?]+)/)?.[1] || '';
    }
    if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return '';

    const timestamp = url.searchParams.get('start') || url.searchParams.get('t') || '';
    const numericStart = /^\d+$/.test(timestamp) ? Number(timestamp) : 0;
    const parts = timestamp.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    const parsedStart = numericStart || (parts && timestamp
      ? Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0)
      : 0);
    return `https://www.youtube-nocookie.com/embed/${id}${parsedStart > 0 ? `?start=${parsedStart}` : ''}`;
  } catch {
    return '';
  }
}

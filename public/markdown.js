// Minimal Markdown for card bodies: headings, lists, paragraphs, `code`, **bold** and links.
// Every piece of text is escaped first; the only tags added are the ones below.

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/https?:\/\/[^\s<]*[^\s<.,;:!?)»]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

export function renderMarkdown(markdown) {
  const out = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
    list = null;
  };
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (item) {
      flushParagraph();
      (list ||= []).push(item[1]);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (list) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return out.join('\n');
}

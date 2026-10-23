import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inline, renderMarkdown } from '../public/markdown.js';

test('escapes HTML everywhere', () => {
  assert.equal(inline('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.doesNotMatch(renderMarkdown('## <b>x</b>\n- <script>'), /<script>|<b>/);
});

test('links only http and https URLs, without trailing punctuation', () => {
  assert.equal(
    inline('Mira https://luma.com/tx2ao2t6.'),
    'Mira <a href="https://luma.com/tx2ao2t6" target="_blank" rel="noopener noreferrer">https://luma.com/tx2ao2t6</a>.',
  );
  assert.doesNotMatch(inline('javascript:alert(1)'), /<a /);
  assert.doesNotMatch(inline('https://x.example/"onmouseover="alert(1)'), /" onmouseover|"onmouseover/);
});

test('renders headings, lists, paragraphs, code and bold', () => {
  const out = renderMarkdown('## Contexto\n\nHilo `1a0f8483bb900fd5` **importante**\nsigue aquí\n\n## Bitácora\n\n- uno\n- dos\n  continúa');
  assert.equal(out, [
    '<h3>Contexto</h3>',
    '<p>Hilo <code>1a0f8483bb900fd5</code> <strong>importante</strong> sigue aquí</p>',
    '<h3>Bitácora</h3>',
    '<ul><li>uno</li><li>dos continúa</li></ul>',
  ].join('\n'));
});

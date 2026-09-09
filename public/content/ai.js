// Mirrors lose-it's public/app.js estimateFromPhoto() — same direct-from-browser
// Anthropic API call pattern, just swapped from a photo prompt to a text prompt.
function buildIdeaPrompt(niche, avoidTitles) {
  const nicheLine = niche
    ? `The creator's content niche/focus: ${niche}.`
    : 'The creator did not specify a niche — give broadly useful short-form video ideas for a solo content creator.';
  const avoidLine = avoidTitles.length
    ? `Do not repeat or closely resemble any of these already-seen titles: ${avoidTitles.join(' | ')}.`
    : '';
  return `Generate 8 fresh short-form video content ideas for a solo creator.
${nicheLine}
${avoidLine}
Respond with ONLY a JSON array and no other text, in exactly this shape:
[{"title": "short punchy idea title", "hook": "one sentence on the angle/hook that makes people watch", "format": "e.g. Talking head, Tutorial, Story, List, Reaction, Challenge"}]
Make ideas specific and filmable, not vague advice. Vary the format across the 8.`;
}

async function generateIdeas(apiKey, niche, avoidTitles) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Required for calling the API straight from a browser.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1536,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: buildIdeaPrompt(niche, avoidTitles) }]
    })
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const message = detail && detail.error && detail.error.message ? detail.error.message : `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('That API key was rejected. Check it in Settings.');
    throw new Error(message);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to generate ideas for that prompt.');
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No ideas came back. Try again.');
  return parseIdeas(textBlock.text);
}

// Asked for bare JSON, but tolerate it being wrapped in prose or a code fence.
function parseIdeas(text) {
  let raw = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('Could not read the generated ideas. Try again.');
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Could not read the generated ideas. Try again.');
  }
  if (!Array.isArray(parsed)) throw new Error('Could not read the generated ideas. Try again.');
  return parsed
    .filter(i => i && i.title)
    .map(i => ({
      title: String(i.title).slice(0, 120),
      hook: String(i.hook || '').slice(0, 200),
      format: String(i.format || 'Idea').slice(0, 40)
    }));
}

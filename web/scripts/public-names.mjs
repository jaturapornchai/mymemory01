// Names the public site may show: the AI apps (approved by ลุงจืด: names, counts, colours) and the site's own name.
// Anything else private is caught by the publish gate's DB needles (src/brain.ts assertAnonymous). Used by public-check.
import { assertAnonymous } from '../../src/brain.ts';

/** the exact display spellings, standalone: a project called e.g. codex-tools or Codex-tools is not one */
export const PUBLIC_NAMES = /(?<![\w./\\-])(Claude|Codex|Gemini|Antigravity|ZCode|LM Studio|Kimi|GitHub|Obsidian|memory-hub)(?![\w./\\-])/g;

/**
 * Visible page text → '' when clean, else what leaked: project/repo names, session ids, path parts, or `user` (the OS
 * account name, standing in for person names). ponytail: no list of other people's names exists to check against.
 */
export async function textLeak(db, text, user) {
  const t = text.replace(PUBLIC_NAMES, '');
  if (user && t.toLowerCase().includes(user.toLowerCase())) return 'user name';
  return assertAnonymous(db, JSON.stringify({ page: t })).then(() => '', (e) => e.message);
}

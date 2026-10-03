// memory-hub serves every AI client (ลุงจืด, 2026-10-02: "memory hub ให้กับ ai model ทุกตัว แต่ claude เป็นตัวหลัก").
// MEMHUB_ANTHROPIC_ONLY=1 restores the stricter rule: no memory for a Claude Code session whose model backend is not
// Anthropic (ANTHROPIC_BASE_URL → e.g. a GLM/z.ai proxy; MCP servers and hooks inherit that env). Indexing stays local.
const ANTHROPIC = /^(?:https?:\/\/)?(?:api\.anthropic\.com|localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i;

/** Host of a non-Anthropic backend to refuse (only with MEMHUB_ANTHROPIC_ONLY=1), else null. */
export function offsiteBackend(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.ANTHROPIC_BASE_URL?.trim();
  if (env.MEMHUB_ANTHROPIC_ONLY !== '1' || !url || ANTHROPIC.test(url)) return null;
  let host = url;
  try { host = new URL(url).host; } catch { /* keep raw */ }
  return env.MEMHUB_ALLOW_BACKEND && host === env.MEMHUB_ALLOW_BACKEND ? null : host;
}

// Claude-only sources (ลุงจืด 2026-10-03): Gmail/Docs/Sheets and the Maps timeline. Never shown to other apps, never dreamed,
// public brain = counts only. Gate = MCP (search/get/related/timeline) + SessionStart; a shell on this PC still reads the DB.
export const PRIVATE_TOOLS = new Set(['google', 'google-timeline']);

/** May this MCP client see PRIVATE_TOOLS? A Claude app (clientInfo claude-code / claude-ai) whose model runs on Anthropic's own
 *  API (ANTHROPIC_BASE_URL unset or api.anthropic.com: a z.ai / localhost proxy is not), unless MEMHUB_PRIVATE_SOURCES=0. */
export function privateOk(client: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const url = env.ANTHROPIC_BASE_URL?.trim();
  let host = url?.toLowerCase();
  try { if (url) host = new URL(url).host; } catch { /* bare host */ }
  return env.MEMHUB_PRIVATE_SOURCES !== '0' && /^claude/i.test(client ?? '') && (!host || host === 'api.anthropic.com');
}

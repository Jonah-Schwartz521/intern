// Syntax highlighting for chat code blocks via Shiki. Shiki renders with the
// real VS Code TextMate grammars + themes, so fenced code matches the Monaco /
// VS Code look. One highlighter instance is created lazily and reused; each
// grammar is loaded on demand the first time its language appears, so startup
// stays cheap and we only pay for the languages we actually render.

import {
  createHighlighter,
  bundledLanguagesInfo,
  type Highlighter,
  type BundledLanguage,
} from "shiki";

// Dark VS Code theme. Its palette reads well on Splerm's warm near-black chat,
// and it carries its own background so we never touch theme background-color.
export const CODE_THEME = "github-dark";

// Every fence token Shiki can highlight (canonical ids plus aliases like ts, py,
// sh). Lets us cheaply tell a real language from a typo and fall back to plain
// text rather than guessing wrong.
const SUPPORTED = new Set<string>();
for (const info of bundledLanguagesInfo) {
  SUPPORTED.add(info.id);
  info.aliases?.forEach((a) => SUPPORTED.add(a));
}

export function isSupportedLang(lang: string): boolean {
  return SUPPORTED.has(lang.toLowerCase());
}

// Shared highlighter, created once on first use (theme only, no grammars).
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({ themes: [CODE_THEME], langs: [] });
  }
  return highlighterPromise;
}

// Grammars already pulled into the shared highlighter, so a repeat of the same
// language highlights immediately with no extra import.
const loaded = new Set<string>();

/**
 * Highlight code to themed HTML (a Shiki <pre>). Lazy-loads the grammar the first
 * time a language appears. Caller must pass a lang that isSupportedLang() accepts.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const id = lang.toLowerCase();
  if (!loaded.has(id)) {
    await hl.loadLanguage(id as BundledLanguage);
    loaded.add(id);
  }
  return hl.codeToHtml(code, { lang: id, theme: CODE_THEME });
}

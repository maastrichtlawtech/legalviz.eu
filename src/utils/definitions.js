/**
 * Inject definition markers into HTML content.
 * Wraps occurrences of defined terms with span elements carrying data-term /
 * data-definition attributes; DefinitionTooltip renders the actual popup.
 */

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape HTML special characters for safe attribute values
 */
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function isInsideElement(parts, index, tagName, openingMatches = () => true) {
    let closingDepth = 0;
    const openingPattern = new RegExp(`^<${tagName}\\b`, "i");
    const closingPattern = new RegExp(`^<\\/${tagName}\\b`, "i");
    for (let cursor = index - 1; cursor >= 0; cursor--) {
        const tag = parts[cursor];
        if (!tag.startsWith('<')) continue;
        if (closingPattern.test(tag)) {
            closingDepth += 1;
        } else if (openingPattern.test(tag)) {
            if (closingDepth > 0) closingDepth -= 1;
            else if (openingMatches(tag)) return true;
        }
    }
    return false;
}

/**
 * Build a stem-based regex pattern for inflected languages (e.g. Polish).
 * Truncates each word to a stem and allows flexible endings.
 * "dane osobowe" → /dan\S+ osobow\S+/i  (matches "danych osobowych", "danymi osobowymi", etc.)
 */
function buildStemPattern(term) {
    const words = term.split(/\s+/);
    const stemmed = words.map(w => {
        // Keep at least 3 chars, truncate up to 3 chars from the end
        const minLen = Math.max(3, w.length - 3);
        const stem = escapeRegex(w.substring(0, minLen));
        return stem + '\\S*';
    });
    return stemmed.join('\\s+');
}

/**
 * Inject tooltips for defined terms into HTML content.
 *
 * @param {string} html - The HTML content to process
 * @param {Array<{term: string, definition: string}>} definitions - Array of definitions
 * @param {Object} options - Options
 * @param {boolean} options.skipDefinitionsArticle - If true, don't highlight terms in the definitions article itself
 * @param {string} options.langCode - Language code (e.g. "PL") for inflection-aware matching
 * @returns {string} - HTML with definition tooltips injected
 */
export function injectDefinitionTooltips(html, definitions, options = {}) {
    if (!html || !definitions || definitions.length === 0) {
        return html;
    }

    // Use stem-based inflection for highly inflected EU languages
    const INFLECTED_LANGS = new Set(["PL", "CS", "SK", "HR", "SL", "LT", "LV", "ET", "BG", "EL", "HU", "RO", "FI"]);
    const useInflection = INFLECTED_LANGS.has(options.langCode);

    const activeTerm = String(options.activeTerm || "").trim().toLocaleLowerCase();

    // Check if this is the definitions article (contains a "Definitions" heading in any EU language)
    if (options.skipDefinitionsArticle) {
        const isDefinitionsArticle = /<p[^>]*class="[^"]*oj-sti-art[^"]*"[^>]*>\s*(?:Definitions?|Definicj[ea]|Begriffsbestimmungen?|D[eé]finitions?|Definicion[e]?s?|Definizion[ei]|Defini[cç][oõ]es?|Definities?|Definitioner?|M[aä][aä]ritelm[iä]|Definice?|Definície?|Fogalomm?eghat[aá]roz[aá]sok?|Defini[tț]ii|Opredelitve?|Apibr[eė][zž]im?ai|Defin[iī]cijas?|M[oõ]isted?|Artikolu|Sainmh[ií]nithe?|Definizzjonijiet?|Ορισμο[ίι]|\u041e\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d\u0438\u044f)\s*<\/p>/i.test(html);
        if (isDefinitionsArticle) {
            if (!activeTerm) return html;
            const activeDefinition = definitions.find((entry) => (
                String(entry?.term || "").trim().toLocaleLowerCase() === activeTerm
            ));
            const marker = String(activeDefinition?.sourcePoint || "").trim();
            if (!marker) return html;
            const markerPattern = escapeRegex(escapeHtml(marker));
            return html.replace(
                new RegExp(`(<li\\b[^>]*\\bdata-marker=["']${markerPattern}["'][^>]*)(>)`, "i"),
                (match, opening, close) => {
                    if (/\bclass=["'][^"']*\bdefinition-comparison-active\b/i.test(opening)) return match;
                    if (/\bclass=["']/i.test(opening)) {
                        return `${opening.replace(/\bclass=(["'])/i, "class=$1definition-comparison-active ")}${close}`;
                    }
                    return `${opening} class="definition-comparison-active"${close}`;
                }
            );
        }
    }

    let result = html;

    // Sort definitions by term length (longest first) to avoid partial replacements
    const sortedDefs = [...definitions].sort((a, b) => b.term.length - a.term.length);

    for (const { term, definition } of sortedDefs) {
        // Create a regex that matches the term (with optional inflection for Polish)
        // But NOT inside HTML tags or already-wrapped spans
        const pattern = useInflection
            ? `(?<![\\w-])${buildStemPattern(term)}`
            : `(?<![\\w-])${escapeRegex(term)}(?![\\w-])`;
        const termPattern = new RegExp(pattern, 'gi');

        // We need to be careful not to replace inside HTML tags
        // Split by tags, process text nodes only
        const parts = result.split(/(<[^>]+>)/);

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];

            // Skip HTML tags
            if (part.startsWith('<')) continue;

            // Definition terms inside links remain links, and text already inside
            // any definition marker must not become a nested interactive control.
            const insideLink = isInsideElement(parts, i, "a");
            const insideDefinedTerm = isInsideElement(
                parts,
                i,
                "span",
                (tag) => /\bclass=["'][^"']*\bdefined-term\b/i.test(tag)
            );
            if (insideLink || insideDefinedTerm) continue;

            // Replace occurrences in text nodes. The span is a pure data
            // marker: the popup itself is rendered by <DefinitionTooltip />
            // outside this HTML, so no title attribute here.
            parts[i] = part.replace(termPattern, (match) => {
                const escapedDef = escapeHtml(definition);
                const escapedTerm = escapeHtml(term);
                const activeClass = activeTerm && term.trim().toLocaleLowerCase() === activeTerm
                    ? " defined-term--active" : "";
                return `<span class="defined-term${activeClass}" data-term="${escapedTerm}" data-definition="${escapedDef}" role="button" tabindex="0" aria-haspopup="dialog">${match}</span>`;
            });
        }

        result = parts.join('');
    }

    return result;
}

/**
 * Inject definition tooltips into HTML content.
 * Wraps occurrences of defined terms with span elements that show the definition on hover.
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

    // Check if this is the definitions article (contains a "Definitions" heading in any EU language)
    if (options.skipDefinitionsArticle) {
        const isDefinitionsArticle = /<p[^>]*class="[^"]*oj-sti-art[^"]*"[^>]*>\s*(?:Definitions?|Definicj[ea]|Begriffsbestimmungen?|D[eé]finitions?|Definicion[e]?s?|Definizion[ei]|Defini[cç][oõ]es?|Definities?|Definitioner?|M[aä][aä]ritelm[iä]|Definice?|Definície?|Fogalomm?eghat[aá]roz[aá]sok?|Defini[tț]ii|Opredelitve?|Apibr[eė][zž]im?ai|Defin[iī]cijas?|M[oõ]isted?|Artikolu|Sainmh[ií]nithe?|Definizzjonijiet?|Ορισμο[ίι]|\u041e\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d\u0438\u044f)\s*<\/p>/i.test(html);
        if (isDefinitionsArticle) {
            return html;
        }
    }

    let result = html;

    // Sort definitions by term length (longest first) to avoid partial replacements
    const sortedDefs = [...definitions].sort((a, b) => b.term.length - a.term.length);

    for (const { term, definition } of sortedDefs) {
        // Create a regex that matches the term (with optional inflection for Polish)
        // But NOT inside HTML tags or already-wrapped spans
        const pattern = useInflection
            ? buildStemPattern(term)
            : `(?<![\\w-])${escapeRegex(term)}(?![\\w-])`;
        const termPattern = new RegExp(pattern, 'gi');

        // We need to be careful not to replace inside HTML tags
        // Split by tags, process text nodes only
        const parts = result.split(/(<[^>]+>)/);

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];

            // Skip HTML tags
            if (part.startsWith('<')) continue;

            // Skip if we're inside a defined-term span (check previous parts)
            let insideDefinedTerm = false;
            for (let j = i - 1; j >= 0; j--) {
                if (parts[j].includes('class="defined-term"')) {
                    insideDefinedTerm = true;
                    break;
                }
                if (parts[j].includes('</span>')) {
                    break;
                }
            }
            if (insideDefinedTerm) continue;

            // Replace occurrences in text nodes
            parts[i] = part.replace(termPattern, (match) => {
                const escapedDef = escapeHtml(definition);
                return `<span class="defined-term" data-definition="${escapedDef}" title="${escapedDef}">${match}</span>`;
            });
        }

        result = parts.join('');
    }

    return result;
}

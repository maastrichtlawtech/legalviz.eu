import DOMPurify from "dompurify";

/**
 * Law HTML reaches the DOM via dangerouslySetInnerHTML from sources of varying
 * trust: the Formex parser escapes text itself, but the EUR-Lex HTML fallback
 * parser passes remote markup through, and IndexedDB replays either on every
 * revisit. Sanitize at this choke point so a hostile fragment from any of them
 * (inline event handlers, script/iframe, javascript: URLs) never executes.
 *
 * DOMPurify defaults keep everything the parsers emit: data-* attributes
 * (ALLOW_DATA_ATTR), aria-* (ALLOW_ARIA_ATTR), class/href/id/role/tabindex,
 * and #fragment links used for cross-references.
 */
export function sanitizeLawHtml(html) {
  if (!html) return "";
  return DOMPurify.sanitize(String(html));
}

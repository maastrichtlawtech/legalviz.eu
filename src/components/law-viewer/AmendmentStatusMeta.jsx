import { useI18n } from "../../i18n/useI18n.js";
import { useConsolidationStatus } from "../../hooks/useConsolidationStatus.js";
import { formatAmendmentSummary } from "../VersionMenu.jsx";

/**
 * The overview's amendment fact, set as one more item in its metadata row
 * ("Amended once, on 8 Jul 2026", "Not amended · 1 corrigendum"). Choosing
 * which text to read is `VersionMenu`'s job in the top bar; this only states
 * the history, the same way "Applies from" does.
 *
 * Says nothing until the amendment history has actually answered: claiming a
 * law has never been amended on the strength of a failed or in-flight fetch
 * would be a falsehood, and a Cellar outage must not invent amendments either.
 */
export function AmendmentStatusMeta({ celex, locale = "en" }) {
  const { t } = useI18n();
  const status = useConsolidationStatus(celex);

  if (status.amendmentStatusPending || status.amendmentStatusUnknown) return null;

  if (status.isOutdated) {
    return <span>{formatAmendmentSummary(status, locale, t)}</span>;
  }

  const corrigenda = status.corrigendumCount;
  return (
    <span>
      {t("consolidation.notAmended")}
      {corrigenda > 0 ? (
        <> · {corrigenda === 1
          ? t("consolidation.corrigendumOnceShort")
          : t("consolidation.corrigendaShort", { count: corrigenda })}</>
      ) : null}
    </span>
  );
}

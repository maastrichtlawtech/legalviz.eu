import { useNavigate } from "react-router-dom";
import { useI18n } from "../i18n/useI18n.js";
import { buildImportedLawCandidate, getCanonicalLawRoute } from "../utils/lawRouting.js";
import { inferOfficialReferenceFromCelex, saveLawMeta } from "../utils/library.js";

export function useSearchNavigation(lawKey) {
  const navigate = useNavigate();
  const { locale, localizePath } = useI18n();

  const navigateToSearchResult = async (item) => {
    if (item.search_kind === "definition") {
      const source = item.representativeSource || {};
      if (!source.celex) return;
      const sourceArticle = source.article ?? source.sourceArticle;
      const targetLaw = buildImportedLawCandidate({
        celex: source.celex,
        title: source.title || source.law?.title,
        officialReference: inferOfficialReferenceFromCelex(source.celex),
      });
      const route = getCanonicalLawRoute(
        targetLaw,
        sourceArticle ? "article" : null,
        sourceArticle || null,
        locale,
      );
      const separator = route.includes("?") ? "&" : "?";
      const term = item.normalizedTerm || item.term;
      const params = new URLSearchParams({ definition: term });
      params.set("definitionSource", `${String(source.celex).toUpperCase()}:${String(sourceArticle ?? "")}${source.sourcePoint ? `:${String(source.sourcePoint)}` : ""}`);
      navigate(`${route}${separator}${params.toString()}`);
      return;
    }

    if (item.search_kind === "fulltext") {
      const celex = String(item.celex || "").trim();
      const unitType = String(item.unitType || "").trim().toLowerCase();
      const number = item.number == null ? "" : String(item.number).trim();
      if (!celex || !number || (unitType !== "article" && unitType !== "recital")) return;

      const officialReference = inferOfficialReferenceFromCelex(celex);
      const targetLaw = buildImportedLawCandidate({
        celex,
        title: item.title,
        officialReference,
      });
      if (officialReference) {
        saveLawMeta({
          celex,
          label: item.title,
          officialReference,
        }).catch(() => {});
      }
      navigate(getCanonicalLawRoute(targetLaw, unitType, number, locale));
      return;
    }

    if (item.search_kind === "law") {
      const officialReference = inferOfficialReferenceFromCelex(item.celex);
      const targetLaw = buildImportedLawCandidate({
        celex: item.celex,
        title: item.title,
        officialReference,
      });

      if (officialReference) {
        // Best-effort bookkeeping: never let a stuck IndexedDB block navigation.
        // saveLawMeta only persists topics when non-empty, so an item without
        // them never clobbers previously stored EuroVoc topics.
        saveLawMeta({
          celex: item.celex,
          label: item.title,
          officialReference,
          topics: item.topics,
        }).catch(() => {});
      }

      navigate(getCanonicalLawRoute(targetLaw, null, null, locale));
      return;
    }

    // Ensure ID is a string before encoding
    const safeId = encodeURIComponent(String(item.id));
    const targetLawSlug = item.law_slug || item.law_key || lawKey;

    if (targetLawSlug) {
      navigate(`${localizePath(`/${targetLawSlug}/${item.type}/${safeId}`, locale)}`);
    }
  };

  return navigateToSearchResult;
}
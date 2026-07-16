import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { buildEurlexOjUrl, buildEurlexSearchUrl } from "../../utils/url.js";
import { parseOfficialReference } from "../../utils/officialReferences.js";
import { buildImportedLawCandidate, getCanonicalLawRoute } from "../../utils/lawRouting.js";
import { saveLawMeta } from "../../utils/library.js";
import { FormexApiError, resolveOfficialReference } from "../../utils/formexApi.js";

function getCurrentEntryIndex(data, selected) {
  let currentList = [];
  if (selected.kind === "article") currentList = data.articles;
  else if (selected.kind === "recital") currentList = data.recitals;
  else if (selected.kind === "annex") currentList = data.annexes;

  if (!currentList?.length) return { currentList: [], index: -1 };

  const index = currentList.findIndex((item) => (
    item.article_number === selected.id ||
    item.recital_number === selected.id ||
    item.annex_id === selected.id
  ));

  return { currentList, index };
}

export function useLawViewerInteractions({
  data,
  selected,
  onPrevNext,
  currentContentLang,
  locale,
}) {
  const navigate = useNavigate();
  const touchStartRef = useRef(null);
  const touchEndRef = useRef(null);
  const externalResolutionRequestRef = useRef(0);
  const [pendingExternalReferenceKey, setPendingExternalReferenceKey] = useState(null);
  const [pendingExternalReferenceLabel, setPendingExternalReferenceLabel] = useState("");

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA") return;

      const { currentList, index } = getCurrentEntryIndex(data, selected);
      if (!currentList.length) return;

      if (event.key === "ArrowLeft" && index > 0) {
        onPrevNext(selected.kind, index - 1);
      }
      if (event.key === "ArrowRight" && index >= 0 && index < currentList.length - 1) {
        onPrevNext(selected.kind, index + 1);
      }

      // Vim-style j / k as previous / next, without modifiers (mirrors the
      // reading-footer hint). Guard against combos so browser shortcuts pass.
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (event.key === "k" && index > 0) {
          onPrevNext(selected.kind, index - 1);
        }
        if (event.key === "j" && index >= 0 && index < currentList.length - 1) {
          onPrevNext(selected.kind, index + 1);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [data, onPrevNext, selected]);

  const onCrossRefArticle = useCallback((articleNumber) => {
    const index = data.articles.findIndex((entry) => entry.article_number === articleNumber);
    if (index !== -1) onPrevNext("article", index);
  }, [data.articles, onPrevNext]);

  const openFallbackReference = useCallback((fallbackUrl) => {
    if (fallbackUrl) window.open(fallbackUrl, "_blank", "noopener,noreferrer");
  }, []);

  const resolveReferenceInput = useCallback((refLike) => {
    if (!refLike) return null;

    const raw = refLike.raw || refLike.label || refLike.target || null;
    const parsed = parseOfficialReference(raw || "");
    return {
      raw,
      actType: refLike.actType || parsed?.actType || null,
      year: refLike.year || parsed?.year || null,
      number: refLike.number || parsed?.number || null,
      suffix: refLike.suffix || parsed?.suffix || null,
      ojColl: refLike.ojColl || null,
      ojNo: refLike.ojNo || null,
      ojYear: refLike.ojYear || null,
    };
  }, []);

  const getExternalReferenceKey = useCallback((refLike) => {
    if (!refLike) return null;

    return [
      refLike.type || "external",
      refLike.raw || refLike.label || refLike.target || "",
      refLike.actType || "",
      refLike.year || "",
      refLike.number || "",
      refLike.suffix || "",
      refLike.ojColl || "",
      refLike.ojYear || "",
      refLike.ojNo || "",
      refLike.articleNumber || "",
    ].join("|");
  }, []);

  const isExternalReferencePending = useCallback((refLike) => {
    const key = getExternalReferenceKey(refLike);
    return key ? key === pendingExternalReferenceKey : false;
  }, [getExternalReferenceKey, pendingExternalReferenceKey]);

  const handleOpenExternalLaw = useCallback(async (refLike) => {
    const requestId = externalResolutionRequestRef.current + 1;
    externalResolutionRequestRef.current = requestId;
    setPendingExternalReferenceKey(getExternalReferenceKey(refLike));
    setPendingExternalReferenceLabel(refLike?.raw || refLike?.label || refLike?.target || "");

    const reference = resolveReferenceInput(refLike);
    const fallbackUrl = refLike?.type === "oj_ref"
      ? buildEurlexOjUrl({
        ojColl: refLike.ojColl,
        ojYear: refLike.ojYear,
        ojNo: refLike.ojNo,
        langCode: currentContentLang,
      })
      : buildEurlexSearchUrl(refLike?.raw || refLike?.label || refLike?.target || "", currentContentLang);

    if (!reference?.actType || !reference?.year || !reference?.number) {
      openFallbackReference(fallbackUrl);
      if (externalResolutionRequestRef.current === requestId) {
        setPendingExternalReferenceKey(null);
        setPendingExternalReferenceLabel("");
      }
      return;
    }

    try {
      const result = await resolveOfficialReference(reference, currentContentLang);
      if (result?.resolved?.celex) {
        const targetLaw = buildImportedLawCandidate({
          celex: result.resolved.celex,
          officialReference: reference,
        });
        // Best-effort bookkeeping: never let a stuck IndexedDB block navigation.
        saveLawMeta({
          celex: result.resolved.celex,
          officialReference: reference,
          label: refLike?.raw || refLike?.label || refLike?.target || `CELEX ${result.resolved.celex}`,
        }).catch(() => {});
        navigate(getCanonicalLawRoute(
          targetLaw,
          refLike?.articleNumber ? "article" : null,
          refLike?.articleNumber || null,
          locale
        ));
        return;
      }
      openFallbackReference(result?.fallback?.url || fallbackUrl);
    } catch (error) {
      if (error instanceof FormexApiError) {
        openFallbackReference(error.fallback?.url || error.details?.fallback?.url || fallbackUrl);
        return;
      }
      openFallbackReference(fallbackUrl);
    } finally {
      if (externalResolutionRequestRef.current === requestId) {
        setPendingExternalReferenceKey(null);
        setPendingExternalReferenceLabel("");
      }
    }
  }, [currentContentLang, getExternalReferenceKey, locale, navigate, openFallbackReference, resolveReferenceInput]);

  const handleOpenLawByCelex = useCallback(async (celex, { articleNumber = null, label = null, queryParams = null } = {}) => {
    const normalizedCelex = String(celex || "").trim().toUpperCase();
    if (!normalizedCelex) return;
    const targetLaw = buildImportedLawCandidate({ celex: normalizedCelex, label });

    try {
      await saveLawMeta({
        celex: normalizedCelex,
        label: label || `CELEX ${normalizedCelex}`,
      });
    } catch (error) {
      console.warn(`[LawViewer] Could not save metadata for ${normalizedCelex}`, error);
    }

    const route = getCanonicalLawRoute(
      targetLaw,
      articleNumber != null && String(articleNumber).trim() !== "" ? "article" : null,
      articleNumber,
      locale
    );
    const query = queryParams instanceof URLSearchParams
      ? queryParams.toString()
      : new URLSearchParams(queryParams || {}).toString();
    navigate(query ? `${route}${route.includes("?") ? "&" : "?"}${query}` : route);
  }, [locale, navigate]);

  const handleContentClick = useCallback((event) => {
    const link = event.target.closest("a.cross-ref");
    if (link) {
      event.preventDefault();
      const articleNumber = link.getAttribute("data-ref-article");
      if (articleNumber) onCrossRefArticle(articleNumber);
      return;
    }

    const externalLink = event.target.closest("a.external-ref");
    if (!externalLink) return;

    event.preventDefault();
    handleOpenExternalLaw({
      raw: externalLink.getAttribute("data-ref-raw") || externalLink.textContent,
      articleNumber: externalLink.getAttribute("data-ref-article") || null,
      paragraph: externalLink.getAttribute("data-ref-paragraph") || null,
      point: externalLink.getAttribute("data-ref-point") || null,
      actType: externalLink.getAttribute("data-ref-act-type") || null,
      year: externalLink.getAttribute("data-ref-year") || null,
      number: externalLink.getAttribute("data-ref-number") || null,
      suffix: externalLink.getAttribute("data-ref-suffix") || null,
    });
  }, [handleOpenExternalLaw, onCrossRefArticle]);

  const onTouchStart = useCallback((event) => {
    touchEndRef.current = null;
    touchStartRef.current = event.targetTouches[0].clientX;
  }, []);

  const onTouchMove = useCallback((event) => {
    touchEndRef.current = event.targetTouches[0].clientX;
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!touchStartRef.current || !touchEndRef.current) return;

    const distance = touchStartRef.current - touchEndRef.current;
    const isLeftSwipe = distance > 50;
    const isRightSwipe = distance < -50;
    const { currentList, index } = getCurrentEntryIndex(data, selected);

    if (isLeftSwipe && index >= 0 && index < currentList.length - 1) {
      onPrevNext(selected.kind, index + 1);
    }
    if (isRightSwipe && index > 0) {
      onPrevNext(selected.kind, index - 1);
    }
  }, [data, onPrevNext, selected]);

  return {
    onCrossRefArticle,
    handleOpenExternalLaw,
    handleOpenLawByCelex,
    handleContentClick,
    isExternalReferencePending,
    isResolvingExternalLaw: pendingExternalReferenceKey != null,
    pendingExternalReferenceLabel,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  };
}

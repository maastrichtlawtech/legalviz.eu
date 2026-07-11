import { useCallback, useState } from "react";
import { FormexApiError, resolveEurlexUrl, resolveOfficialReference } from "../utils/formexApi.js";
import { buildImportedLawCandidate, getCanonicalLawRoute } from "../utils/lawRouting.js";
import { findCachedCelexByOfficialReference } from "../utils/library.js";

export function useAddLawImport({ locale, navigate, t }) {
  const [referenceType, setReferenceType] = useState("regulation");
  const [referenceYear, setReferenceYear] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [importError, setImportError] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [eurlexUrl, setEurlexUrl] = useState("");
  const [eurlexError, setEurlexError] = useState("");
  const [isResolvingUrl, setIsResolvingUrl] = useState(false);
  const [isAddLawDialogOpen, setIsAddLawDialogOpen] = useState(false);

  const handleReferenceImport = useCallback(async (event) => {
    event.preventDefault();
    setImportError("");

    const year = referenceYear.trim();
    const number = referenceNumber.trim();
    if (!/^\d{4}$/.test(year) || !/^\d{1,4}$/.test(number)) {
      setImportError(t("landing.invalidReference"));
      return;
    }

    const parsed = {
      actType: referenceType,
      year,
      number,
      raw: `${referenceType[0].toUpperCase()}${referenceType.slice(1)} ${year}/${number}`,
    };

    setIsImporting(true);
    try {
      const cachedCelex = await findCachedCelexByOfficialReference(parsed);
      const result = cachedCelex ? null : await resolveOfficialReference(parsed, "EN");
      const resolvedCelex = cachedCelex || result?.resolved?.celex;
      if (resolvedCelex) {
        const importedLaw = buildImportedLawCandidate({
          celex: resolvedCelex,
          officialReference: parsed,
        });
        navigate(getCanonicalLawRoute(importedLaw, null, null, locale));
        return;
      }

      const fallbackUrl = result?.fallback?.url;
      if (fallbackUrl) {
        window.open(fallbackUrl, "_blank", "noopener,noreferrer");
        setImportError(t("landing.automaticImportFallback"));
        return;
      }

      setImportError(t("landing.importUnavailable"));
    } catch (error) {
      const fallbackUrl = error instanceof FormexApiError
        ? error.fallback?.url || error.details?.fallback?.url
        : null;

      if (fallbackUrl) {
        window.open(fallbackUrl, "_blank", "noopener,noreferrer");
        setImportError(t("landing.automaticImportFallback"));
      } else {
        setImportError(t("landing.importUnavailable"));
      }
    } finally {
      setIsImporting(false);
    }
  }, [locale, navigate, referenceNumber, referenceType, referenceYear, t]);

  const handleEurlexUrlImport = useCallback(async (event) => {
    event.preventDefault();
    const sourceUrl = eurlexUrl.trim();

    if (!sourceUrl) {
      setEurlexError(t("landing.invalidEurlexUrl"));
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(sourceUrl);
    } catch {
      setEurlexError(t("landing.invalidEurlexUrl"));
      return;
    }

    const host = parsedUrl.hostname.toLowerCase();
    const isEurlexHost = host === "eur-lex.europa.eu" || host.endsWith(".eur-lex.europa.eu");
    if (!isEurlexHost) {
      setEurlexError(t("landing.invalidEurlexUrl"));
      return;
    }

    setEurlexError("");
    setIsResolvingUrl(true);

    try {
      const result = await resolveEurlexUrl(sourceUrl, "EN");
      const resolvedCelex = result?.resolved?.celex;

      if (resolvedCelex) {
        const officialReference = result?.parsed?.reference || null;
        if (officialReference?.actType && officialReference?.year && officialReference?.number) {
          const importedLaw = buildImportedLawCandidate({
            celex: resolvedCelex,
            officialReference,
          });
          navigate(getCanonicalLawRoute(importedLaw, null, null, locale));
          return;
        }

        navigate(`/import?celex=${encodeURIComponent(resolvedCelex)}`);
        return;
      }

      setEurlexError(t("landing.importResolveFailed"));
    } catch (error) {
      setEurlexError(
        error instanceof FormexApiError
          ? t("landing.importResolveFailed")
          : t("landing.importUnavailable")
      );
    } finally {
      setIsResolvingUrl(false);
    }
  }, [eurlexUrl, locale, navigate, t]);

  const openAddLawDialog = useCallback(() => {
    setImportError("");
    setEurlexError("");
    setIsAddLawDialogOpen(true);
  }, []);

  const closeAddLawDialog = useCallback(() => {
    setIsAddLawDialogOpen(false);
    setImportError("");
    setEurlexError("");
  }, []);

  return {
    closeAddLawDialog,
    eurlexError,
    eurlexUrl,
    handleEurlexUrlImport,
    handleReferenceImport,
    importError,
    isAddLawDialogOpen,
    isImporting,
    isResolvingUrl,
    openAddLawDialog,
    referenceNumber,
    referenceType,
    referenceYear,
    setEurlexUrl,
    setReferenceNumber,
    setReferenceType,
    setReferenceYear,
  };
}

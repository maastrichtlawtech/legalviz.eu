import { useCallback, useEffect, useState } from "react";
import {
  getLibraryLaws,
  markLawOpened as persistLawOpened,
} from "../utils/library.js";

export function useLandingLibrary() {
  const [allLaws, setAllLaws] = useState([]);
  const [libraryVersion, setLibraryVersion] = useState(0);

  const refreshLibrary = useCallback(async () => {
    try {
      const laws = await getLibraryLaws();
      setAllLaws(laws);
      setLibraryVersion((version) => version + 1);
    } catch (error) {
      console.error("Failed to load landing library", error);
      setAllLaws([]);
    }
  }, []);

  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    const handleLibraryUpdate = () => {
      refreshLibrary();
    };

    window.addEventListener("focus", handleLibraryUpdate);
    window.addEventListener("storage", handleLibraryUpdate);
    window.addEventListener("legalviz-library-updated", handleLibraryUpdate);
    window.addEventListener("legalviz-formex-cache-updated", handleLibraryUpdate);
    return () => {
      window.removeEventListener("focus", handleLibraryUpdate);
      window.removeEventListener("storage", handleLibraryUpdate);
      window.removeEventListener("legalviz-library-updated", handleLibraryUpdate);
      window.removeEventListener("legalviz-formex-cache-updated", handleLibraryUpdate);
    };
  }, [refreshLibrary]);

  const markLawOpened = useCallback(async (celex, position) => {
    await persistLawOpened(celex, position);
  }, []);

  return {
    allLaws,
    libraryVersion,
    markLawOpened,
    refreshLibrary,
  };
}

import { useCallback, useRef, useState } from "react";

const noop = () => {};

// Owns the request lifecycle shared by the networked search modes in SearchBox
// (laws, definitions, fulltext): a debounced entry point, abort of any
// in-flight request when a newer one starts, a monotonic request-id guard so a
// slow older response can never clobber newer results, and the loading/error/
// lastQuery bookkeeping each mode needs. The caller supplies the fetch itself
// via `run` and stays in charge of what results/errors mean for the UI.
//
//  - `run(query, { signal, filter })` performs the network call and returns the
//    final result array. It may throw; AbortError and stale responses are
//    filtered out here, so `onError` only sees genuinely current failures.
//  - `onResults(results)` receives the mapped results (and `[]` on resets).
//  - `onError(error)` is invoked for current failures; its side effects
//    (clearing results, logging) belong here.
//  - `onReset(query, extra)` fires on the short-query reset path, so a mode
//    that tracks extra state (e.g. the definitions discovery filter) can clear
//    it exactly when the reset happens.
//  - `abortOnSchedule` reproduces modes that cancel an in-flight request the
//    moment a new one is scheduled (fulltext), instead of only when it fires.
//  - `invalidateOnReset` reproduces modes that also invalidate an in-flight
//    request on a short-query reset (laws) rather than merely aborting it
//    (definitions/fulltext, whose stale response the mode still applies).
export function useNetworkedSearch({
  minQueryLength = 2,
  debounceMs = 300,
  run,
  onError = noop,
  onResults = noop,
  onReset = noop,
  abortOnSchedule = false,
  invalidateOnReset = true,
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastQuery, setLastQuery] = useState("");
  const abortRef = useRef(null);
  const requestIdRef = useRef(0);
  const debounceRef = useRef(null);

  const execute = useCallback((query, extra = {}) => {
    const trimmedQuery = String(query || "").trim();
    const { filter } = extra;

    if (trimmedQuery.length < minQueryLength && !filter) {
      if (invalidateOnReset) {
        requestIdRef.current += 1;
      }
      abortRef.current?.abort();
      setError(null);
      onResults([]);
      setLastQuery("");
      setIsLoading(false);
      onReset(query, extra);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    abortRef.current?.abort();
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setLastQuery(trimmedQuery);

    Promise.resolve(run(trimmedQuery, { signal: controller.signal, filter }))
      .then((results) => {
        if (requestIdRef.current !== requestId || abortRef.current !== controller) return;
        onResults(results);
      })
      .catch((error) => {
        if (error?.name === "AbortError" || requestIdRef.current !== requestId || abortRef.current !== controller) return;
        setError(error);
        onError(error);
      })
      .finally(() => {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setIsLoading(false);
        }
      });
  }, [invalidateOnReset, minQueryLength, onError, onReset, onResults, run]);

  const schedule = useCallback((query, extra = {}) => {
    if (abortOnSchedule) {
      abortRef.current?.abort();
      abortRef.current = null;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const { filter } = extra;
    if (String(query || "").trim().length < minQueryLength && !filter) {
      execute(query, extra);
      return;
    }
    setIsLoading(true);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      execute(query, extra);
    }, debounceMs);
  }, [abortOnSchedule, debounceMs, execute, minQueryLength]);

  const abort = useCallback(() => {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const reset = useCallback(() => {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLastQuery("");
    setError(null);
    setIsLoading(false);
    onResults([]);
  }, [onResults]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    isLoading,
    error,
    lastQuery,
    schedule,
    execute,
    abort,
    reset,
    clearError,
  };
}
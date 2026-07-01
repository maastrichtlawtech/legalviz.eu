export function getSelectedEntry(data, selected) {
  if (!selected?.id) return null;

  if (selected.kind === "article") {
    return data.articles?.find((entry) => entry.article_number === selected.id) || null;
  }
  if (selected.kind === "recital") {
    return data.recitals?.find((entry) => entry.recital_number === selected.id) || null;
  }
  if (selected.kind === "annex") {
    return data.annexes?.find((entry) => entry.annex_id === selected.id) || null;
  }

  return null;
}

export function resolveSelectionFromData(data, kind, id) {
  if (kind && id) {
    if (kind === "article") {
      const article = data.articles?.find((entry) => entry.article_number === id);
      if (article) return { kind: "article", id: article.article_number, html: article.article_html };
    }
    if (kind === "recital") {
      const recital = data.recitals?.find((entry) => entry.recital_number === id);
      if (recital) return { kind: "recital", id: recital.recital_number, html: recital.recital_html };
    }
    if (kind === "annex") {
      const annex = data.annexes?.find((entry) => entry.annex_id === id);
      if (annex) return { kind: "annex", id: annex.annex_id, html: annex.annex_html };
    }
  }

  if (!kind && !id) {
    return { kind: "overview", id: null, html: "" };
  }

  if (data.articles?.[0]) {
    return {
      kind: "article",
      id: data.articles[0].article_number,
      html: data.articles[0].article_html,
    };
  }
  if (data.recitals?.[0]) {
    return {
      kind: "recital",
      id: data.recitals[0].recital_number,
      html: data.recitals[0].recital_html,
    };
  }
  if (data.annexes?.[0]) {
    return {
      kind: "annex",
      id: data.annexes[0].annex_id,
      html: data.annexes[0].annex_html,
    };
  }

  return null;
}

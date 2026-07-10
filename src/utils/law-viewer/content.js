import { buildEurlexOjUrl, buildEurlexSearchUrl } from "../url.js";

export function getAnnexSidebarTitle(annex) {
  if (!annex) return "";

  const title = String(annex.annex_title || "").trim();
  if (!title) return "";

  const parts = title.split("—").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) return parts.slice(1).join(" — ");

  const normalizedTitle = title.toLowerCase();
  const normalizedId = String(annex.annex_id || "").trim().toLowerCase();
  if (normalizedId && (normalizedTitle === normalizedId || normalizedTitle.endsWith(` ${normalizedId}`))) {
    return "";
  }

  return title;
}

export function getProseClass(scale) {
  switch (scale) {
    case 1: return "prose-sm";
    case 2: return "prose-base";
    case 3: return "prose-lg";
    case 4: return "prose-xl";
    case 5: return "prose-2xl";
    default: return "prose-lg";
  }
}

export function getTextClass(scale) {
  switch (scale) {
    case 1: return "text-sm";
    case 2: return "text-base";
    case 3: return "text-lg";
    case 4: return "text-xl";
    case 5: return "text-2xl";
    default: return "text-lg";
  }
}

export function getFontPercent(scale) {
  switch (scale) {
    case 1: return 75;
    case 2: return 100;
    case 3: return 125;
    case 4: return 150;
    case 5: return 200;
    default: return 125;
  }
}

export function getSelectionTitle(selected, t) {
  if (selected.kind === "article") return `${t("common.article")} ${selected.id || ""}`;
  if (selected.kind === "recital") return `${t("common.recital")} ${selected.id || ""}`;
  if (selected.kind === "annex") return `${t("common.annex")} ${selected.id || ""}`;
  return t("common.noSelection");
}

export function buildToc(articles = []) {
  const chapters = [];
  const chMap = new Map();
  const label = (division) => (division ? [division.number, division.title].filter(Boolean).join(" — ").trim() : "");

  for (const article of articles) {
    const chapterLabel = label(article?.division?.chapter) || "(Untitled Chapter)";
    const sectionLabel = label(article?.division?.section) || null;

    let chapter = chMap.get(chapterLabel);
    if (!chapter) {
      chapter = { label: chapterLabel, items: [], sections: [], secMap: new Map() };
      chMap.set(chapterLabel, chapter);
      chapters.push(chapter);
    }

    if (sectionLabel) {
      let section = chapter.secMap.get(sectionLabel);
      if (!section) {
        section = { label: sectionLabel, items: [] };
        chapter.secMap.set(sectionLabel, section);
        chapter.sections.push(section);
      }
      section.items.push(article);
      continue;
    }

    chapter.items.push(article);
  }

  return chapters.map((chapter) => ({
    label: chapter.label,
    items: chapter.items,
    sections: chapter.sections,
  }));
}

export function buildExternalLawOverview(crossReferences, currentLang) {
  if (!crossReferences) return [];

  const items = new Map();

  const buildExternalHref = (ref) => {
    if (ref.type === "oj_ref" && ref.ojColl && ref.ojNo && ref.ojYear) {
      return buildEurlexOjUrl({
        ojColl: ref.ojColl,
        ojYear: ref.ojYear,
        ojNo: ref.ojNo,
        langCode: currentLang,
      });
    }

    const label = ref.raw || ref.target;
    return label ? buildEurlexSearchUrl(label, currentLang) : null;
  };

  for (const refs of Object.values(crossReferences)) {
    for (const ref of refs || []) {
      if (ref.type !== "external" && ref.type !== "oj_ref") continue;

      const label = ref.raw || ref.target;
      if (!label) continue;

      const key = ref.type === "oj_ref"
        ? `oj:${ref.ojColl || ""}:${ref.ojYear || ""}:${ref.ojNo || ""}`
        : `external:${ref.target || label}`;

      const existing = items.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }

      items.set(key, {
        key,
        label,
        href: buildExternalHref(ref),
        count: 1,
        ref,
      });
    }
  }

  return Array.from(items.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
}

export function buildSeoData({ dataTitle, currentLaw, selected, t }) {
  let lawName = dataTitle;
  if (!lawName) {
    lawName = currentLaw?.label || t("app.name");
  }

  let title = lawName;
  let description = t("seo.defaultDescription");

  if (selected.id) {
    const kindLabel = selected.kind === "article"
      ? t("common.article")
      : selected.kind === "recital"
        ? t("common.recital")
        : t("common.annex");
    title = `${kindLabel} ${selected.id} - ${lawName}`;
    description = t("seo.itemDescription", {
      kind: kindLabel,
      id: selected.id,
      law: lawName,
      app: t("app.name"),
    });
  }

  return { title, description };
}

export function buildCurrentLawLabel({ dataTitle, rawReference, currentLaw, slugReference }) {
  if (dataTitle) return dataTitle;
  if (rawReference) return rawReference;
  if (currentLaw?.label) return currentLaw.label;
  if (slugReference) return `${slugReference.actType} ${slugReference.year}/${slugReference.number}`;
  return "";
}

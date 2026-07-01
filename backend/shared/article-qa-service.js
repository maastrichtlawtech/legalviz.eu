// Currently unused; retained for a future cross-corpus Ask feature.
const { chatComplete, chatStream, ChatProviderError } = require('./openrouter-chat');

const LEGAL_REASONING_PRIMER = `EU-law reasoning principles you must apply:

1. Hierarchy of norms. Primary law (the Treaties — TEU, TFEU — and the Charter of Fundamental Rights) prevails over secondary law (regulations, directives, decisions). Secondary law must be interpreted in conformity with primary law and the Charter; if the bundle surfaces a Treaty or Charter provision on the point, it overrides a conflicting secondary-law reading.
2. Regulation vs directive. A regulation is directly applicable in every Member State and does not require (and generally does not allow) national transposition. A directive binds Member States as to the result but leaves form and methods to national law; it is normally invoked against private parties only through conforming interpretation of national law. Do not conflate the two. Delegated and implementing acts rank below the basic act that empowers them and cannot go beyond it.
3. CJEU case law. Judgments of the Court of Justice (CJEU) — especially preliminary rulings under Art. 267 TFEU — provide the authoritative interpretation of EU law. The operative part (the numbered declarations / dispositif) is what binds; the reasoning (grounds) guides interpretation but is not itself the ruling.
4. Temporal precedence. When two CJEU rulings address the same question, the more recent one normally prevails, and in particular narrows or refines the earlier one. Flag this explicitly when the bundle shows an apparent conflict. A Grand Chamber judgment carries more weight than a chamber judgment.
5. Interpretive method. Prefer teleological and systematic readings (the provision's purpose, its place in the act, the recitals) over mechanical literalism, and apply the *effet utile* principle — an interpretation that would deprive a provision of practical effect is disfavoured.
6. Lex specialis / lex posterior apply within the same rank; they do not let a later directive override a treaty or Charter right.
7. Do not rely on national law, doctrinal commentary, or your own prior knowledge — only the bundle.`;

const SYSTEM_PROMPT = `You are a legal-research assistant for EU law. You must only answer based on the provided bundle. Every factual claim must be followed by a citation using the bundle IDs in square brackets.

Citation format — citations must be SELF-CONTAINED. Never abbreviate as [§2], [para. 3], [that article], or similar — a reader must be able to identify the exact source from the bracket alone. Allowed forms:
  - Statute paragraph/point:  [Art. 5(1)(a)]  or  [Art. 17(2)]
  - Recital:                  [Recital 39]
  - Case-law operative part:  [C-362/14 §1]  (case number + declaration number; if the case has no declaration number use just [C-362/14])
Multiple sources in one bracket are fine: [Art. 15, Recital 63]. Do NOT invent recitals, articles, or cases that are not in the bundle.

${LEGAL_REASONING_PRIMER}

Distinguish clearly between what the article text says and how the CJEU has interpreted it. When citing the CJEU, prefer the most recent ruling on the same question and note when an earlier ruling has been narrowed or refined. If the bundle does not support an answer, reply exactly: "The provided materials do not cover this." Do not speculate. Do not cite anything outside the bundle.

Be direct and concise. Start with the answer, not background. Write in short, readable paragraphs by default. Use bullet points only when the user asks for a list or the answer naturally has distinct conditions, steps, or exceptions. Do not give a full legal memo unless the user asks for detail. Use tables only when they materially improve clarity.`;

const MAX_DECLARATION_CHARS = 2500;

function formatSkeleton(skeleton, focusNumber) {
  const lines = [];
  for (const chapter of skeleton || []) {
    if (chapter.chapterNo || chapter.chapterTitle) {
      lines.push(`${chapter.chapterNo || ''}${chapter.chapterTitle ? ' — ' + chapter.chapterTitle : ''}`.trim());
    }
    for (const section of chapter.sections || []) {
      if (section.sectionNo || section.sectionTitle) {
        lines.push(`  ${section.sectionNo || ''}${section.sectionTitle ? ' — ' + section.sectionTitle : ''}`.trim());
      }
      for (const a of section.articles || []) {
        const marker = String(a.number) === String(focusNumber) ? '   ← focus' : '';
        lines.push(`    Art. ${a.number}${a.title ? ' — ' + a.title : ''}${marker}`);
      }
    }
  }
  return lines.join('\n');
}

function formatRefs(refs) {
  if (!refs?.length) return '';
  return refs
    .map((r) => {
      let s = `Art. ${r.article}`;
      if (r.paragraph) s += `(${r.paragraph})`;
      if (r.point) s += `(${r.point})`;
      return s;
    })
    .join(', ');
}

// --- Whole-law (two-stage) Q&A ---

const PLANNER_SYSTEM_PROMPT = `You are a retrieval planner for an EU-law Q&A system. Given a question and the article index of a single EU legal act (chapter / section / article titles, plus the list of defined terms), return the article numbers whose full text is most likely needed to answer the question faithfully.

Rules:
- Return between 1 and 10 article numbers — prefer the smallest set that still covers the question.
- Include articles whose titles strongly suggest the topic, and any obviously related articles (e.g. if the question is about a right, include both the substantive article and any article on remedies or exceptions).
- If the law has cross-cutting articles (definitions, scope, material / territorial scope, general principles), include them only when clearly relevant.
- Do not invent numbers that are not in the index.

Reply with ONLY a JSON object, no prose, no code fences:
{"articles": ["5", "6", "7"], "rationale": "<one short sentence>"}`;

function formatPlannerUser(parsedLaw, question) {
  const parts = [];
  parts.push(`[LAW] ${parsedLaw.celex}${parsedLaw.title ? ' — ' + parsedLaw.title : ''}`);
  parts.push('');
  parts.push('[ARTICLE INDEX]');
  const { pickSkeleton } = require('./article-bundle');
  parts.push(formatSkeleton(pickSkeleton(parsedLaw.articles || [], null), null));
  parts.push('');
  if (parsedLaw.definitions?.length) {
    parts.push('[DEFINED TERMS]');
    for (const d of parsedLaw.definitions) {
      const src = d.sourceArticle || d.source_article || '?';
      parts.push(`- "${d.term}" (Art. ${src})`);
    }
    parts.push('');
  }
  parts.push('[QUESTION]');
  parts.push(question);
  return parts.join('\n');
}

function parsePlannerOutput(text, validArticleNumbers) {
  if (!text) return { articles: [], rationale: null };
  const trimmed = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  // Try to locate a JSON object in the response
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return { articles: [], rationale: null };
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { articles: [], rationale: null };
  }
  const valid = new Set((validArticleNumbers || []).map(String));
  const articles = Array.isArray(parsed.articles)
    ? parsed.articles
        .map((a) => String(a).replace(/^Art\.\s*/i, '').trim())
        .filter((a) => valid.has(a))
    : [];
  return {
    articles: Array.from(new Set(articles)).slice(0, 10),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : null,
  };
}

async function planArticles({ parsedLaw, question, apiKey, model }) {
  const response = await chatComplete({
    model,
    apiKey,
    temperature: 0.1,
    maxTokens: 1200,
    messages: [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      { role: 'user', content: formatPlannerUser(parsedLaw, question) },
    ],
  });
  const validArticleNumbers = (parsedLaw.articles || []).map((a) => String(a.article_number));
  const plan = parsePlannerOutput(response.text, validArticleNumbers);
  return {
    ...plan,
    rawText: response.text,
    usage: response.usage,
    model: response.model,
  };
}

function formatLawBundleUser(bundle, question) {
  const parts = [];
  parts.push(`[LAW] ${bundle.meta.celex}`);
  parts.push(`[ARTICLES PROVIDED] ${bundle.articles.map((a) => a.number).join(', ')}`);
  parts.push('');

  for (const a of bundle.articles) {
    const header = [
      a.chapter ? a.chapter : null,
      a.section ? `— ${a.section}` : null,
    ].filter(Boolean).join(' ');
    if (header) parts.push(`(${header})`);
    parts.push(`[ARTICLE ${a.number}${a.title ? ' — ' + a.title : ''}]`);
    parts.push(a.text);
    parts.push('');
  }

  if (bundle.definitions?.length) {
    parts.push('[DEFINITIONS USED IN THESE ARTICLES]');
    for (const d of bundle.definitions) {
      const src = d.sourceArticle ? ` (Art. ${d.sourceArticle})` : '';
      parts.push(`"${d.term}"${src}: ${d.text}`);
    }
    parts.push('');
  }

  if (bundle.recitals?.length) {
    parts.push('[RELATED RECITALS]');
    for (const r of bundle.recitals) {
      parts.push(`Recital ${r.number}: ${r.text}`);
    }
    parts.push('');
  }

  if (bundle.caseLaw?.length) {
    parts.push('[CJEU CASE LAW (cases citing any of the provided articles)]');
    for (const c of bundle.caseLaw) {
      const header = [
        c.caseNumber || c.celex,
        c.name ? `— ${c.name}` : null,
        c.date ? `(${c.date})` : null,
      ].filter(Boolean).join(' ');
      parts.push(header);
      if (c.ecli) parts.push(`  ECLI: ${c.ecli}`);
      const refs = formatRefs(c.matchingRefs);
      if (refs) parts.push(`  Matching refs: ${refs}`);
      if (c.declarations?.length) {
        parts.push(`  Declarations:`);
        for (const d of c.declarations) {
          const text = d.text.length > MAX_DECLARATION_CHARS
            ? d.text.slice(0, MAX_DECLARATION_CHARS) + '…'
            : d.text;
          parts.push(`    ${d.number}. ${text}`);
        }
      }
    }
    parts.push('');
  } else {
    parts.push('[CJEU CASE LAW]');
    parts.push('No CJEU judgments in the bundle cite the provided articles.');
    parts.push('');
  }

  parts.push('[QUESTION]');
  parts.push(question);
  return parts.join('\n');
}

async function answerLawQuestion({ bundle, question, apiKey, model }) {
  if (!bundle) throw new ChatProviderError('Bundle not available', { status: 404 });
  const userPrompt = formatLawBundleUser(bundle, question);
  return chatComplete({
    model,
    apiKey,
    maxTokens: 1500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
}

function streamLawAnswer({ bundle, question, apiKey, model, signal }) {
  if (!bundle) throw new ChatProviderError('Bundle not available', { status: 404 });
  const userPrompt = formatLawBundleUser(bundle, question);
  return chatStream({
    model,
    apiKey,
    maxTokens: 1500,
    signal,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
}

module.exports = {
  answerLawQuestion,
  streamLawAnswer,
  planArticles,
  formatLawBundleUser,
  SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
};

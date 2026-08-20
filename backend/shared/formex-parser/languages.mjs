/**
 * Language-specific patterns for parsing EUR-Lex legal documents.
 *
 * EUR-Lex publishes legislation in all 24 official EU languages with identical
 * XML structure (same CSS classes) — only the text content changes.
 * This module provides per-language keyword patterns and a detector that reads
 * the language code embedded in every EUR-Lex HTML page.
 *
 * Notes on quote characters:
 * - In Formex XML, quotation marks are encoded as <QUOT.START>/<QUOT.END> elements.
 *   The fmxParser converts these to U+2018/U+2019 (left/right single quotes) regardless
 *   of language.  So every language's quoteChars must include \u2018\u2019.
 * - Languages that also use «» or „" in raw text get those added too.
 *
 * Notes on definitionFormat:
 * - "term_first": '[term]' means/bezeichnet/oznacza ...  (EN, PL, DE, NL, SV, DA, FI, ET, LV, LT, CS, SK, HU, RO, BG, HR, SL, EL, MT, GA)
 * - "verb_first": entend par '[term]' / si intende per '[term]'  (FR, IT, ES, PT)
 *
 * For verb_first languages, meansVerb includes any prefix words (e.g. "on" in French).
 */

// ---------------------------------------------------------------------------
// Per-language configurations
// ---------------------------------------------------------------------------

const EN = {
  code: "EN",
  article: /Article\s+(\d+[a-z]*)/i,
  chapter: /^\s*CHAPTER\b/i,
  section: /^\s*SECTION\b/i,
  annex: /^ANNEX(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^ANNEX\s*([IVXLC]+|\d+)?/i,
  definition: /definitions?/i,
  recital: /[Rr]ecitals?/,
  quoteChars: "\u2018\u2019'\"",
  // Pre-2000 drafting says "'term' shall mean \u2026" where modern acts say
  // "'term' means \u2026" \u2014 both spellings appear across the corpus, so the verb
  // has to cover them or every older directive's definitions article is lost.
  meansVerb: "shall\\s+mean|means",
  definitionFormat: "term_first",
  titleSplit: /\s+of\s+/i,
  parliamentSplit: /\s+of the European Parliament\b/i,
  eea: /text with eea relevance/i,
  stopWords: [
    // Basic English stop words
    "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "at", "by", "for", "with",
    "about", "against", "between", "into", "through", "during", "before", "after", "above", "below",
    "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further", "once",
    "here", "there", "where", "why", "how", "all", "any", "both", "each", "few", "more", "most",
    "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "can", "will", "just", "should", "now", "also", "therefore", "upon", "within", "without",
    // EU legal structure terms
    "union", "member", "states", "commission", "article", "paragraph", "eu", "european",
    "regulation", "regulations", "directive", "directives", "decision", "decisions",
    "law", "act", "provisions", "measures",
    "shall", "may", "whereas", "pursuant", "accordance", "hereof", "thereof",
    // Common legal verbs/procedural language
    "apply", "applicable", "applied", "applies", "provide", "provided", "provides", "providing",
    "ensure", "ensures", "ensuring", "establish", "establishing", "regard", "regarding",
    "refer", "referred", "include", "including", "included", "follow", "following", "follows",
    "make", "made", "take", "taken", "taking", "set", "given", "lay", "laying",
    // Generic filler terms
    "relevant", "appropriate", "necessary", "competent", "concerned", "particular",
    "respect", "account", "case", "cases", "order", "view", "way", "ways", "manner",
    "point", "points", "subject", "meaning", "need", "needs", "effect", "effects",
    // Additional boilerplate/transition words
    "however", "furthermore", "especially", "certain", "inter", "alia",
  ],
};

const PL = {
  code: "PL",
  article: /Artyku[\u0142l]\s+(\d+[a-z]*)/i,
  chapter: /^\s*ROZDZIA[\u0141L]\b/i,
  section: /^\s*(?:SEKCJA|ODDZIA[\u0141L])\b/i,
  annex: /^ZA[\u0141L][\u0104A]CZNIK(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^ZA[\u0141L][\u0104A]CZNIK\s*([IVXLC]+|\d+)?/i,
  definition: /definicj/i,
  recital: /[Mm]otyw/,
  // „term" oznacza …
  //  Polish EUR-Lex uses „ (U+201E) and " (U+201D)
  quoteChars: "\u201E\u201A\u00AB\u201C'\"\u2018\u201D\u201F\u00BB\u2019",
  meansVerb: "oznacz[a\u0105]\\S*",
  definitionFormat: "term_first",
  titleSplit: /\s+z dnia\s+/i,
  parliamentSplit: /\s+Parlamentu Europejskiego\b/i,
  eea: /tekst maj\u0105cy znaczenie dla eog/i,
  stopWords: [
    // Basic Polish function words
    "i", "w", "na", "do", "z", "o", "za", "od", "po", "ze", "we", "nie", "si\u0119",
    "jest", "to", "co", "jak", "lub", "oraz", "tym", "jej", "ich", "jego", "tej",
    "tego", "ten", "ta", "te", "kt\u00F3ry", "kt\u00F3ra", "kt\u00F3re", "kt\u00F3rych",
    "kt\u00F3rego", "kt\u00F3rej", "jako", "by\u0107", "mo\u017Ce", "mog\u0105",
    "b\u0119dzie", "zosta\u0142", "zosta\u0142a", "by\u0142", "by\u0142a", "przez",
    "przy", "dla", "bez", "nad", "pod", "przed", "mi\u0119dzy", "tak", "tylko",
    "jednak", "r\u00F3wnie\u017C", "tak\u017Ce", "wi\u0119c", "gdy", "je\u015Bli",
    "je\u017Celi", "celu", "zgodnie", "przypadku", "spos\u00F3b", "zakresie",
    // EU legal structure terms (Polish)
    "artyku\u0142", "ust\u0119p", "punkt", "motyw", "za\u0142\u0105cznik",
    "rozporz\u0105dzenie", "dyrektywa", "decyzja",
    "komisja", "pa\u0144stwa", "cz\u0142onkowskie", "unia", "europejska",
    "stosuje", "stosowania", "zapewnia", "ustanawia", "odniesienie",
    "niniejszego", "niniejszej", "niniejszym",
  ],
};

const DE = {
  code: "DE",
  article: /Artikel\s+(\d+[a-z]*)/i,
  chapter: /^\s*KAPITEL\b/i,
  section: /^\s*ABSCHNITT\b/i,
  annex: /^ANHANG(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^ANHANG\s*([IVXLC]+|\d+)?/i,
  definition: /Begriffsbestimmungen?|Definitionen?/i,
  recital: /Erw\u00e4gungsgrund(?:e|en)?/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB'\"",
  meansVerb: "bezeichnet(?:\\s+\\S+)*",
  definitionFormat: "term_first",
  titleSplit: /\s+vom?\s+/i,
  parliamentSplit: /\s+des Europ\u00e4ischen Parlaments\b/i,
  eea: /Text(?:.*?)EWR/i,
  stopWords: [
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einer", "einen", "einem", "eines",
    "und", "oder", "aber", "wenn", "dann", "als", "wie", "bei", "mit", "von", "zu", "an", "in",
    "auf", "aus", "nach", "vor", "f\u00fcr", "durch", "gegen", "ohne", "um", "bis", "seit",
    "nicht", "noch", "auch", "nur", "schon", "so", "jedoch", "dabei", "daher", "damit",
    "werden", "wurde", "worden", "wird", "sein", "sind", "war", "waren", "hat", "haben",
    "artikel", "absatz", "buchstabe", "anhang", "erw\u00e4gungsgrund",
    "verordnung", "richtlinie", "beschluss", "europ\u00e4ischen", "kommission",
    "mitgliedstaaten", "union", "gem\u00e4\u00df", "entsprechend", "nach",
  ],
};

const FR = {
  code: "FR",
  article: /Article\s+(\d+[a-z]*)/i,
  chapter: /^\s*CHAPITRE\b/i,
  section: /^\s*SECTION\b/i,
  annex: /^ANNEXE(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^ANNEXE\s*([IVXLC]+|\d+)?/i,
  definition: /D\u00e9finitions?/i,
  recital: /[Cc]onsid\u00e9rants?/,
  quoteChars: "\u00AB\u00BB\u2018\u2019\u201C\u201D\"'",
  // French: "on entend par «terme»: ..." → verb before term
  meansVerb: "(?:on\\s+)?entend\\s+par",
  definitionFormat: "verb_first",
  titleSplit: /\s+du\s+/i,
  parliamentSplit: /\s+du Parlement europ\u00e9en\b/i,
  eea: /Texte.*EEE/i,
  stopWords: [
    "le", "la", "les", "un", "une", "des", "du", "de", "d", "l", "et", "ou", "mais", "si",
    "car", "que", "qui", "qu", "ne", "pas", "plus", "aussi", "donc", "or", "ni", "car",
    "en", "au", "aux", "par", "sur", "sous", "avec", "sans", "pour", "dans", "entre",
    "\u00e0", "chez", "contre", "depuis", "lors", "vers", "avant", "apr\u00e8s", "pendant",
    "est", "sont", "a", "ont", "avoir", "\u00eatre", "fait", "faire",
    "article", "paragraphe", "point", "annexe", "consid\u00e9rant",
    "r\u00e8glement", "directive", "d\u00e9cision", "europ\u00e9enne", "commission",
    "\u00e9tats", "membres", "union", "conform\u00e9ment", "pr\u00e9vu",
  ],
};

const ES = {
  code: "ES",
  article: /Art[i\u00ed]culo\s+(\d+[a-z]*)/i,
  chapter: /^\s*CAP[I\u00cd]TULO\b/i,
  section: /^\s*SECCI[O\u00d3]N\b/i,
  annex: /^ANEXO(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^ANEXO\s*([IVXLC]+|\d+)?/i,
  definition: /Definiciones?/i,
  recital: /[Cc]onsiderando/,
  quoteChars: "\u00AB\u00BB\u2018\u2019\u201C\u201D\"'",
  // Spanish: "se entenderá por «término»: ..."
  meansVerb: "se\\s+entender[a\u00e1]\\s+por|se\\s+entiende\\s+por",
  definitionFormat: "verb_first",
  titleSplit: /\s+de\s+/i,
  parliamentSplit: /\s+del Parlamento Europeo\b/i,
  eea: /Texto.*EEE/i,
  stopWords: [
    "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "a",
    "y", "o", "pero", "si", "que", "en", "con", "por", "para", "sin", "sobre",
    "entre", "ante", "bajo", "cabe", "desde", "hacia", "hasta", "seg\u00fan",
    "es", "son", "fue", "fueron", "ser", "estar", "tiene", "tienen", "ha", "han",
    "art\u00edculo", "apartado", "letra", "anexo", "considerando",
    "reglamento", "directiva", "decisi\u00f3n", "europea", "comisi\u00f3n",
    "estados", "miembros", "uni\u00f3n", "conforme", "previsto",
  ],
};

const IT = {
  code: "IT",
  article: /Articolo\s+(\d+[a-z]*)/i,
  chapter: /^\s*CAPO\b/i,
  section: /^\s*SEZIONE\b/i,
  annex: /^ALLEGATO(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^ALLEGATO\s*([IVXLC]+|\d+)?/i,
  definition: /Definizioni?/i,
  recital: /[Cc]onsiderando/,
  quoteChars: "\u00AB\u00BB\u2018\u2019\u201C\u201D\"'",
  // Italian: "si intende per «termine»: ..."
  meansVerb: "si\\s+intende(?:\\s+per)?",
  definitionFormat: "verb_first",
  titleSplit: /\s+del\s+/i,
  parliamentSplit: /\s+del Parlamento europeo\b/i,
  eea: /Testo.*SEE/i,
  stopWords: [
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "del", "dello", "della",
    "dei", "degli", "delle", "al", "allo", "alla", "ai", "agli", "alle",
    "e", "o", "ma", "se", "che", "di", "da", "in", "con", "su", "per", "tra", "fra",
    "\u00e8", "sono", "era", "erano", "essere", "ha", "hanno", "fare", "avere",
    "articolo", "paragrafo", "lettera", "allegato", "considerando",
    "regolamento", "direttiva", "decisione", "europea", "commissione",
    "stati", "membri", "unione", "conformemente", "previsto",
  ],
};

const PT = {
  code: "PT",
  article: /Artigo\s+(\d+[a-z]*)/i,
  chapter: /^\s*CAP[I\u00cd]TULO\b/i,
  section: /^\s*SEC[C\u00c7][A\u00c3]O\b/i,
  annex: /^ANEXO(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^ANEXO\s*([IVXLC]+|\d+)?/i,
  definition: /Defini\u00e7[o\u00f5]es?/i,
  recital: /[Cc]onsiderando/,
  quoteChars: "\u00AB\u00BB\u2018\u2019\u201C\u201D\"'",
  // Portuguese: "entende-se por «termo»: ..."
  meansVerb: "entende-se\\s+por",
  definitionFormat: "verb_first",
  titleSplit: /\s+de\s+/i,
  parliamentSplit: /\s+do Parlamento Europeu\b/i,
  eea: /Texto.*EEE/i,
  stopWords: [
    "o", "a", "os", "as", "um", "uma", "uns", "umas", "do", "da", "dos", "das",
    "ao", "\u00e0", "aos", "\u00e0s", "e", "ou", "mas", "se", "que", "em", "com",
    "por", "para", "sem", "sobre", "entre", "de", "no", "na", "nos", "nas",
    "\u00e9", "s\u00e3o", "foi", "foram", "ser", "ter", "tem", "t\u00eam",
    "artigo", "n.\u00ba", "al\u00ednea", "anexo", "considerando",
    "regulamento", "diretiva", "decis\u00e3o", "europeia", "comiss\u00e3o",
    "estados", "membros", "uni\u00e3o", "nos termos", "previsto",
  ],
};

const NL = {
  code: "NL",
  article: /Artikel\s+(\d+[a-z]*)/i,
  chapter: /^\s*HOOFDSTUK\b/i,
  section: /^\s*AFDELING\b/i,
  annex: /^BIJLAGE(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^BIJLAGE\s*([IVXLC]+|\d+)?/i,
  definition: /Definities?/i,
  recital: /[Oo]verweging/,
  quoteChars: "\u2018\u2019\u201C\u201D\u00AB\u00BB\"'",
  meansVerb: "wordt\\s+verstaan|verstaat\\s+men",
  definitionFormat: "term_first",
  titleSplit: /\s+van\s+/i,
  parliamentSplit: /\s+van het Europees Parlement\b/i,
  eea: /Tekst.*EER/i,
  stopWords: [
    "de", "het", "een", "van", "in", "op", "aan", "te", "bij", "voor", "over",
    "met", "als", "is", "zijn", "was", "waren", "wordt", "worden", "heeft", "hebben",
    "en", "of", "maar", "dat", "dit", "die", "deze", "door", "uit", "naar",
    "artikel", "lid", "punt", "bijlage", "overweging",
    "verordening", "richtlijn", "besluit", "europese", "commissie",
    "lidstaten", "unie", "overeenkomstig", "voorzien",
  ],
};

const DA = {
  code: "DA",
  article: /Artikel\s+(\d+[a-z]*)/i,
  chapter: /^\s*KAPITEL\b/i,
  section: /^\s*AFDELING\b/i,
  annex: /^BILAG(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^BILAG\s*([IVXLC]+|\d+)?/i,
  definition: /Definitioner?/i,
  recital: /[Bb]etragtning/,
  quoteChars: "\u2018\u2019\u201C\u201D\u00AB\u00BB\"'",
  meansVerb: "forst\u00e5s\\s+ved|betyder",
  definitionFormat: "term_first",
  titleSplit: /\s+af\s+/i,
  parliamentSplit: /\s+Europa-Parlamentets?\b/i,
  eea: /E\u00d8S-relevant tekst/i,
  stopWords: [
    "den", "det", "de", "en", "et", "af", "i", "p\u00e5", "til", "for", "med",
    "og", "eller", "men", "som", "der", "at", "er", "var", "har", "have", "blive",
    "artikel", "stk", "litra", "bilag", "betragtning",
    "forordning", "direktiv", "afg\u00f8relse", "europ\u00e6iske", "kommissionen",
    "medlemsstaterne", "unionen",
  ],
};

const SV = {
  code: "SV",
  article: /Artikel\s+(\d+[a-z]*)/i,
  chapter: /^\s*KAPITEL\b/i,
  section: /^\s*AVSNITT\b/i,
  annex: /^BILAGA(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^BILAGA\s*([IVXLC]+|\d+)?/i,
  definition: /Definitioner?/i,
  recital: /[Ss]k\u00e4l/,
  quoteChars: "\u2018\u2019\u201C\u201D\u00AB\u00BB\"'",
  meansVerb: "avses",
  definitionFormat: "term_first",
  titleSplit: /\s+av den\s+/i,
  parliamentSplit: /\s+Europaparlamentets?\b/i,
  eea: /EES-relevant text/i,
  stopWords: [
    "den", "det", "de", "en", "ett", "av", "i", "p\u00e5", "till", "f\u00f6r", "med",
    "och", "eller", "men", "som", "att", "det", "\u00e4r", "var", "har", "ha",
    "artikel", "punkt", "led", "bilaga", "sk\u00e4l",
    "f\u00f6rordning", "direktiv", "beslut", "europeiska", "kommissionen",
    "medlemsstaterna", "unionen",
  ],
};

const FI = {
  code: "FI",
  article: /Artikla\s+(\d+[a-z]*)/i,
  chapter: /\bLUKU\b/i,
  section: /\bJAKSO\b/i,
  annex: /^LIITE(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^LIITE\s*([IVXLC]+|\d+)?/i,
  definition: /M\u00e4\u00e4ritelm[i\u00e4]/i,
  recital: /[Jj]ohdanto-osa|[Pp]erustelukappale/,
  quoteChars: "\u2018\u2019\u201C\u201D\u00AB\u00BB\"'",
  meansVerb: "tarkoitetaan",
  definitionFormat: "term_first",
  titleSplit: /\s+annettu\s+/i,
  parliamentSplit: /\s+Euroopan parlamentin\b/i,
  eea: /ETA-merkityksellinen teksti/i,
  stopWords: [
    "ja", "tai", "sekä", "mutta", "jos", "kun", "kuin", "joka", "jotka", "jonka",
    "on", "oli", "ovat", "olivat", "ei", "en", "se", "ne", "tämä", "nämä",
    "että", "koska", "vaikka", "siten", "kuitenkin",
    "artikla", "kohta", "liite", "johdantokappale",
    "asetus", "direktiivi", "päätös", "eurooppalainen", "komissio",
    "jäsenvaltiot", "unioni",
  ],
};

const CS = {
  code: "CS",
  article: /\u010cl[a\u00e1]nek\s+(\d+[a-z]*)/i,
  chapter: /^\s*KAPITOLA\b/i,
  section: /^\s*ODD[I\u00cd]L\b/i,
  annex: /^P\u0158[I\u00cd]LOHA(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^P\u0158[I\u00cd]LOHA\s*([IVXLC]+|\d+)?/i,
  definition: /Definice?/i,
  recital: /[Bb]od\s+odůvodnění|[Oo]d\u016fvodn[eě]n[ií]/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "rozum[ií]\\s+se",
  definitionFormat: "term_first",
  titleSplit: /\s+ze dne\s+/i,
  parliamentSplit: /\s+Evropsk\u00e9ho parlamentu\b/i,
  eea: /Text.*v\u00fdznam.*pro EHP/i,
  stopWords: [
    "a", "v", "na", "do", "z", "o", "za", "od", "po", "ze", "ve", "ne", "se",
    "je", "jsou", "byl", "byla", "bylo", "být", "jako", "když", "pokud",
    "také", "tedy", "však", "nebo", "ani", "ale", "přitom",
    "článek", "odstavec", "písmeno", "příloha", "bod",
    "nařízení", "směrnice", "rozhodnutí", "evropské", "komise",
    "členské", "státy", "unie", "podle", "v souladu",
  ],
};

const SK = {
  code: "SK",
  article: /\u010cl[a\u00e1]nok\s+(\d+[a-z]*)/i,
  chapter: /^\s*KAPITOLA\b/i,
  section: /^\s*ODDIEL\b/i,
  annex: /^PR[I\u00cd]LOHA(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^PR[I\u00cd]LOHA\s*([IVXLC]+|\d+)?/i,
  definition: /Definície?/i,
  recital: /[Oo]dôvodnenie|[Bb]od\s+odôvodnenia/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "rozumie\\s+sa",
  definitionFormat: "term_first",
  titleSplit: /\s+z\s+/i,
  parliamentSplit: /\s+Eur\u00f3pskeho parlamentu\b/i,
  eea: /Text.*v\u00fdznamu.*pre EHP/i,
  stopWords: [
    "a", "v", "na", "do", "z", "o", "za", "od", "po", "zo", "vo", "nie", "sa",
    "je", "sú", "bol", "bola", "bolo", "byť", "ako", "keď", "pokiaľ",
    "taktiež", "teda", "však", "alebo", "ani", "ale",
    "článok", "odsek", "písmeno", "príloha", "bod",
    "nariadenie", "smernica", "rozhodnutie", "európske", "komisia",
    "členské", "štáty", "únia",
  ],
};

const HU = {
  code: "HU",
  article: /(\d+[a-z]*)\.\s+cikk/i,
  chapter: /\bFEJEZET\b/i,
  section: /\bSZAKASZ\b/i,
  annex: /^MELL[E\u00c9]KLET(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^MELL[E\u00c9]KLET\s*([IVXLC]+|\d+)?/i,
  definition: /Fogalomm?eghat\u00e1roz[a\u00e1]sok?/i,
  recital: /[Pp]reambulumbekezdés/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "jelenti",
  definitionFormat: "term_first",
  titleSplit: /\s+\u00e9vi\s+/i,
  parliamentSplit: /\s+az Eur\u00f3pai Parlament\b/i,
  eea: /EGT-vonatkoz\u00e1s\u00fa sz\u00f6veg/i,
  stopWords: [
    "a", "az", "és", "vagy", "de", "ha", "hogy", "amely", "amelyek", "amelynek",
    "van", "vannak", "volt", "voltak", "lesz", "lesznek", "nem", "sem", "is", "már",
    "csak", "még", "azonban", "ezért", "tehát", "illetve",
    "cikk", "bekezdés", "pont", "melléklet",
    "rendelet", "irányelv", "határozat", "európai", "bizottság",
    "tagállamok", "unió",
  ],
};

const RO = {
  code: "RO",
  article: /Articolul?\s+(\d+[a-z]*)/i,
  chapter: /^\s*CAPITOLUL?\b/i,
  section: /^\s*SEC[T\u0162]IUNEA\b/i,
  annex: /^ANEXA?(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^ANEXA?\s*([IVXLC]+|\d+)?/i,
  definition: /Defini[t\u0163]ii/i,
  recital: /[Cc]onsiderent/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "\u00eenseamn\u0103",
  definitionFormat: "term_first",
  titleSplit: /\s+din\s+/i,
  parliamentSplit: /\s+Parlamentului European\b/i,
  eea: /Text.*SEE/i,
  stopWords: [
    "și", "sau", "dar", "că", "care", "de", "la", "în", "pe", "cu", "pentru",
    "din", "prin", "între", "după", "înainte", "sub", "este", "sunt", "era",
    "era", "fi", "nu", "și", "deja", "astfel", "totuși",
    "articolul", "alineatul", "litera", "anexa",
    "regulamentul", "directiva", "decizia", "europeană", "comisia",
    "statele", "membre", "uniunea",
  ],
};

const BG = {
  code: "BG",
  article: /\u0427\u043b\u0435\u043d\s+(\d+[a-z]*)/i,   // Член N
  chapter: /^\s*\u0413\u041b\u0410\u0412\u0410\b/i,    // ГЛАВА
  section: /^\s*\u0420\u0410\u0417\u0414\u0415\u041b\b/i,  // РАЗДЕЛ
  annex: /^\u041f\u0420\u0418\u041b\u041e\u0416\u0415\u041d\u0418\u0415(\s+[IVXLC]+|\s+\d+)?/i,  // ПРИЛОЖЕНИЕ
  annexCapture: /^\u041f\u0420\u0418\u041b\u041e\u0416\u0415\u041d\u0418\u0415\s*([IVXLC]+|\d+)?/i,
  definition: /\u041e\u043f\u0440\u0435\u0434\u0435\u043b\u0435\u043d\u0438\u044f/i,  // Определения
  recital: /[Сс]\u044a\u043e\u0431\u0440\u0430\u0436\u0435\u043d\u0438\u0435/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "\u043e\u0437\u043d\u0430\u0447\u0430\u0432\u0430",  // означава
  definitionFormat: "term_first",
  titleSplit: /\s+\u043e\u0442\s+/i,
  parliamentSplit: /\s+\u043d\u0430 \u0415\u0432\u0440\u043e\u043f\u0435\u0439\u0441\u043a\u0438\u044f \u043f\u0430\u0440\u043b\u0430\u043c\u0435\u043d\u0442\b/i,
  eea: /\u0422\u0435\u043a\u0441\u0442.*\u0415\u0418\u041f/i,
  stopWords: [
    "\u0438", "\u0432", "\u043d\u0430", "\u0437\u0430", "\u043e\u0442", "\u0434\u043e", "\u043f\u043e", "\u0441",
    "\u0435", "\u0441\u0430", "\u0431\u0435", "\u0434\u0430", "\u043d\u0435", "\u0441\u0435",
    "\u0447\u043b\u0435\u043d", "\u0430\u043b\u0438\u043d\u0435\u044f", "\u0442\u043e\u0447\u043a\u0430",
    "\u0440\u0435\u0433\u043b\u0430\u043c\u0435\u043d\u0442", "\u0434\u0438\u0440\u0435\u043a\u0442\u0438\u0432\u0430",
  ],
};

const HR = {
  code: "HR",
  article: /\u010clanak\s+(\d+[a-z]*)/i,
  chapter: /^\s*POGLAVLJE\b/i,
  section: /^\s*ODJELJAK\b/i,
  annex: /^PRILOG(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^PRILOG\s*([IVXLC]+|\d+)?/i,
  definition: /Definicije?/i,
  recital: /[Uu]vodna\s+izjava|[Uu]vodne\s+izjave/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "zna\u010di",
  definitionFormat: "term_first",
  titleSplit: /\s+od\s+/i,
  parliamentSplit: /\s+Europskog parlamenta\b/i,
  eea: /Tekst.*EGP/i,
  stopWords: [
    "i", "u", "na", "za", "od", "do", "po", "iz", "bez", "se", "je", "su", "bila",
    "koje", "koji", "koja", "što", "da", "ne", "ili", "ali", "ni",
    "članak", "stavak", "točka", "prilog",
    "uredba", "direktiva", "odluka", "europska", "komisija",
    "države", "članice", "unija",
  ],
};

const SL = {
  code: "SL",
  article: /\u010clen\s+(\d+[a-z]*)/i,
  chapter: /^\s*POGLAVJE\b/i,
  section: /^\s*ODDELEK\b/i,
  annex: /^PRILOGA(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^PRILOGA\s*([IVXLC]+|\d+)?/i,
  definition: /Opredelitve?/i,
  recital: /[Uu]vodni\s+del|[Uu]vodna\s+izjava/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "pomeni",
  definitionFormat: "term_first",
  titleSplit: /\s+z dne\s+/i,
  parliamentSplit: /\s+Evropskega parlamenta\b/i,
  eea: /Besedilo.*EGS/i,
  stopWords: [
    "in", "v", "na", "za", "od", "do", "po", "iz", "se", "je", "so", "bil",
    "ki", "da", "ne", "ali", "ter", "pa", "kot", "tudi",
    "člen", "odstavek", "točka", "priloga",
    "uredba", "direktiva", "odločba", "evropska", "komisija",
    "države", "članice", "unija",
  ],
};

const ET = {
  code: "ET",
  article: /Artikkel\s+(\d+[a-z]*)/i,
  chapter: /\bPEAT[U\u00dc]KK\b/i,
  section: /\bJAGU\b/i,
  annex: /^LISA(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^LISA\s*([IVXLC]+|\d+)?/i,
  definition: /M[o\u00f5]isted?/i,
  recital: /[Pp]õhjendus/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "t\u00e4hendab",
  definitionFormat: "term_first",
  titleSplit: /\s+\d+\.\s+/i,
  parliamentSplit: /\s+Euroopa Parlamendi\b/i,
  eea: /EMP-s kohaldatav tekst/i,
  stopWords: [
    "ja", "või", "aga", "et", "mis", "mille", "millel", "milline", "kellel",
    "on", "oli", "olid", "ei", "see", "need", "ka", "kuid", "ning",
    "artikkel", "lõige", "punkt", "lisa",
    "määrus", "direktiiv", "otsus", "euroopa", "komisjon",
    "liikmesriigid", "liit",
  ],
};

const LV = {
  code: "LV",
  article: /Pants\s+(\d+[a-z]*)/i,
  chapter: /\bNODA\u013cA\b/i,
  section: /\bIEDA\u013cA\b/i,
  annex: /^PIELIKUMS(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^PIELIKUMS\s*([IVXLC]+|\d+)?/i,
  definition: /Defin[i\u012b]cijas?/i,
  recital: /[Ap]psvērums|[Pp]reambulas\s+daļa/,
  quoteChars: "\u201C\u201D\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "noz\u012bm\u0113",
  definitionFormat: "term_first",
  titleSplit: /\s+gada\s+/i,
  parliamentSplit: /\s+Eiropas Parlamenta\b/i,
  eea: /EEZ noz\u012bm\u012bgs teksts/i,
  stopWords: [
    "un", "vai", "bet", "ka", "kas", "kura", "kuram", "ar", "no", "uz", "par",
    "ir", "bija", "nav", "ne", "arī", "taču", "tomēr",
    "pants", "punkts", "pielikums",
    "regula", "direktīva", "lēmums", "eiropas", "komisija",
    "dalībvalstis", "savienība",
  ],
};

const LT = {
  code: "LT",
  article: /Straipsnis\s+(\d+[a-z]*)/i,
  chapter: /\bSKYRIUS\b/i,
  section: /\bSKIRSNIS\b/i,
  annex: /^PRIEDAS?(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^PRIEDAS?\s*([IVXLC]+|\d+)?/i,
  definition: /Apibr\u0117\u017eim?ai/i,
  recital: /[Kk]onstatuojamoji\s+dalis|[Pp]reambul\u0117s\s+punktas/,
  quoteChars: "\u201E\u201C\u2018\u2019\u00AB\u00BB\"'",
  meansVerb: "rei\u0161kia",
  definitionFormat: "term_first",
  titleSplit: /\s+m\.\s+/i,
  parliamentSplit: /\s+Europos Parlamento\b/i,
  eea: /EEE svarbus tekstas/i,
  stopWords: [
    "ir", "arba", "bet", "kad", "kuris", "kuri", "kurie", "nuo", "iki", "per",
    "yra", "buvo", "ne", "taip", "tačiau", "taip pat",
    "straipsnis", "dalis", "punktas", "priedas",
    "reglamentas", "direktyva", "sprendimas", "europos", "komisija",
    "valstybės", "narės", "sąjunga",
  ],
};

const EL = {
  code: "EL",
  article: /\u0386\u03c1\u03b8\u03c1\u03bf\s+(\d+[a-z]*)/i,   // Άρθρο N
  chapter: /^\s*\u039a\u0395\u03a6\u0391\u039b\u0391\u0399\u039f\b/i,   // ΚΕΦΑΛΑΙΟ
  section: /^\s*\u03a4\u039c\u0397\u039c\u0391\b/i,   // ΤΜΗΜΑ
  annex: /^\u03a0\u0391\u03a1\u0391\u03a1\u03a4\u0397\u039c\u0391(\s+[IVXLC]+|\s+\d+)?/i,  // ΠΑΡΑΡΤΗΜΑ
  annexCapture: /^\u03a0\u0391\u03a1\u0391\u03a1\u03a4\u0397\u039c\u0391\s*([IVXLC]+|\d+)?/i,
  definition: /\u039f\u03c1\u03b9\u03c3\u03bc\u03bf[ί\u03af]/i,   // Ορισμοί
  recital: /\u03b1\u03b9\u03c4\u03b9\u03bf\u03bb\u03bf\u03b3\u03b9\u03ba\u03ae\s+\u03c3\u03ba\u03ad\u03c8\u03b7/,
  quoteChars: "\u00AB\u00BB\u2018\u2019\u201C\u201D\"'",
  meansVerb: "\u03bd\u03bf\u03b5\u03af\u03c4\u03b1\u03b9",  // νοείται
  definitionFormat: "term_first",
  titleSplit: /\s+\u03c4\u03b7\u03c2\s+/i,
  parliamentSplit: /\s+\u03c4\u03bf\u03c5 \u0395\u03c5\u03c1\u03c9\u03c0\u03b1\u03ca\u03ba\u03bf\u03cd \u039a\u03bf\u03b9\u03bd\u03bf\u03b2\u03bf\u03c5\u03bb\u03af\u03bf\u03c5\b/i,
  eea: /\u03a3\u03c7\u03b5\u03c4\u03b9\u03ba\u03cc.*\u0395\u039f\u03a7/i,
  stopWords: [
    "\u03ba\u03b1\u03b9", "\u03ae", "\u03b1\u03bb\u03bb\u03ac", "\u03b1\u03bd", "\u03cc\u03c4\u03b1\u03bd", "\u03cc\u03c4\u03b9",
    "\u03b5\u03af\u03bd\u03b1\u03b9", "\u03ae\u03c4\u03b1\u03bd", "\u03b5\u03c0\u03af\u03c3\u03b7\u03c2",
    "\u03ac\u03c1\u03b8\u03c1\u03bf", "\u03c0\u03b1\u03c1\u03ac\u03b3\u03c1\u03b1\u03c6\u03bf\u03c2", "\u03c3\u03c4\u03bf\u03b9\u03c7\u03b5\u03af\u03bf",
  ],
};

const MT = {
  code: "MT",
  article: /Artikolu\s+(\d+[a-z]*)/i,
  chapter: /^\s*KAPITOLU\b/i,
  section: /^\s*TAQSIMA\b/i,
  annex: /^ANNESS(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^ANNESS\s*([IVXLC]+|\d+)?/i,
  definition: /Definizzjonijiet?/i,
  recital: /[Kk]onsiderazzjonijiet?/,
  quoteChars: "\u2018\u2019\u201C\u201D\u00AB\u00BB\"'",
  meansVerb: "tfisser",
  definitionFormat: "term_first",
  titleSplit: /\s+ta'\s+/i,
  parliamentSplit: /\s+tal-Parlament Ewropew\b/i,
  eea: /Test.*\u017eEE/i,
  stopWords: [
    "u", "jew", "iżda", "li", "ta", "tal", "l", "fl", "f", "b", "minn", "għal",
    "huwa", "hija", "huma", "kien", "kienet", "kienu", "ma",
    "artikolu", "paragrafu", "punt", "anness",
    "regolament", "direttiva", "deċiżjoni", "ewropea", "kummissjoni",
    "stati", "membri", "unjoni",
  ],
};

const GA = {
  code: "GA",
  article: /Airteagal\s+(\d+[a-z]*)/i,
  chapter: /^\s*CAIBIDIL\b/i,
  section: /^\s*ROINN\b/i,
  annex: /^IARSCR[I\u00cd]BHINN(\s+[IVXLC]+|\s+\d+)?/i,
  annexCapture: /^IARSCR[I\u00cd]BHINN\s*([IVXLC]+|\d+)?/i,
  definition: /Sainmh[i\u00ed]nithe?/i,
  recital: /[Aa]imhr\u00e9asa|[Rr]achta\u00ed/,
  quoteChars: "\u2018\u2019\u201C\u201D\u00AB\u00BB\"'",
  meansVerb: "ciallaíonn",
  definitionFormat: "term_first",
  titleSplit: /\s+an\s+/i,
  parliamentSplit: /\s+Pharlaimint na hEorpa\b/i,
  eea: /Téacs.*LEE/i,
  stopWords: [
    "agus", "nó", "ach", "má", "go", "nach", "an", "na", "de", "do", "i",
    "ar", "faoi", "le", "tá", "bhí", "beidh", "nach", "níl",
    "airteagal", "mír", "pointe", "iarscríbhinn",
    "rialachán", "treoir", "cinneadh", "eorpach", "coimisiún",
    "ballstáit", "aontas",
  ],
};

// ---------------------------------------------------------------------------
// Language registry — add new languages here
// ---------------------------------------------------------------------------

const LANGUAGES = {
  EN, PL, DE, FR, ES, IT, PT, NL, DA, SV, FI, CS, SK, HU, RO,
  BG, HR, SL, ET, LV, LT, EL, MT, GA,
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect the document language from EUR-Lex metadata.
 *
 * Looks for (in order):
 *  1. <meta name="WT.z_usr_lan" content="XX">
 *  2. <p class="oj-hd-lg">XX</p>
 *
 * Returns the two-letter language code (e.g. "EN", "PL") or "EN" as fallback.
 */
export function detectLanguage(doc) {
  // 1. Meta tag
  const meta = doc.querySelector('meta[name="WT.z_usr_lan"]');
  if (meta) {
    const code = (meta.getAttribute("content") || "").trim().toUpperCase();
    if (code) return code;
  }

  // 2. OJ header language cell
  const lgEl = doc.querySelector("p.oj-hd-lg");
  if (lgEl) {
    const code = (lgEl.textContent || "").trim().toUpperCase();
    if (code) return code;
  }

  return "EN"; // default
}

/**
 * Return the language configuration for a given code.
 * Falls back to EN for unsupported languages.
 */
export function getLangConfig(code) {
  return LANGUAGES[code] || LANGUAGES.EN;
}

/**
 * The quote characters a definition term may be wrapped in, as the body of a
 * character class.
 *
 * On top of each language's own quoteChars this admits three marks everywhere:
 * the backtick, which the pre-1999 Official Journal HTML renderer used as the
 * opening quote in every language (`distance contract\' in Directive 97/7/EC),
 * and the low quotes U+201E/U+201A, which several configs list and several
 * others (NL, notably) omit even though the rendered text uses them. None of
 * the three appears in running legal text, so admitting them costs nothing and
 * spares the per-language audit.
 */
function quoteCharClass(lang) {
  return `${lang.quoteChars}\u0060\u201E\u201A`;
}

/**
 * Body pattern for a quote-delimited term: any character that is not a quote
 * character, OR a straight/typographic apostrophe standing directly between
 * two letters.
 *
 * French, Italian and other Romance languages elide a short word before a
 * vowel with an apostrophe -- "d'origine", "l'Etat", "all'ingrosso" -- using
 * the very same glyph (U+0027 / U+2019) their quoteChars list as a
 * quotation mark. A plain negated class ([^q]+) reads that elision
 * apostrophe as the term's closing quote and truncates the term mid-word
 * ("Etat membre d'origine" -> "Etat membre d"). A genuine closing quote is
 * never immediately followed by a letter -- the meansVerb or a separator
 * always intervenes -- so treating a letter-apostrophe-letter run as term
 * text is safe everywhere the negated class is already used: the lookaround
 * only fires when both neighbours are letters, so it can never swallow a
 * true closing quote. Requires the "u" regex flag (uses \p{L}).
 */
function termBody(q) {
  return `(?:[^${q}]|(?<=\\p{L})['\u2019](?=\\p{L}))`;
}

/**
 * Build the "means" regex for definition extraction from the language config.
 *
 * Two formats:
 *  - term_first: 'term' means/bezeichnet/oznacza ...  (default)
 *  - verb_first: entend par 'term' / si intende per 'term'  (FR, IT, ES, PT)
 *
 * Capture group 1 = the term text (without quotes).
 */
export function buildMeansRegex(lang) {
  const q = quoteCharClass(lang);
  // Several languages spell meansVerb as an alternation ("wordt verstaan|
  // verstaat men"). Interpolated bare, that alternation would swallow the
  // whole pattern — the anchor and the term group would bind to the first
  // branch only, so a later branch could match anywhere in the item and
  // leave capture group 1 undefined. Always group it.
  const verb = `(?:${lang.meansVerb})`;
  if (lang.definitionFormat === "verb_first") {
    // "meansVerb [q]term[q]" — term comes AFTER the verb
    return new RegExp(`^${verb}\\s+[${q}](${termBody(q)}+)[${q}]`, "iu");
  }
  // Default: "'term' meansVerb definition"
  //
  // The term is matched lazily rather than as a run of non-quote characters
  // because the apostrophe is itself a quote character in several languages:
  // "'the data subject's consent' shall mean …" would otherwise define "the
  // data subject". Requiring the verb right after the closing quote is what
  // keeps the lazy match honest — it reopens on "subject's" and settles on the
  // quote that the verb actually follows.
  //
  // Older acts also gloss a short alias between the term and the verb
  // ("'processing of personal data' ('processing') shall mean …"); that
  // parenthetical is consumed so it lands in neither the term nor the
  // definition.
  // The trailing punctuation covers "'health and safety' means, in relation
  // to a recipient, …" and "'main establishment' means: (a) … (b) …" — without
  // it the verb is left glued to the definition, or the item is missed.
  //
  // The tail ends on `\\s+|$` rather than plain `\\s+` so that an item whose
  // definition lives in the *following* paragraphs still matches here, with an
  // empty group 2: "(4) 'night worker' means:" followed by (a)/(b) sub-points.
  // Alternation keeps the word boundary that a bare `\\s*` would drop.
  return new RegExp(`^[${q}](.+?)[${q}]\\s*(?:\\([^)]*\\)\\s*)?${verb}\\s*[:,]?(?:\\s+|$)`, "i");
}

/**
 * Build an *unanchored* definition regex, for prose that packs several
 * definitions into one paragraph instead of one lettered point each:
 *
 *   For the purpose of this Directive 'product' means all movables …
 *   'Primary agricultural products' means the products of the soil …
 *
 * (Directive 85/374/EEC, Article 2 — a shape that only occurs in the older,
 * pre-Formex acts.)
 *
 * Unlike buildMeansRegex this may match mid-string, so it *requires* the
 * quote characters around the term: an unquoted `(.+?) means (.+)` would
 * happily split on the "means" in "the purposes and means of the processing"
 * and yield a sentence fragment as the term. Returns a global RegExp with
 * capture group 1 = the term text; callers read `.index`/`[0].length` to
 * slice out the definition that follows.
 */
export function buildInlineDefRegex(lang) {
  const q = quoteCharClass(lang);
  const verb = `(?:${lang.meansVerb})`;
  if (lang.definitionFormat === "verb_first") {
    return new RegExp(`${verb}\\s+[${q}](${termBody(q)}+)[${q}]\\s*`, "giu");
  }
  return new RegExp(`[${q}](${termBody(q)}+)[${q}]\\s+${verb}\\s+`, "giu");
}

/**
 * Build a fallback regex for definition extraction.
 *
 * Used when buildMeansRegex() produces no match, which happens whenever the
 * translated regulation does NOT repeat the "means" verb in each definition
 * item — only in the article-level intro.  In those cases the items are
 * formatted as one of:
 *
 *   'term': definition          (FR, NL, DA, HU, EL — colon separator)
 *   'term' – definition         (ET — en-dash separator)
 *   'term' definition           (DE, CS, FI, SK — direct juxtaposition)
 *   'term' ir/sú definition     (LV, SK — copula verb)
 *
 * For Lithuanian (LT) and Swedish (SV), the EU Publications Office omits
 * QUOT.START/QUOT.END elements entirely.  Items look like:
 *
 *   term – definition           (LT — en-dash)
 *   term : definition           (SV — colon)
 *
 * The function returns a RegExp with capture group 1 = the term text.
 * It also consumes any trailing separator so that the remainder of the
 * string is the definition.
 */
export function buildFallbackDefRegex(lang) {
  const q = quoteCharClass(lang);

  // For LT and SV the term is NOT wrapped in QUOT markers.  Detect them by
  // code so we don't need to add per-language flags.
  if (lang.code === "LT") {
    // term – definition  (en-dash U+2013)
    return /^(.+?)\s*\u2013\s+/;
  }
  if (lang.code === "SV") {
    // term : definition
    return /^(.+?)\s*:\s+/;
  }

  // All other languages: term is surrounded by quote characters from quoteChars.
  // After the closing quote there may be: colon, en-dash (–), comma, or nothing.
  return new RegExp(
    `^[${q}](${termBody(q)}+)[${q}]\\s*[:\\u2013\\u2014,]?\\s*`,
    "iu"
  );
}

/**
 * Build a regex for the *unquoted* colon shape, where the term carries no
 * quotation marks at all and the colon is the only separator:
 *
 *   1. Proprietary medicinal product: Any ready-prepared medicinal product …
 *   (a) consumer: shall mean any natural person who …
 *
 * (Directives 2001/83/EC and 1999/44/EC.) This is the loosest shape we accept
 * and it cannot be told apart from ordinary prose by pattern alone — "(a)
 * Member States shall ensure that: …" fits it just as well. The pattern is
 * therefore deliberately narrow (no sentence punctuation inside the term, and
 * see the caller for the word-count and corroboration limits), and callers must
 * only offer it text that is already a numbered or lettered point.
 *
 * Capture group 1 = the term text; the trailing meansVerb, when the drafting
 * repeats it after the colon, is consumed.
 */
export function buildColonDefRegex(lang) {
  return new RegExp(`^([^:;.,\\u2013\\u2014]{2,60}?)\\s*:\\s*(?:(?:${lang.meansVerb})\\s*,?\\s+)?(?=\\S)`, "i");
}

/**
 * Return the combined stop-words set for a language.
 * Includes both English baseline terms and language-specific ones.
 */
export function getStopWords(langCode) {
  const lang = LANGUAGES[langCode];
  if (!lang || langCode === "EN") {
    return new Set(EN.stopWords);
  }
  // Merge English + target language
  return new Set([...EN.stopWords, ...lang.stopWords]);
}

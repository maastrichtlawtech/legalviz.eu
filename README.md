# LegalViz.EU

<p align="center">
  <img src="public/wizard.png" alt="LegalViz Wizard" height="128">
</p>

An interactive reader for EU legislation. Search for any EU law, navigate its structure, and understand how articles, recitals, and definitions connect — all in the browser or from the command line.

Built by [Konrad Kollnig](https://kollnig.net) at the [Law & Tech Lab, Maastricht University](https://www.maastrichtuniversity.nl/law-tech-lab).

**[Open LegalViz.EU](https://legalviz.eu)**

## Features

**Read** — Collapsible table of contents, grid-based recitals viewer, annexes browser, side-by-side dual-language reading in all 24 official EU languages, dark mode, and responsive layout for desktop and mobile.

**Search** — Instant full-text search across articles, recitals, and annexes. Press `Cmd+K` / `Ctrl+K` to jump to any section. Deep links update as you navigate so you can share exact locations.

**Understand context** — Client-side TF-IDF analysis links related recitals to articles automatically and displays AI-generated short recital titles where available. Defined terms (e.g. "online platform") are highlighted with their legal definition on hover. Cross-law references — including pre-2004 references like "Directive 95/46/EC" — are parsed, resolved to CELEX, and linked across acts.

**CJEU case law** — Every law pulls in the judgments that cite it, parsed from EUR-Lex (including older pre-2004 and Curia HTML formats) into structured article references. Cases that cite the article you're reading are surfaced beside it, with the operative part, a link back to EUR-Lex, and cached article-level digests where available.

**Static overviews** — Optional AI-generated law summaries are computed once, cached, and rendered as article-cited overviews above the reader. No model call is made while reading a warm cache.

**Export** — Print or save to PDF with selectable sections (articles, recitals, annexes) and optional inline recitals next to articles.

## How to Use

Go to [legalviz.eu](https://legalviz.eu) and search for any EU law by name, reference, or CELEX number. The app fetches the Formex XML source from EUR-Lex, parses it, and renders it for reading. Metadata for opened laws is cached locally so they load instantly on return.

## Working with EU Law Data

Beyond the web app, this repository includes tools for anyone who wants to work with EU legislation as structured data — useful for legal research, automated analysis, or building your own applications on top of EU law.

The `eurlex` command-line tool lets you download any EU law and get it back as clean, structured JSON instead of raw XML. You can look up metadata (entry into force, amendments, implementing acts), search across legislation by keyword, or resolve a legal reference like "Regulation 2016/679" to its official identifier. A REST API provides the same functionality over HTTP, so you can integrate it into scripts in any language.

A few examples:

```bash
# Download the GDPR as structured JSON
eurlex get 32016R0679

# Get the AI Act in German
eurlex get 32024R1689 --lang DEU

# Find legislation about artificial intelligence
eurlex search "artificial intelligence"

# Look up what amended the GDPR
eurlex amendments 32016R0679

# Resolve a human-readable reference to a CELEX ID
eurlex resolve "Regulation 2016/679"
```

See the [full documentation](backend/README.md) for installation and all available commands.

## For Developers

### Setup

Requires Node.js v24+.

```bash
git clone https://github.com/maastrichtlawtech/eur-lex-visualiser.git
cd eur-lex-visualiser
npm install
npm run dev          # frontend on http://localhost:5173
```

### Project Structure

```
legalviz.eu/
├── src/
│   ├── components/        # React components (LawViewer, TopBar, Landing, …)
│   ├── utils/             # Formex parser, NLP/search, routing, API client
│   ├── hooks/             # Custom React hooks
│   ├── i18n/              # Internationalization
│   ├── App.jsx            # Router and layout
│   └── main.jsx           # Entry point
├── backend/               # REST API & eurlex CLI (see backend/README.md)
├── extension/             # Browser extension (Chrome & Firefox)
├── scripts/               # Build & utility scripts
└── public/                # Static assets
```

### Tech Stack

React 19, React Router 7, Vite, Tailwind CSS 4, Framer Motion, Lucide React, Express (API).

### How It Works

The app fetches Formex XML for a given CELEX identifier (falling back to EUR-Lex HTML for laws without FMX) and parses it into articles, chapters, recitals, definitions, annexes, and cross-references — the same parser powers the web app, the REST API, and the CLI. The client builds an inverted index for full-text search and runs a TF-IDF module to link recitals to relevant articles. CJEU judgments are fetched via SPARQL, their operative parts parsed, and their article references structured so the viewer can show "cases citing this article". Optional AI features use OpenRouter only on cache misses: recital titles, law overviews, and article case-law digests are generated once, validated, and cached. The current view is synced to the URL so every position is bookmarkable.

## Contributing

Contributions are welcome. Please open an issue first for major changes.

## License

GPLv3.0 — see [LICENSE](LICENSE).

## Credits

Built by **Konrad Kollnig** at the **Law & Tech Lab, Maastricht University**. Contact: [eu-law@trackercontrol.org](mailto:eu-law@trackercontrol.org).

This project uses legal documents from EUR-Lex, the official database of EU law.

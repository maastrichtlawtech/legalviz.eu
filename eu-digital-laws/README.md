# EU Digital Laws

An interactive overview of EU legislation in the digital sector — an
interactive take on Kai Zenner's ["Green Wall"](https://www.kaizenner.eu/),
built on the CEPS dataset and integrated with [LegalViz](https://legalviz.eu).

The EU's digital acquis spans roughly 196 legislative initiatives — adopted
laws, pending proposals, and announced plans — across twelve policy areas,
from data governance and cybersecurity to platforms and digital justice. The
famous "Green Wall" poster maps them all on a single page. This project makes
that map explorable: filter by status and policy area, open any law to see
what it is, and jump straight into its full text in the LegalViz reader.

## How it fits together

- **Dataset**: a normalized JSON derived from the CEPS "Digital Laws" tables
  (statuses, official references, impact assessments, evaluation clauses,
  governance bodies), with official references resolved to CELEX identifiers.
  The one-off converter lives in this repo so future dataset releases can be
  re-imported; the committed JSON is the source of truth for the site.
- **Site**: a fully static Vite + React app, deployed to GitHub Pages.
- **LegalViz integration**: each law deep-links into the
  [LegalViz](https://legalviz.eu) reader by CELEX id, and the detail view
  enriches laws on demand via the open [LegalViz API](https://api.legalviz.eu)
  (summaries, in-force status, case law).

## Development

```bash
pnpm install
pnpm dev       # local dev server
pnpm test      # unit tests
pnpm build     # static production build in dist/
```

## Data source & attribution

The underlying dataset is © CEPS 2026, free to use, modify, and redistribute
with attribution:

> Zenner, K. and Marcus, J.S. (2026), "A dataset of EU legal and policy
> instruments for the digital world", CEPS.

Earlier iterations of the dataset were hosted by Bruegel. This project is not
endorsed by CEPS. All views expressed are the authors' own.

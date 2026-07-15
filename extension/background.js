const LEGALVIZ_HOME = 'https://legalviz.eu/';

function getTargetUrl(pageUrl) {
  try {
    const sourceUrl = new URL(pageUrl);
    if (sourceUrl.hostname !== 'eur-lex.europa.eu') return LEGALVIZ_HOME;

    const importUrl = new URL('/import', LEGALVIZ_HOME);
    importUrl.searchParams.set('sourceUrl', sourceUrl.href);
    return importUrl.href;
  } catch {
    return LEGALVIZ_HOME;
  }
}

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: getTargetUrl(tab?.url) });
});

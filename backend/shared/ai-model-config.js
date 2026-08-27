function resolveRecitalTitleModel() {
  return process.env.RECITAL_TITLE_MODEL
    || process.env.ARTICLE_QA_PLANNER_MODEL
    || process.env.ARTICLE_QA_MODEL
    || 'google/gemini-3.5-flash-lite';
}

function getRecitalTitleApiKey() {
  return process.env.RECITAL_TITLE_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
}

module.exports = {
  resolveRecitalTitleModel,
  getRecitalTitleApiKey,
};

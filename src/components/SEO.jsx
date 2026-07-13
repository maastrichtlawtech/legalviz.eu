import { useI18n } from "../i18n/useI18n.js";

export function SEO({ 
  title, 
  description, 
  keywords, 
  canonical,
  alternates = [],
  type = 'website',
  image = '/preview.png'
}) {
  const { t } = useI18n();
  const siteTitle = t("app.name");
  const fullTitle = title ? `${title} | ${siteTitle}` : siteTitle;
  const metaDescription = description || t("seo.defaultDescription");
  const metaKeywords = keywords || t("seo.defaultKeywords");
  const siteUrl = 'https://legalviz.eu';
  const currentUrl = canonical
    || (typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : siteUrl);
  const imageUrl = image.startsWith('http') ? image : `${siteUrl}${image}`;

  return (
    <>
      <title>{fullTitle}</title>
      <meta name="description" content={metaDescription} />
      <meta name="keywords" content={metaKeywords} />
      <link rel="canonical" href={currentUrl} />
      {alternates.map((alternate) => (
        <link key={alternate.hrefLang} rel="alternate" hrefLang={alternate.hrefLang} href={alternate.href} />
      ))}

      {/* Open Graph / Facebook */}
      <meta property="og:type" content={type} />
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={metaDescription} />
      <meta property="og:url" content={currentUrl} />
      <meta property="og:image" content={imageUrl} />
      <meta property="og:site_name" content={siteTitle} />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={metaDescription} />
      <meta name="twitter:image" content={imageUrl} />
    </>
  );
}

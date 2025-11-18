export default function Head() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "Sliptail",
            "url": "https://sliptail.com",
            "logo": "https://sliptail.com/icon.png",
            "description":
              "Sliptail is a creator platform where creators sell memberships, digital downloads, and custom requests.",
            "sameAs": [
              "https://www.instagram.com/sliptail_",
              "https://www.tiktok.com/@sliptail_",
            ],
          }),
        }}
      />
    </>
  );
}
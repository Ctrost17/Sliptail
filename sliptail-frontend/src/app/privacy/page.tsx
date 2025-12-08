// app/privacy/page.tsx
import Link from "next/link";

export const metadata = {
  title: "Privacy Policy | Sliptail",
  description:
    "Privacy Policy for Sliptail — how we collect, use, share, and protect your information.",
};

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 py-10">
      <div className="mx-auto max-w-4xl px-4">
        <div className="rounded-2xl bg-white p-6 shadow-xl md:p-10">
          <header className="mb-8">
            <h1 className="text-3xl font-bold text-black md:text-4xl">Privacy Policy</h1>
            <p className="mt-2 text-sm text-neutral-600">Last updated: October 12, 2025</p>
            <div className="mt-4 flex gap-3">
              <Link
                href="/terms"
                className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-semibold transition
                border border-black/10 shadow-sm focus:outline-none focus:ring-2 focus:ring-black/30
                bg-black text-white md:bg-white md:text-black md:hover:bg-black md:hover:text-white"
              >
                Terms of Use
              </Link>
            </div>
          </header>

          <section className="prose prose-neutral max-w-none text-black">
            <p>
              This Privacy Policy explains how Sliptail (“<strong>Sliptail</strong>,” “<strong>we</strong>,”
              “<strong>us</strong>,” or “<strong>our</strong>”) collects, uses, shares, and protects information
              about users of our platform, including creators who sell Requests, Memberships, and digital downloads,
              and customers who purchase them (collectively, “<strong>Services</strong>”).
              By using our Services, you agree to the practices described here and in our{" "}
              <Link href="/terms">Terms of Use</Link>.
            </p>

            <h2>1) Who we are & contact</h2>
            <p>
              Sliptail is the controller of personal information processed in connection with the Services, except
              where we act as a service provider/processor for creators or where third parties (e.g., Stripe) act as
              independent controllers. Questions? Email <a href="mailto:info@sliptail.com">info@sliptail.com</a>.
            </p>

            <h2>2) Information we collect</h2>
            <ul>
              <li>
                <strong>Account & profile data:</strong> name, email, username/handle, password hashes, profile image,
                bio, categories, linked social handles you provide.
              </li>
              <li>
                <strong>Transaction & payout data:</strong> purchase history, product details, prices, currency,
                refunds/chargebacks/disputes, payout metadata (via Stripe Connect). <em>Note:</em> payment card details
                and creator KYC (identity documents, SSN/EIN, bank account numbers) are collected and processed by{" "}
                <strong>Stripe</strong> directly and not stored by Sliptail.
              </li>
              <li>
                <strong>Content & activity:</strong> posts, messages, requests, uploads, membership access, download
                counts, feed interactions.
              </li>
              <li>
                <strong>Device & usage data:</strong> IP address, device/browser type, OS, language, referral URLs,
                pages viewed, links clicked, session timestamps, and similar analytics.
              </li>
              <li>
                <strong>Communications:</strong> support emails, notifications preferences, marketing opt-ins/opt-outs.
              </li>
              <li>
                <strong>Cookies & similar technologies:</strong> Cookies/SDKs for authentication, preferences, security,
                analytics, and (if enabled) marketing attribution. See “Cookies” below.
              </li>
            </ul>

            <h2>3) Sources of information</h2>
            <p>
              We collect information directly from you, automatically from your device/use of the Services, and from
              third parties such as Stripe (payments/payouts), analytics providers, fraud-prevention services, and (if
              applicable) social/media platforms you connect.
            </p>

            <h2>4) How we use information</h2>
            <ul>
              <li>Provide, operate, secure, and troubleshoot the Services.</li>
              <li>Process payments via Stripe and make creator payouts via Stripe Connect.</li>
              <li>Authenticate users; maintain accounts; deliver purchases, memberships, and requests.</li>
              <li>Prevent fraud, abuse, violations of our Terms, illegal content leaks, and activity that violates Stripe’s policies or risk controls..</li>
              <li>Comply with legal obligations and enforce agreements.</li>
              <li>Analyze usage to improve features, performance, and support.</li>
              <li>Send transactional emails (e.g., receipts, access notices) and, with consent, marketing messages.</li>
            </ul>

            <h2>5) Legal bases (EEA/UK users)</h2>
            <p>
              Where applicable, we rely on: (a) <strong>contract</strong> (to provide the Services); (b){" "}
              <strong>legitimate interests</strong> (e.g., security, product improvement, anti-fraud); (c){" "}
              <strong>consent</strong> (e.g., marketing cookies/emails where required); and (d){" "}
              <strong>legal obligation</strong> (e.g., tax/records).
            </p>

            <h2>6) How we share information</h2>
            <ul>
              <li>
                <strong>With creators and customers:</strong> We share what is necessary to fulfill purchases and
                requests (e.g., order details, usernames).
              </li>
              <li>
                <strong>Service providers:</strong> Hosting/CDN, analytics, logging, error monitoring, email delivery,
                customer support tools, and payment/payout processing (<strong>Stripe</strong>). These providers are
                bound by contractual obligations to protect your data and use it only on our instructions. For payment processing, Stripe acts as an independent controller of certain personal data (such as payment method details and identity verification information) in accordance with its own privacy policy. Sliptail does not have access to full card numbers or creator KYC documents.
              </li>
              <li>
                <strong>Compliance & safety:</strong> To comply with law, respond to legal process, enforce our Terms,
                protect rights, property, and safety, investigate fraud or leaks, comply with Stripe’s platform requirements, and address security incidents.
              </li>
              <li>
                <strong>Business transfers:</strong> In a merger, acquisition, financing, or sale of assets, data may
                be transferred as part of the transaction, subject to this Policy.
              </li>
            </ul>

            <h2>7) Cookies & analytics</h2>
            <p>
              We use essential cookies for login, security, and core functionality; and (optionally) analytics cookies
              (e.g., page views, device stats) to improve the product. Where required, we obtain consent for
              non-essential cookies. You can usually manage cookies via your browser settings. If you implement a
              cookie banner/preferences, link it here (e.g., “Cookie Settings”).
            </p>

            <h2>8) Data retention</h2>
            <p>
              We keep personal data for as long as necessary to provide the Services and for legitimate business needs
              (e.g., accounting, security, dispute resolution), then delete or anonymize it. Exact retention depends on
              the type of data and applicable laws.
            </p>

            <h2>9) Security</h2>
            <p>
              We employ administrative, technical, and physical safeguards designed to protect personal data. No system
              is perfectly secure; you are responsible for maintaining the confidentiality of your credentials and
              promptly notifying us of any suspected compromise.
            </p>

            <h2>10) International data transfers</h2>
            <p>
              We may transfer, store, and process information in countries other than where you live. Where required, we
              use appropriate safeguards (e.g., Standard Contractual Clauses) for transfers of personal data.
            </p>

            <h2>11) Your rights</h2>
            <ul>
              <li>
                <strong>EEA/UK:</strong> You can request access, correction, deletion, restriction, portability, and
                object to processing (including to profiling for direct marketing). Where we rely on consent, you may
                withdraw it at any time.
              </li>
              <li>
                <strong>US (e.g., CA/VA/CO/CT/UT):</strong> Subject to law, you may request access, deletion, correction,
                and opt-out of “sale”/“sharing”/targeted advertising (as defined by state law). We do not sell personal
                information for money. If analytics/ads are considered “sharing,” you may opt out via browser or cookie
                settings. You will not be discriminated against for exercising rights.
              </li>
            </ul>
            <p>
              To exercise rights, email <a href="mailto:info@sliptail.com">info@sliptail.com</a>. We may need to verify
              your identity and we will respond as required by law. Authorized agents may submit requests where
              permitted, subject to verification.
            </p>

            <h2>12) Children’s privacy</h2>
            <p>
              The Services are not intended for children under 13, and we do not knowingly collect personal information
              from them. If you believe a child provided personal information, contact{" "}
              <a href="mailto:info@sliptail.com">info@sliptail.com</a> and we will take appropriate action.
            </p>

            <h2>13) Creator responsibilities</h2>
            <p>
              Creators are independent sellers responsible for their own content and compliance (e.g., consumer,
              marketing, tax, and IP laws). Stripe may collect identity and payout information directly from creators
              per Stripe’s terms. If you reuse customer data for purposes beyond fulfilling sales on Sliptail, you
              act as an independent controller and must provide your own privacy disclosures and lawful basis.
            </p>

            <h2>14) Anti-leak & enforcement cooperation</h2>
            <p>
              We may retain and disclose limited transactional data (e.g., purchase timestamps, usernames, IP logs) to
              facilitate creators’ lawful enforcement against unauthorized redistribution, consistent with this Policy
              and applicable law. We may share relevant information with Stripe, law enforcement, or regulators when reasonably necessary to investigate fraud, enforce our Terms, comply with Stripe’s platform requirements, or respond to legal requests. See also our <Link href="/terms">Terms of Use</Link>.
            </p>

            <h2>15) Communications</h2>
            <p>
              We send transactional emails (e.g., receipts, password resets, access notices). With consent (if
              required), we may send marketing communications; you can opt out via the email footer or by contacting us.
              Note that critical transactional messages will still be sent.
            </p>

            <h2>16) Changes to this Policy</h2>
            <p>
              We may update this Policy to reflect changes in our practices or legal requirements. We will post the new
              effective date and, where appropriate, notify you via the Services or email. Your continued use after the
              effective date constitutes acceptance of the updated Policy.
            </p>

            <h2>17) Contact</h2>
            <p>
              Questions or requests about this Policy? Email{" "}
              <a href="mailto:info@sliptail.com">info@sliptail.com</a>.
            </p>

            <hr />
            <p className="text-xs text-neutral-600">
              <strong>Disclaimer:</strong> This document is provided for general informational purposes only and does
              not constitute legal advice. Laws vary by jurisdiction. You should have a qualified attorney review and
              tailor this Policy (and your data-handling practices) to your specific operations, including any use of
              analytics/ads, regional privacy laws (e.g., GDPR/UK GDPR, CPRA), and creator categories.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

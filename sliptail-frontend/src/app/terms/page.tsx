// app/terms/page.tsx
import Link from "next/link";

export const metadata = {
  title: "Terms of Use | Sliptail",
  description:
    "Terms of Use for Sliptail - a platform where creators sell requests, memberships, and digital downloads. Please read carefully.",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 py-10">
      <div className="mx-auto max-w-4xl px-4">
        <div className="rounded-2xl bg-white p-6 shadow-xl md:p-10">
          <header className="mb-8">
            <h1 className="text-3xl font-bold text-black md:text-4xl">Terms of Use</h1>
            <p className="mt-2 text-sm text-neutral-600">
              Last updated: December 8, 2025
            </p>
            <div className="mt-4">
              <Link
                href="/privacy"
                className="inline-flex items-center rounded-lg px-4 py-2 text-sm font-semibold transition
                border border-black/10 shadow-sm focus:outline-none focus:ring-2 focus:ring-black/30
                bg-black text-white md:bg-white md:text-black md:hover:bg-black md:hover:text-white"
              >
                Privacy Policy
              </Link>
            </div>
          </header>

          <section className="prose prose-neutral max-w-none text-black">
            <p>
              These Terms of Use (<strong>Terms</strong>) govern your access to and use
              of the Sliptail website, applications, and services (collectively,{" "}
              <strong>Sliptail</strong>, <strong>we</strong>, <strong>us</strong>, or{" "}
              <strong>our</strong>). Sliptail is a platform that enables creators (
              <strong>Creators</strong>) to sell (a) <strong>Requests</strong>{" "}
              (personalized content), (b) <strong>Memberships</strong> (recurring access
              to a private feed), and (c) <strong>Purchases</strong> (downloadable
              digital items) directly to customers (<strong>Users</strong>). By using
              Sliptail, you agree to these Terms and to any policies referenced here
              (including our Privacy Policy). If you do not agree, do not use Sliptail.
            </p>

            <h2>1) What Sliptail is</h2>
            <p>
              Sliptail provides technology that allows Creators to list, market, sell,
              and deliver Creator content (<strong>Creator Content</strong>) to Users.
              Sliptail is not the seller of Creator Content. Each Creator is an
              independent seller and is solely responsible for their content, pricing,
              timelines, and compliance with applicable laws.
            </p>
            <p>
              Payments are processed by <strong>Stripe</strong>, and payouts to Creators
              are facilitated via <strong>Stripe Connect</strong>, which requires
              Creators to complete Stripe onboarding, identity verification, and ongoing
              compliance. Sliptail is not a party to the contract between Creator and
              User and does not guarantee the quality, legality, or availability of any
              Creator Content.
            </p>

            <h2>2) Eligibility and accounts</h2>
            <ul>
              <li>
                You must be at least 13 years old (or the minimum age required in your
                jurisdiction) to use Sliptail. If you are under 18, you represent that
                you have consent from a parent or guardian and will use Sliptail under
                their supervision.
              </li>
              <li>
                You agree to provide accurate information, keep your credentials secure,
                and be responsible for all activity on your account. We may suspend or
                terminate accounts that violate these Terms, Stripe requirements, or
                applicable law, or that pose risk or abuse to the platform.
              </li>
            </ul>

            <h2>3) Creator accounts, payouts and taxes</h2>
            <ul>
              <li>
                <strong>Stripe Connect:</strong> Creators must onboard to Stripe
                Connect and agree to Stripe&apos;s applicable terms (including the{" "}
                <em>Stripe Services Agreement</em> and <em>Connect Platform Agreements</em>).
                Stripe may require identity verification, bank details, and other
                information. Payouts are made by Stripe to the Creator&apos;s linked
                account, subject to Stripe&apos;s schedules, reserves, and compliance
                holds.
              </li>
              <li>
                <strong>Platform fees:</strong> Sliptail charges a platform fee of{" "}
                <strong>4%</strong> on Creator sales (plus Stripe fees and applicable
                taxes). We may change platform fees prospectively with notice.
              </li>
              <li>
                <strong>Chargebacks and refunds:</strong> Creators bear the economic
                risk of chargebacks, refunds, disputes, and payment reversals related to
                their sales. Sliptail may offset chargebacks, refunds, fees, and
                penalties from future Creator payouts.
              </li>
              <li>
                <strong>Taxes:</strong> Creators are responsible for assessing,
                collecting (where required), and remitting all applicable taxes
                (including VAT, GST, and sales tax) on their sales. Creators are also
                responsible for their own income tax obligations. Stripe may issue
                informational tax forms (for example, 1099-K) where required by law.
              </li>
            </ul>

            <h2>4) Users - purchases, memberships and requests</h2>
            <ul>
              <li>
                <strong>Purchases:</strong> When you buy a downloadable item, the
                Creator grants you a personal, non-exclusive, non-transferable,
                revocable license to access and use the file for your own
                non-commercial use, unless the Creator expressly grants broader rights
                in writing.
              </li>
              <li>
                <strong>Memberships:</strong> When you subscribe to a membership, you
                receive access to a private feed for the membership term. If you
                cancel, your access continues through the end of the current paid
                period. Creators may post, edit, or remove content at their discretion.
              </li>
              <li>
                <strong>Requests:</strong> Personalized content is produced at the
                Creator&apos;s discretion and subject to feasibility and the Creator&apos;s
                content policies. Timeframes are not guaranteed unless explicitly
                stated by the Creator.
              </li>
              <li>
                <strong>No redistribution:</strong> Users may not share, resell,
                publicly post, livestream, record, screen capture, or otherwise
                redistribute Creator Content without the Creator&apos;s prior written
                permission.
              </li>
            </ul>

            <h2>5) Refunds and support</h2>
            <p>
              Support is available at{" "}
              <a href="mailto:info@sliptail.com">info@sliptail.com</a>. Sliptail uses
              an item-type based refund policy:
            </p>
            <ul>
              <li>
                <strong>Custom Requests:</strong> Refunds are automatically issued only
                if the Creator declines the request. If declined, the User receives a
                refund for the request amount (minus non-refundable Stripe processing
                fees) back to the original payment method. Refund completion times vary
                by bank and typically take 3 to 10 business days (up to 14 days
                internationally). If a request is accepted or completed by the Creator,
                the sale is final.
              </li>
              <li>
                <strong>Digital Downloads:</strong> Due to instant access and the
                irreversible nature of digital goods, download purchases are{" "}
                <strong>non-refundable</strong> once delivered, except where required
                by law.
              </li>
              <li>
                <strong>Memberships:</strong> Membership charges are{" "}
                <strong>non-refundable</strong> once billing occurs. Users may cancel
                at any time, and access continues through the remainder of the paid
                period.
              </li>
            </ul>
            <p>
              Sliptail may intervene or issue refunds only when legally required or in
              cases of fraud, abuse, or platform misuse. Chargebacks, disputes, and
              fraudulent activity may result in account suspension, withheld payouts,
              and additional review.
            </p>

            <h2>6) Intellectual property, anti-leak and enforcement</h2>
            <ul>
              <li>
                <strong>Ownership:</strong> Creators retain all rights in their content,
                subject to the limited licenses granted to Users for personal use under
                these Terms.
              </li>
              <li>
                <strong>User license:</strong> Users receive a limited, revocable,
                non-exclusive, non-transferable license solely for personal use, unless
                the Creator expressly grants broader rights in writing.
              </li>
              <li>
                <strong>Anti-leak:</strong> Any sharing, posting, re-uploading, public
                performance, public display, or distribution of Creator Content without
                permission is strictly prohibited. Creators may pursue legal remedies,
                including injunctive relief, damages, and attorneys&apos; fees where
                permitted by law. Sliptail may provide reasonable cooperation (for
                example, basic transaction records) to Creators seeking to enforce
                their rights, consistent with our Privacy Policy and applicable law.
              </li>
              <li>
                <strong>Watermarking and monitoring:</strong> Creators may use
                watermarks or other markers. Sliptail may employ technical and manual
                measures to detect abuse (subject to our Privacy Policy and applicable
                law) and may suspend or terminate accounts associated with leaks or
                misuse.
              </li>
              <li>
                <strong>DMCA:</strong> If you believe content infringes your copyright,
                send a notice to{" "}
                <a href="mailto:info@sliptail.com">info@sliptail.com</a> with: (i) your
                contact information; (ii) a description of the work; (iii) the URL of
                the allegedly infringing material; (iv) a statement under penalty of
                perjury that you have a good-faith belief that the use is unauthorized;
                (v) a statement that your notice is accurate and you are authorized to
                act; and (vi) a physical or electronic signature. We may remove content
                and, where appropriate, terminate repeat infringers.
              </li>
            </ul>

            <h2>7) Acceptable use and prohibited content</h2>
            <p>You agree not to, and not to allow others to, use Sliptail to:</p>
            <ul>
              <li>
                Violate any law, rule, or regulation, or post illegal, defamatory,
                fraudulent, hateful, harassing, exploitative, or pornographic material,
                or content depicting minors or non-consensual activity.
              </li>
              <li>
                Infringe intellectual property, privacy, or publicity rights, or
                disclose others&apos; personal data without consent.
              </li>
              <li>
                Circumvent access controls, copy or scrape content at scale, reverse
                engineer, probe, or interfere with the platform&apos;s security or
                normal operation.
              </li>
              <li>
                Engage in spamming, scams, impersonation, deceptive conduct, or
                financial fraud.
              </li>
              <li>
                Upload or monetize content that is violent, self-harm related, hateful,
                extremist, or otherwise prohibited by Stripe&apos;s Acceptable Use
                Policy.
              </li>
            </ul>

            <h2>8) Marketplace compliance and Stripe Connect requirements</h2>
            <p>
              Sliptail is a marketplace platform that must comply with Stripe Connect
              policies and risk controls. To protect Users, Creators, and the
              integrity of the platform, Sliptail and Stripe may monitor transactions
              and account behavior for fraud, abuse, and policy violations.
            </p>
            <ul>
              <li>
                Sliptail may suspend, delay, or withhold payouts, freeze accounts, or
                reverse transactions if we or Stripe suspect fraud, illegal activity,
                policy violations, or elevated chargeback risk.
              </li>
              <li>
                Creators must comply with Stripe requirements, including their
                Acceptable Use Policy and onboarding requests. Failure to comply may
                result in disabled payouts or removal from Sliptail.
              </li>
              <li>
                Sliptail may remove content, pause sales, or terminate Creator accounts
                where necessary to comply with Stripe rules or applicable law.
              </li>
            </ul>

            <h2>9) Moderation, reporting and enforcement</h2>
            <p>
              Users and Creators may report content or behavior that violates these
              Terms by contacting{" "}
              <a href="mailto:info@sliptail.com">info@sliptail.com</a>. Sliptail will
              review reports and may take actions such as:
            </p>
            <ul>
              <li>Removing or restricting access to content</li>
              <li>Suspending or terminating accounts</li>
              <li>Revoking access to purchases or memberships obtained through abuse</li>
              <li>Notifying Stripe or law enforcement where required</li>
            </ul>
            <p>
              Sliptail may also act proactively when we detect risk, abuse, or
              violations of these Terms or Stripe&apos;s policies.
            </p>

            <h2>10) Access controls</h2>
            <p>
              Paid content, including digital downloads, membership content, and
              request deliveries, requires a valid Sliptail account and a valid
              purchase or membership. Any attempt to bypass access controls, including
              by technical means or unauthorized sharing, violates these Terms.
            </p>

            <h2>11) Platform changes and availability</h2>
            <p>
              We may modify, suspend, or discontinue features or access at any time,
              including for maintenance, security, business, or legal reasons. We may
              update these Terms prospectively by posting a new version with a new
              Last updated date. Your continued use after changes become effective
              constitutes acceptance of the updated Terms.
            </p>

            <h2>12) Disclaimers</h2>
            <ul>
              <li>
                <strong>No warranties:</strong> Sliptail is provided on an as is and as
                available basis. We disclaim all warranties, express or implied,
                including merchantability, fitness for a particular purpose, and
                non-infringement.
              </li>
              <li>
                <strong>Creator responsibility:</strong> Creators are solely
                responsible for their content, promises, schedules, and conduct. We do
                not endorse or verify Creator Content and are not responsible for any
                interactions between Users and Creators.
              </li>
              <li>
                <strong>Third-party services:</strong> Payment processing and payouts
                are provided by Stripe and other third parties, subject to their own
                terms and availability. We are not responsible for outages or errors by
                third-party services.
              </li>
            </ul>

            <h2>13) Limitation of liability</h2>
            <p>
              To the maximum extent permitted by law, Sliptail and its affiliates,
              officers, employees, and agents will not be liable for any indirect,
              incidental, special, consequential, exemplary, or punitive damages, or
              any loss of profits, revenues, data, or goodwill, arising out of or
              related to your use of Sliptail, even if we have been advised of the
              possibility of such damages. Our aggregate liability to you for all
              claims relating to Sliptail will not exceed the greater of (a) the
              amounts paid by you to Sliptail (excluding Creator payouts and Stripe
              fees) in the 6 months preceding the event giving rise to liability, or
              (b) 100 United States dollars (USD 100).
            </p>

            <h2>14) Indemnification</h2>
            <p>
              You agree to defend, indemnify, and hold harmless Sliptail and its
              affiliates, officers, employees, and agents from and against any claims,
              liabilities, damages, losses, and expenses (including reasonable
              attorneys fees) arising out of or related to: (a) your use of Sliptail;
              (b) your content or conduct; (c) your violation of these Terms or any
              law; or (d) any dispute between you and any other user or Creator.
            </p>

            <h2>15) Governing law, arbitration and class action waiver</h2>
            <ul>
              <li>
                <strong>Governing law:</strong> These Terms are governed by the laws of
                the United States and the state or jurisdiction in which Sliptail is
                organized, without regard to its conflicts of law rules.
              </li>
              <li>
                <strong>Arbitration:</strong> Any dispute arising out of or relating to
                these Terms or Sliptail will be resolved by binding, individual
                arbitration under the Federal Arbitration Act, administered by the
                American Arbitration Association (AAA) under its Consumer Arbitration
                Rules. Judgment on the award may be entered in any court with
                jurisdiction.
              </li>
              <li>
                <strong>Class action waiver:</strong> You may bring claims only in your
                individual capacity and not as a plaintiff or class member in any
                purported class, collective, or representative proceeding.
              </li>
              <li>
                <strong>Opt-out:</strong> You may opt out of arbitration within 30 days
                of first accepting these Terms by emailing{" "}
                <a href="mailto:info@sliptail.com">info@sliptail.com</a> with the
                subject line Arbitration Opt-Out and including your account email and
                full name.
              </li>
            </ul>

            <h2>16) Termination</h2>
            <p>
              You may stop using Sliptail at any time. We may suspend or terminate
              your access immediately for any violation of these Terms, risk, fraud,
              illegality, non-compliance with Stripe requirements, or at our
              discretion. Sections that by their nature should survive termination
              (including intellectual property, anti-leak, disclaimers, limitations of
              liability, indemnity, and arbitration) will continue to apply.
            </p>

            <h2>17) Notices and contact</h2>
            <p>
              Questions or notices about these Terms may be sent to{" "}
              <a href="mailto:info@sliptail.com">info@sliptail.com</a>.
            </p>

            <h2>18) Entire agreement</h2>
            <p>
              These Terms and any policies referenced here (including our Privacy
              Policy) constitute the entire agreement between you and Sliptail
              regarding your use of the platform and supersede any prior or
              contemporaneous understandings on the subject.
            </p>

            <hr />

            <p className="text-xs text-neutral-600">
              <strong>Important:</strong> This information is provided for general
              informational purposes and does not constitute legal advice. Because
              laws and Stripe requirements may change and can vary by jurisdiction,
              you should have a qualified attorney review and customize these Terms
              for your specific situation.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

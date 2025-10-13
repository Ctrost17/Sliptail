// app/terms/page.tsx
import Link from "next/link";

export const metadata = {
  title: "Terms of Use | Sliptail",
  description:
    "Terms of Use for Sliptail — a platform where creators sell requests, memberships, and digital downloads. Please read carefully.",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-gradient-to-r from-emerald-300 via-cyan-400 to-sky-400 py-10">
      <div className="mx-auto max-w-4xl px-4">
        <div className="rounded-2xl bg-white p-6 shadow-xl md:p-10">
          <header className="mb-8">
            <h1 className="text-3xl font-bold text-black md:text-4xl">Terms of Use</h1>
            <p className="mt-2 text-sm text-neutral-600">
              Last updated: October 12, 2025
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
              These Terms of Use (“<strong>Terms</strong>”) govern your access to and
              use of the Sliptail website, applications, and services (collectively,
              “<strong>Sliptail</strong>,” “<strong>we</strong>,” “<strong>us</strong>,”
              or “<strong>our</strong>”). Sliptail is a platform that enables
              creators (“<strong>Creators</strong>”) to sell (a){" "}
              <strong>Requests</strong> (personalized content), (b){" "}
              <strong>Memberships</strong> (recurring access to a private feed), and (c){" "}
              <strong>Purchases</strong> (downloadable digital items) to customers
              (“<strong>Users</strong>”). By using Sliptail, you agree to these
              Terms and to any policies referenced here (including our Privacy Policy).
              If you do not agree, do not use Sliptail.
            </p>

            <h2>1) Who we are and how Sliptail works</h2>
            <p>
              Sliptail provides the technology to facilitate the listing, purchase,
              and delivery of Creator Content. We process payments via{" "}
              <strong>Stripe</strong> and pay out Creators via{" "}
              <strong>Stripe Connect</strong>, which requires Creators to complete
              Stripe’s onboarding, identity verification, and ongoing compliance. We
              are <strong>not</strong> the seller of Creator Content to Users; the
              Creator is. Sliptail is not a party to the contract between Creator
              and User, and we do not control or guarantee the quality, legality,
              or availability of Creator Content.
            </p>

            <h2>2) Eligibility & accounts</h2>
            <ul>
              <li>
                You must be at least 13 years old (or the minimum age required in your
                jurisdiction) to use Sliptail. If you are under 18, you represent you
                have consent from a parent/guardian and will use Sliptail under their
                supervision.
              </li>
              <li>
                You agree to provide accurate information, keep your credentials
                secure, and be responsible for all activity on your account. We may
                suspend or terminate accounts that violate these Terms or applicable law.
              </li>
            </ul>

            <h2>3) Creator accounts, payouts & taxes</h2>
            <ul>
              <li>
                <strong>Stripe Connect:</strong> Creators must onboard to Stripe
                Connect and agree to Stripe’s applicable terms (including the{" "}
                <em>Stripe Services Agreement</em> and <em>Connect Platform Agreements</em>).
                Stripe may require identity verification, bank account details, and
                other information. Payouts are made by Stripe to the Creator’s linked
                account, subject to Stripe’s schedules, reserves, and compliance holds.
              </li>
              <li>
                <strong>Platform fees:</strong> Sliptail charges a platform fee of{" "}
                <strong>4%</strong> on Creator sales (plus Stripe fees and any
                applicable taxes). We may change fees prospectively with notice.
              </li>
              <li>
                <strong>Chargebacks & refunds:</strong> Creators bear the economic risk
                of chargebacks, refunds, and disputes related to their sales. We may
                offset fees, chargebacks, refunds, and penalties from future payouts.
              </li>
              <li>
                <strong>Taxes:</strong> Creators are responsible for assessing,
                collecting (where required), and remitting all applicable taxes
                (including VAT/GST/sales tax) for their sales, and for satisfying
                their income tax obligations. Stripe may issue informational tax
                forms (e.g., 1099-K) where required by law.
              </li>
            </ul>

            <h2>4) Users: purchases, memberships & requests</h2>
            <ul>
              <li>
                <strong>Purchases:</strong> When you buy a downloadable item, the
                Creator grants you a personal, non-exclusive, non-transferable,
                revocable license to access and use the file for your own
                non-commercial use unless the Creator expressly grants additional
                rights in writing.
              </li>
              <li>
                <strong>Memberships:</strong> When you subscribe to a membership, you
                receive access to a private feed for the membership term. If you
                cancel, your access continues through the end of the current paid
                period. Creators may post, edit, or remove content at their
                discretion.
              </li>
              <li>
                <strong>Requests:</strong> Personalized content is produced at the
                Creator’s discretion and subject to feasibility and the Creator’s
                content policies. Timeframes are not guaranteed unless explicitly
                stated by the Creator.
              </li>
              <li>
                <strong>No redistribution:</strong> Users may not share, resell,
                publicly post, livestream, re-record, or otherwise redistribute
                Creator Content without the Creator’s prior written permission.
              </li>
            </ul>

            <h2>5) Refunds & support</h2>
            <p>
              Support is available via <a href="mailto:info@sliptail.com">info@sliptail.com</a>.
              Refunds are reviewed case-by-case and are not guaranteed. We typically
              do not refund after digital access or downloads have been delivered,
              except where required by law. In the event of a dispute, chargeback,
              or suspected fraud, we may suspend access, delay payouts, or take other
              appropriate actions.
            </p>

            <h2>6) Intellectual property; anti-leak & enforcement</h2>
            <ul>
              <li>
                <strong>Ownership:</strong> Creators retain all rights in their content,
                subject to the limited licenses granted to Users for personal use.
              </li>
              <li>
                <strong>User license:</strong> Users receive a limited, revocable,
                non-exclusive, non-transferable license solely for personal use,
                unless the Creator expressly grants broader rights in writing.
              </li>
              <li>
                <strong>Anti-leak:</strong> Any sharing, posting, re-uploading,
                public performance, public display, or distribution of Creator
                Content without permission is strictly prohibited. Creators may pursue
                legal remedies, including injunctive relief, damages, and attorneys’
                fees where permitted by law. Sliptail may provide reasonable
                cooperation (e.g., basic transaction records) to Creators seeking to
                enforce their rights, consistent with our Privacy Policy and applicable
                law.
              </li>
              <li>
                <strong>Watermarking/monitoring:</strong> Creators may use watermarks
                or other markers. Sliptail may employ technical measures to detect
                abuse (subject to our Privacy Policy and applicable law) and may
                suspend or terminate accounts associated with leaks.
              </li>
              <li>
                <strong>DMCA:</strong> If you believe content infringes your copyright,
                send a notice to <a href="mailto:info@sliptail.com">info@sliptail.com</a>
                with: (i) your contact info; (ii) a description of the work; (iii) the
                URL of the allegedly infringing material; (iv) a statement under
                penalty of perjury that you have a good-faith belief that the use is
                unauthorized; (v) a statement that your notice is accurate and you are
                authorized to act; and (vi) a physical or electronic signature. We may
                remove content and, where appropriate, terminate repeat infringers.
              </li>
            </ul>

            <h2>7) Acceptable use</h2>
            <p>You agree not to, and not to allow others to:</p>
            <ul>
              <li>
                Violate any law; post illegal, defamatory, fraudulent, hateful,
                harassing, exploitative, or pornographic material; or depict minors or
                non-consensual activity.
              </li>
              <li>
                Infringe intellectual property, privacy, or publicity rights; or
                disclose others’ personal data without consent.
              </li>
              <li>
                Circumvent access controls, copy or scrape content, reverse engineer,
                or interfere with the platform’s security or operation.
              </li>
              <li>
                Engage in spamming, scams, impersonation, or deceptive conduct.
              </li>
            </ul>

            <h2>8) Platform changes; availability</h2>
            <p>
              We may modify, suspend, or discontinue features or access at any time,
              including for maintenance, security, or legal reasons. We may update
              these Terms prospectively by posting a new version with a new “Last
              updated” date. Your continued use after changes becomes effective
              constitutes acceptance.
            </p>

            <h2>9) Disclaimers</h2>
            <ul>
              <li>
                <strong>No warranties:</strong> Sliptail is provided “as is” and “as
                available.” We disclaim all warranties, express or implied, including
                merchantability, fitness for a particular purpose, and non-infringement.
              </li>
              <li>
                <strong>Creator responsibility:</strong> Creators are solely
                responsible for their content, promises, schedules, and conduct.
                We do not endorse or verify Creator Content.
              </li>
              <li>
                <strong>Third-party services:</strong> Payment processing and payouts
                are provided by Stripe, subject to their terms and availability.
              </li>
            </ul>

            <h2>10) Limitation of liability</h2>
            <p>
              To the maximum extent permitted by law, Sliptail and its affiliates,
              officers, employees, and agents will not be liable for any indirect,
              incidental, special, consequential, exemplary, or punitive damages, or
              any loss of profits, revenues, data, or goodwill, arising out of or
              related to your use of Sliptail, even if advised of the possibility of
              such damages. Our aggregate liability to you for all claims relating to
              Sliptail shall not exceed the greater of (a) the amounts paid by you to
              Sliptail (excluding Creator payouts and Stripe fees) in the 6 months
              preceding the event giving rise to liability, or (b) $100.
            </p>

            <h2>11) Indemnification</h2>
            <p>
              You agree to defend, indemnify, and hold harmless Sliptail and its
              affiliates, officers, employees, and agents from and against any claims,
              liabilities, damages, losses, and expenses (including reasonable
              attorneys’ fees) arising out of or related to: (a) your use of Sliptail;
              (b) your content or conduct; (c) your violation of these Terms or any
              law; or (d) any dispute between you and any other user or any Creator.
            </p>

            <h2>12) Governing law; arbitration; class-action waiver</h2>
            <ul>
              <li>
                <strong>Governing law:</strong> These Terms are governed by the laws
                of the USA, without regard to its conflicts-of-law
                rules.
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
                <strong>Class-action waiver:</strong> You may only bring claims in your
                individual capacity and not as a plaintiff or class member in any
                purported class, collective, or representative proceeding.
              </li>
              <li>
                <strong>Opt-out:</strong> You may opt out of arbitration within 30 days
                of first accepting these Terms by emailing{" "}
                <a href="mailto:info@sliptail.com">info@sliptail.com</a> with subject
                line “Arbitration Opt-Out” and your account email and full name.
              </li>
            </ul>

            <h2>13) Termination</h2>
            <p>
              You may stop using Sliptail at any time. We may suspend or terminate
              access immediately for any violation of these Terms, risk, fraud,
              illegality, or at our discretion. Sections that by their nature should
              survive termination (e.g., IP, anti-leak, disclaimers, limitations of
              liability, indemnity, arbitration) will survive.
            </p>

            <h2>14) Notices & contact</h2>
            <p>
              Questions or notices about these Terms may be sent to{" "}
              <a href="mailto:info@sliptail.com">info@sliptail.com</a>.
            </p>

            <h2>15) Entire agreement</h2>
            <p>
              These Terms (and any policies referenced, including our Privacy Policy)
              constitute the entire agreement between you and Sliptail regarding your
              use of the platform and supersede any prior or contemporaneous
              understandings on the subject.
            </p>

            <hr />

            <p className="text-xs text-neutral-600">
              <strong>Important:</strong> This template is provided for general
              informational purposes and does not constitute legal advice. Because
              laws vary by jurisdiction and your business specifics may change, you
              should have a qualified attorney review and customize this policy for
              your situation (including governing law, venue, disclosures, consumer
              rights, and any creator-specific restrictions).
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

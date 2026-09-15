import React from 'react';
import { LegalHeading, LegalList, LegalPage, LegalParagraph } from '@/components/legal/LegalPage';

export default function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      description="Terms governing access to and use of the Volume Capture photography workflow."
    >
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Terms of Service</h1>
      <p className="mt-2 text-sm text-slate-500">Effective date: September 9, 2026</p>

      <LegalHeading>1. Agreement</LegalHeading>
      <LegalParagraph>
        These Terms govern access to Volume Capture, a web and desktop photography workflow operated
        by Mehdi Chafik. By creating an account, accepting an invitation, downloading the desktop
        application, or using the service, you agree to these Terms. If you use Volume Capture for a
        studio or organization, you confirm that you are authorized to bind that organization.
      </LegalParagraph>

      <LegalHeading>2. The service</LegalHeading>
      <LegalParagraph>
        Volume Capture helps studios prepare school photography and corporate headshot projects,
        organize rosters and groups, generate QR codes, match captures, review image completeness,
        collaborate, and transfer files to connected storage. Features may evolve, and third-party
        integrations may change or become unavailable.
      </LegalParagraph>

      <LegalHeading>3. Accounts and eligibility</LegalHeading>
      <LegalList>
        <li>You must be at least 18 years old and legally capable of entering this agreement.</li>
        <li>You must provide accurate account information and protect your credentials and devices.</li>
        <li>You are responsible for activity performed through your account and for promptly removing team members who no longer require access.</li>
        <li>You must notify us at info@mehdichafik.ma if you suspect unauthorized access.</li>
      </LegalList>

      <LegalHeading>4. Studio responsibilities</LegalHeading>
      <LegalParagraph>
        You retain control of the rosters, portraits, files, and instructions you submit. You are
        responsible for having all necessary contracts, notices, consents, permissions, and lawful
        bases to photograph subjects and process their information, including minors. You must ensure
        that exports, local devices, watch folders, and connected storage are appropriately secured.
      </LegalParagraph>

      <LegalHeading>5. Acceptable use</LegalHeading>
      <LegalParagraph>You may not use Volume Capture to:</LegalParagraph>
      <LegalList>
        <li>Break the law, violate privacy or intellectual-property rights, or process images without proper authority.</li>
        <li>Upload malware, harmful code, or content intended to disrupt or compromise the service.</li>
        <li>Attempt unauthorized access, bypass security controls, scrape the service, or probe other accounts.</li>
        <li>Resell, reverse engineer, copy, or exploit the service except where mandatory law expressly permits it.</li>
        <li>Use the service for biometric identification, unlawful surveillance, or other high-risk purposes not expressly supported by Volume Capture.</li>
      </LegalList>

      <LegalHeading>6. Your content</LegalHeading>
      <LegalParagraph>
        You and your clients retain ownership of content you submit. You grant us a limited,
        non-exclusive license to host, copy, generate previews, process, and transfer that content
        only as necessary to provide, secure, and support the service. This license ends when the
        content is deleted from active systems, subject to reasonable backup and legal-retention periods.
      </LegalParagraph>

      <LegalHeading>7. Volume Capture materials</LegalHeading>
      <LegalParagraph>
        Volume Capture, its software, design, documentation, trademarks, and other service materials
        are owned by the operator or its licensors. Subject to these Terms, you receive a limited,
        revocable, non-transferable right to use the service for your internal photography operations.
      </LegalParagraph>

      <LegalHeading>8. Third-party services</LegalHeading>
      <LegalParagraph>
        Google, Clerk, Dropbox, Replit, GitHub, and other connected services have their own terms and
        privacy practices. You authorize Volume Capture to communicate with providers you connect.
        We are not responsible for outages, account restrictions, data loss, or policy changes caused
        by a third-party service outside our reasonable control.
      </LegalParagraph>

      <LegalHeading>9. Fees</LegalHeading>
      <LegalParagraph>
        If paid plans are offered, the applicable price, billing period, taxes, renewal terms, and
        cancellation terms will be shown before purchase or agreed in writing. Unless otherwise
        stated, fees already earned for a completed billing period are non-refundable to the extent
        permitted by law. Mandatory consumer rights remain unaffected.
      </LegalParagraph>

      <LegalHeading>10. Availability and updates</LegalHeading>
      <LegalParagraph>
        We aim to provide a reliable service but do not promise uninterrupted operation or a specific
        uptime unless agreed separately in writing. Studios should maintain appropriate backups and
        verify captures and uploads before deleting originals. Desktop updates may be required for
        security, compatibility, or continued access to cloud features.
      </LegalParagraph>

      <LegalHeading>11. Suspension and termination</LegalHeading>
      <LegalParagraph>
        You may stop using the service at any time. We may restrict or suspend access when reasonably
        necessary to address a security risk, legal requirement, non-payment, or material violation
        of these Terms. Where practical, we will provide notice and an opportunity to correct the
        issue. Data export and deletion remain subject to account status, studio authority, applicable
        law, and reasonable retention periods.
      </LegalParagraph>

      <LegalHeading>12. Disclaimers</LegalHeading>
      <LegalParagraph>
        To the extent permitted by law, the service is provided “as is” and “as available.” We do not
        guarantee that every camera file, QR code, network transfer, third-party integration, or
        recovery attempt will succeed. You remain responsible for shoot procedures, file verification,
        backups, client commitments, and final delivery quality.
      </LegalParagraph>

      <LegalHeading>13. Limitation of liability</LegalHeading>
      <LegalParagraph>
        To the extent permitted by law, neither party will be liable for indirect, incidental,
        special, consequential, or punitive damages, or for lost profits, revenue, goodwill, or data.
        Volume Capture&apos;s aggregate liability arising from the service will not exceed the greater
        of the fees you paid for the service during the 12 months before the event giving rise to the
        claim or USD 100. These limitations do not apply where liability cannot legally be limited,
        including liability for fraud or intentional misconduct.
      </LegalParagraph>

      <LegalHeading>14. Governing law</LegalHeading>
      <LegalParagraph>
        These Terms are governed by the laws of Morocco, without regard to conflict-of-law rules.
        Disputes will be submitted to the competent courts of Morocco, except where mandatory consumer
        or data-protection law gives you the right to bring a claim elsewhere. EU/EEA users retain
        rights that cannot be waived under applicable law.
      </LegalParagraph>

      <LegalHeading>15. Changes</LegalHeading>
      <LegalParagraph>
        We may update these Terms to reflect service, legal, or security changes. We will provide
        reasonable notice of material changes. Continued use after the new effective date constitutes
        acceptance where permitted by law.
      </LegalParagraph>

      <LegalHeading>16. Contact</LegalHeading>
      <LegalParagraph>
        Questions about these Terms may be sent to Mehdi Chafik at{' '}
        <a className="font-medium text-teal-700 underline" href="mailto:info@mehdichafik.ma">
          info@mehdichafik.ma
        </a>.
      </LegalParagraph>
    </LegalPage>
  );
}
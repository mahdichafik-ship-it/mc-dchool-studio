import React from 'react';
import { LegalHeading, LegalList, LegalPage, LegalParagraph } from '@/components/legal/LegalPage';

export default function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      description="How Volume Capture collects, uses, stores, and protects personal information."
    >
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Privacy Policy</h1>
      <p className="mt-2 text-sm text-slate-500">Effective date: September 9, 2026</p>

      <LegalHeading>1. Who we are</LegalHeading>
      <LegalParagraph>
        Volume Capture is operated by Mehdi Chafik in Morocco. This policy explains how Volume
        Capture processes personal information when studios use our web and desktop photography
        workflow. Contact us about privacy at{' '}
        <a className="font-medium text-teal-700 underline" href="mailto:info@mehdichafik.ma">
          info@mehdichafik.ma
        </a>.
      </LegalParagraph>
      <LegalParagraph>
        For studio account information, Volume Capture acts as the data controller. For rosters,
        portraits, and other information a studio uploads on behalf of schools, companies, students,
        employees, or other subjects, the studio or its client is normally the controller and Volume
        Capture acts as a service provider or processor on its instructions.
      </LegalParagraph>

      <LegalHeading>2. Information we process</LegalHeading>
      <LegalList>
        <li><strong>Account information:</strong> name, email address, authentication identifiers, studio membership, and account settings.</li>
        <li><strong>Project and roster information:</strong> school or company names, classes or departments, names, identifiers, contact details supplied by the studio, project dates, and notes.</li>
        <li><strong>Photography files:</strong> JPEG and RAW images, previews, QR codes, filenames, capture metadata, review choices, and upload status.</li>
        <li><strong>Storage and integration information:</strong> the connected storage provider, connection status, destination paths, and provider tokens required to perform authorized transfers.</li>
        <li><strong>Technical information:</strong> device, browser, IP address, timestamps, security events, diagnostics, and service logs.</li>
        <li><strong>Communications:</strong> messages and support requests sent to us.</li>
      </LegalList>

      <LegalHeading>3. How and why we use information</LegalHeading>
      <LegalList>
        <li>Provide accounts, project preparation, QR matching, capture review, collaboration, export, and delivery features.</li>
        <li>Store and transfer files to destinations selected by an authorized studio.</li>
        <li>Protect accounts, investigate abuse, diagnose failures, and maintain service reliability.</li>
        <li>Respond to support, privacy, and legal requests.</li>
        <li>Meet legal obligations and enforce our Terms of Service.</li>
      </LegalList>
      <LegalParagraph>
        Where the GDPR applies, our legal bases are performance of a contract, legitimate interests
        in operating and securing the service, compliance with legal obligations, and consent where
        the law requires it. Studios are responsible for establishing a lawful basis for the personal
        information and portraits they collect and upload.
      </LegalParagraph>

      <LegalHeading>4. Service providers and disclosures</LegalHeading>
      <LegalParagraph>We disclose information only as needed to operate the service, follow studio instructions, or comply with law. Providers may include:</LegalParagraph>
      <LegalList>
        <li><strong>Clerk:</strong> account authentication, session management, and social sign-in.</li>
        <li><strong>Replit:</strong> application hosting, managed infrastructure, databases, logs, and file storage.</li>
        <li><strong>Google Drive and Dropbox:</strong> optional storage destinations selected and connected by a studio.</li>
        <li><strong>GitHub:</strong> public distribution of desktop application installers; it does not receive project rosters or portraits through Volume Capture.</li>
      </LegalList>
      <LegalParagraph>
        We may disclose limited information to professional advisers, authorities, or a successor in
        a business transaction when legally permitted. We do not sell personal information or use
        project portraits for advertising.
      </LegalParagraph>

      <LegalHeading>5. International transfers</LegalHeading>
      <LegalParagraph>
        Volume Capture serves users internationally. Information may be processed in Morocco, the
        European Economic Area, the United States, or other locations where our providers operate.
        Where required, transfers are protected through contractual safeguards or another lawful
        transfer mechanism.
      </LegalParagraph>

      <LegalHeading>6. Retention and deletion</LegalHeading>
      <LegalParagraph>
        We retain account information while an account is active and as reasonably needed for
        security, legal, and accounting purposes. Project data and photography files are retained
        according to the studio&apos;s instructions, connected-storage configuration, and applicable
        backup cycles. A studio should define and communicate its own retention schedule to its
        clients and subjects. Deletion requests may take additional time to clear encrypted backups.
      </LegalParagraph>

      <LegalHeading>7. Security</LegalHeading>
      <LegalParagraph>
        We use access controls, encrypted network connections, authenticated storage integrations,
        and operational safeguards designed to protect information. No internet service or storage
        system can guarantee absolute security. Studios must protect their credentials, restrict team
        access, and maintain secure local copies and devices.
      </LegalParagraph>

      <LegalHeading>8. Cookies and local storage</LegalHeading>
      <LegalParagraph>
        Volume Capture uses cookies and similar browser storage required for authentication, session
        security, and essential application preferences. We do not currently use advertising cookies.
        If non-essential analytics or advertising technologies are introduced, this policy and any
        required consent controls will be updated before they are used.
      </LegalParagraph>

      <LegalHeading>9. Children and photographed minors</LegalHeading>
      <LegalParagraph>
        Volume Capture is a business tool for adult studio professionals and is not directed to
        children. Studios may process portraits and roster information concerning minors for school
        photography. The studio and school are responsible for parental notices, permissions, lawful
        collection, access controls, and responding to requests concerning those children.
      </LegalParagraph>

      <LegalHeading>10. Your rights</LegalHeading>
      <LegalParagraph>
        Depending on your location, you may request access, correction, deletion, restriction,
        objection, portability, or withdrawal of consent. Contact the studio first for requests about
        a roster or portrait supplied by that studio, or contact us at info@mehdichafik.ma. We may
        verify your identity before acting. EU/EEA users may also complain to their local supervisory
        authority. Individuals in Morocco may contact the CNDP.
      </LegalParagraph>

      <LegalHeading>11. Changes to this policy</LegalHeading>
      <LegalParagraph>
        We may update this policy as the service or law changes. The effective date will be revised,
        and material changes will be communicated through the service or by another reasonable method.
      </LegalParagraph>

      <LegalHeading>12. Contact</LegalHeading>
      <LegalParagraph>
        Privacy questions and requests may be sent to Mehdi Chafik at{' '}
        <a className="font-medium text-teal-700 underline" href="mailto:info@mehdichafik.ma">
          info@mehdichafik.ma
        </a>.
      </LegalParagraph>
    </LegalPage>
  );
}
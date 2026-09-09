import React, { useEffect } from 'react';
import { Camera } from 'lucide-react';
import { Link } from 'wouter';

interface LegalPageProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

export function LegalPage({ title, description, children }: LegalPageProps) {
  useEffect(() => {
    document.title = `${title} | Volume Capture`;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (meta) meta.content = description;
  }, [description, title]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-700">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-5">
          <Link href="/" className="flex items-center gap-3 text-slate-900">
            <span className="flex size-9 items-center justify-center rounded-lg bg-teal-600 text-white">
              <Camera className="size-5" aria-hidden="true" />
            </span>
            <span className="font-bold">Volume Capture</span>
          </Link>
          <Link href="/" className="text-sm font-medium text-teal-700 hover:text-teal-800">
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-8 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This document is a general informational template, not legal advice. Consult a qualified
          lawyer for advice about your specific obligations.
        </div>
        <article className="rounded-2xl border border-slate-200 bg-white px-6 py-10 shadow-sm sm:px-10">
          {children}
        </article>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-6 py-7 text-sm text-slate-500">
          <Link href="/" className="hover:text-teal-700">Home</Link>
          <Link href="/privacy" className="hover:text-teal-700">Privacy Policy</Link>
          <Link href="/terms" className="hover:text-teal-700">Terms of Service</Link>
          <a href="mailto:info@mehdichafik.ma" className="hover:text-teal-700">Contact</a>
        </div>
      </footer>
    </div>
  );
}

export function LegalHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 mt-9 text-xl font-bold text-slate-900 first:mt-0">{children}</h2>;
}

export function LegalParagraph({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 leading-7">{children}</p>;
}

export function LegalList({ children }: { children: React.ReactNode }) {
  return <ul className="mb-4 list-disc space-y-2 pl-6 leading-7">{children}</ul>;
}
import React from 'react';
import { Link } from 'wouter';
import { Camera, ArrowRight, ShieldCheck, Zap, Users, Monitor, Apple } from 'lucide-react';

const DESKTOP_RELEASE_URL = 'https://github.com/mahdichafik-ship-it/mc-dchool-studio/releases/download/v1.0.30';
const MAC_DOWNLOAD_URL = `${DESKTOP_RELEASE_URL}/mc-school-studio-1.0.30-arm64.dmg`;

export default function Landing() {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <header className="flex items-center justify-between px-8 py-6 bg-white border-b border-slate-200">
        <div className="flex items-center gap-3 text-slate-900">
          <Camera className="w-7 h-7 text-teal-600" />
          <span className="font-bold text-xl tracking-tight">MC School Studio</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/sign-in" className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors">
            Sign In
          </Link>
          <Link href="/sign-up" className="text-sm font-medium bg-teal-600 text-white px-5 py-2.5 rounded-md hover:bg-teal-700 transition-colors shadow-sm">
            Get Started
          </Link>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero Section */}
        <section className="py-24 px-8 max-w-6xl mx-auto text-center">
          <h1 className="text-5xl md:text-6xl font-extrabold text-slate-900 tracking-tight leading-tight mb-6">
            The professional <span className="text-teal-600">photography day</span> preparation tool.
          </h1>
          <p className="text-xl text-slate-600 mb-10 max-w-3xl mx-auto leading-relaxed">
            Import student lists, organize classes, and generate personalized QR codes in seconds. 
            Built for precision, designed for high-volume studio workflows.
          </p>
          <div className="flex justify-center gap-4">
            <Link href="/sign-up" className="inline-flex items-center gap-2 bg-teal-600 text-white px-8 py-3.5 rounded-lg font-semibold text-lg hover:bg-teal-700 transition-colors shadow-md">
              Start Free Trial <ArrowRight className="w-5 h-5" />
            </Link>
          </div>
        </section>

        {/* Desktop app download */}
        <section className="pb-16 px-8 max-w-6xl mx-auto">
          <div className="rounded-2xl border border-teal-200 bg-teal-50 px-8 py-7 flex flex-col sm:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-5">
              <div className="w-12 h-12 rounded-xl bg-teal-600 flex items-center justify-center shrink-0">
                <Monitor className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-slate-900">Download the Desktop App</h2>
                <p className="text-sm text-slate-600 mt-0.5">
                  Shoot-day tool — auto-matches QR codes as photos land in your camera folder.
                </p>
              </div>
            </div>
            <div className="shrink-0">
              <a
                href={MAC_DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 bg-white border border-slate-200 text-slate-700 text-sm font-semibold px-5 py-2.5 rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-colors shadow-sm"
              >
                <Apple className="w-4 h-4" />
                Mac (.dmg)
              </a>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="py-20 bg-white border-y border-slate-200">
          <div className="max-w-6xl mx-auto px-8">
            <div className="grid md:grid-cols-3 gap-12">
              <div className="space-y-4">
                <div className="w-12 h-12 bg-teal-50 text-teal-600 rounded-xl flex items-center justify-center">
                  <Zap className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-bold text-slate-900">Lightning Fast Imports</h3>
                <p className="text-slate-600 leading-relaxed">
                  Upload CSV or Excel files. Our intelligent wizard helps you map columns and organize thousands of students into classes instantly.
                </p>
              </div>
              <div className="space-y-4">
                <div className="w-12 h-12 bg-teal-50 text-teal-600 rounded-xl flex items-center justify-center">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-bold text-slate-900">Precision QR Codes</h3>
                <p className="text-slate-600 leading-relaxed">
                  Generate unique QR codes for every student. Export them to PDF or ZIP for foolproof identification on photo day.
                </p>
              </div>
              <div className="space-y-4">
                <div className="w-12 h-12 bg-teal-50 text-teal-600 rounded-xl flex items-center justify-center">
                  <Users className="w-6 h-6" />
                </div>
                <h3 className="text-xl font-bold text-slate-900">Class Management</h3>
                <p className="text-slate-600 leading-relaxed">
                  Keep projects organized by school and class. Edit student details on the fly and manage bulk deletions effortlessly.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="py-8 text-center text-slate-500 text-sm border-t border-slate-200 bg-white">
        &copy; {new Date().getFullYear()} MC School Studio. All rights reserved.
      </footer>
    </div>
  );
}

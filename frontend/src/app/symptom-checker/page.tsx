import { Metadata } from 'next';
import SymptomChat from '@/components/symptom-checker/SymptomChat';
import Link from 'next/link';
import { ComplianceBadges } from '@/components/ui/TrustBadge';
import { BrandLogoMark } from '@/components/ui/BrandLogo';

export const metadata: Metadata = {
    title: 'Free AI Symptom Checker for Nigeria & Africa | Docarion',
    description: 'Chat with our AI health assistant about your symptoms. Covers malaria, typhoid, sickle cell, and 40+ conditions common in Nigeria and Africa. Free, instant, and private.',
    keywords: [
        'symptom checker Nigeria', 'AI symptom checker Africa', 'malaria symptoms checker',
        'typhoid symptoms check', 'free health check Africa', 'sickle cell symptoms',
        'body pain checker Nigeria', 'Docarion health assistant', 'Nigerian health AI',
        'check symptoms online free', 'pidgin English symptom checker',
    ],
    openGraph: {
        title: 'Free AI Symptom Checker — Docarion',
        description: 'Chat with our AI about your symptoms. Built for Nigeria & Africa. Covers malaria, typhoid, sickle cell + 40 more conditions.',
        url: 'https://docarion.com/symptom-checker',
        siteName: 'Docarion',
        type: 'website',
    },
    alternates: {
        canonical: 'https://docarion.com/symptom-checker',
    },
};

// JSON-LD Structured Data
const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'MedicalWebPage',
    name: 'Docarion AI Symptom Checker',
    description: 'A free AI-powered symptom checker designed for Nigerian and African health conditions.',
    url: 'https://docarion.com/symptom-checker',
    audience: {
        '@type': 'MedicalAudience',
        geographicArea: {
            '@type': 'AdministrativeArea',
            name: 'Nigeria',
        },
    },
    mainEntity: {
        '@type': 'WebApplication',
        name: 'Docarion Symptom Checker',
        applicationCategory: 'HealthApplication',
        operatingSystem: 'Web',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'NGN' },
    },
    publisher: {
        '@type': 'Organization',
        name: 'Docarion',
        url: 'https://docarion.com',
    },
};

export default function SymptomCheckerPage() {
    return (
        <div className="min-h-screen bg-gray-950 text-white">
            {/* JSON-LD */}
            <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
            />

            {/* Nav */}
            <nav className="px-6 py-4 border-b border-white/5">
                <div className="max-w-4xl mx-auto flex items-center justify-between">
                    <Link href="/" className="flex items-center gap-2.5 text-xl font-black bg-gradient-to-r from-green-400 to-emerald-400 bg-clip-text text-transparent">
                        <BrandLogoMark className="w-8 h-8 rounded-lg shadow-md" />
                        <span>Docarion</span>
                    </Link>
                    <Link href="/" className="text-sm text-gray-500 hover:text-white transition-colors">
                        ← Back to Home
                    </Link>
                </div>
            </nav>

            {/* Hero */}
            <section className="px-6 py-10 text-center">
                <div className="max-w-2xl mx-auto">
                    <div className="inline-flex items-center gap-2 px-4 py-2 bg-green-500/10 border border-green-500/20 rounded-full text-xs text-green-400 font-medium mb-6">
                        <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                        Powered by Meta Muse Spark + SAM 3.1 · English &amp; Naija Pidgin · Private
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-black mb-3 leading-tight">
                        Check Your Symptoms
                        <br />
                        <span className="bg-gradient-to-r from-green-400 to-emerald-400 bg-clip-text text-transparent">
                            Instantly
                        </span>
                    </h1>
                    <p className="text-gray-500 text-sm sm:text-base max-w-xl mx-auto dark:text-gray-400">
                        Describe how you&apos;re feeling — in English or Pidgin — and our AI will help you understand your symptoms.
                        Built for Nigerian and African health conditions.
                    </p>
                </div>
            </section>

            {/* Chat */}
            <section className="px-4 pb-12">
                <div className="max-w-2xl mx-auto">
                    <SymptomChat />
                </div>
            </section>

            {/* SEO Content Sections */}
            <section className="px-6 py-12 border-t border-white/5 bg-gray-950/80">
                <div className="max-w-3xl mx-auto space-y-10">
                    <div>
                        <h2 className="text-xl font-bold text-white mb-4">Common Symptoms in Nigeria — What They Could Mean</h2>
                        <div className="grid sm:grid-cols-2 gap-3 text-sm text-gray-500 dark:text-gray-400">
                            <p><strong className="text-gray-300 dark:text-gray-600">Fever + Chills + Body Pain</strong> → Could indicate malaria, especially during rainy season. Get a rapid test (RDT).</p>
                            <p><strong className="text-gray-300 dark:text-gray-600">Fever + Headache + Stomach Pain</strong> → May suggest typhoid. Common with contaminated water or food.</p>
                            <p><strong className="text-gray-300 dark:text-gray-600">Severe Bone Pain + Fever</strong> → Could be sickle cell crisis for carriers (25% of Nigerians carry the trait).</p>
                            <p><strong className="text-gray-300 dark:text-gray-600">Watery Diarrhea + Vomiting</strong> → May indicate cholera, especially during outbreaks. Start ORS immediately.</p>
                            <p><strong className="text-gray-300 dark:text-gray-600">Cough Lasting 2+ Weeks</strong> → TB screening recommended. Nigeria ranks 6th globally for TB burden.</p>
                            <p><strong className="text-gray-300 dark:text-gray-600">High Blood Pressure + Headache</strong> → Hypertension affects 30-45% of Nigerian adults. Regular BP checks are essential.</p>
                        </div>
                    </div>

                    <div>
                        <h2 className="text-xl font-bold text-white mb-4">When to See a Doctor in Nigeria</h2>
                        <ul className="space-y-2 text-sm text-gray-500 dark:text-gray-400">
                            <li className="flex gap-2"><span className="text-red-400">🔴</span> Chest pain with difficulty breathing — go to the nearest hospital immediately</li>
                            <li className="flex gap-2"><span className="text-red-400">🔴</span> Sudden weakness on one side of the body — possible stroke (remember FAST)</li>
                            <li className="flex gap-2"><span className="text-orange-400">🟠</span> Fever above 39°C not responding to paracetamol</li>
                            <li className="flex gap-2"><span className="text-orange-400">🟠</span> Blood in stool, urine, or vomit</li>
                            <li className="flex gap-2"><span className="text-yellow-400">🟡</span> Any symptom lasting more than 3 days without improvement</li>
                            <li className="flex gap-2"><span className="text-yellow-400">🟡</span> Pregnant with any fever, bleeding, or severe pain</li>
                        </ul>
                    </div>

                    <div>
                        <h2 className="text-xl font-bold text-white mb-3">Frequently Asked Questions</h2>
                        <div className="space-y-4">
                            <details className="group bg-white/[0.03] border border-white/10 rounded-xl">
                                <summary className="px-4 py-3 text-sm font-medium text-gray-300 cursor-pointer hover:text-white transition-colors">
                                    Is this symptom checker free?
                                </summary>
                                <p className="px-4 pb-3 text-sm text-gray-500 dark:text-gray-400">
                                    Yes, completely free. Docarion&apos;s AI health assistant is available to everyone at no cost.
                                </p>
                            </details>
                            <details className="group bg-white/[0.03] border border-white/10 rounded-xl">
                                <summary className="px-4 py-3 text-sm font-medium text-gray-300 cursor-pointer hover:text-white transition-colors">
                                    Can I use Pidgin English?
                                </summary>
                                <p className="px-4 pb-3 text-sm text-gray-500 dark:text-gray-400">
                                    Yes! Our AI understands Nigerian Pidgin. You can type &quot;my body dey hot&quot;, &quot;belle dey pain me&quot;, or &quot;I dey purge&quot; and it will understand.
                                </p>
                            </details>
                            <details className="group bg-white/[0.03] border border-white/10 rounded-xl">
                                <summary className="px-4 py-3 text-sm font-medium text-gray-300 cursor-pointer hover:text-white transition-colors">
                                    Is this a medical diagnosis?
                                </summary>
                                <p className="px-4 pb-3 text-sm text-gray-500 dark:text-gray-400">
                                    No. This tool provides health information only. It is not a substitute for professional medical diagnosis or treatment. Always consult a qualified healthcare provider.
                                </p>
                            </details>
                            <details className="group bg-white/[0.03] border border-white/10 rounded-xl">
                                <summary className="px-4 py-3 text-sm font-medium text-gray-300 cursor-pointer hover:text-white transition-colors">
                                    Is my data private?
                                </summary>
                                <p className="px-4 pb-3 text-sm text-gray-500 dark:text-gray-400">
                                    You do not need to sign in. Your text is processed to provide the symptom check and may be kept under Docarion&apos;s documented security, quality, and retention criteria. Do not enter names, contact details, MRNs, or other direct identifiers. See the Privacy Policy for details.
                                </p>
                            </details>
                        </div>
                    </div>

                    <div>
                        <h2 className="text-xl font-bold text-white mb-3">About Docarion</h2>
                        <p className="text-sm text-gray-500 leading-relaxed dark:text-gray-400">
                            Docarion is a telemedicine platform revolutionizing healthcare access in Nigeria and across Africa.
                            Our mission is to connect patients with qualified healthcare providers using technology — making quality
                            healthcare accessible to everyone, regardless of location. The AI Symptom Checker is one step
                            toward giving every Nigerian the health information they need, when they need it.
                        </p>
                    </div>
                </div>
            </section>

            {/* Footer */}
            <footer className="px-6 py-6 border-t border-white/5 text-center space-y-3">
                <div className="flex justify-center">
                    <ComplianceBadges />
                </div>
                <p className="text-xs text-gray-600 dark:text-gray-300">
                    © {new Date().getFullYear()} Docarion ·
                    <Link href="/" className="text-gray-500 hover:text-white transition-colors ml-1">Home</Link>
                </p>
            </footer>
        </div>
    );
}

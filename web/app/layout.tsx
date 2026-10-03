import type { Metadata, Viewport } from 'next';
import { Anuphan, Inter } from 'next/font/google';
import { THEME, THEME_KEY } from './components/brain/style';
import './globals.css';

const SHARE_TITLE = 'สมองความจำของ AI ทุกตัว · ดูสดแบบ 3 มิติ';
const SHARE_DESC = 'สมองความจำระยะยาวที่ AI ทุกตัวในเครื่องใช้ร่วมกัน ดูสดได้ ไม่มีข้อมูลส่วนตัว';

export const metadata: Metadata = {
  title: 'memory-hub · สมองความจำระยะยาวที่ AI หลายตัวใช้ร่วมกัน',
  description: 'สมองความจำระยะยาวที่ AI หลายตัวใช้ร่วมกัน — แผนที่ 3 มิติแบบสดของบทสนทนา โน้ต และความจำ',
  robots: { index: false, follow: false },
  // share card (LINE/Facebook/X): og.png = the live brain, shot at build time by scripts/og.mjs
  metadataBase: new URL('https://memory-hub-brain.vercel.app'),
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'memory-hub',
    locale: 'th_TH',
    title: SHARE_TITLE,
    description: SHARE_DESC,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'ภาพสมอง 3 มิติ จุดสีคือบทสนทนา โน้ต และความจำ' }],
  },
  twitter: { card: 'summary_large_image', title: SHARE_TITLE, description: SHARE_DESC, images: ['/og.png'] },
};

export const viewport: Viewport = {
  colorScheme: 'dark light',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover', // iOS notch: HUD pads itself with env(safe-area-inset-*)
};

// next/font downloads both at build time and serves them from this origin: 0 runtime requests to Google.
// Variable fonts (400/500/600 in CSS) = one woff2 per family. No size-adjusted Arial fallback face: it has no
// unicode-range, so it would sit between Inter and Anuphan in the stack.
const latin = Inter({ subsets: ['latin'], variable: '--font-latin', display: 'swap', adjustFontFallback: false });
const thai = Anuphan({ subsets: ['thai'], variable: '--font-thai', display: 'swap', adjustFontFallback: false });

// Runs before first paint: the saved theme (default dark, whatever the OS says: the bloom is the signature look) and
// the matching browser-chrome colour. A blocked localStorage just means dark.
const THEME_JS = `try{var t=localStorage.getItem('${THEME_KEY}')}catch(e){}t=t==='light'?'light':'dark';document.documentElement.dataset.theme=t;var m=document.createElement('meta');m.name='theme-color';m.content=t==='light'?'${THEME.light.bg}':'${THEME.dark.bg}';document.head.appendChild(m)`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="th" className={`${latin.variable} ${thai.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_JS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

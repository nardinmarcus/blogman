import type { Metadata } from "next";
import { connection } from "next/server";
import localFont from "next/font/local";
import "./globals.css";
import { GlobalShortcuts } from "@/components/GlobalShortcuts";
import { ToastProvider } from "@/components/Toast";
import { CustomJsInjector } from "@/components/CustomJsInjector";
import { FONT_CONFIG, THEME_OPTIONS, THEME_STORAGE_KEY, normalizeTheme } from "@/lib/appearance";
import { getAppCloudflareEnv } from "@/lib/cloudflare";
import { getSetting } from "@/lib/db";
import { rethrowIfDatabaseMigrationRequired } from "@/lib/database-errors";
import { resolveDefaultSiteCoverImage } from "@/lib/default-cover-images";
import { getSiteUrl, getSiteUrlObject } from "@/lib/site-config";

const geistSans = localFont({
  src: [
    { path: "./fonts/geist/Geist-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/geist/Geist-Medium.ttf", weight: "500", style: "normal" },
    { path: "./fonts/geist/Geist-SemiBold.ttf", weight: "600", style: "normal" },
    { path: "./fonts/geist/Geist-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-geist-sans",
  display: "swap",
  fallback: ["system-ui", "Arial", "Helvetica", "sans-serif"],
});

const geistMono = localFont({
  src: [
    { path: "./fonts/geist/GeistMono-Regular.ttf", weight: "400", style: "normal" },
    { path: "./fonts/geist/GeistMono-Medium.ttf", weight: "500", style: "normal" },
    { path: "./fonts/geist/GeistMono-SemiBold.ttf", weight: "600", style: "normal" },
    { path: "./fonts/geist/GeistMono-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-geist-mono",
  display: "swap",
  fallback: ["SFMono-Regular", "Consolas", "Monaco", "monospace"],
});

const SITE_URL = getSiteUrl()
const DEFAULT_SITE_OG_IMAGE = resolveDefaultSiteCoverImage(SITE_URL)

export const metadata: Metadata = {
  metadataBase: getSiteUrlObject(),
  title: {
    default: 'Namoo',
    template: '%s · Namoo',
  },
  description: 'Namoo 的数字花园 — 记录思考，分享所学。',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  manifest: '/manifest.json',
  alternates: {
    types: {
      'application/rss+xml': '/feed.xml',
    },
  },
  openGraph: {
    type: 'website',
    locale: 'zh_CN',
    url: SITE_URL,
    siteName: 'Namoo',
    title: 'Namoo',
    description: 'Namoo 的数字花园 — 记录思考，分享所学。',
    images: [
      {
        url: DEFAULT_SITE_OG_IMAGE,
        width: 1280,
        height: 720,
        alt: 'Namoo',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    site: '',
    creator: '',
    title: 'Namoo',
    description: 'Namoo 的数字花园 — 记录思考，分享所学。',
    images: [DEFAULT_SITE_OG_IMAGE],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await connection()

  let customJs = ''
  let bodyFont = ''
  let defaultTheme = 'default'
  try {
    const env = await getAppCloudflareEnv()
    if (env?.DB) {
      const [customJsValue, bodyFontValue, defaultThemeValue] = await Promise.all([
        getSetting(env.DB, 'custom_js'),
        getSetting(env.DB, 'body_font'),
        getSetting(env.DB, 'default_theme'),
      ])
      customJs = customJsValue || ''
      bodyFont = bodyFontValue || ''
      defaultTheme = normalizeTheme(defaultThemeValue)
    }
  } catch (error) {
    // TEMP DIAG + fix: the root layout must degrade (defaults) instead of
    // rethrowing a schema error into a whole-page 500. Log the raw cause so the
    // offending SQL stays observable, then continue with defaults.
    console.error('layout settings degraded:', error instanceof Error ? error.message : String(error))
  }

  const font = FONT_CONFIG[bodyFont]
  const validThemes = THEME_OPTIONS.map((theme) => theme.id)

  const appearanceApplyScript = `
(function(){
  var f = ${JSON.stringify(FONT_CONFIG)};
  var k = "${bodyFont || ''}";
  var defaultTheme = "${defaultTheme}";
  var themeStorageKey = "${THEME_STORAGE_KEY}";
  var validThemes = ${JSON.stringify(validThemes)};
  function isTheme(value) {
    return validThemes.indexOf(value) !== -1;
  }
  function applyFont(key) {
    var c = f[key];
    document.documentElement.setAttribute('data-font', key || 'default');
    if (c) {
      document.documentElement.style.setProperty('--body-font', c.family);
      if (c.link && !document.getElementById('nm-font-link')) {
        var l = document.createElement('link');
        l.id = 'nm-font-link';
        l.rel = 'stylesheet';
        l.href = c.link;
        document.head.appendChild(l);
      }
    } else {
      document.documentElement.style.removeProperty('--body-font');
    }
  }
  function applyTheme(theme) {
    if (isTheme(theme) && theme !== 'default') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }
  applyFont(k);
  applyTheme(defaultTheme);
  try {
    var savedTheme = window.localStorage.getItem(themeStorageKey);
    if (isTheme(savedTheme)) applyTheme(savedTheme);
  } catch (e) {}
})();
`

  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      data-font={bodyFont || 'default'}
      data-theme={defaultTheme !== 'default' ? defaultTheme : undefined}
      suppressHydrationWarning
    >
      <head>
        {font?.link && <link rel="stylesheet" href={font.link} />}
        {font && (
          <style dangerouslySetInnerHTML={{ __html: `:root { --body-font: ${font.family}; }` }} />
        )}
        <script dangerouslySetInnerHTML={{ __html: appearanceApplyScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <ToastProvider>
          <GlobalShortcuts />
          {children}
        </ToastProvider>
        {customJs && <CustomJsInjector code={customJs} />}
      </body>
    </html>
  );
}

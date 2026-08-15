import type { Metadata, Viewport } from 'next';
import { Azeret_Mono, Figtree, Literata } from 'next/font/google';
import type { ReactNode } from 'react';

import './globals.css';

/**
 * The document, the three typefaces, and the one keyboard escape hatch.
 *
 * **`auth()` is not called here, and must not be.** A root layout that awaits the
 * session opts every route in the app into dynamic rendering, including the
 * landing page and `/status`, which have no session to read and are the two pages
 * that most want to be static. The session is read per route instead, off the same
 * request-scoped cookie, so a second read costs a cookie parse rather than a round
 * trip. A sibling repo lost static rendering on every route this way and the only
 * symptom was a slower cold page nobody could attribute.
 *
 * The three faces are chosen for what a chat is: a body of prose somebody reads for
 * hours, wrapped in chrome they never look at directly.
 *
 * - **Literata** carries message prose and headings. It is a text serif drawn for
 *   long-form screen reading, with a large x-height and open counters, which is the
 *   difference between an hour of messages and forty minutes of messages plus
 *   twenty of eye strain.
 * - **Figtree** is the interface face: channel names, buttons, the roster. A
 *   humanist sans whose `l`, `1` and `I` stay separable at 14px, which is where
 *   every piece of chrome in this app lives.
 * - **Azeret Mono** carries timestamps, unread counts and code spans. Tabular by
 *   default, so a column of times does not shuffle sideways as the minute changes.
 *
 * `docs/SPECS.md` section 6.1 originally named Geist Mono. It is not in the Google
 * Fonts metadata Next 14.2 ships, so `next/font/google` cannot load it and the
 * build fails at typecheck rather than at runtime. Azeret Mono is the substitute:
 * available, unspent across the portfolio, and a grotesque mono that sits with
 * Figtree rather than against it. Loading Geist through the `geist` package
 * instead would mean a second font import statement in this file, which is
 * exactly what the single-statement rule below cannot survive.
 *
 * The import is ONE statement with single-quoted specifier on purpose.
 * `lib/identity.test.ts` and `web/scripts/identity-distinct.mjs` parse it with the
 * same regex, and the cross-repo script is the only check that can see the other
 * twelve projects. Split the import in two, or switch to double quotes, and that
 * script reads zero faces from this repo and reports success while checking
 * nothing.
 */
const prose = Literata({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-prose',
  // Only the two weights the stylesheet asks for. Every unused weight is a font
  // file a reader downloads and never sees: 400 is message body and the lede, 600
  // is every heading.
  weight: ['400', '600'],
});

const ui = Figtree({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-ui',
  // 400 body chrome, 500 roster names, 600 buttons and the presence word.
  weight: ['400', '500', '600'],
});

const mono = Azeret_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
  weight: ['400'],
});

export const metadata: Metadata = {
  title: {
    default: 'Chat',
    template: '%s | Chat',
  },
  description:
    'A real-time chat with channels and direct messages: presence, typing indicators, read state, ' +
    'and a gateway that scales past one process because every broadcast goes through Redis pub/sub.',
};

/**
 * `color-scheme` is what makes the browser paint its own furniture, meaning
 * scrollbars, form controls and the address bar on mobile, in the scheme the
 * stylesheet is using. Without it a dark page keeps a white scrollbar, which is
 * the one part of the page CSS cannot reach.
 */
export const viewport: Viewport = {
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en" className={`${prose.variable} ${ui.variable} ${mono.variable}`}>
      <body>
        {/* First focusable element on every page. Every page below renders a
            `<main id="main">`, so the target always exists. A skip link pointing
            at nothing is worse than none: it moves focus to the document root and
            the reader loses their place with no way to tell what happened. */}
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}

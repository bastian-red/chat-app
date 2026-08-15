import Link from 'next/link';

/**
 * The signed-in navigation.
 *
 * The `NAV` array is read by `scripts/dev-smoke.sh`, which `sed`s the `href`
 * values out of this file and loads every one of them against a booted app. That
 * is why each entry is a single line with a single-quoted `href`: a reformat that
 * split one across two lines would make the smoke lane silently probe fewer
 * routes, and two probed routes cannot catch a third one being broken.
 *
 * Keeping the list here rather than in the smoke script is the point. A route
 * added to the nav and forgotten in the script is a route nobody ever loads until
 * a reader does, and that exact miss shipped in a sibling project.
 */
export const NAV = [
  { href: '/channels', label: 'Channels' },
  { href: '/status', label: 'Status' },
] as const;

export function Nav({ current }: { current: string }) {
  return (
    <nav className="nav" aria-label="Main">
      <ul className="nav-list">
        {NAV.map((item) => (
          <li key={item.href}>
            <Link
              className="nav-link"
              href={item.href}
              // The current page is marked for a screen reader as well as for the
              // eye. `aria-current` is what tells one that this link is where they
              // already are; a colour change alone tells them nothing.
              aria-current={current.startsWith(item.href) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

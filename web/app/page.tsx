import { redirect } from 'next/navigation';

/**
 * `/` opens Conversation, the demo screen (docs/ui.md asks whether it should; this answers yes).
 * The address's query string is kept, so `/?replay=1` lands on `/conversation?replay=1`.
 *
 * next.config.ts answers `/` with a plain 307 before this page renders. This page is the fallback
 * if that rule is removed; here the redirect arrives inside the page stream, after the shell.
 */
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (Array.isArray(value)) value.forEach((v) => query.append(key, v));
    else if (value !== undefined) query.set(key, value);
  }
  const suffix = query.toString();
  redirect(suffix ? `/conversation?${suffix}` : '/conversation');
}

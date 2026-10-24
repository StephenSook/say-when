import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // React Three Fiber's install notes for Next.js 13.1 and later (Screen 1, /brain).
  transpilePackages: ['three'],
  /**
   * `/` opens Conversation, the demo screen, with a plain 307 before any page renders. The query
   * string goes along, so `/?replay=1` lands on `/conversation?replay=1`. app/page.tsx does the same
   * if this rule is ever removed.
   */
  async redirects() {
    return [{ source: '/', destination: '/conversation', permanent: false }];
  },
};

export default nextConfig;

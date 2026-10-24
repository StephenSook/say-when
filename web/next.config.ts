import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
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

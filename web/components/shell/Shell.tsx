'use client';

/**
 * The frame around every screen. The three dashboard routes get the header (name, tabs, connection
 * chip, headset chip), the safety banner, the connection line and the replay banner. The partner
 * phone view (/partner) gets only the replay banner; it draws its own top row.
 *
 * Every frame renders the page's <main id="main">, so a screen must not render another <main>.
 */
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { useConnection, useReplayParam } from '@/lib/data/provider';
import { withReplayParam } from '@/lib/data/source-mode';
import { ConnectionChip } from './ConnectionChip';
import { ConnectionGate, ConnectionLine } from './ConnectionLine';
import { HeadsetChip } from './HeadsetChip';
import { ReplayBanner } from './ReplayBanner';
import { SafetyBanner } from './SafetyBanner';
import { TABS, Tabs } from './Tabs';
import styles from './Shell.module.css';

export function isPhoneRoute(pathname: string | null): boolean {
  return pathname === '/partner' || (pathname?.startsWith('/partner/') ?? false);
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isPhoneRoute(pathname)) return <PhoneFrame>{children}</PhoneFrame>;
  return <DashboardFrame>{children}</DashboardFrame>;
}

function DashboardFrame({ children }: { children: ReactNode }) {
  const conn = useConnection();
  useScreenKeys();
  return (
    <>
      <a className={styles.skip} href="#main">
        Skip to the screen
      </a>
      <ReplayBanner />
      <header className={styles.header}>
        <span className={styles.brand}>NeuroLingo</span>
        <Tabs className={styles.tabs} />
        <div className={styles.chips}>
          <ConnectionChip />
          <HeadsetChip />
        </div>
      </header>
      <SafetyBanner />
      <ConnectionLine />
      <main id="main" tabIndex={-1} className={cx(styles.main, conn.dimmed && styles.dimmed)}>
        <ConnectionGate>{children}</ConnectionGate>
      </main>
    </>
  );
}

/** Exactly one screen tall with the replay banner included, so the phone view never scrolls just for the banner. */
function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className={styles.phoneFrame}>
      <ReplayBanner />
      <main id="main" tabIndex={-1} className={styles.phoneMain}>
        {children}
      </main>
    </div>
  );
}

/** Keys 1, 2 and 3 switch screens, unless the person is typing or a dialog is open. */
function useScreenKeys() {
  const router = useRouter();
  const replayParam = useReplayParam();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) return;
      if (document.querySelector('dialog[open]')) return;
      const tab = TABS.find((t) => t.key === event.key);
      if (!tab) return;
      event.preventDefault();
      router.push(withReplayParam(tab.href, replayParam));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router, replayParam]);
}

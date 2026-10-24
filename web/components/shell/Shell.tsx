'use client';

/**
 * The frame around every screen. The three dashboard routes get the header (name, tabs, connection
 * chip, headset chip), the safety banner, the connection line and the replay banner. The partner
 * phone view (/partner) gets only the replay banner; it draws its own top row. The station and the
 * speaker (/station, /speaker) get a bare frame: they draw their own top row from their own role
 * connection, and the board source never starts there (lib/routes.ts, docs/station.md 1.6).
 * The judge page (/judge, PLAN 5.8) keeps the dashboard header but is a reading page: no connection
 * gate, no dimming, no safety banner or connection line, so it shows even when the live data cannot
 * connect. The brain (/brain, Screen 1) is framed the same way, because it reads the local EEG bridge and never the live
 * data. A quiet "For judges" link sits at the end of the tabs row on every dashboard.
 *
 * Every frame renders the page's <main id="main">, so a screen must not render another <main>.
 */
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { useConnection, useReplayParam } from '@/lib/data/provider';
import { withReplayParam } from '@/lib/data/source-mode';
import { isBrainRoute, isJudgeRoute, isPhoneRoute, isRolePageRoute } from '@/lib/routes';
import { ConnectionChip } from './ConnectionChip';
import { ConnectionGate, ConnectionLine } from './ConnectionLine';
import { HeadsetChip } from './HeadsetChip';
import { JudgeLink } from './JudgeLink';
import { ReplayBanner } from './ReplayBanner';
import { SafetyBanner } from './SafetyBanner';
import { TABS, Tabs } from './Tabs';
import styles from './Shell.module.css';

export { isPhoneRoute, isRolePageRoute };

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isRolePageRoute(pathname)) return <BareFrame>{children}</BareFrame>;
  if (isPhoneRoute(pathname)) return <PhoneFrame>{children}</PhoneFrame>;
  return <DashboardFrame>{children}</DashboardFrame>;
}

/**
 * The station and the speaker: no tabs, no screen keys (a stray screen key must never leave a running station), no
 * headset chip, no replay banner and no connection gate (the board connection is not opened here). The dashboard's
 * side padding stays.
 */
function BareFrame({ children }: { children: ReactNode }) {
  return (
    <main id="main" tabIndex={-1} className={styles.main}>
      {children}
    </main>
  );
}

function DashboardFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const conn = useConnection();
  useScreenKeys();
  // The judge page reads the same with or without a connection, so it is never gated or dimmed. The brain does not use
  // the live data at all.
  const readingPage = isJudgeRoute(pathname) || isBrainRoute(pathname);
  return (
    <>
      <a className={styles.skip} href="#main">
        Skip to the screen
      </a>
      <ReplayBanner />
      <header className={styles.header}>
        <span className={styles.brand}>Eleven</span>
        <div className={styles.nav}>
          <Tabs className={styles.tabs} />
          <JudgeLink className={styles.judgeLink} />
        </div>
        {/* The brain reads the local headset stream, not the live data, so the live-data chips would only confuse. */}
        {isBrainRoute(pathname) ? null : (
          <div className={styles.chips}>
            <ConnectionChip />
            <HeadsetChip />
          </div>
        )}
      </header>
      {readingPage ? null : <SafetyBanner />}
      {readingPage ? null : <ConnectionLine />}
      <main id="main" tabIndex={-1} className={cx(styles.main, !readingPage && conn.dimmed && styles.dimmed)}>
        {readingPage ? children : <ConnectionGate>{children}</ConnectionGate>}
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

/** Keys 1 to 5 switch screens, unless the person is typing or a dialog is open. */
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

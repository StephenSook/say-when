/**
 * Which frame a route gets (docs/station.md 1.6). Pure, so the frame and the data provider share one rule and a test
 * can check it without React.
 *
 * - The partner phone view (/partner) gets the phone frame.
 * - The role pages that run on a dedicated laptop (/station, /speaker) get a bare frame: no tabs, no screen keys, no
 *   headset chip, no replay banner. They open their own role connection, so the dashboards' board source never starts
 *   there (the EEG laptop has 8 GB and should not run the board mapping it never shows).
 * - Everything else is a dashboard. The judge page (/judge) keeps the dashboard header but is a reading page: it renders
 *   without the connection gate, so it shows even when the live data cannot connect.
 * - The brain (/brain, Screen 1) frames like the judge page: it reads only the local EEG bridge on 127.0.0.1:8766, never
 *   SpacetimeDB, so the live-data gate and the safety banner do not apply to it.
 */

function isRoute(pathname: string | null, route: string): boolean {
  if (!pathname) return false;
  return pathname === route || pathname.startsWith(`${route}/`);
}

export function isPhoneRoute(pathname: string | null): boolean {
  return isRoute(pathname, '/partner');
}

/** /station and /speaker: the bare frame, and no board source. */
export function isRolePageRoute(pathname: string | null): boolean {
  return isRoute(pathname, '/station') || isRoute(pathname, '/speaker');
}

/** /judge: the dashboard header, no connection gate, no safety banner (PLAN 5.8). */
export function isJudgeRoute(pathname: string | null): boolean {
  return isRoute(pathname, '/judge');
}

/** /brain: Screen 1, the live brain. Framed like /judge: no connection gate, no safety banner. */
export function isBrainRoute(pathname: string | null): boolean {
  return isRoute(pathname, '/brain');
}

/**
 * The judge page (PLAN 5.8): what Eleven does, a three-minute itinerary through the live screens, the public
 * routes anyone can check with no login, and what is measured and what is not. Every line comes from
 * components/judge/model.ts, whose measured lines are held to the repo's docs by test/judge-page.test.ts.
 *
 * A reading page, so it renders without the connection gate (components/shell/Shell.tsx). Only the stats lines are
 * live, fetched in the browser from the public route; nothing else on the page changes.
 */
import { StatusMark } from '@/components/ui/StatusMark';
import { TextLink } from '@/components/ui/TextLink';
import { buildJudgePage, citationLabel, citationUrl, keepUnits, type Claim } from './model';
import { StatsCheck } from './StatsCheck';
import { StepLink } from './StepLink';
import styles from './Judge.module.css';

export function Judge() {
  const page = buildJudgePage();
  return (
    <article className={styles.root} aria-labelledby="judge-title">
      <header className={styles.intro}>
        <h1 id="judge-title" className={styles.title}>
          {page.title}
        </h1>
        <p className={styles.lead}>{page.lead}</p>
        <p className={styles.note}>
          {page.signals} {page.safety}
        </p>
      </header>

      <div className={styles.columns}>
        <div className={styles.column}>
          <section aria-labelledby="judge-tour">
            <h2 id="judge-tour" className={styles.heading}>
              {page.tourTitle}
            </h2>
            <ol className={styles.list}>
              {page.itinerary.map((step) => (
                <StepLink key={step.href} step={step} />
              ))}
            </ol>
            <p className={styles.replay}>
              {page.replay.before}{' '}
              {/* A full page load: the data source is chosen once per load, so a client-side move would keep live data. */}
              <a className={styles.replayLink} href={page.replay.href}>
                {page.replay.link}
              </a>
            </p>
          </section>

          <section aria-labelledby="judge-check">
            <h2 id="judge-check" className={styles.heading}>
              {page.checkTitle}
            </h2>
            <ul className={styles.list}>
              {page.databases.map((database) => (
                <li key={database.db} className={styles.item}>
                  <StatsCheck db={database.db} note={database.note} />
                </li>
              ))}
              {page.links.map((link) => (
                <li key={link.href} className={styles.item}>
                  <span className={styles.linkLabel}>{link.label}</span>
                  <TextLink href={link.href} className={styles.url}>
                    {link.text}
                  </TextLink>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className={styles.column}>
          <ClaimList id="judge-measured" title={page.measuredTitle} claims={page.measured} measured />
          <ClaimList id="judge-not-measured" title={page.notMeasuredTitle} claims={page.notMeasured} measured={false} />
        </div>
      </div>
    </article>
  );
}

function ClaimList({ id, title, claims, measured }: { id: string; title: string; claims: Claim[]; measured: boolean }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className={styles.heading}>
        {title}
      </h2>
      <ul className={styles.list}>
        {claims.map((claim) => (
          <li key={claim.text} className={styles.claim}>
            <span className={styles.claimMark}>
              <StatusMark status={measured ? 'done' : 'not_started'} showWord={false} word={title} />
            </span>
            <span className={styles.claimBody}>
              <span className={styles.claimText}>{keepUnits(claim.text)}</span>
              <TextLink href={citationUrl(claim.cite)} className={styles.cite}>
                {citationLabel(claim.cite)}
              </TextLink>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

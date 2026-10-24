// Guards (docs/spacetime.md 3.1). Every client reducer starts with one; every scheduled reducer starts with
// `requireScheduler`. A failed guard throws SenderError, which rolls the whole transaction back.
import type { Identity } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import { getConfig } from './config';
import type { Ctx, ReadDb } from './ctx';
import type { Config, Device, Role, Session } from './schema';

export type RoleTag = Role['tag'];

/** The live (not revoked) device row for an identity. */
export function deviceOf(db: ReadDb, identity: Identity): Device | undefined {
  const d = db.device.identity.find(identity);
  return d && !d.revoked ? d : undefined;
}

export function isOwner(ctx: Ctx): boolean {
  const cfg = ctx.db.config.id.find(0);
  return !!cfg && cfg.owner.isEqual(ctx.sender);
}

export function requireOwner(ctx: Ctx): Config {
  const cfg = getConfig(ctx.db);
  if (!cfg.owner.isEqual(ctx.sender)) throw new SenderError('owner only');
  return cfg;
}

export function requireRole(ctx: Ctx, ...roles: RoleTag[]): Device {
  const d = deviceOf(ctx.db, ctx.sender);
  if (!d || !roles.includes(d.role.tag)) throw new SenderError('not allowed');
  return d;
}

/** The owner (Stephen's CLI login) or a paired device with one of the roles. Returns the device, if any. */
export function requireRoleOrOwner(ctx: Ctx, ...roles: RoleTag[]): Device | undefined {
  if (isOwner(ctx)) return deviceOf(ctx.db, ctx.sender);
  return requireRole(ctx, ...roles);
}

/** The owner or a Partner approved as a caregiver. */
export function requireOwnerOrCaregiver(ctx: Ctx): 'Owner' | 'Partner' {
  if (isOwner(ctx)) return 'Owner';
  const d = deviceOf(ctx.db, ctx.sender);
  if (!d || d.role.tag !== 'Partner' || !d.caregiver) throw new SenderError('owner or caregiver only');
  return 'Partner';
}

/** The session named in `config.activeSessionId`, if it has not ended. */
export function activeSession(db: ReadDb): Session | undefined {
  const cfg = db.config.id.find(0);
  if (!cfg || cfg.activeSessionId === 0n) return undefined;
  const s = db.session.id.find(cfg.activeSessionId);
  return s && s.endedAt === undefined ? s : undefined;
}

export function requireActiveSession(ctx: Ctx): Session {
  const s = activeSession(ctx.db);
  if (!s) throw new SenderError('no active session');
  return s;
}

/** A Station, and the one that armed the active session. */
export function requireStation(ctx: Ctx): { device: Device; session: Session } {
  const device = requireRole(ctx, 'Station');
  const session = requireActiveSession(ctx);
  if (!session.station.isEqual(ctx.sender)) throw new SenderError('not the session station');
  return { device, session };
}

/**
 * Scheduled reducers are ordinary reducers that the owner can also call, and `senderAuth.isInternal` is false
 * for every call on a real host in the TypeScript library, so the database identity is the only real check.
 */
export function requireScheduler(ctx: Ctx): void {
  if (!ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('scheduler only');
}

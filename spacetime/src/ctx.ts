// Context types shared by the helpers. Types only: nothing here is a module export.
import type {
  AnonymousViewCtx,
  InferSchema,
  ReadonlyDbView,
  ReducerCtx,
  ViewCtx,
} from 'spacetimedb/server';
import type spacetimedb from './schema';

export type Schema = InferSchema<typeof spacetimedb>;
export type Ctx = ReducerCtx<Schema>;
export type ViewContext = ViewCtx<Schema>;
export type AnonContext = AnonymousViewCtx<Schema>;
/** What reducers and views can both read. A reducer's `ctx.db` is assignable to it. */
export type ReadDb = ReadonlyDbView<Schema>;

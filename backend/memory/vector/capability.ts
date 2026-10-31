import type { Queryable } from '../database.js';
import { AppError } from '../../shared/types.js';

export type VectorBackend = 'pgvector' | 'array_exact';
export interface VectorCapability { backend: VectorBackend; extensionVersion: string | null; extensionSchema: string | null }
export const quoteIdentifier = (value: string): string => '"' + value.replaceAll('"', '""') + '"';

/** Explicit opt-in only. Array fallback is selected by configuration, never by
 * swallowing an unavailable pgvector installation or permission failure. */
export async function ensureVectorCapability(tx: Queryable, input: { backend: VectorBackend; install?: boolean }): Promise<VectorCapability> {
  if (input.backend === 'array_exact') return { backend: 'array_exact', extensionVersion: null, extensionSchema: null };
  if (input.backend !== 'pgvector') throw new AppError('invalid_vector_backend');
  let row = (await tx.query(`SELECT e.extversion,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`)).rows[0];
  if (!row && input.install) {
    // Native PostgreSQL must already have extension binaries installed. PGlite
    // must have been opened with vectorExtension:true. No package install here.
    await tx.exec('CREATE EXTENSION IF NOT EXISTS vector');
    row = (await tx.query(`SELECT e.extversion,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`)).rows[0];
  }
  if (!row) throw new AppError('pgvector_unavailable', 503);
  const schema = String(row.nspname);
  const type = `${quoteIdentifier(schema)}.vector`;
  await tx.exec(`ALTER TABLE memory_embeddings ADD COLUMN IF NOT EXISTS embedding_vector ${type}`);
  // This constraint is installed only after the optional native type exists.
  if (!(await tx.query(`SELECT 1 FROM pg_constraint WHERE conrelid='memory_embeddings'::regclass AND conname='embedding_vector_dimensions'`)).rows.length) {
    await tx.exec(`ALTER TABLE memory_embeddings ADD CONSTRAINT embedding_vector_dimensions CHECK
      (embedding_vector IS NULL OR (${quoteIdentifier(schema)}.vector_dims(embedding_vector)=dimensions
        AND ${quoteIdentifier(schema)}.vector_norm(embedding_vector)>0))`);
  }
  return { backend: 'pgvector', extensionVersion: String(row.extversion), extensionSchema: schema };
}

export async function readVectorCapability(tx: Queryable): Promise<VectorCapability> {
  const row = (await tx.query(`SELECT e.extversion,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`)).rows[0];
  if (!row) throw new AppError('pgvector_unavailable', 503);
  if (!(await tx.query(`SELECT 1 FROM pg_attribute WHERE attrelid='memory_embeddings'::regclass AND attname='embedding_vector' AND NOT attisdropped`)).rows.length) throw new AppError('pgvector_storage_not_initialized', 503);
  return { backend: 'pgvector', extensionVersion: String(row.extversion), extensionSchema: String(row.nspname) };
}

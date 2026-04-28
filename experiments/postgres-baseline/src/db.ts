import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://bp:bp@localhost:5434/bp_baseline',
  max: Number(process.env.PG_POOL_MAX ?? 40),
});

export async function closePool(): Promise<void> {
  await pool.end();
}

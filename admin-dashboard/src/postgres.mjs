import pg from 'pg';
pg.types.setTypeParser(20, Number);
const normalize = (result) => ({ ...result, rows: result.rows.map(row => Object.fromEntries(Object.entries(row).map(([key,value]) => [key,value instanceof Date ? value.toISOString() : value]))) });
const clientApi = (client) => ({
  query: async (sql, params = []) => normalize(await client.query(sql,params)),
  exec: async (sql) => { await client.query(sql); }
});
export function connectPostgres(databaseUrl) {
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('Set DATABASE_URL to the same PostgreSQL database as the WhatsApp bot');
  const pool = new pg.Pool({ connectionString:databaseUrl, max:5, connectionTimeoutMillis:15000 });
  // pg removes failed idle clients before emitting this event. Handle it so a
  // transient database disconnect does not terminate the whole local server.
  // Never log the error object: pg attaches the client and its credentials.
  pool.on('error', error => {
    const code = /^[A-Z0-9_]{1,40}$/.test(error?.code || '') ? error.code : 'CONNECTION_ERROR';
    console.warn(`[postgres] Idle connection closed (${code}); the pool will reconnect on demand.`);
  });
  return {
    ...clientApi(pool),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(clientApi(client));
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    close: () => pool.end()
  };
}

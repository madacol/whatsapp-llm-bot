import { PGlite } from '@electric-sql/pglite';

// We'll initialize this from index.js
const db = new PGlite('./pgdata');

/**
 * SQL template literal function (using PGlite)
 * @param {TemplateStringsArray} strings
 * @param {...any} values
 * @returns {Promise<any[]>}
 */
async function sql(strings, ...values) {
    const result = await db.sql(strings, ...values);
    return result.rows;
}

export async function initDb() {
    await sql`
        CREATE TABLE IF NOT EXISTS actions (
            name TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            parameters JSONB,
            permissions JSONB,
            file_path TEXT NOT NULL
        )
    `;
}

export async function saveAction(action, filePath) {
    await sql`
        INSERT INTO actions (name, description, parameters, permissions, file_path)
        VALUES (${action.name}, ${action.description}, ${JSON.stringify(action.parameters)}, ${JSON.stringify(action.permissions)}, ${filePath})
        ON CONFLICT (name) DO UPDATE SET
            description = EXCLUDED.description,
            parameters = EXCLUDED.parameters,
            permissions = EXCLUDED.permissions,
            file_path = EXCLUDED.file_path
    `;
}

export async function getActionByName(name) {
    const [action] = await sql`SELECT * FROM actions WHERE name = ${name}`;
    return action;
}

export async function getAllActions() {
    return await sql`SELECT * FROM actions`;
}

export async function deleteAction(name) {
    await sql`DELETE FROM actions WHERE name = ${name}`;
}

// Export sql function for direct database access
export { sql };

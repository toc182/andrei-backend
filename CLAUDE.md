# Andrei Backend

Express + TypeScript API. Port 5000 (dev), 8080 (Railway).
33 route files, PostgreSQL via pg pool, auto-migrations on server start.

## Structure

src/
├── routes/ # 33 route files — one per domain
├── middleware/ # auth.ts (JWT + permissions), asyncHandler.ts
├── services/ # storage.ts, emailService.ts, pdfGenerator.ts, auditLog.ts, dailyNotification.ts, reportePdf.ts, reporteNumero.ts, reporteCambios.ts, cronogramaEngine.ts, partidasProyecto.ts, constanciaPdf.ts, asistentePagos/
├── database/ # config.ts (pool), migrate.ts (migrations/ here is EMPTY)
├── types/ # api.ts, auth.ts, database.ts, index.ts, models.ts
├── cron/ # scheduler.ts (daily email notifications)
└── utils/ # fileEncoding.ts

database/migrations/ # the REAL migrations — 158 .sql files, at the repo root, NOT under src/
scripts/ # hand-rolled *.spec.ts verification scripts, run with npx tsx

## Commands

npm run dev # tsx watch src/server.ts
npm run build # tsc → dist/
npm run lint # eslint

## Middleware pattern

Every protected route must follow this order:
authenticateToken → requireRole / checkPermission / checkProjectAccess → asyncHandler(handler)

Available middleware (from src/middleware/auth.ts):

- authenticateToken — validates JWT, loads user + permissions into req.user
- requireAdmin — shortcut for requireRole(['admin', 'co-admin'])
- requireManager — shortcut for requireRole(['admin', 'co-admin', 'usuario'])
- checkPermission('key') — checks individual permission; admin/co-admin always pass
- checkProjectAccess('param') — checks user_project_access table; admin/co-admin always pass

## Roles

admin, co-admin, usuario.

- admin and co-admin bypass all granular permission checks
- admin only: delete projects, trigger test notifications, delete non-pending solicitudes
- co-admin only: cannot modify/deactivate admin users, appears in permissions management list
- usuario: subject to individual permissions in user_permissions table
- Full permissions reference: see .claude/skills/permissions/SKILL.md

## Route pattern

import { authenticateToken, requireAdmin, checkPermission } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

router.get('/', authenticateToken, asyncHandler(async (req, res) => {
const result = await query('SELECT ...', [params]);
res.json({ success: true, data: result.rows });
}));

## Database

- query() from src/database/config.ts — parameterized only, never string concat
- Migrations: `andrei-backend/database/migrations/NNN_name.sql` — at the repo root, NOT
  under `src/`. `src/database/migrations/` exists but is empty; don't put anything there.
  Look in the folder for the next number — never assume.
- runAllMigrations() runs automatically on server start
- Local: andrei_db / Production: DATABASE_URL (Railway)
- MCP postgres tool available for local queries
- `pg` returns a DATE column as a JS `Date` object, never a string. Don't `slice()` a
  `fecha` — you get `"Tue Sep 08"` and then `Invalid Date`. Format it explicitly.
- Never seed accented text through `curl` from the Windows console — it mangles the
  encoding before the request reaches the API. Seed from Node instead.

Migration file format:
-- NNN_description.sql
ALTER TABLE nombre ADD COLUMN IF NOT EXISTS columna tipo;
CREATE TABLE IF NOT EXISTS nueva_tabla (...);

### audit_log polymorphic pattern

The `audit_log` table is the one intentional exception to the project's
FK discipline. Two columns work together as a polymorphic reference:

- `entidad` (varchar) — the kind of record being audited, e.g.
  `'solicitud_pago'`, `'requisicion'`, `'cuenta'`, `'equipo'`, etc.
- `entidad_id` (integer) — the primary key of the row, *in whatever
  table `entidad` names*.

There is deliberately **no FK constraint** on `entidad_id`, because Postgres
FKs target a single parent table and this column targets many. Treat the
pair as "(table_name, row_id)". Filter audit queries by `entidad` first,
then by `entidad_id`. Do not try to "fix" this with a FK.

## Services

- storage.ts — uploadFile(), downloadFile(), deleteFile() via Cloudflare R2
- emailService.ts — sendEmail() via Resend API
- pdfGenerator.ts — generateSolicitudPDF() via Puppeteer + templates/
- auditLog.ts — registrarAudit() — call on every create/edit/delete/approve/pay
- scheduler.ts — cron: Mon-Fri 3:30pm, Sat 11:30am Panama time

## Critical rules

- NEVER skip authenticateToken on any route
- NEVER use string concatenation in SQL queries
- NEVER assume table structure — verify with MCP postgres before writing queries
- ALWAYS call registrarAudit() on create, edit, delete, approve, pay operations
- NEVER delete migrations — add new ones only
- On PUT/PATCH, build the SET clause only from the fields present in the request. A fixed
  column list can't tell "not touching this" from "blank it", and silently wipes data.
- Upload routes must translate multer rejections (10 MB limit, mime type) into real
  messages — otherwise a phone photo fails as "Error interno del servidor"
- .env is never committed — Railway uses DATABASE_URL, JWT_SECRET, R2 keys, RESEND_API_KEY

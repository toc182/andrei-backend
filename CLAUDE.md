# Andrei Backend

Express + TypeScript API. Port 5000 (dev), 8080 (Railway).
36 route files, PostgreSQL via pg pool, auto-migrations on server start.

## Structure

src/
├── routes/ # 36 route files — one per domain
├── middleware/ # auth.ts (JWT + permissions), asyncHandler.ts
├── services/ # storage.ts, emailService.ts, pdfGenerator.ts, auditLog.ts, dailyNotification.ts, cronogramaEngine.ts, partidasProyecto.ts, constanciaPdf.ts, asistentePagos/
│                # reporte diario: reportePdf.ts, reporteNumero.ts, reporteCambios.ts, reporteEnvio.ts
│                # reporte semanal: reporteSemana.ts, semanaCerrada.ts, reporteSemanalDatos.ts,
│                #   reporteSemanalPdf.ts, reporteSemanalEnvio.ts, reporteSemanalIA.ts,
│                #   reporteSemanalCambios.ts; reportePdfComun.ts es lo que los dos papeles comparten
├── database/ # config.ts (pool), migrate.ts (migrations/ here is EMPTY)
├── types/ # api.ts, auth.ts, database.ts, index.ts, models.ts
├── cron/ # scheduler.ts (daily email notifications)
└── utils/ # fileEncoding.ts

database/migrations/ # the REAL migrations — 174 .sql files, at the repo root, NOT under src/
scripts/ # *-humo.ts smoke tests (npm run pruebas) + *.spec.ts pure-calculation ones (npx tsx)
scripts/pruebas/ # the throwaway test database: entorno.ts, semilla.sql, contexto.ts

## Commands

npm run dev # tsx watch src/server.ts
npm run build # tsc → dist/
npm run lint # eslint
npm run pruebas # all smoke tests, each on a throwaway database
npm run pruebas -- filas listas # just those

## Tests

Smoke tests (`scripts/*-humo.ts`) NEVER touch the local database. Each one gets a
database created from the migrations, seeded by `scripts/pruebas/semilla.sql`, with its
own server on a free port; both are thrown away when it finishes, so no test carries
cleanup code. `scripts/pruebas/contexto.ts` refuses to run against any database whose
name does not start with `andrei_pruebas_`, so running one by hand cannot dirty local
data. A test that needs more starting data adds it to `semilla.sql`, never to another
test. Files land in the `andrei-pruebas` R2 bucket under the seeded projects' short
names and get swept at the end of the run.

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
- whatsapp/ — the daily-report assistant on WhatsApp. cliente.ts (send text,
  buttons and documents; download media), firma.ts (X-Hub-Signature-256),
  entrantes.ts (store every message in and out, copy media to R2),
  numero.ts (phone numbers are stored digits-only with country code, exactly as
  Meta sends them), conversacion.ts (one live conversation per phone, dies after
  12 h of silence), datosReporte.ts (the ONLY list of report sections the
  assistant knows — add a field to the daily report, add a line here),
  herramientas.ts (everything the model can actually do; validates against the
  project's lists and the person's permissions), asistente.ts (instructions +
  tool loop, ANTHROPIC_MODELO_WHATSAPP), trabajador.ts (answers a few seconds
  after the person stops writing, never per message), borrador.ts (builds the
  draft with the SAME function the screen uses, its PDF with the BORRADOR stamp,
  and the send).
  Keys are optional: without them WhatsApp simply does not exist for this
  server. Nothing is ever sent without the person having seen the draft first —
  that rule lives in code (herramientas.ts), not in the model's instructions.

## Critical rules

- NEVER skip authenticateToken on any route. The one exception is
  `/api/whatsapp/webhook`: the caller is Meta, which has no session. It is
  guarded by Meta's signature instead, which is why that router is mounted with
  `express.raw` BEFORE the global `express.json` — re-serializing the body
  changes the bytes and the signature stops matching.
- NEVER use string concatenation in SQL queries
- NEVER assume table structure — verify with MCP postgres before writing queries
- ALWAYS call registrarAudit() on create, edit, delete, approve, pay operations
- NEVER delete migrations — add new ones only
- La SEMANA CERRADA: cuando el reporte semanal de una semana se envía, sus siete días
  quedan cerrados para los reportes diarios. No se corrigen, no se eliminan, no admiten
  ni pierden fotos, y no se puede crear uno nuevo con fecha de esos días
  (services/semanaCerrada.ts). Decisión de Ivan del 2026-09-17: el semanal se guarda
  como se envió, así que dejar los diarios abiertos solo conseguiría que el papel y la
  pantalla dijeran cosas distintas del mismo día. Lo que aparezca después se anota en
  un reporte diario posterior.
- Lo que escribe la IA del reporte semanal es TEXTO y nada más —el resumen y los
  problemas—. Todo número sale de la base (services/reporteSemanalDatos.ts): un modelo
  puede equivocarse sumando y nadie lo notaría hasta que el papel ya salió por correo.
- On PUT/PATCH, build the SET clause only from the fields present in the request. A fixed
  column list can't tell "not touching this" from "blank it", and silently wipes data.
- Upload routes must translate multer rejections (10 MB limit, mime type) into real
  messages — otherwise a phone photo fails as "Error interno del servidor"
- .env is never committed — Railway uses DATABASE_URL, JWT_SECRET, R2 keys, RESEND_API_KEY

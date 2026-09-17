import cron from 'node-cron';
import { sendDailyNotifications } from '../services/dailyNotification.js';
import {
  archivarCorreccionesSemanalesPendientes,
  procesarEnviosSemanalesPendientes,
} from '../services/reporteSemanalEnvio.js';
import {
  procesarEnviosPendientes,
  barrerBorradoresAbandonados,
  archivarCorreccionesPendientes,
} from '../routes/proyectoReportes.js';

export function startScheduler(): void {
  // Lunes a viernes a las 3:30 PM hora Panamá
  cron.schedule(
    '30 15 * * 1-5',
    async () => {
      console.log('⏰ Running weekday daily notification...');
      try {
        await sendDailyNotifications();
      } catch (err) {
        console.error('⏰ Error in weekday notification cron:', err);
      }
    },
    { timezone: 'America/Panama' },
  );

  // Sábados a las 11:30 AM hora Panamá
  cron.schedule(
    '30 11 * * 6',
    async () => {
      console.log('⏰ Running Saturday daily notification...');
      try {
        await sendDailyNotifications();
      } catch (err) {
        console.error('⏰ Error in Saturday notification cron:', err);
      }
    },
    { timezone: 'America/Panama' },
  );

  // La cola de reportes, cada minuto.
  //
  // Cada minuto y no cada hora porque esto es lo que separa al ingeniero de su
  // reporte enviado: la primera espera es de un minuto, y si todo va bien el
  // correo sale en ese minuto sin que nadie haga nada. Cuando no hay nada en
  // cola —que es casi siempre— la pasada es una consulta contra un índice
  // parcial de unas pocas filas.
  cron.schedule('* * * * *', async () => {
    try {
      await procesarEnviosPendientes();
    } catch (err) {
      // Que reviente una pasada no puede matar el programador entero.
      console.error('⏰ Error en la cola de envío de reportes:', err);
    }
    try {
      // La misma pasada se lleva los semanales. Van en su propio try para que
      // un semanal que reviente no deje sin mandar los diarios, ni al revés.
      await procesarEnviosSemanalesPendientes();
    } catch (err) {
      console.error('⏰ Error en la cola de envío de reportes semanales:', err);
    }
  });

  // Los borradores abandonados y las correcciones que se quedaron sin su PDF,
  // una vez al dia de madrugada. No corre cada minuto como la cola porque no
  // hay ninguna prisa: ni un borrador invisible ni una version archivada de
  // mas tarde le estorban a nadie mientras esperan su turno.
  cron.schedule(
    '20 3 * * *',
    async () => {
      try {
        await barrerBorradoresAbandonados();
        // Las correcciones del semanal que se quedaron sin su PDF archivado.
        await archivarCorreccionesSemanalesPendientes();
      } catch (err) {
        console.error('⏰ Error barriendo borradores abandonados:', err);
      }
      try {
        await archivarCorreccionesPendientes();
      } catch (err) {
        console.error('⏰ Error archivando correcciones pendientes:', err);
      }
    },
    { timezone: 'America/Panama' },
  );

  console.log(
    '✅ Cron scheduler started (L-V 3:30PM, Sáb 11:30AM — America/Panama; cola de reportes cada minuto; borradores y correcciones 3:20AM)',
  );
}

import cron from 'node-cron';
import { sendDailyNotifications } from '../services/dailyNotification.js';

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

  console.log(
    '✅ Cron scheduler started (L-V 3:30PM, Sáb 11:30AM — America/Panama)',
  );
}

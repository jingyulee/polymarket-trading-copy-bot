import fetch from 'node-fetch';
import { config } from './config.js';

const DEDUPE_WINDOW_MS = 5000;
const recentMessages = new Map<string, number>();

function getChatId(overrideChatId?: string): string {
  return overrideChatId || config.notifications.telegramChatId;
}

function pruneDeduped(now: number): void {
  for (const [key, ts] of recentMessages.entries()) {
    if ((now - ts) > DEDUPE_WINDOW_MS) {
      recentMessages.delete(key);
    }
  }
}

export async function sendTelegram(message: string, overrideChatId?: string): Promise<void> {
  const token = config.notifications.telegramBotToken;
  const chatId = getChatId(overrideChatId);

  if (!token || !chatId) {
    return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });
  } catch (error: any) {
    console.error('Telegram send failed:', error?.message || error);
  }
}

export async function sendTelegramDeduped(key: string, message: string, overrideChatId?: string): Promise<void> {
  const now = Date.now();
  pruneDeduped(now);

  const lastSent = recentMessages.get(key);
  if (lastSent && (now - lastSent) < DEDUPE_WINDOW_MS) {
    return;
  }

  recentMessages.set(key, now);
  await sendTelegram(message, overrideChatId);
}

import { isPlaceId, PLAYER_NAME_LIMIT, type PlaceId } from "./games.ts";

export type ChatPayload = { id: string; name: string; text: string; at: number; place: PlaceId };
export type ChatEntry = ChatPayload & { authorId: string; system?: boolean };
export type ChatHistoryRequest = { version: 1 };
export type ChatHistoryResponse = { messages: ChatPayload[] };

export const CHAT_TEXT_LIMIT = 180;
export const OWN_CHAT_HISTORY_LIMIT = 40;
export const CHAT_LOG_LIMIT = 100;
const OWN_CHAT_STORAGE_KEY = "multiplay-own-chat-v1";

export function sanitizeChatPayload(value: unknown, now: number): ChatPayload | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<ChatPayload>;
  if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.text !== "string") return null;
  if (typeof item.at !== "number" || !Number.isFinite(item.at) || !isPlaceId(item.place)) return null;
  const text = item.text.trim().slice(0, CHAT_TEXT_LIMIT);
  if (!text) return null;
  return {
    id: item.id.slice(0, 120),
    name: item.name.slice(0, PLAYER_NAME_LIMIT),
    text,
    // Sender clocks can run ahead; a future timestamp would pin the entry below newer messages.
    at: Math.min(item.at, now),
    place: item.place,
  };
}

export function mergeChatEntries(current: ChatEntry[], incoming: ChatEntry[]) {
  const system = current.find((entry) => entry.system);
  const byMessageId = new Map<string, ChatEntry>();
  for (const entry of [...current, ...incoming]) {
    // First entry wins so a peer reusing a known id cannot rewrite a displayed message.
    if (!entry.system && !byMessageId.has(entry.id)) byMessageId.set(entry.id, entry);
  }
  const messages = [...byMessageId.values()]
    .sort((first, second) => first.at - second.at)
    .slice(-(CHAT_LOG_LIMIT - (system ? 1 : 0)));
  return system ? [system, ...messages] : messages;
}

export function loadOwnChatHistory() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(OWN_CHAT_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    const now = Date.now();
    return stored.map((item) => sanitizeChatPayload(item, now)).filter((item): item is ChatPayload => item !== null).slice(-OWN_CHAT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function saveOwnChatHistory(history: ChatPayload[]) {
  try {
    window.localStorage.setItem(OWN_CHAT_STORAGE_KEY, JSON.stringify(history.slice(-OWN_CHAT_HISTORY_LIMIT)));
  } catch {
    // Storage can be unavailable in private modes; live chat should continue working.
  }
}

import { prisma } from "../lib/prisma.js";

/** Settings a user can change. Defaults live in the database (user_settings column defaults). */
export interface SearchSettingsInput {
  jobsPerSearch?: number;
  pagesPerSearch?: number;
}

/** Returns the user's settings, creating the row with the defaults the first time. */
export function getUserSettings(userId: string) {
  return prisma.userSettings.upsert({ where: { userId }, create: { userId }, update: {} });
}

export function updateUserSettings(userId: string, data: SearchSettingsInput) {
  return prisma.userSettings.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

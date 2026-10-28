// Совместимость: вся логика переехала в dbcore.ts — SQLite с адаптивным драйвером
// (Bun.sqlite под bun / node:sqlite под Node ≥ 22.3). Один и тот же код работает в обоих рантаймах,
// поэтому standalone-сервер (bun) и встраивание в Next.js (TatNet/node) пользуются одной БД-логикой.
export * from './dbcore';

/**
 * The operator composition root.
 *
 * One process that serves both operator services and holds the three seams neither of them
 * may hold alone (DEC-64, DEC-65, D-18). See `compose.ts` for what is wired and what is
 * deliberately still a hole.
 */
export * from "./compose.js";
export * from "./merchant-events.js";
export * from "./ownership.js";

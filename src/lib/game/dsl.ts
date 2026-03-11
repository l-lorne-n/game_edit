import { z } from 'zod';

const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

const colorSchema = z
  .string()
  .regex(/^#([0-9a-fA-F]{6})$/, 'Color must be a 6-digit hex code');

export const gameDslSchema = z.object({
  version: z.literal('1.0'),
  meta: z.object({
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
  }),
  arena: z.object({
    width: z.number().int().min(320).max(1920),
    height: z.number().int().min(240).max(1080),
    backgroundColor: colorSchema,
  }),
  player: z.object({
    radius: z.number().min(6).max(36),
    color: colorSchema,
    speed: z.number().min(60).max(520),
    start: pointSchema,
    maxInvulnerabilityMs: z.number().int().min(0).max(2000),
  }),
  enemies: z.array(
    z.object({
      id: z.string().min(1),
      radius: z.number().min(6).max(40),
      color: colorSchema,
      speed: z.number().min(20).max(420),
      spawn: pointSchema,
      damage: z.number().int().min(1).max(3),
      behavior: z.enum(['seek']),
    }),
  ).max(48),
  spawners: z.array(
    z.object({
      id: z.string().min(1),
      intervalMs: z.number().int().min(500).max(8000),
      maxAlive: z.number().int().min(0).max(100),
      templateEnemyId: z.string().min(1),
      area: z.object({
        xMin: z.number().finite(),
        xMax: z.number().finite(),
        yMin: z.number().finite(),
        yMax: z.number().finite(),
      }),
    }),
  ).max(24),
  collectibles: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.literal('coin'),
      radius: z.number().min(4).max(30),
      color: colorSchema,
      value: z.number().int().min(1).max(100),
      spawn: pointSchema,
    }),
  ).max(64),
  rules: z.object({
    durationSec: z.number().int().min(10).max(300),
    startingLives: z.number().int().min(1).max(9),
    winCondition: z
      .object({
        type: z.enum(['survive', 'scoreAtLeast']),
        scoreTarget: z.number().int().min(1).max(1000).optional(),
      })
      .superRefine((value, ctx) => {
        if (value.type === 'scoreAtLeast' && value.scoreTarget == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'scoreTarget is required when winCondition.type=scoreAtLeast',
          });
        }
      }),
    loseCondition: z.object({
      type: z.literal('livesDepleted'),
    }),
  }),
  ui: z.object({
    showTimer: z.boolean(),
    showScore: z.boolean(),
    showLives: z.boolean(),
  }),
  theme: z.object({
    name: z.string().min(1).max(50),
    accentColor: colorSchema,
  }),
});

export type GameDsl = z.infer<typeof gameDslSchema>;

import { z } from 'zod';

export const packageCapabilitySchema = z.enum(['audio', 'fullscreen', 'pointerLock']);

export const packageManifestSchema = z.object({
  title: z.string().min(1).max(80),
  summary: z.string().min(1).max(280),
  editable: z.array(z.string().min(1).max(80)).max(32).default([]),
  capabilities: z.array(packageCapabilitySchema).max(3).default([]),
  notes: z.string().max(600).optional(),
});

export const generatedGamePackageSchema = z
  .object({
    indexHtml: z.string().min(1).max(120_000),
    gameJs: z.string().min(1).max(120_000),
    styleCss: z.string().max(120_000).default(''),
    manifestJson: z.string().min(2).max(40_000),
  })
  .strict();

export type PackageCapability = z.infer<typeof packageCapabilitySchema>;
export type GamePackageManifest = z.infer<typeof packageManifestSchema>;
export type GeneratedGamePackage = z.infer<typeof generatedGamePackageSchema>;

export type ParsedGeneratedGamePackage = {
  pkg: GeneratedGamePackage;
  manifest: GamePackageManifest;
};

export type PackageParseErrorCode =
  | 'PACKAGE_SCHEMA_INVALID'
  | 'MANIFEST_JSON_INVALID'
  | 'MANIFEST_SCHEMA_INVALID';

export type PackageParseResult =
  | {
      ok: true;
      pkg: GeneratedGamePackage;
      manifest: GamePackageManifest;
    }
  | {
      ok: false;
      code: PackageParseErrorCode;
      message: string;
      issues?: string[];
    };

function issuesToText(issues: z.core.$ZodIssue[]): string[] {
  return issues.map(issue => {
    const path = issue.path?.join('.') ?? 'root';
    return `${path}: ${issue.message}`;
  });
}

export function parseGeneratedGamePackage(input: unknown): PackageParseResult {
  const parsedPackage = generatedGamePackageSchema.safeParse(input);
  if (!parsedPackage.success) {
    return {
      ok: false,
      code: 'PACKAGE_SCHEMA_INVALID',
      message: 'Package must provide indexHtml, gameJs, styleCss, and manifestJson.',
      issues: issuesToText(parsedPackage.error.issues),
    };
  }

  let manifestCandidate: unknown;
  try {
    manifestCandidate = JSON.parse(parsedPackage.data.manifestJson);
  } catch {
    return {
      ok: false,
      code: 'MANIFEST_JSON_INVALID',
      message: 'manifestJson must be valid JSON.',
    };
  }

  const parsedManifest = packageManifestSchema.safeParse(manifestCandidate);
  if (!parsedManifest.success) {
    return {
      ok: false,
      code: 'MANIFEST_SCHEMA_INVALID',
      message: 'Manifest JSON does not satisfy the schema.',
      issues: issuesToText(parsedManifest.error.issues),
    };
  }

  return {
    ok: true,
    pkg: parsedPackage.data,
    manifest: parsedManifest.data,
  };
}

export function stringifyManifest(manifest: GamePackageManifest): string {
  return JSON.stringify(manifest, null, 2);
}

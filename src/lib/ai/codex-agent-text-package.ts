import { parse as parseYaml } from 'yaml';

import { parseGeneratedGamePackage, type GeneratedGamePackage, type PackageParseResult } from '@/lib/package/contracts';

function parseJsonObject(text: string): unknown | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseYamlObject(text: string): unknown | null {
  try {
    const parsed = parseYaml(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractCandidate(text: string): unknown | null {
  const trimmed = text.trim();
  const wholeJson = parseJsonObject(trimmed);
  if (wholeJson) {
    return wholeJson;
  }

  const fenceRegex = /```(json|yaml|yml)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  while ((match = fenceRegex.exec(trimmed)) !== null) {
    const body = match[2].trim();
    const jsonBody = parseJsonObject(body);
    if (jsonBody) {
      return jsonBody;
    }
    const yamlBody = parseYamlObject(body);
    if (yamlBody) {
      return yamlBody;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const maybeJson = parseJsonObject(trimmed.slice(firstBrace, lastBrace + 1));
    if (maybeJson) {
      return maybeJson;
    }
  }

  return parseYamlObject(trimmed);
}

export function recoverPackageFromAgentText(text: string): PackageParseResult {
  const candidate = extractCandidate(text);
  if (!candidate) {
    return {
      ok: false,
      code: 'PACKAGE_SCHEMA_INVALID',
      message: 'Agent text did not contain a recoverable package object.',
    };
  }

  return parseGeneratedGamePackage(candidate);
}

export function packageSizes(pkg: GeneratedGamePackage): string {
  return `index.html=${pkg.indexHtml.length}B, game.js=${pkg.gameJs.length}B, style.css=${pkg.styleCss.length}B, manifest.json=${pkg.manifestJson.length}B`;
}
